package api

import "net/http"

// healthHandler reports that the core process is alive and returns its version.
// Registered at GET /api/health by router.go.
func healthHandler(w http.ResponseWriter, r *http.Request) {
	JSONData(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"version": "0.1.0",
	})
}

// readyHandler reports that the core is ready to serve requests (e.g. DB/config
// loaded, Docker socket reachable). Useful for container health checks.
// Registered at GET /api/ready by router.go.
func readyHandler(w http.ResponseWriter, r *http.Request) {
	JSONData(w, http.StatusOK, map[string]bool{
		"ready": true,
	})
}
