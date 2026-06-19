package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/OpenMasjidOS/OpenMasjidOS/internal/api"
	"github.com/OpenMasjidOS/OpenMasjidOS/internal/config"
)

func main() {
	// Load configuration from environment variables with sensible defaults.
	cfg := config.Load()

	// Healthcheck mode: the container HEALTHCHECK invokes the binary with
	// -healthcheck. The final image is distroless (no shell, no wget/curl), so
	// the binary checks itself by hitting its own /api/health and exiting 0/1.
	if len(os.Args) > 1 && (os.Args[1] == "-healthcheck" || os.Args[1] == "--healthcheck") {
		os.Exit(healthcheck(cfg.Port))
	}

	// Structured JSON logging so log aggregators (e.g. Docker log drivers) can
	// parse fields without brittle regex. Level is INFO by default.
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Build the HTTP router. All route registration, middleware, and handler
	// wiring live in the api package — main stays thin.
	router, err := api.NewRouter(cfg)
	if err != nil {
		slog.Error("failed to initialise router", "err", err)
		os.Exit(1)
	}

	addr := fmt.Sprintf(":%s", cfg.Port)
	srv := &http.Server{
		Addr:    addr,
		Handler: router,
		// Conservative timeouts to protect against slow clients.
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Capture SIGINT (Ctrl-C) and SIGTERM (Docker / systemd stop) so we can
	// drain in-flight requests before exiting.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	// Start serving in a goroutine so the main goroutine can block on the
	// signal channel below.
	go func() {
		slog.Info("OpenMasjidOS core is ready", "address", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	// Block until a shutdown signal arrives.
	sig := <-quit
	slog.Info("shutting down", "signal", sig.String())

	// Give in-flight requests up to 5 seconds to finish before forcibly closing.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("graceful shutdown failed; forcing close", "err", err)
		os.Exit(1)
	}

	slog.Info("server stopped cleanly")
}

// healthcheck performs a single GET against the local /api/health endpoint and
// returns a process exit code (0 = healthy, 1 = not). Used by the container
// HEALTHCHECK; kept dependency-free so it works in the distroless image.
func healthcheck(port string) int {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/api/health")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
