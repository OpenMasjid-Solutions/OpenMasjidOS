# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions
#
# OpenMasjidOS core — multi-stage build.
#   1. deps:    the core's production dependencies, and nothing else.
#   2. build:   install the monorepo, build the React UI (Vite) and bundle the
#               TypeScript daemon (esbuild).
#   3. runtime: a slim Node + Docker-CLI image that runs the daemon, which
#               serves the built UI and the tRPC API — HTTPS on 443, an HTTP
#               front door on 80, and per-app HTTPS proxies on 8443-8452.
#
# We use Alpine and @node-rs/argon2 (prebuilt musl binaries) so the multi-arch
# (amd64 + arm64) build needs no native compilation. See docs/ARCHITECTURE.md.
#
# Node 22 is the current LTS line; Node 20 stopped receiving security fixes on
# 2026-04-30, and this daemon runs as root with the Docker socket.

# ---- Runtime dependencies ---------------------------------------------------
# Only what the core's bundle requires at run time (esbuild leaves every package
# external). The UI ships as built static files, so React, Radix, Motion and the
# rest of its dependencies are not needed here; `npm prune --omit=dev` over the
# whole workspace kept them: about 80 MB on disk and 11 MB of download on every
# box, for nothing.
# Same lockfile, same integrity pins; npm picks the musl argon2 binary for the
# architecture this stage runs on. Both workspace manifests are copied because
# `npm ci` checks the lockfile against every workspace.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/
RUN npm ci --omit=dev --workspace=@openmasjid/core --no-audit --no-fund

# ---- Build stage ------------------------------------------------------------
FROM node:22-alpine AS build
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

# ---- Runtime stage ----------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# The core installs/removes apps by shelling out to `docker` + `docker compose`
# against the mounted host socket, so the CLI and compose plugin must be present.
# openssl generates the self-signed TLS cert for the dashboard's forced HTTPS.
# rclone uploads scheduled backups to Google Drive / a NAS (SFTP/SMB/WebDAV).
RUN apk add --no-cache docker-cli docker-cli-compose ca-certificates tar openssl rclone

ENV NODE_ENV=production \
    OPENMASJID_DATA_DIR=/data \
    OPENMASJID_PORT=80 \
    OPENMASJID_VERSION_FILE=/app/VERSION

# Built output, the core's production deps, manifests, and the VERSION file.
# The monorepo layout is preserved so the core resolves the UI at ../ui/dist.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/VERSION ./
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/ui/package.json ./packages/ui/package.json
COPY --from=build /app/packages/ui/dist ./packages/ui/dist

# 80 = HTTP front door, 443 = dashboard (HTTPS), 8443-8452 = per-app HTTPS
# proxies for Stripe apps that need a secure context.
EXPOSE 80 443 8443-8452

# Runs as root: it must read the root-owned Docker socket and write to /data.
# Least-privilege still applies to the APP containers the core launches.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD wget -qO- http://127.0.0.1:80/api/health || exit 1

ENTRYPOINT ["node", "packages/core/dist/index.js"]
