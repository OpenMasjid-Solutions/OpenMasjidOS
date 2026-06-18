package main

import (
	"embed"
	"io/fs"
	"net/http"
)

// uiAssets holds the compiled SvelteKit static output.
// At build time, `make build-ui` writes to frontend/build,
// which is then copied into place before `go build` runs.
//
//go:embed frontend/build
var uiAssets embed.FS

// UIFileSystem returns an http.FileSystem rooted at the embedded build directory.
func UIFileSystem() (http.FileSystem, error) {
	sub, err := fs.Sub(uiAssets, "frontend/build")
	if err != nil {
		return nil, err
	}
	return http.FS(sub), nil
}
