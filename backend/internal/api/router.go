// Package api wires together all HTTP routes and middleware for the
// OpenMasjidOS control plane. The router is constructed once at startup and
// handed to net/http.ListenAndServe.
package api

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/openmasjid/core/internal/config"
)

// version is the API/build version reported by the health endpoint.
// Replaced at link time with -ldflags "-X api.version=x.y.z".
var version = "0.1.0"

// uiAssets holds the compiled SvelteKit output.
// UI assets are embedded at build time via embed.go (in the backend/ root).
// The variable is set from that file so the router package stays import-clean.
var uiAssets embed.FS

// SetUIAssets is called from embed.go (or main) to inject the embedded
// filesystem before the router is created.
func SetUIAssets(f embed.FS) {
	uiAssets = f
}

// NewRouter builds and returns the fully configured HTTP handler.
// It owns all route registration and middleware layering.
func NewRouter(cfg *config.Config) http.Handler {
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
		// Health: lightweight liveness probe — just confirms the process is up.
		// GET /api/health → 200 {"status":"ok","version":"0.1.0"}
		api.Get("/health", handleHealth)

		// Ready: will later gate on setup-wizard completion and Docker
		// connectivity. For now it always returns ready so the UI can boot.
		// GET /api/ready → 200 {"ready":true}
		api.Get("/ready", handleReady)
	})

	// ── SPA fallback ────────────────────────────────────────────────────────
	// Serve the embedded SvelteKit static build for every route that is not
	// under /api. If the requested file does not exist we serve index.html so
	// that client-side routing (e.g. /store, /settings) works after a hard
	// refresh.
	r.Handle("/*", spaHandler())

	return r
}

// ── Handlers ────────────────────────────────────────────────────────────────

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"version": version,
	})
}

func handleReady(w http.ResponseWriter, r *http.Request) {
	// TODO(phase-2): check that the setup wizard has been completed and that
	// the Docker socket is reachable before returning ready:true.
	writeJSON(w, http.StatusOK, map[string]bool{"ready": true})
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// writeJSON encodes v as JSON and writes it with the given status code.
// It sets Content-Type so callers do not have to.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// At this point headers are already sent; log and move on.
		slog.Error("failed to encode JSON response", "err", err)
	}
}

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
		// Try to open the requested file. If it does not exist, fall back to
		// index.html so that deep-links like /store/prayer-times-display work.
		f, openErr := sub.Open(r.URL.Path)
		if openErr != nil {
			// Serve the root index.html; SvelteKit handles the route.
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
