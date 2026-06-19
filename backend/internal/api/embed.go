package api

import "embed"

// uiAssets holds the compiled SvelteKit static build.
// The Dockerfile copies the frontend build output to internal/api/ui/build
// so that this directive resolves correctly relative to this file.
//
// The "all:" prefix is required because SvelteKit places all compiled JS and
// CSS assets inside the "_app/" directory, and Go's embed directive silently
// excludes any file or directory whose name begins with "_" or "." by default.
// Without "all:", the entire _app/ tree is missing and the browser receives
// only the HTML shell with no styles or scripts, resulting in a blank page.
//
//go:embed all:ui/build
var uiAssets embed.FS
