// Package api wires together all HTTP routes and middleware for the
// OpenMasjidOS control plane. The router is constructed once at startup and
// handed to net/http.ListenAndServe.
package api

import (
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/OpenMasjidOS/OpenMasjidOS/internal/auth"
	"github.com/OpenMasjidOS/OpenMasjidOS/internal/config"
)

// version is the API/build version reported by the health endpoint.
// Replaced at link time with -ldflags "-X github.com/OpenMasjidOS/OpenMasjidOS/internal/api.version=x.y.z".
var version = "0.1.0"

// sessionTTL is the inactivity timeout for an admin session.
const sessionTTL = 24 * time.Hour

// NewRouter builds and returns the fully configured HTTP handler.
// It owns all route registration and middleware layering. It returns an error
// if a required dependency (e.g. the credential store) cannot be initialised.
func NewRouter(cfg *config.Config) (http.Handler, error) {
	// Credential store + session manager for the single admin account.
	authStore, err := auth.NewStore(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	authn := newAuthAPI(authStore, auth.NewSessions(sessionTTL), sessionTTL)

	r := chi.NewRouter()

	// ── Middleware stack ────────────────────────────────────────────────────

	// Recover from panics and return a 500 rather than crashing the process.
	r.Use(middleware.Recoverer)

	// Honour X-Real-IP / X-Forwarded-For set by a reverse proxy.
	r.Use(middleware.RealIP)

	// Structured request logging via slog (replaces chi.Logger which writes
	// plain text). In dev mode slog defaults to human-readable output.
	r.Use(slogRequestLogger())

	// CORS: in dev mode we allow all origins so the Vite dev server
	// (localhost:5173) can talk to the Go backend (localhost:8723).
	// In production we restrict to localhost and the loopback address because
	// the dashboard is served by the Go binary itself — no cross-origin calls
	// are needed from the wild.
	corsOptions := cors.Options{
		AllowedMethods: []string{
			http.MethodGet,
			http.MethodPost,
			http.MethodPut,
			http.MethodPatch,
			http.MethodDelete,
			http.MethodOptions,
		},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: true, // needed for session cookies
		MaxAge:           300,
	}
	if cfg.Dev {
		corsOptions.AllowedOrigins = []string{"*"}
	} else {
		corsOptions.AllowedOrigins = []string{
			"http://localhost:" + cfg.Port,
			"http://127.0.0.1:" + cfg.Port,
		}
	}
	r.Use(cors.Handler(corsOptions))

	// ── API subrouter ───────────────────────────────────────────────────────

	r.Route("/api", func(api chi.Router) {
		// ── Public probes (no auth — used by Docker healthchecks) ──
		// GET /api/health → 200 {"status":"ok","version":"..."}
		api.Get("/health", handleHealth)
		// GET /api/ready → 200 {"ready":true}
		api.Get("/ready", handleReady)

		// ── Public auth endpoints ──
		// These must be reachable before/without a session so the SPA can
		// decide whether to show the setup wizard, the login screen, or the app.
		api.Get("/auth/me", authn.handleMe)
		api.Post("/auth/setup", authn.handleSetup)
		api.Post("/auth/login", authn.handleLogin)
		api.Post("/auth/logout", authn.handleLogout)

		// ── Protected endpoints ──
		// Everything that manages the masjid's apps/host lives here. Before
		// setup these return 403; without a session they return 401.
		api.Group(func(pr chi.Router) {
			pr.Use(authn.requireAuth)
			pr.Get("/session", authn.handleSession)
		})
	})

	// ── SPA fallback ────────────────────────────────────────────────────────
	// Serve the embedded SvelteKit static build for every route that is not
	// under /api. The static assets carry no secrets; the SPA itself enforces
	// auth by calling /api/auth/me and gating on protected API responses. If the
	// requested file does not exist we serve index.html so client-side routing
	// (e.g. /store, /settings) works after a hard refresh.
	r.Handle("/*", spaHandler())

	return r, nil
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// spaHandler returns an http.Handler that serves files from the embedded UI
// filesystem. If a requested path is not found it falls back to index.html so
// that SvelteKit's client-side router can take over.
func spaHandler() http.Handler {
	// The SvelteKit build is placed under "ui/build" inside the embed.FS.
	// embed.go declares  //go:embed ui/build  and exposes the FS via
	// SetUIAssets. We strip the leading "ui/build" prefix here so that
	// requests for "/app.js" resolve to "ui/build/app.js" in the archive.
	sub, err := fs.Sub(uiAssets, "ui/build")
	if err != nil {
		// This should only happen if embed.go is misconfigured at build time.
		// Return a clear error handler so the misconfiguration is obvious.
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			slog.Error("UI assets not embedded correctly", "err", err)
			http.Error(w, "UI assets unavailable — build error", http.StatusInternalServerError)
		})
	}

	fileServer := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// io/fs paths must never start with "/". Strip it before probing so that
		// asset requests like "/_app/immutable/entry.js" are served correctly
		// rather than always falling back to index.html (which caused a blank page).
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "."
		}
		f, openErr := sub.Open(name)
		if openErr != nil {
			// File not found — serve index.html so SvelteKit's client-side router
			// can handle deep-links like /store or /settings after a hard refresh.
			r.URL.Path = "/"
		} else {
			f.Close()
		}
		fileServer.ServeHTTP(w, r)
	})
}

// slogRequestLogger returns a chi-compatible middleware that logs each request
// with slog so the log format is consistent with the rest of the application.
func slogRequestLogger() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)
			slog.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", ww.Status(),
				"bytes", ww.BytesWritten(),
				"remote", r.RemoteAddr,
			)
		})
	}
}
