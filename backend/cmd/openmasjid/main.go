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
	// PORT controls the listen address; DATA_DIR is where all persistent data lives.
	cfg := config.Load(config.Options{
		Port:    getEnv("PORT", "8723"),
		DataDir: getEnv("DATA_DIR", "/data"),
	})

	// Structured JSON logging so log aggregators (e.g. Docker log drivers) can
	// parse fields without brittle regex. Level is INFO by default.
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Build the HTTP router. All route registration, middleware, and handler
	// wiring live in the api package — main stays thin.
	router := api.NewRouter(cfg)

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

// getEnv returns the value of the named environment variable, or fallback if
// the variable is unset or empty. Kept here rather than in config so main.go
// remains self-contained and easy to audit.
func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
