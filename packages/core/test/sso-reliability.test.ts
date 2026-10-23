// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * "Press the app from the OS for it to sign in automatically" — and the ways the
 * platform used to say no while the admin WAS signed in.
 *
 * Every OpenMasjid app reads anything other than `{authenticated:true}` from
 * `GET /api/auth/session` as "the platform is up and this person is not signed
 * in" — deliberately, because `reachable:false` is what unlocks an app's own
 * password recovery, and an attacker must not be able to unlock it by making the
 * platform refuse. So the app shows "sign in through your dashboard" AND refuses
 * the local password. When the platform said no for the wrong reason, the admin
 * was locked out of the app with no way in. These tests pin each wrong reason.
 *
 * Driven through the real routes on a real Fastify instance, because the bugs
 * were in which counter a request was charged to — something a unit test of the
 * limiter function cannot see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-sso-'));
process.env.OPENMASJID_DATA_DIR = DATA;

const req = createRequire(__filename);
const Fastify = req('fastify') as typeof import('fastify').default;
const fastifyCookie = req('@fastify/cookie') as typeof import('@fastify/cookie').default;
const fabric = req('../src/api/fabric') as typeof import('../src/api/fabric');
const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
const manager = req('../src/apps/manager') as typeof import('../src/apps/manager');
const { log } = req('../src/logger') as typeof import('../src/logger');

const APP_ID = 'demo-sso';
const SECRET = `sso-secret-${'a'.repeat(40)}`;
const BUS = '172.17.0.1'; // what EVERY app presents, behind Docker's published port

function installSsoApp(id: string, secret: string): void {
  const dir = path.join(DATA, 'apps', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id, name: id, kind: 'catalog', sso: true, ssoSecret: secret }),
  );
  manager.invalidateFabricIndex();
}

installSsoApp(APP_ID, SECRET);
const { token: SIGNED_IN } = sessions.createSession('admin', sessions.currentCredential());

async function server() {
  const app = Fastify();
  await app.register(fastifyCookie);
  fabric.registerFabric(app);
  await app.ready();
  return app;
}

type App = Awaited<ReturnType<typeof server>>;

function sso(app: App, o: { secret?: string | null; cookie?: string | null; ip?: string; url?: string; method?: 'GET' | 'POST' } = {}) {
  const headers: Record<string, string> = {};
  const secret = o.secret === undefined ? SECRET : o.secret;
  const cookie = o.cookie === undefined ? SIGNED_IN : o.cookie;
  if (secret) headers['x-openmasjid-app-secret'] = secret;
  if (cookie) headers.cookie = `omos_session=${cookie}`;
  return app.inject({ method: o.method ?? 'GET', url: o.url ?? '/api/auth/session', remoteAddress: o.ip ?? BUS, headers });
}

/** An app's own Fabric traffic — anything charged to its SEND budget. */
function send(app: App, ip = BUS) {
  return app.inject({
    method: 'POST',
    url: '/api/fabric/notify',
    remoteAddress: ip,
    headers: { 'x-openmasjid-app-secret': SECRET, 'content-type': 'application/json' },
    payload: { text: 'hello' },
  });
}

const body = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;

test('baseline: a signed-in admin opening an SSO app is signed in', async () => {
  fabric.__resetFabricRateForTests();
  const app = await server();
  const r = await sso(app);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(body(r), { authenticated: true, username: 'admin' });
  await app.close();
});

// ── the per-app send budget ────────────────────────────────────────────────

test("AN APP'S OWN SENDS CANNOT LOCK THE ADMIN OUT OF IT", async () => {
  // The sign-in check used to be charged to the same 120/min bucket as every
  // email, WhatsApp, alert and broker call the app makes. A busy minute — a
  // Friday collection's receipts, a roster's fee reminders — and the very next
  // sign-in check came back 429, which the app reads as "not signed in".
  fabric.__resetFabricRateForTests();
  const app = await server();
  let refused = 0;
  for (let i = 0; i < 125; i++) if ((await send(app)).statusCode === 429) refused++;
  assert.ok(refused > 0, 'precondition: the app really has spent its send budget');

  const r = await sso(app);
  assert.equal(r.statusCode, 200, "the app's sign-in check was refused because the app had been sending");
  assert.equal(body(r).authenticated, true);
  await app.close();
});

// ── the one bucket every app on the box shares ─────────────────────────────

test('ANOTHER APP CANNOT LOCK THE ADMIN OUT OF THIS ONE', async () => {
  // Every app reaches the core through Docker's published port and presents the
  // same peer address, so the per-IP tier is one bucket for the whole box. The
  // sign-in check was charged to it — so a different app's traffic could refuse
  // the app the admin had just pressed, with nothing to connect the two.
  fabric.__resetFabricRateForTests();
  const app = await server();
  // Exhaust the shared bucket with UNIDENTIFIED traffic from the shared address.
  let last = 0;
  for (let i = 0; i < 605; i++) last = (await sso(app, { secret: null, cookie: null })).statusCode;
  assert.equal(last, 429, 'precondition: the shared per-IP bucket is really exhausted');

  const r = await sso(app); // an IDENTIFIED app, from the same shared address
  assert.equal(r.statusCode, 200, 'an identified sign-in check was refused by a bucket every app shares');
  assert.equal(body(r).authenticated, true);
  await app.close();
});

test('an UNIDENTIFIED flood is still bounded by that shared tier', async () => {
  // What the per-IP tier is actually for. Exempting identified apps must not
  // exempt a stranger with no secret.
  fabric.__resetFabricRateForTests();
  const app = await server();
  let r = await sso(app, { secret: null });
  for (let i = 0; i < 605; i++) r = await sso(app, { secret: null });
  assert.equal(r.statusCode, 429);
  await app.close();
});

// ── the sign-in check's own budget ─────────────────────────────────────────

test('the sign-in check has its OWN ceiling, and hitting it says "try again", not "signed out"', async () => {
  fabric.__resetFabricRateForTests();
  const app = await server();
  let r = await sso(app);
  for (let i = 0; i < 1205; i++) r = await sso(app);
  assert.equal(r.statusCode, 429);
  const b = body(r);
  // Kept, so an app that reads only this field behaves exactly as before — it
  // fails closed, which Display's /api/setup depends on for its security.
  assert.equal(b.authenticated, false);
  // New and additive: this was load, not a sign-out.
  assert.equal(b.retryable, true);
  assert.ok(Number(r.headers['retry-after']) > 0, 'a Retry-After header tells the app when to ask again');

  // And spending it did not touch the app's SEND budget.
  const s = await send(app);
  assert.notEqual(s.statusCode, 429, "the sign-in budget leaked into the app's send budget");
  await app.close();
});

// ── it cannot be gamed into the generous budget ────────────────────────────

test('an odd SPELLING of the route cannot borrow the sign-in budget', async () => {
  // §15: a security comparison must not trust one spelling. The generous budget
  // is granted only when every spelling resolves exactly to the SSO path; one
  // that disagrees pays the tight send budget instead.
  fabric.__resetFabricRateForTests();
  const app = await server();
  for (let i = 0; i < 125; i++) await send(app); // spend the send budget
  const odd = await sso(app, { url: '/api/auth/sessio%6E' });
  assert.equal(odd.statusCode, 429, 'an encoded spelling was priced on the generous sign-in budget');
  const post = await sso(app, { method: 'POST' });
  assert.equal(post.statusCode, 429, 'a POST was priced on the generous sign-in budget');
  // The canonical check is unaffected.
  assert.equal((await sso(app)).statusCode, 200);
  await app.close();
});

// ── the failure that left no trace ─────────────────────────────────────────

test('A COOKIE THE PLATFORM DOES NOT RECOGNISE IS LOGGED — without the cookie or the secret', async () => {
  // Every failing exit from this route used to be silent while the succeeding one
  // logged at info, so the one outcome an admin needed to see left no trace.
  fabric.__resetFabricRateForTests();
  const app = await server();
  const lines: string[] = [];
  const orig = log.warn;
  log.warn = (msg: string) => {
    lines.push(msg);
  };
  try {
    const stale = 'z'.repeat(43);
    const r = await sso(app, { cookie: stale });
    assert.deepEqual(body(r), { authenticated: false });
    const line = lines.find((l) => /does not recognise/.test(l));
    assert.ok(line, `expected a log line for a stale cookie, got: ${JSON.stringify(lines)}`);
    assert.equal(line!.includes(stale), false, 'the cookie value must never be logged');
    assert.equal(line!.includes(SECRET), false, 'the app secret must never be logged');
    assert.match(line!, new RegExp(APP_ID), 'it should say which app asked');
  } finally {
    log.warn = orig;
  }
  await app.close();
});

// ── restore ────────────────────────────────────────────────────────────────

test('THE FABRIC KEY CACHE GOES STALE WHEN apps/ IS REPLACED UNDERNEATH IT', () => {
  // The mechanism, demonstrated. `saveMeta` invalidates the cache on every write,
  // but restore replaces apps/ with a rename that never goes through it.
  installSsoApp('restored', 'old-key-'.padEnd(48, 'x'));
  assert.ok(manager.findFabricApp('old-key-'.padEnd(48, 'x')), 'the cache knows the old key');
  // What restore's renameSync does: a new meta.json, no saveMeta.
  fs.writeFileSync(
    path.join(DATA, 'apps', 'restored', 'meta.json'),
    JSON.stringify({ id: 'restored', name: 'restored', kind: 'catalog', sso: true, ssoSecret: 'new-key-'.padEnd(48, 'y') }),
  );
  assert.equal(
    manager.findFabricApp('new-key-'.padEnd(48, 'y')),
    null,
    'precondition: without invalidation the restored key is not recognised',
  );
  manager.invalidateFabricIndex();
  assert.ok(manager.findFabricApp('new-key-'.padEnd(48, 'y')), 'invalidating fixes it');
});

test('restore invalidates the cache after moving apps/ into place, before restarting them', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'restore.ts'), 'utf8');
  const rename = src.indexOf('fs.renameSync(src, dest)');
  const invalidate = src.indexOf('invalidateFabricIndex()', rename);
  const reup = src.indexOf('await reupAllApps(', rename);
  assert.ok(rename > 0, 'the restore rename is gone');
  assert.ok(invalidate > rename, 'restore must invalidate the Fabric key cache AFTER replacing apps/');
  assert.ok(reup > invalidate, '...and BEFORE restarting the apps, or their first check uses stale keys');
});

// ── the dashboard side ─────────────────────────────────────────────────────

test('THE DASHBOARD RE-CHECKS THE SIGN-IN WHEN THE ADMIN COMES BACK TO IT', () => {
  // It used to fetch `auth.me` once, on mount. A tab left open drew the signed-in
  // shell long after the server had forgotten the session, so every Open button
  // handed the app a dead cookie; the app said "press Open from the dashboard";
  // the admin came back, saw themselves signed in, pressed Open, and looped.
  //
  // `'always'`, because `true` honours the global 30s staleTime — and coming back
  // within half a minute is exactly what someone does after that message.
  const ui = path.join(__dirname, '..', '..', 'ui', 'src');
  const root = fs.readFileSync(path.join(ui, 'Root.tsx'), 'utf8');
  const call = root.slice(root.indexOf('trpc.auth.me.useQuery('), root.indexOf('});', root.indexOf('trpc.auth.me.useQuery(')));
  assert.match(call, /refetchOnWindowFocus:\s*'always'/, "auth.me must re-check on EVERY return to the tab");
  assert.match(call, /refetchInterval:\s*\d/, 'and periodically while the admin stays on it');
});

// ── what the log says, and how often ───────────────────────────────────────

test('an app WITHOUT the sso capability is named, and not told to reinstall', async () => {
  // The review: "identified but not an SSO app" shared one message with "no key at
  // all" — which said to reinstall (wrong: the key is fine) and hid the app id (which
  // the core knows). Different problem, different fix, different line.
  fabric.__resetFabricRateForTests();
  const NOT_SSO = `notify-only-${'b'.repeat(40)}`;
  const dir = path.join(DATA, 'apps', 'notify-only');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id: 'notify-only', name: 'notify-only', kind: 'catalog', notify: true, ssoSecret: NOT_SSO }),
  );
  manager.invalidateFabricIndex();
  const app = await server();
  const lines: string[] = [];
  const orig = log.warn;
  log.warn = (msg: string) => {
    lines.push(msg);
  };
  try {
    const r = await sso(app, { secret: NOT_SSO });
    assert.deepEqual(body(r), { authenticated: false }, 'it must still fail closed');
    const line = lines.find((l) => /not set up for single sign-on/.test(l));
    assert.ok(line, `expected a "not set up for single sign-on" line, got ${JSON.stringify(lines)}`);
    assert.match(line!, /notify-only/, 'it must name the app');
    assert.doesNotMatch(line!, /reinstall/i, 'reinstalling would not fix a missing capability');
  } finally {
    log.warn = orig;
  }
  await app.close();
});

test('successful checks are logged once a minute per app, not once per check', async () => {
  // One INFO line per success was bounded only because SSO was capped at 120/min —
  // the cap that locked admins out. With its own far larger budget, an app checking
  // on every request would fill an unrotated Docker log on an SD card.
  fabric.__resetFabricRateForTests();
  const app = await server();
  const lines: string[] = [];
  const orig = log.info;
  log.info = (msg: string) => {
    lines.push(msg);
  };
  try {
    for (let i = 0; i < 25; i++) assert.equal(body(await sso(app)).authenticated, true);
  } finally {
    log.info = orig;
  }
  const ssoLines = lines.filter((l) => /SSO introspection/.test(l));
  assert.equal(ssoLines.length, 1, `expected one line for 25 checks, got ${ssoLines.length}`);
  await app.close();
});

test('restore ends every session — at the NEXT boot, never part-way through', () => {
  // With sessions persisted, the old core keeps serving for the rest of a restore,
  // and any sign-in in that window is written into the restored config/. A restore
  // always ended every session when they lived in memory; it must still.
  //
  // The first fix did it with destroyAllSessions() straight after the rename. That
  // signed the admin out mid-restore, and the dashboard then unmounted the window
  // reporting whether the restore worked. A review caught it: the marker ends them
  // at the next boot instead, and the hold keeps the admin store on the identity
  // the restore began with. Both mechanisms are driven for real in
  // session-persistence.test.ts and credential-binding.test.ts; this pins that
  // restore.ts actually uses them, in the right places.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'restore.ts'), 'utf8');
  const rename = src.indexOf('fs.renameSync(src, dest)');
  const hold = src.indexOf('holdForRestore()');
  const marker = src.indexOf('endAllSessionsAtNextBoot()', rename);
  const reup = src.indexOf('await reupAllApps(', rename);
  const fin = src.lastIndexOf('} finally {');
  const release = src.indexOf('releaseHold?.()', fin);
  assert.ok(rename > 0, 'the restore rename is gone');
  assert.ok(hold > 0 && hold < rename, 'the admin store must be held BEFORE config/ is replaced');
  assert.ok(marker > rename, 'sessions must be marked to end AFTER config/ is replaced');
  assert.ok(reup > marker, '...and before the apps come back up');
  assert.ok(fin > 0 && release > fin, 'the hold must be released in a finally, or a failed restore leaves account changes refused');
  assert.match(src, /releaseHold = holdForRestore\(\)/, "the run must release ITS OWN hold, not a shared one");
  assert.match(src, /withUpdateLock\('restore'/, 'restores must be single-flight on the server');
  assert.doesNotMatch(src, /destroyAllSessions\(/, 'signing everyone out mid-restore is the bug the marker replaced');
});

test('a volume archive that cannot be read fails that volume instead of hanging the restore', () => {
  // A signal is not enough: `docker run -i` forwards SIGTERM to the container, where
  // tar is PID 1 with no handler, and it then waits for the rest of the archive for
  // ever — every app the restore stopped stays down, and the restore lock is held.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'restore.ts'), 'utf8');
  const handler = /src\.on\('error', \(\) => \{([\s\S]*?)\n {6}\}\);/.exec(src);
  assert.ok(handler, "restoreVolumes no longer handles a read error on the archive");
  assert.match(handler![1]!, /child\.stdin\.end\(\)/, "it must end tar's input");
  assert.match(handler![1]!, /SIGKILL/, 'with a hard stop if nothing else ends it');
});
