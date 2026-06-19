package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/OpenMasjidOS/OpenMasjidOS/internal/auth"
)

// sessionCookie is the name of the HTTP-only session cookie.
const sessionCookie = "omos_session"

// minPasswordLen is the minimum admin password length enforced at setup.
const minPasswordLen = 8

// authAPI bundles the credential store and session manager and exposes the
// HTTP handlers + middleware for authentication.
type authAPI struct {
	store    *auth.Store
	sessions *auth.Sessions
	ttl      time.Duration
}

func newAuthAPI(store *auth.Store, sessions *auth.Sessions, ttl time.Duration) *authAPI {
	return &authAPI{store: store, sessions: sessions, ttl: ttl}
}

type credentialsBody struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// setSessionCookie writes the session token as an HTTP-only, SameSite=Strict
// cookie. Secure is intentionally NOT set: v1 is served over plain HTTP on a
// trusted LAN (TLS is out of scope, see ARCHITECTURE §11), and a Secure cookie
// would never be sent, breaking login. HttpOnly + SameSite=Strict still defend
// against XSS token theft and CSRF.
func (a *authAPI) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(a.ttl.Seconds()),
	})
}

func (a *authAPI) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	})
}

// isAuthenticated reports whether the request carries a valid session cookie.
func (a *authAPI) isAuthenticated(r *http.Request) bool {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	return a.sessions.Valid(c.Value)
}

// handleMe reports the auth state so the SPA can decide what to render:
// the setup wizard, the login screen, or the dashboard.
//
// GET /api/auth/me → { setup_required, authenticated, username }
func (a *authAPI) handleMe(w http.ResponseWriter, r *http.Request) {
	setup := a.store.IsSetup()
	authed := setup && a.isAuthenticated(r)
	resp := map[string]any{
		"setup_required": !setup,
		"authenticated":  authed,
	}
	if authed {
		resp["username"] = a.store.Username()
	}
	JSONData(w, http.StatusOK, resp)
}

// handleSetup creates the admin account on first run, then logs the user in.
//
// POST /api/auth/setup { username, password }
func (a *authAPI) handleSetup(w http.ResponseWriter, r *http.Request) {
	if a.store.IsSetup() {
		JSONError(w, http.StatusConflict, "An admin account already exists.")
		return
	}

	body, ok := decodeCredentials(w, r)
	if !ok {
		return
	}
	if body.Username == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a username.")
		return
	}
	if len(body.Password) < minPasswordLen {
		JSONError(w, http.StatusBadRequest, "Your password needs to be at least 8 characters.")
		return
	}

	if err := a.store.Setup(body.Username, body.Password); err != nil {
		if errors.Is(err, auth.ErrAlreadySetup) {
			JSONError(w, http.StatusConflict, "An admin account already exists.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't create your account. Please try again.")
		return
	}

	a.issueSession(w)
	JSONData(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"username":      a.store.Username(),
	})
}

// handleLogin verifies credentials and starts a session.
//
// POST /api/auth/login { username, password }
func (a *authAPI) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !a.store.IsSetup() {
		JSONError(w, http.StatusForbidden, "This OpenMasjidOS isn't set up yet.")
		return
	}

	body, ok := decodeCredentials(w, r)
	if !ok {
		return
	}

	if !a.store.Verify(body.Username, body.Password) {
		// Deliberately vague so we don't reveal which field was wrong.
		JSONError(w, http.StatusUnauthorized, "That username or password isn't right.")
		return
	}

	a.issueSession(w)
	JSONData(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"username":      a.store.Username(),
	})
}

// handleLogout destroys the current session and clears the cookie.
//
// POST /api/auth/logout
func (a *authAPI) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		a.sessions.Destroy(c.Value)
	}
	a.clearSessionCookie(w)
	JSONData(w, http.StatusOK, map[string]any{"authenticated": false})
}

// issueSession creates a session token and sets the cookie. On the rare token
// generation failure it logs nothing sensitive and leaves the user logged out.
func (a *authAPI) issueSession(w http.ResponseWriter) {
	token, err := a.sessions.Create()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't start your session. Please try again.")
		return
	}
	a.setSessionCookie(w, token)
}

// requireAuth wraps protected routes. Before setup it returns 403; after setup
// it returns 401 unless a valid session cookie is present.
func (a *authAPI) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.store.IsSetup() {
			JSONError(w, http.StatusForbidden, "This OpenMasjidOS isn't set up yet.")
			return
		}
		if !a.isAuthenticated(r) {
			JSONError(w, http.StatusUnauthorized, "Please sign in to continue.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// handleSession is a simple protected endpoint that echoes the signed-in admin.
//
// GET /api/session (protected) → { username }
func (a *authAPI) handleSession(w http.ResponseWriter, r *http.Request) {
	JSONData(w, http.StatusOK, map[string]any{"username": a.store.Username()})
}

// decodeCredentials parses and trims a credentials body, writing a friendly
// error and returning ok=false if the JSON is malformed.
func decodeCredentials(w http.ResponseWriter, r *http.Request) (credentialsBody, bool) {
	var body credentialsBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't read that request. Please try again.")
		return body, false
	}
	body.Username = strings.TrimSpace(body.Username)
	return body, true
}
