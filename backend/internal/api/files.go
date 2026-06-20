package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/OpenMasjidOS/OpenMasjidOS/internal/files"
)

// filesAPI exposes the sandboxed file manager. All routes are behind requireAuth.
type filesAPI struct {
	mgr *files.Manager
}

func newFilesAPI(mgr *files.Manager) *filesAPI {
	return &filesAPI{mgr: mgr}
}

// writeErr maps a files error to a friendly HTTP response.
func (a *filesAPI) writeErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, files.ErrOutsideRoot):
		JSONError(w, http.StatusForbidden, "That location isn't allowed.")
	case errors.Is(err, files.ErrNotFound):
		JSONError(w, http.StatusNotFound, "That file or folder doesn't exist.")
	case errors.Is(err, files.ErrIsDir):
		JSONError(w, http.StatusBadRequest, "That's a folder, not a file.")
	default:
		JSONError(w, http.StatusInternalServerError, "Something went wrong. Please try again.")
	}
}

// handleList lists a directory.  GET /api/files?path=<rel>
func (a *filesAPI) handleList(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	entries, err := a.mgr.List(p)
	if err != nil {
		a.writeErr(w, err)
		return
	}
	JSONData(w, http.StatusOK, map[string]any{"path": p, "entries": entries})
}

// handleDownload streams a file.  GET /api/files/download?path=<rel>
func (a *filesAPI) handleDownload(w http.ResponseWriter, r *http.Request) {
	f, info, err := a.mgr.OpenFile(r.URL.Query().Get("path"))
	if err != nil {
		a.writeErr(w, err)
		return
	}
	defer f.Close()

	// Large files can exceed the server's default write timeout.
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Now().Add(30 * time.Minute))
	}

	name := strings.ReplaceAll(info.Name(), `"`, "")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	_, _ = io.Copy(w, f)
}

// handleUpload saves an uploaded file.  POST /api/files/upload?path=<rel-dir>
// Body: multipart/form-data with a "file" part. Streamed (no full buffering).
func (a *filesAPI) handleUpload(w http.ResponseWriter, r *http.Request) {
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetReadDeadline(time.Now().Add(30 * time.Minute))
		_ = rc.SetWriteDeadline(time.Now().Add(30 * time.Minute))
	}
	// Cap the request at 2 GiB.
	r.Body = http.MaxBytesReader(w, r.Body, 2<<30)

	dir := r.URL.Query().Get("path")
	mr, err := r.MultipartReader()
	if err != nil {
		JSONError(w, http.StatusBadRequest, "That upload couldn't be read. Please try again.")
		return
	}

	saved := false
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			JSONError(w, http.StatusBadRequest, "That upload was incomplete. Please try again.")
			return
		}
		if part.FormName() == "file" && part.FileName() != "" {
			if err := a.mgr.Save(dir, part.FileName(), part); err != nil {
				_ = part.Close()
				a.writeErr(w, err)
				return
			}
			saved = true
		}
		_ = part.Close()
	}

	if !saved {
		JSONError(w, http.StatusBadRequest, "No file was included in the upload.")
		return
	}
	JSONData(w, http.StatusOK, map[string]any{"ok": true})
}

type filesNameBody struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

func decodeNameBody(w http.ResponseWriter, r *http.Request) (filesNameBody, bool) {
	var body filesNameBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't read that request. Please try again.")
		return body, false
	}
	return body, true
}

// handleMkdir creates a folder.  POST /api/files/mkdir { path, name }
func (a *filesAPI) handleMkdir(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeNameBody(w, r)
	if !ok {
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		JSONError(w, http.StatusBadRequest, "Please enter a folder name.")
		return
	}
	if err := a.mgr.Mkdir(body.Path, body.Name); err != nil {
		a.writeErr(w, err)
		return
	}
	JSONData(w, http.StatusOK, map[string]any{"ok": true})
}

// handleRename renames an item.  POST /api/files/rename { path, name }
func (a *filesAPI) handleRename(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeNameBody(w, r)
	if !ok {
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		JSONError(w, http.StatusBadRequest, "Please enter a name.")
		return
	}
	if err := a.mgr.Rename(body.Path, body.Name); err != nil {
		a.writeErr(w, err)
		return
	}
	JSONData(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDelete removes a file/folder.  DELETE /api/files?path=<rel>
func (a *filesAPI) handleDelete(w http.ResponseWriter, r *http.Request) {
	if err := a.mgr.Delete(r.URL.Query().Get("path")); err != nil {
		a.writeErr(w, err)
		return
	}
	JSONData(w, http.StatusOK, map[string]any{"ok": true})
}
