# Stage 1: Build the SvelteKit frontend
FROM node:20-alpine AS ui-builder

WORKDIR /app/frontend

# Install dependencies first (better layer caching)
COPY frontend/package*.json ./
RUN npm ci

# Copy the rest of the frontend source and build
COPY frontend/ ./
RUN npm run build

# Stage 2: Build the Go backend binary
FROM golang:1.22-alpine AS go-builder

WORKDIR /app

# Download dependencies first (better layer caching)
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# Copy the backend source
COPY backend/ ./

# Copy the built UI assets so they can be embedded via go:embed
COPY --from=ui-builder /app/frontend/build ./frontend/build

# Build a statically linked binary with debug info stripped
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o openmasjid ./cmd/openmasjid

# Stage 3: Minimal production image — no shell, no package manager, no runtime deps
FROM gcr.io/distroless/static-debian12

COPY --from=go-builder /app/openmasjid /openmasjid

EXPOSE 8723

# Run as the built-in nonroot user provided by distroless
USER nonroot:nonroot

ENTRYPOINT ["/openmasjid"]
