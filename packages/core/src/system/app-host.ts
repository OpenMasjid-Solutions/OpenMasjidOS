// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * How the core reaches an app's published HOST port.
 *
 * The core runs in its own bridge-network container, so `127.0.0.1` inside the core is
 * the CORE — not the machine. An app's published port is on the host, and nothing is
 * listening for it on the core's own loopback. The installer therefore adds
 * `host.docker.internal:host-gateway` to the core service, and that name is how every
 * in-core caller reaches a port published on the host.
 *
 * WHY THIS IS ITS OWN MODULE: the same expression was copy-pasted into three callers
 * (the Fabric broker, the per-app TLS proxy, the tunnel ingress) and then written a
 * fourth time from memory, wrongly — the WhatsApp gateway client used `127.0.0.1` and so
 * could never reach OpenWA at all, on any install (fixed in 0.50.4-dev.3). A value that
 * must agree across callers gets exactly one definition.
 *
 * NOT a security-relevant input: this is a fixed name from the environment, never
 * request-controlled, so the broker's "target URL is built only from the registry"
 * no-SSRF property is unchanged by going through here.
 */

/** Hostname that resolves to the Docker host from inside the core container. */
export function appHost(): string {
  // Unset in dev, where the core runs on the host and apps publish to localhost —
  // that is what the env var is for.
  return process.env.OPENMASJID_APP_PROXY_TARGET ?? 'host.docker.internal';
}

/** Origin for an app's published port, e.g. `http://host.docker.internal:2785`. */
export function appOrigin(port: number): string {
  return `http://${appHost()}:${port}`;
}
