// Package apps manages installed apps. In v1 this covers custom (3rd-party)
// apps installed by pasting a Docker Compose file; catalog apps will reuse the
// same lifecycle. Each app is a Docker Compose project named "omos-<id>" with
// its files under <dataDir>/apps/<id>/.
package apps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/OpenMasjidOS/OpenMasjidOS/internal/docker"
)

var (
	// ErrInvalidName is returned when a name can't be turned into a usable id.
	ErrInvalidName = errors.New("invalid app name")
	// ErrInvalidCompose is returned when the pasted text isn't a compose file.
	ErrInvalidCompose = errors.New("that doesn't look like a Docker Compose file")
	// ErrExists is returned when an app with the same id already exists.
	ErrExists = errors.New("an app with that name already exists")
	// ErrNotFound is returned when removing an unknown app.
	ErrNotFound = errors.New("app not found")
)

var nonSlug = regexp.MustCompile(`[^a-z0-9-]+`)

// App is the metadata for an installed app. Running and Ports are filled in at
// list time (not persisted).
type App struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Custom    bool   `json:"custom"`
	CreatedAt string `json:"created_at"`
	Running   bool   `json:"running"`
	Ports     []int  `json:"ports"`
}

// Manager owns the apps directory and the compose lifecycle.
type Manager struct {
	appsDir string
}

// NewManager returns a manager rooted at <dataDir>/apps.
func NewManager(dataDir string) *Manager {
	return &Manager{appsDir: filepath.Join(dataDir, "apps")}
}

func slugify(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = strings.ReplaceAll(s, " ", "-")
	s = nonSlug.ReplaceAllString(s, "")
	return strings.Trim(s, "-")
}

func (m *Manager) project(id string) string { return "omos-" + id }
func (m *Manager) dir(id string) string     { return filepath.Join(m.appsDir, id) }

// InstallCustom installs an app from a pasted compose file. It returns the
// created App, the raw compose output (for diagnostics on failure), and an error.
func (m *Manager) InstallCustom(ctx context.Context, name, composeYAML string) (App, string, error) {
	id := slugify(name)
	if id == "" {
		return App{}, "", ErrInvalidName
	}
	// Lightweight sanity check; `docker compose` does the real validation and
	// returns precise errors which we surface to the caller.
	if !strings.Contains(composeYAML, "services:") {
		return App{}, "", ErrInvalidCompose
	}
	if _, err := m.loadMeta(id); err == nil {
		return App{}, "", ErrExists
	}

	dir := m.dir(id)
	out, err := docker.ComposeUp(ctx, dir, m.project(id), composeYAML)
	if err != nil {
		// Roll back so a fixed retry can reuse the name.
		_, _ = docker.ComposeDown(context.Background(), dir, m.project(id), false)
		_ = os.RemoveAll(dir)
		return App{}, out, fmt.Errorf("compose up failed: %w", err)
	}

	app := App{
		ID:        id,
		Name:      strings.TrimSpace(name),
		Custom:    true,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if err := m.saveMeta(app); err != nil {
		return App{}, out, err
	}
	app.Running = true
	return app, out, nil
}

// List returns all installed apps with their current running state.
func (m *Manager) List(ctx context.Context) ([]App, error) {
	entries, err := os.ReadDir(m.appsDir)
	if errors.Is(err, os.ErrNotExist) {
		return []App{}, nil
	}
	if err != nil {
		return nil, err
	}

	apps := make([]App, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		app, err := m.loadMeta(e.Name())
		if err != nil {
			continue // not a managed app dir
		}
		app.Running = docker.ComposeRunning(ctx, m.project(app.ID))
		if app.Running {
			app.Ports = docker.ProjectPorts(ctx, m.project(app.ID))
		}
		apps = append(apps, app)
	}
	sort.Slice(apps, func(i, j int) bool { return apps[i].Name < apps[j].Name })
	return apps, nil
}

// Stop stops an app's containers (without removing them).
func (m *Manager) Stop(ctx context.Context, id string) error {
	if _, err := m.loadMeta(id); err != nil {
		return ErrNotFound
	}
	_, err := docker.ComposeStop(ctx, m.dir(id), m.project(id))
	return err
}

// Start starts a previously-stopped app.
func (m *Manager) Start(ctx context.Context, id string) error {
	if _, err := m.loadMeta(id); err != nil {
		return ErrNotFound
	}
	_, err := docker.ComposeStart(ctx, m.dir(id), m.project(id))
	return err
}

// Restart restarts an app's containers.
func (m *Manager) Restart(ctx context.Context, id string) error {
	if _, err := m.loadMeta(id); err != nil {
		return ErrNotFound
	}
	_, err := docker.ComposeRestart(ctx, m.dir(id), m.project(id))
	return err
}

// Remove stops an app and deletes its project files. When removeData is true,
// named volumes are deleted too.
func (m *Manager) Remove(ctx context.Context, id string, removeData bool) error {
	if _, err := m.loadMeta(id); err != nil {
		return ErrNotFound
	}
	// Best-effort down; we still remove metadata even if compose complains.
	_, _ = docker.ComposeDown(ctx, m.dir(id), m.project(id), removeData)
	return os.RemoveAll(m.dir(id))
}

func (m *Manager) saveMeta(a App) error {
	dir := m.dir(a.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "app.json"), data, 0o644)
}

func (m *Manager) loadMeta(id string) (App, error) {
	data, err := os.ReadFile(filepath.Join(m.dir(id), "app.json"))
	if err != nil {
		return App{}, err
	}
	var a App
	if err := json.Unmarshal(data, &a); err != nil {
		return App{}, err
	}
	a.Running = false
	return a, nil
}
