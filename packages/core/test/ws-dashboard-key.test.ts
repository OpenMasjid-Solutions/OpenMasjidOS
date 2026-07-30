// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * protectedProcedure must verify the dashboard key on EVERY transport
 * (trpc/trpc.ts) — [OPENMASJIDOS-001].
 *
 * The bug this pins: the middleware read
 *     if (!ctx.isWebSocket && !verifyCsrf(ctx.sessionToken, ctx.csrf))
 * so the WebSocket transport was exempt. Two beliefs behind that were both wrong —
 * tRPC's WS transport executes queries and mutations (not just subscriptions), and
 * the origin guard fails open when there is no Origin header, which a non-browser
 * client simply omits. Net effect: the shared session cookie ALONE drove the entire
 * admin API, including `files.read` over the config directory (Stripe keys, SMTP
 * password, tunnel token, TLS private key) and `settings.update`. The core runs as
 * root with the Docker socket, so that ends at host root.
 *
 * The cookie is genuinely obtainable by an attacker: it is non-Secure, host-scoped,
 * path=/, SameSite=Lax, and the dashboard's "Open" button top-level-navigates to an
 * app on another port over plain HTTP — so an installed app's backend, or anyone
 * sniffing the masjid wifi, can hold it. The dashboard KEY is what it cannot get,
 * because that lives in the dashboard origin's storage.
 *
 * Tested at the middleware boundary with a real session and a real context shape,
 * because a genuine WS upgrade can't be driven through `app.inject`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-ws-'));

const { createSession } = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
const { router, protectedProcedure } = req('../src/trpc/trpc') as typeof import('../src/trpc/trpc');

/** A router with one protected procedure, using the REAL protectedProcedure. */
const probe = router({
  secret: protectedProcedure.query(() => 'the-config-directory' as const),
});

type Ctx = {
  username: string | null;
  sessionToken: string | null;
  csrf: string | null;
  isWebSocket: boolean;
  ip?: string;
  host?: string | null;
};

async function call(ctx: Ctx): Promise<{ ok: boolean; error?: string }> {
  try {
    // createCaller runs the real middleware chain against the context we supply.
    const caller = probe.createCaller(ctx as never);
    await caller.secret();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

test('a valid session WITHOUT the dashboard key is refused over WebSocket', async () => {
  // This is the vulnerability. Before the fix this call SUCCEEDED.
  const s = createSession('admin');
  const r = await call({ username: 'admin', sessionToken: s.token, csrf: null, isWebSocket: true });
  assert.equal(r.ok, false, 'cookie-only must not reach a protected procedure over WS');
  assert.match(r.error ?? '', /sign in/i);
});

test('a valid session WITH the dashboard key is allowed over WebSocket', async () => {
  // The dashboard itself must keep working — live stats ride this transport.
  const s = createSession('admin');
  const r = await call({ username: 'admin', sessionToken: s.token, csrf: s.csrf, isWebSocket: true });
  assert.equal(r.ok, true, `the real dashboard must still connect: ${r.error ?? ''}`);
});

test('the HTTP transport still requires the key, as it always did', async () => {
  const s = createSession('admin');
  const without = await call({ username: 'admin', sessionToken: s.token, csrf: null, isWebSocket: false });
  assert.equal(without.ok, false);
  const with_ = await call({ username: 'admin', sessionToken: s.token, csrf: s.csrf, isWebSocket: false });
  assert.equal(with_.ok, true);
});

test("another session's key does not authorise this session", async () => {
  // verifyCsrf must bind the key to the token, not merely check it is non-empty.
  const a = createSession('admin');
  const b = createSession('admin');
  const r = await call({ username: 'admin', sessionToken: a.token, csrf: b.csrf, isWebSocket: true });
  assert.equal(r.ok, false, "a key from a different session must not be accepted");
});

test('a garbage or empty key is refused on both transports', async () => {
  const s = createSession('admin');
  for (const csrf of ['', '   ', 'not-the-key', 'null', 'undefined']) {
    for (const isWebSocket of [true, false]) {
      const r = await call({ username: 'admin', sessionToken: s.token, csrf, isWebSocket });
      assert.equal(r.ok, false, `csrf=${JSON.stringify(csrf)} ws=${isWebSocket}`);
    }
  }
});

test('no session at all is refused before the key is even considered', async () => {
  const r = await call({ username: null, sessionToken: null, csrf: null, isWebSocket: true });
  assert.equal(r.ok, false);
});

test('the WebSocket exemption is not reintroduced in source', () => {
  // Structural backstop: the tests above go through createCaller, which cannot
  // catch someone re-adding the exemption in a way that only manifests on a real
  // upgrade. Cheap to pin, so pin it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'trpc', 'trpc.ts'), 'utf8');
  assert.equal(
    /!ctx\.isWebSocket\s*&&/.test(src),
    false,
    'protectedProcedure must not exempt the WebSocket transport from verifyCsrf',
  );
});
