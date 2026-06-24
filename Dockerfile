# syntax=docker/dockerfile:1
#
# OpenMasjidOS core — multi-stage build.
#   1. build:   install the monorepo, build the React UI (Vite) and the
#               TypeScript daemon (tsc), then drop dev dependencies.
#   2. runtime: a slim Node + Docker-CLI image that runs the daemon, which
#               serves the built UI and the tRPC API on one port.
#
# We use Alpine and @node-rs/argon2 (prebuilt musl binaries) so the multi-arch
# (amd64 + arm64) build needs no native compilation. See docs/ARCHITECTURE.md.

# ---- Build stage ------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Copy workspace manifests + lockfile first so dependency layers cache well.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/

# Reproducible, integrity-pinned install from the committed lockfile.
RUN npm ci --no-audit --no-fund

# Copy the rest of the sources and build both packages.
COPY tsconfig.base.json VERSION ./
COPY packages ./packages
RUN npm run build

# Strip dev dependencies (vite, tsc, tsx…) — the runtime only needs prod deps.
RUN npm prune --omit=dev --no-audit --no-fund

# ---- Runtime stage ----------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

# The core installs/removes apps by shelling out to `docker` + `docker compose`
# against the mounted host socket, so the CLI and compose plugin must be present.
# openssl generates the self-signed TLS cert for the dashboard's forced HTTPS.
RUN apk add --no-cache docker-cli docker-cli-compose ca-certificates tar openssl

ENV NODE_ENV=production \
    OPENMASJID_DATA_DIR=/data \
    OPENMASJID_PORT=80 \
    OPENMASJID_VERSION_FILE=/app/VERSION

# Built output, installed (prod-only) deps, manifests, and the VERSION file.
# The monorepo layout is preserved so the core resolves the UI at ../ui/dist.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/VERSION ./
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/ui/package.json ./packages/ui/package.json
COPY --from=build /app/packages/ui/dist ./packages/ui/dist

EXPOSE 80 443

# Runs as root: it must read the root-owned Docker socket and write to /data.
# Least-privilege still applies to the APP containers the core launches.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD wget -qO- http://127.0.0.1:80/api/health || exit 1

ENTRYPOINT ["node", "packages/core/dist/index.js"]
