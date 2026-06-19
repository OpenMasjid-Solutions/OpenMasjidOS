package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/OpenMasjidOS/OpenMasjidOS/internal/apps"
)

// appsAPI exposes app install/list/remove over HTTP. All routes are mounted
// behind requireAuth.
type appsAPI struct {
	mgr *apps.Manager
}

func newAppsAPI(mgr *apps.Manager) *appsAPI {
	return &appsAPI{mgr: mgr}
}

// handleList returns all installed apps with their running state.
// GET /api/apps → { apps: [...] }
func (a *appsAPI) handleList(w http.ResponseWriter, r *http.Request) {
	list, err := a.mgr.List(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't read your installed apps.")
		return
	}
	JSONData(w, http.StatusOK, map[string]any{"apps": list})
}

type installCustomBody struct {
	Name    string `json:"name"`
	Compose string `json:"compose"`
}

// handleInstallCustom installs an app from a pasted compose file.
// POST /api/apps/custom { name, compose }
func (a *appsAPI) handleInstallCustom(w http.ResponseWriter, r *http.Request) {
	// Pulling images + starting containers can take well over the server's
	// default write timeout, so extend the deadline for this request only.
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Now().Add(200 * time.Second))
	}

	var body installCustomBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&body); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't read that request. Please try again.")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		JSONError(w, http.StatusBadRequest, "Please give the app a name.")
		return
	}

	app, output, err := a.mgr.InstallCustom(r.Context(), body.Name, body.Compose)
	if err != nil {
		switch {
		case errors.Is(err, apps.ErrInvalidName):
			JSONError(w, http.StatusBadRequest, "Please use a name with letters or numbers.")
		case errors.Is(err, apps.ErrInvalidCompose):
			JSONError(w, http.StatusBadRequest, "That doesn't look like a Docker Compose file — it should have a \"services:\" section.")
		case errors.Is(err, apps.ErrExists):
			JSONError(w, http.StatusConflict, "An app with that name is already installed. Choose a different name.")
		default:
			// Installation failed (bad image, port clash, etc.). Surface the
			// compose output as technical details for the "view details" expander.
			JSON(w, http.StatusUnprocessableEntity, envelope{
				Error: "We couldn't install that app. Check the details below and try again.",
				Meta:  map[string]any{"details": strings.TrimSpace(output)},
			})
		}
		return
	}

	JSONData(w, http.StatusOK, app)
}

// lifecycleAction wraps a manager method (stop/start/restart) as an HTTP handler.
func (a *appsAPI) lifecycleAction(action func(ctx context.Context, id string) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if err := action(r.Context(), id); err != nil {
			if errors.Is(err, apps.ErrNotFound) {
				JSONError(w, http.StatusNotFound, "That app isn't installed.")
				return
			}
			JSONError(w, http.StatusInternalServerError, "We couldn't complete that action. Please try again.")
			return
		}
		JSONData(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// handleRemove stops and removes an installed app.
// DELETE /api/apps/{id}?data=true
func (a *appsAPI) handleRemove(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	removeData := r.URL.Query().Get("data") == "true"

	if err := a.mgr.Remove(r.Context(), id, removeData); err != nil {
		if errors.Is(err, apps.ErrNotFound) {
			JSONError(w, http.StatusNotFound, "That app isn't installed.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't remove that app. Please try again.")
		return
	}
	JSONData(w, http.StatusOK, map[string]any{"removed": id})
}
