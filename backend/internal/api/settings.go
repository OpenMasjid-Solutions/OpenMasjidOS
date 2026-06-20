package api

import (
	"encoding/json"
	"net/http"

	"github.com/OpenMasjidOS/OpenMasjidOS/internal/settings"
)

// settingsAPI exposes the server-enforced platform toggles (currently the web
// terminal switches). Mounted behind requireAuth.
type settingsAPI struct {
	store *settings.Store
}

func newSettingsAPI(store *settings.Store) *settingsAPI {
	return &settingsAPI{store: store}
}

// handleGet returns the current settings.
// GET /api/settings
func (s *settingsAPI) handleGet(w http.ResponseWriter, r *http.Request) {
	JSONData(w, http.StatusOK, s.store.Get())
}

// handleUpdate replaces the settings.
// PUT /api/settings { web_terminal, root_terminal }
func (s *settingsAPI) handleUpdate(w http.ResponseWriter, r *http.Request) {
	var body settings.Settings
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't read that request. Please try again.")
		return
	}
	if err := s.store.Set(body); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't save your settings. Please try again.")
		return
	}
	JSONData(w, http.StatusOK, s.store.Get())
}
