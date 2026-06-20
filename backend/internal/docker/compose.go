// Package docker wraps all interaction with the Docker engine. Per the project
// conventions, `docker compose` is the one place we shell out — every compose
// invocation goes through here against the mounted host socket.
package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const composeFileName = "docker-compose.yml"

// ComposeUp writes composeYAML to <projectDir>/docker-compose.yml and starts it
// as a detached compose project. It returns the combined stdout+stderr so the
// caller can surface diagnostics (e.g. an invalid compose file) to the user.
func ComposeUp(ctx context.Context, projectDir, project, composeYAML string) (string, error) {
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		return "", fmt.Errorf("creating project dir: %w", err)
	}
	file := filepath.Join(projectDir, composeFileName)
	if err := os.WriteFile(file, []byte(composeYAML), 0o644); err != nil {
		return "", fmt.Errorf("writing compose file: %w", err)
	}
	return run(ctx, "compose", "-p", project, "-f", file, "up", "-d", "--remove-orphans")
}

// composeArgs builds the base `compose -p <project> [-f file]` arguments. The
// compose file is only added when it exists on disk, so recovered orphan apps
// (whose metadata/file may be gone) can still be managed by project label.
func composeArgs(projectDir, project string) []string {
	args := []string{"compose", "-p", project}
	if _, err := os.Stat(filepath.Join(projectDir, composeFileName)); err == nil {
		args = append(args, "-f", filepath.Join(projectDir, composeFileName))
	}
	return args
}

// ComposeDown stops and removes a compose project. When removeData is true,
// named volumes are deleted as well.
func ComposeDown(ctx context.Context, projectDir, project string, removeData bool) (string, error) {
	args := append(composeArgs(projectDir, project), "down", "--remove-orphans")
	if removeData {
		args = append(args, "-v")
	}
	return run(ctx, args...)
}

// ComposeStop stops a project's containers without removing them.
func ComposeStop(ctx context.Context, projectDir, project string) (string, error) {
	return run(ctx, append(composeArgs(projectDir, project), "stop")...)
}

// ComposeStart starts a previously-stopped project.
func ComposeStart(ctx context.Context, projectDir, project string) (string, error) {
	return run(ctx, append(composeArgs(projectDir, project), "start")...)
}

// ComposeRestart restarts a project's containers.
func ComposeRestart(ctx context.Context, projectDir, project string) (string, error) {
	return run(ctx, append(composeArgs(projectDir, project), "restart")...)
}

// ComposeRunning reports whether a project currently has any running container.
func ComposeRunning(ctx context.Context, project string) bool {
	out, err := run(ctx, "compose", "-p", project, "ps", "--status", "running", "-q")
	if err != nil {
		return false
	}
	return strings.TrimSpace(out) != ""
}

var publishedPortRe = regexp.MustCompile(`:(\d+)->`)

// ProjectPorts returns the unique published host ports for a project's running
// containers (parsed from `docker ps` output), sorted ascending.
func ProjectPorts(ctx context.Context, project string) []int {
	out, err := run(ctx, "ps",
		"--filter", "label=com.docker.compose.project="+project,
		"--format", "{{.Ports}}")
	if err != nil {
		return nil
	}
	seen := map[int]bool{}
	var ports []int
	for _, m := range publishedPortRe.FindAllStringSubmatch(out, -1) {
		p, convErr := strconv.Atoi(m[1])
		if convErr == nil && !seen[p] {
			seen[p] = true
			ports = append(ports, p)
		}
	}
	sort.Ints(ports)
	return ports
}

// RunningProjects returns the OpenMasjidOS compose project names ("omos-*")
// currently known to Docker (running or stopped). Used to recover apps whose
// on-disk metadata was lost, so a running app never vanishes from the UI.
// Uses `docker compose ls` (the canonical project list) rather than a ps label
// template, which is more reliable across CLI versions.
func RunningProjects(ctx context.Context) []string {
	out, err := run(ctx, "compose", "ls", "--all", "--format", "json")
	if err != nil {
		return nil
	}
	var entries []struct {
		Name string `json:"Name"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(out)), &entries) != nil {
		return nil
	}
	var projects []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name, "omos-") {
			projects = append(projects, e.Name)
		}
	}
	return projects
}

// FirstContainer returns the ID of the first running container in a project,
// used as the target for `docker exec` when opening a web terminal.
func FirstContainer(ctx context.Context, project string) (string, error) {
	out, err := run(ctx, "ps",
		"--filter", "label=com.docker.compose.project="+project,
		"--format", "{{.ID}}")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(out, "\n") {
		if id := strings.TrimSpace(line); id != "" {
			return id, nil
		}
	}
	return "", fmt.Errorf("no running container for project %q", project)
}

// run executes the docker CLI with the given arguments and returns combined output.
func run(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}
