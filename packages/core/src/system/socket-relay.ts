// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The lifetime of a browser's live socket relayed to an app: when either side goes, so
 * does the other.
 *
 * `a.pipe(b)` passes on an END — the other side closing politely — and nothing else. A
 * socket that is DESTROYED emits 'close' but never 'end', so with pipes alone the other
 * side stays open: the app is never told the browser has gone, and this daemon holds the
 * connection to it until the app notices by itself, which an idle socket may never do.
 * The platform destroys a browser's socket on purpose — the sweep that closes an app
 * socket whose sign-in has ended (system/remote-sockets.ts) — and a review found that
 * the sweep cut the browser off and left the app's connection behind, still open.
 *
 * Shared by the tunnel ingress and the per-app HTTPS proxy: the same relay written twice
 * is how one copy gets fixed and the other does not.
 */
import type { Duplex } from 'node:stream';

/**
 * Tie the two sockets' lifetimes together. Call it as soon as both exist — before the
 * connection to the app is even made — so a browser that leaves while the app is still
 * being dialled cancels the dial.
 */
export function closeTogether(client: Duplex, upstream: Duplex): void {
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.once('close', () => upstream.destroy());
  upstream.once('close', () => {
    // After a polite end, pipe() has already ended the browser's side; destroying it now
    // would throw away whatever is still on its way to the browser.
    if (!client.writableEnded) client.destroy();
  });
}
