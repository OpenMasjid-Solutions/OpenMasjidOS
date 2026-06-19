# Stage 1: Build the SvelteKit frontend
FROM node:20-alpine AS ui-builder

WORKDIR /app/frontend

COPY frontend/package.json ./
RUN npm install

COPY frontend/ ./
RUN npm run build

# Stage 2: Build the Go backend binary
FROM golang:1.22-alpine AS go-builder

WORKDIR /app

# Copy VERSION so the build can stamp it into the binary via ldflags.
COPY VERSION ./

COPY backend/go.mod ./
RUN go mod download

COPY backend/ ./

# Copy the built UI assets into the exact path expected by go:embed in
# internal/api/embed.go:  //go:embed all:ui/build
COPY --from=ui-builder /app/frontend/build ./internal/api/ui/build

RUN go mod tidy

# Stamp the version from the VERSION file into the binary at link time.
# The api.version variable is declared in internal/api/router.go and defaults
# to "0.1.0"; the -X flag overrides it with whatever is in VERSION.
RUN VERSION=$(cat /app/VERSION) && \
    CGO_ENABLED=0 GOOS=linux go build \
      -ldflags="-w -s -X github.com/OpenMasjidOS/OpenMasjidOS/internal/api.version=${VERSION}" \
      -o openmasjid ./cmd/openmasjid

# Stage 3: Minimal production image
FROM gcr.io/distroless/static-debian12

COPY --from=go-builder /app/openmasjid /openmasjid

EXPOSE 80

# Runs as root (the default for distroless/static). The core is the control
# plane: it must read the root-owned Docker socket (/var/run/docker.sock) and
# write its config/state to the root-owned /data bind mount. A non-root user
# cannot do either, so "USER nonroot" makes the container crash on startup.
# Least-privilege still applies to the APP containers the core launches.

# The image is distroless (no shell/wget/curl); the binary self-checks via the
# -healthcheck flag, invoked by the compose HEALTHCHECK.
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=15s \
  CMD ["/openmasjid", "-healthcheck"]

ENTRYPOINT ["/openmasjid"]
