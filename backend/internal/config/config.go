// Package config loads and holds runtime configuration for OpenMasjidOS.
// Values are read from environment variables so the same binary works in
// Docker, bare-metal dev, and CI without touching code.
package config

import (
	"os"
)

// Config holds all runtime settings for the core service.
type Config struct {
	// Port is the TCP port the HTTP server listens on.
	Port string

	// DataDir is the root directory for all persistent data (masjid profile,
	// app state, volumes). Mapped from the host at /opt/openmasjid inside
	// the container.
	DataDir string

	// LogLevel controls verbosity: "debug", "info", "warn", "error".
	LogLevel string

	// Dev is true when OPENMASJID_DEV=true is set. In dev mode CORS is
	// relaxed and structured logs are replaced with human-readable output.
	Dev bool
}

// Load reads configuration from environment variables and fills in sensible
// defaults. It never fails — callers always get a usable Config back.
func Load() *Config {
	cfg := &Config{
		Port:     envOr("OPENMASJID_PORT", "8723"),
		DataDir:  envOr("OPENMASJID_DATA_DIR", "/data"),
		LogLevel: envOr("OPENMASJID_LOG_LEVEL", "info"),
		Dev:      os.Getenv("OPENMASJID_DEV") == "true",
	}
	return cfg
}

// envOr returns the value of the named environment variable, or fallback if
// the variable is unset or empty.
func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
