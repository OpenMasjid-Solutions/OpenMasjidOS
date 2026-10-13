// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What to show someone when something failed.
 *
 * An error's own message is fit to show only when it was written for them: our server's
 * answer (a tRPC error from the server carries a `data.code`), or a sentence this code
 * threw on purpose (`ShownError`). Anything else is the transport talking — "Failed to
 * fetch" when the connection drops, "Unexpected token '<'…" when Cloudflare answers with
 * its own error page while the core restarts — which tells a volunteer nothing, so the
 * caller's friendly fallback is shown instead (CLAUDE.md §14).
 */

/** An error whose message was written for the person reading the screen. */
export class ShownError extends Error {}

export function errorText(e: unknown, fallback: string): string {
  const err = e as { message?: unknown; data?: { code?: unknown } | null } | null | undefined;
  const message = typeof err?.message === 'string' ? err.message.trim() : '';
  if (!message) return fallback;
  return e instanceof ShownError || err?.data?.code ? message : fallback;
}
