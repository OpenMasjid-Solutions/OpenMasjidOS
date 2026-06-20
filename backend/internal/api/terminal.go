package api

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"github.com/OpenMasjidOS/OpenMasjidOS/internal/docker"
	"github.com/OpenMasjidOS/OpenMasjidOS/internal/settings"
)

// terminalAPI serves interactive web terminals over WebSocket. Both endpoints
// are mounted behind requireAuth AND additionally gated by the server-side
// settings toggles — the terminal is a powerful capability, so it is off unless
// explicitly enabled.
type terminalAPI struct {
	settings *settings.Store
}

func newTerminalAPI(s *settings.Store) *terminalAPI {
	return &terminalAPI{settings: s}
}

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// The session cookie (verified by requireAuth before this handler runs) plus
	// SameSite=Strict on that cookie is the real gate; allow the upgrade here.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// resizeMsg is the only text message the client sends; everything else is
// binary stdin.
type resizeMsg struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// handleAppTerminal opens a shell inside an app's first running container.
// GET /api/apps/{id}/terminal (WebSocket)
func (t *terminalAPI) handleAppTerminal(w http.ResponseWriter, r *http.Request) {
	if !t.settings.Get().WebTerminal {
		JSONError(w, http.StatusForbidden, "The web terminal is turned off. Enable it in Settings → Advanced.")
		return
	}
	id := chi.URLParam(r, "id")
	containerID, err := docker.FirstContainer(r.Context(), "omos-"+id)
	if err != nil {
		JSONError(w, http.StatusNotFound, "That app isn't running, so there's no terminal to open.")
		return
	}
	t.serve(w, r, exec.Command("docker", "exec", "-it", containerID, "sh"))
}

// handleRootTerminal opens a root shell inside the core container (which has the
// Docker CLI and socket access).
// GET /api/terminal/root (WebSocket)
func (t *terminalAPI) handleRootTerminal(w http.ResponseWriter, r *http.Request) {
	if !t.settings.Get().RootTerminal {
		JSONError(w, http.StatusForbidden, "The root terminal is turned off. Enable it in Settings → Advanced.")
		return
	}
	t.serve(w, r, exec.Command("/bin/sh"))
}

// serve upgrades to a WebSocket and bridges it to a PTY running cmd:
//   - PTY output  → WebSocket binary frames
//   - binary frame → PTY stdin
//   - text frame   → resize control ({"type":"resize","cols":..,"rows":..})
func (t *terminalAPI) serve(w http.ResponseWriter, r *http.Request, cmd *exec.Cmd) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already wrote the error response
	}
	defer conn.Close()

	ptmx, err := pty.Start(cmd)
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("\r\nCould not start a shell.\r\n"))
		return
	}
	defer func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
		}
	}()

	var writeMu sync.Mutex

	// PTY -> WebSocket
	go func() {
		buf := make([]byte, 4096)
		for {
			n, readErr := ptmx.Read(buf)
			if n > 0 {
				writeMu.Lock()
				werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n])
				writeMu.Unlock()
				if werr != nil {
					return
				}
			}
			if readErr != nil {
				writeMu.Lock()
				_ = conn.WriteControl(
					websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
					time.Now().Add(time.Second),
				)
				writeMu.Unlock()
				_ = conn.Close()
				return
			}
		}
	}()

	// WebSocket -> PTY
	for {
		mt, data, readErr := conn.ReadMessage()
		if readErr != nil {
			return
		}
		switch mt {
		case websocket.BinaryMessage:
			if _, werr := ptmx.Write(data); werr != nil {
				return
			}
		case websocket.TextMessage:
			var msg resizeMsg
			if json.Unmarshal(data, &msg) == nil && msg.Type == "resize" {
				_ = pty.Setsize(ptmx, &pty.Winsize{Rows: msg.Rows, Cols: msg.Cols})
			}
		}
	}
}
