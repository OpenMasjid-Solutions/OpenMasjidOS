// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Serving the dashboard over the Cloudflare tunnel.
 *
 * This feature deliberately breaks the first half of CLAUDE.md §15's oldest
 * sentence — "the tunnel exposes ONLY app paths" — so the tests here exist to
 * pin exactly how much of it moved and how much did not. Three things must stay
 * true whatever this setting says:
 *
 *   1. `/api/fabric/*` and `/api/auth/session` are refused over the tunnel. They
 *      carry every app's Fabric secret and every Stripe live key.
 *   2. LAN traffic on the plain-HTTP front door still goes to HTTPS. Publishing
 *      the dashboard to the internet must not quietly start serving it
 *      unencrypted on the masjid's own network.
 *   3. With the feature off, nothing changes AT ALL — including the refusal
 *      recording that makes a wrong public address diagnosable.
 *
 * Two halves, for the reason `fabric-lan-only.test.ts` has two: a behavioural
 * one that drives a front door wired like the real one, and a structural one
 * that reads `index.ts`, because a behavioural test of a hand-built copy proves
 * the logic and not the wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { createRequire } from 'node:module';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-remote-admin-'));

const req = createRequire(__filename);
const ra = req('../src/system/remote-admin') as typeof import('../src/system/remote-admin');
const settings = req('../src/settings/store') as typeof import('../src/settings/store');
const store = req('../src/auth/store') as typeof import('../src/auth/store');
const tf = req('../src/auth/twofactor') as typeof import('../src/auth/twofactor');
const totpLib = req('../src/auth/totp') as typeof import('../src/auth/totp');
const refusals = req('../src/system/tunnel-refusals') as typeof import('../src/system/tunnel-refusals');
const { registerFabricTunnelGuard, isViaTunnel } = req(
  '../src/system/via-tunnel',
) as typeof import('../src/system/via-tunnel');

const TUNNEL = { 'cf-ray': '7a1b2c3d4e5f-LHR' };
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
/** The apps' hostname — where the dashboard is served from outside too, beside the apps. */
const APPS = 'omos.example.org';
/** A tunnel request for that hostname. */
const REMOTE = { ...TUNNEL, host: APPS };

/** Enrol a second factor, so the "2FA is required" precondition can be met. */
function enrolTwoFactor(): void {
  const { secret } = tf.beginEnrolment('admin');
  tf.confirmEnrolment(totpLib.totp(secret, Date.now()));
}

function setState(o: { tunnel: boolean; remoteAdmin: boolean; twoFactor: boolean }): void {
  // An admin exists in every state below: remote administration requires one (the
  // first test checks that, before any admin is made).
  if (!store.isConfigured()) store.setCredentials('admin', '$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb');
  settings.updateCloudflare({ enabled: o.tunnel, remoteAdmin: o.remoteAdmin, domain: APPS });
  tf.disableTwoFactor();
  if (o.twoFactor) enrolTwoFactor();
}

// ── the decision ───────────────────────────────────────────────────────────

// MUST STAY THE FIRST TEST: every later one creates the admin.
test('NO ADMIN, NO REMOTE ADMINISTRATION — first-run is for someone in the building', () => {
  // With no admin, first-run setup and first-run restore are open by design. The
  // second factor lives in its own file, so "tunnel + switch + a second factor" does
  // not imply an admin exists — a box whose admin record went missing while those
  // settings survived would otherwise offer "create the admin account" to the internet.
  assert.equal(store.isConfigured(), false, 'precondition: no admin yet');
  settings.updateCloudflare({ enabled: true, remoteAdmin: true, domain: APPS });
  enrolTwoFactor();
  assert.equal(ra.remoteAdminEnabled(), false, 'the dashboard was offered to the internet with no admin');
  store.setCredentials('admin', '$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb');
  assert.equal(ra.remoteAdminEnabled(), true);
});

test('remote administration is OFF until every condition holds', () => {
  setState({ tunnel: false, remoteAdmin: false, twoFactor: false });
  assert.equal(ra.remoteAdminEnabled(), false, 'nothing set up');

  setState({ tunnel: true, remoteAdmin: false, twoFactor: true });
  assert.equal(ra.remoteAdminEnabled(), false, 'the switch is off');

  setState({ tunnel: false, remoteAdmin: true, twoFactor: true });
  assert.equal(ra.remoteAdminEnabled(), false, 'there is no tunnel to reach it through');

  setState({ tunnel: true, remoteAdmin: true, twoFactor: false });
  assert.equal(ra.remoteAdminEnabled(), false, 'NO SECOND FACTOR — this is the important one');

  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  assert.equal(ra.remoteAdminEnabled(), true);
});

test('THE DASHBOARD NEEDS NO ADDRESS OF ITS OWN — no hostname is part of the door', () => {
  // dev.16 required a second Cloudflare hostname for the dashboard; it is served beside
  // the apps now. A settings.json that still carries that address, or no apps' address
  // at all, neither opens nor shuts the door.
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  settings.updateSettings({ cloudflare: { enabled: true, remoteAdmin: true, domain: APPS, adminHost: 'admin.example.org' } as never });
  assert.equal(ra.remoteAdminEnabled(), true, 'a stale dashboard address shut the door');
  assert.equal(ra.remoteAdminBlockedReason(), null);
  settings.updateCloudflare({ domain: '' });
  assert.equal(ra.remoteAdminEnabled(), true, "no apps' address shut the door");
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
});

test('REMOVING THE SECOND FACTOR CLOSES THE DOOR, with the switch still on', () => {
  // The condition is re-read per request, not captured when the switch was
  // flipped. An admin who turns two-step sign-in off should not have to know
  // that a setting three panels away depended on it — otherwise the result is a
  // password-only admin dashboard on the public internet and nothing saying so.
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  assert.equal(ra.remoteAdminEnabled(), true);

  tf.disableTwoFactor();
  assert.equal(ra.remoteAdminEnabled(), false, 'still serving the dashboard with no second factor');
  assert.equal(settings.getSettings().cloudflare.remoteAdmin, true, 'and the switch itself is untouched');
  assert.equal(ra.remoteAdminBlockedReason(), 'no-two-factor', 'Settings must be able to say why');
});

test('an older settings.json has the feature off, not undefined-on', () => {
  // Absence must read as off, the same rule the alerts matrix's WhatsApp column
  // follows: an upgrade can never silently publish a masjid's dashboard.
  const cf = { enabled: true, domain: APPS } as never;
  settings.updateSettings({ cloudflare: cf });
  enrolTwoFactor();
  assert.equal(ra.remoteAdminEnabled(), false);
  assert.equal(ra.settingsOpenTheDoor({ enabled: true }), false);
  // The control: with the switch present the same settings open it, so the false above
  // is the missing switch's doing.
  assert.equal(ra.settingsOpenTheDoor({ enabled: true, remoteAdmin: true }), true);
});

// ── which paths the dashboard owns ─────────────────────────────────────────

test('NOTHING UNDER /api IS A DASHBOARD PATH except the dashboard\'s own routes', () => {
  // The gate must not claim these: each one owns its own tunnel rule, and the
  // secret-gated ones are refused by a guard that runs before it.
  for (const url of [
    '/api',
    '/api/health',
    '/api/ready',
    '/api/fabric/site',
    '/api/fabric/app/students/billing/lookup',
    '/api/auth/session',
    '/api/public/appearance',
    '/api/public/logo',
    // Near misses of the allow-list: a prefix is not a path.
    '/api/backups',
    '/api/filesystem',
    '/api/updates',
    '/api/branding',
    '/api/terminals',
    '/api/restore-now',
  ]) {
    assert.equal(ra.isDashboardPath(url), false, url);
  }
});

test('the dashboard\'s own API routes ARE dashboard paths — so they work remotely', () => {
  // These were refused over the tunnel outright (LAN_ONLY_FEATURES), which is why
  // remote access could see the dashboard but not update an app, open a file,
  // download a backup or use a terminal. Each route still checks for a session
  // that passed the second factor before it does anything.
  for (const url of [
    '/api/update',
    '/api/apps/update?id=display',
    '/api/files/download?path=/apps/x/data.txt&k=key',
    '/api/files/raw?path=/a.png',
    '/api/files/upload?path=/',
    '/api/terminal/root',
    '/api/terminal/app/display',
    '/api/backup',
    '/api/backup?k=key',
    '/api/restore/upload',
    '/api/restore/run',
    '/api/branding/logo',
  ]) {
    assert.equal(ra.isDashboardPath(url), true, url);
  }
  for (const url of ra.DASHBOARD_API) assert.equal(ra.isDashboardPath(url), true, url);
});

test('an ENCODED /api spelling is still not a dashboard path', () => {
  // The router dispatches on the decoded path, so `/%61pi/fabric/...` reaches the
  // Fabric handler. If this predicate called it a dashboard path, the gate would
  // be the thing deciding whether it is served — and the gate says yes when the
  // feature is on. Same class as the `/api/%66abric/...` walk-past in v0.46.0.
  for (const url of ['/%61pi/fabric/site', '/api/%66abric/site', '/./api/health', '/apps/../api/health']) {
    assert.equal(ra.isDashboardPath(url), false, url);
  }
});

test('the dashboard owns its own routes and nothing else', () => {
  for (const url of [
    '/',
    '/index.html',
    '/favicon.svg',
    '/assets/index-abc123.js',
    '/trpc/auth.me',
    '/store',
    '/store/custom',
    '/apps/prayer-times-display',
    '/files',
    '/settings',
    '/settings/account',
    '/design-system',
  ]) {
    assert.equal(ra.isDashboardPath(url), true, url);
  }
  // And an address where an app should be, or that is simply wrong, is NOT —
  // so it keeps 404ing with a refusal recorded rather than silently showing the
  // admin sign-in page to a donor who mistyped the donations path.
  for (const url of ['/donations', '/display/x', '/wp-admin', '/.env', '/kiosk']) {
    assert.equal(ra.isDashboardPath(url), false, url);
  }
});

test('every route in the UI is covered by the allow-list', () => {
  // Otherwise that page 404s remotely with nothing to say why. Read from
  // Root.tsx so adding a route without thinking about this fails here.
  const root = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'src', 'Root.tsx'), 'utf8');
  const paths = [...root.matchAll(/path="([^"]+)"/g)].map((m) => m[1]!).filter((p) => p !== '*');
  assert.ok(paths.length >= 6, `expected to parse the route table, got ${JSON.stringify(paths)}`);
  for (const p of paths) {
    // Substitute a real-looking value for a param so the path is concrete.
    const concrete = p.replace(/:[A-Za-z]+/g, 'example');
    assert.equal(
      ra.isDashboardPath(concrete),
      true,
      `the UI route "${p}" is not in DASHBOARD_SEGMENTS, so it would 404 over the tunnel`,
    );
  }
});

// ── the front door, wired as index.ts wires it ─────────────────────────────

/**
 * The dashboard listener, as far as these tests need one: some routes, and an SPA
 * fallback for everything else, the way registerStaticUI serves index.html.
 */
async function dashboardListener() {
  const dash = Fastify();
  dash.get('/trpc/auth.me', async () => ({ dashboard: true }));
  dash.get('/', async () => 'index.html');
  dash.get('/assets/index.js', async () => 'bundle');
  dash.get('/api/backup', async () => ({ backup: true }));
  dash.setNotFoundHandler((_r, reply) => reply.type('text/html').send('<!doctype html><title>OpenMasjidOS</title>'));
  await dash.ready();
  return dash;
}

/**
 * A front door mirroring `startHttpFront`: the Fabric guard, then the gate, then
 * the front door's own not-found handler — and NO dashboard routes of its own. A
 * visit the gate serves is handed, as its own request event, to a SEPARATE
 * dashboard listener, exactly as index.ts hands it to the HTTPS listener.
 *
 * THE GATE IS THE REAL ONE. Its decision is `frontDoorDecision`, the same pure
 * function index.ts calls; only the mapping to a reply is repeated here. The first
 * version of this mirror re-implemented the decision by hand, and a review found it
 * had already drifted — it had no upgrade branch at all, so no test ever sent a
 * plain-http tunnel visit through a gate.
 */
const TEST_HOST = APPS;
async function frontDoor() {
  const dash = await dashboardListener();
  const app = Fastify();
  registerFabricTunnelGuard(app);
  app.get('/api/health', async (r, reply) =>
    isViaTunnel(r) ? refusals.refuseOverTunnel(r, reply, 'lan-only-route') : { status: 'ok', version: '9.9.9' },
  );
  app.get('/api/fabric/site', async () => ({ ok: true }));

  app.addHook('onRequest', (r, reply, done) => {
    const d = ra.frontDoorDecision(r.url, r.headers, {
      viaTunnel: isViaTunnel(r),
      remoteAdminEnabled: ra.remoteAdminEnabled(),
      appsHost: ra.appHostname(),
    });
    switch (d.kind) {
      case 'pass':
        return done();
      case 'serve':
        reply.hijack();
        dash.server.emit('request', r.raw, reply.raw);
        return;
      case 'lan-https':
        return reply.code(308).redirect(`https://example${r.url}`);
      case 'upgrade':
        return reply.code(308).redirect(d.to);
      case 'refuse':
        return refusals.refuseOverTunnel(r, reply, d.reason);
    }
  });
  app.setNotFoundHandler((r, reply) => {
    if (isViaTunnel(r)) return refusals.refuseOverTunnel(r, reply, refusals.notFoundReason(r.url, null));
    return reply.code(308).redirect(`https://example${r.url}`);
  });
  app.addHook('onClose', async () => {
    await dash.close();
  });
  await app.ready();
  return app;
}

test('WITH THE FEATURE OFF, tunnel traffic is refused exactly as before', async () => {
  setState({ tunnel: true, remoteAdmin: false, twoFactor: true });
  const app = await frontDoor();
  for (const url of ['/', '/settings', '/trpc/auth.me', '/assets/index.js']) {
    const res = await app.inject({ method: 'GET', url, headers: TUNNEL });
    assert.equal(res.statusCode, 404, url);
  }
  await app.close();
});

test('with the feature off, a refusal is still RECORDED', async () => {
  // "Recently turned away" is the diagnostic an admin reads when a page 404s.
  // A gate that refused silently would take it away for dashboard paths.
  setState({ tunnel: true, remoteAdmin: false, twoFactor: true });
  const app = await frontDoor();
  await app.inject({ method: 'GET', url: '/settings', headers: TUNNEL });
  const found = refusals.recentRefusals().some((r) => r.path === '/settings');
  assert.ok(found, 'the refusal was not recorded');
  await app.close();
});

test('with the feature ON, the dashboard is served over the tunnel — by the dashboard listener', async () => {
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  const app = await frontDoor();
  const me = await app.inject({ method: 'GET', url: '/trpc/auth.me', headers: REMOTE });
  assert.equal(me.statusCode, 200);
  assert.match(me.body, /dashboard/, 'the request did not reach the dashboard listener');
  const page = await app.inject({ method: 'GET', url: '/settings/account', headers: REMOTE });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /OpenMasjidOS/);
  await app.close();
});

test("THE DASHBOARD IS SERVED ON THE APPS' HOSTNAME — and on any other the tunnel delivers", async () => {
  // dev.16 served it only on a second hostname of its own; the masjid found that one
  // address too many. What keeps an app page sharing this origin from acting as the
  // admin is where the dashboard key lives (system/remote-admin.ts), not the hostname.
  // Cloudflare delivers only the hostnames the masjid routed to the tunnel, so the Host
  // is not asked at all.
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  refusals.__clearRefusalsForTests();
  const app = await frontDoor();
  try {
    for (const host of [APPS, 'OMOS.example.org.', 'admin.example.org']) {
      for (const [url, body] of [
        ['/', /index\.html/],
        ['/trpc/auth.me', /dashboard/],
        ['/settings', /OpenMasjidOS</],
        ['/assets/index.js', /bundle/],
        ['/api/backup', /backup/],
        ['/%74rpc/auth.me', /dashboard/],
      ] as const) {
        const res = await app.inject({ method: 'GET', url, headers: { ...TUNNEL, host } });
        assert.equal(res.statusCode, 200, `${host}${url}`);
        assert.match(res.body, body, `${host}${url} did not reach the dashboard listener`);
      }
    }
    assert.deepEqual(refusals.recentRefusals(), [], 'a dashboard visit was refused');
  } finally {
    await app.close();
  }
});

test('WITH THE FEATURE ON, the dashboard\'s own API is handed over too — and only with it on', async () => {
  // A backup download, as one representative of DASHBOARD_API. Off: refused like
  // the rest of the dashboard. On: reaches the dashboard listener, where the route
  // itself checks for a session that passed the second factor.
  setState({ tunnel: true, remoteAdmin: false, twoFactor: true });
  const off = await frontDoor();
  assert.equal((await off.inject({ method: 'GET', url: '/api/backup', headers: TUNNEL })).statusCode, 404);
  await off.close();
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  const on = await frontDoor();
  const res = await on.inject({ method: 'GET', url: '/api/backup', headers: REMOTE });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /backup/);
  await on.close();
});

test('THE FABRIC STAYS REFUSED even with the feature on', async () => {
  // The half of §15 that does not move. These carry every app's 256-bit secret
  // and every configured Stripe live key.
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  const app = await frontDoor();
  for (const headers of [TUNNEL, REMOTE]) {
    assert.equal((await app.inject({ method: 'GET', url: '/api/fabric/site', headers })).statusCode, 404);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/%66abric/site', headers })).statusCode,
      404,
      'the encoded spelling too',
    );
  }
  await app.close();
});

test('the version stays withheld even with the feature on', async () => {
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  const app = await frontDoor();
  const res = await app.inject({ method: 'GET', url: '/api/health', headers: REMOTE });
  assert.equal(res.statusCode, 404);
  assert.doesNotMatch(res.body, /9\.9\.9/);
  await app.close();
});

test('a wrong public address still 404s with the feature on', async () => {
  // Not "everything that is not an app is now the dashboard". A donor who
  // mistypes the donations path gets "no page here", not an admin sign-in box.
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  const app = await frontDoor();
  for (const headers of [TUNNEL, REMOTE]) {
    const res = await app.inject({ method: 'GET', url: '/donatoins', headers });
    assert.equal(res.statusCode, 404);
  }
  await app.close();
});

test('LAN TRAFFIC ON THE HTTP FRONT DOOR IS UNCHANGED, feature on or off', async () => {
  // Publishing the dashboard to the internet must not start serving it
  // unencrypted on the masjid's own network.
  for (const remoteAdmin of [false, true]) {
    setState({ tunnel: true, remoteAdmin, twoFactor: true });
    const app = await frontDoor();
    // '/' and '/assets/index.js' are registered on the dashboard listener behind
    // this one — the spellings that once skipped the gate and were served over plain
    // HTTP on the LAN. They must be redirected, never handed over.
    for (const url of ['/', '/settings', '/assets/index.js', '/api/backup']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(
        res.statusCode,
        308,
        `${url} (remoteAdmin=${remoteAdmin}) — the dashboard must never be served over plain HTTP on the LAN`,
      );
      assert.match(String(res.headers.location), /^https:\/\//);
    }
    await app.close();
  }
});

// ── the real wiring ────────────────────────────────────────────────────────

test('index.ts registers the Fabric guard BEFORE the remote-admin gate', () => {
  // Order is the security property: the Fabric guard must get first refusal on
  // the routes it owns, whatever the gate would say about them.
  // The gate is the onRequest hook's call, `frontDoorDecision(req.url, req.headers` —
  // the only call to it in index.ts. The WebSocket claim reaches the same function
  // through `claimsDashboardSocket`, inside system/remote-admin.ts.
  const guard = INDEX.indexOf('registerFabricTunnelGuard(front)');
  const gate = INDEX.indexOf('frontDoorDecision(req.url, req.headers');
  assert.ok(guard > 0, 'the front-door Fabric guard is gone');
  assert.ok(gate > 0, 'the remote-admin gate is gone');
  assert.ok(guard < gate, 'the Fabric guard must be registered before the gate');
});

/** The body of `startHttpFront` in index.ts. */
function frontDoorSource(): string {
  const fn = INDEX.slice(INDEX.indexOf('async function startHttpFront'));
  const end = fn.indexOf('\n  }\n');
  const body = end > 0 ? fn.slice(0, end) : fn;
  assert.ok(body.includes('const front = Fastify('), 'could not find the front door');
  return body;
}

test('THE FRONT DOOR SERVES NO DASHBOARD OF ITS OWN — it hands a permitted visit over', () => {
  // A second copy of the dashboard on this listener was only part of one: everything
  // under /api stayed behind, which is why remote access could look at the dashboard
  // but not update an app or open a file. And every route registered HERE is a route
  // that skips the not-found handler — the class of bug that once served the
  // dashboard over plain HTTP on the LAN.
  const body = frontDoorSource();
  assert.doesNotMatch(body, /front\.register\(\s*fastifyTRPCPlugin/, 'tRPC is registered on the front door again');
  assert.doesNotMatch(body, /registerStaticFiles\(\s*front/, 'the UI is served by the front door again');
  assert.doesNotMatch(body, /registerStaticUI\(\s*front/, 'the UI is served by the front door again');
  assert.match(
    body,
    /case 'serve':[\s\S]*?reply\.hijack\(\);[\s\S]*?server\.server\.emit\('request', req\.raw, reply\.raw\)/,
    'a served visit must be handed to the dashboard listener, unread',
  );
  // Its own answers — refusals and redirects — still carry the security headers.
  assert.match(body, /reply\.header\('X-Frame-Options', 'SAMEORIGIN'\)/);
});

test('the front door only claims the dashboard WebSocket, and only when the gate would pass it', () => {
  // `attachIngress` destroys every non-app upgrade on purpose — an abandoned
  // socket is an unauthenticated file-descriptor leak on a root daemon. The one
  // exception must stay narrow, and it must ask the SAME question the HTTP gate
  // asks: the first version checked "tunnel + feature on + /trpc" by hand, so an
  // upgrade the gate would have redirected or refused was claimed anyway.
  const call = INDEX.slice(INDEX.indexOf('attachIngress(front'), INDEX.indexOf('registerFabricTunnelGuard(front)'));
  assert.ok(call.length > 0, 'attachIngress(front, …) is gone or has moved after the Fabric guard');
  assert.match(call, /claimUpgrade/, 'the dashboard socket claim is gone');
  assert.match(call, /claimsDashboardSocket\(/, 'it must ask the shared rule, not re-derive it');
  assert.match(call, /remoteAdminEnabled:\s*remoteAdminEnabled\(\)/, 'it must respect the setting');
  assert.match(call, /appsHost:\s*appHostname\(\)/, "the same gate, with the apps' hostname it upgrades to");
  assert.match(call, /if \(!ok\) return false;/, 'a declined upgrade must be handed back (and so destroyed)');
  assert.match(
    call,
    /if \(!trackHandedOverSocket\(req, socket\)\) return false;[\s\S]*?markHandedOver\(req\);[\s\S]*?server\.server\.emit\('upgrade', req, socket, head\)/,
    'a claimed socket must be tracked (so it is closed when the door shuts; refused when the table is full), marked and then handed over',
  );
  // And the dashboard opens its socket only while something is subscribed, so the
  // sign-in screen holds none — the front door now hands one over only to a session.
  const client = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'src', 'lib', 'trpcClient.ts'), 'utf8');
  assert.match(client, /createWSClient\(\{[^}]*lazy: \{ enabled: true/, 'the dashboard socket must be lazy');
});

test('claimsDashboardSocket: the dashboard socket, over the tunnel, when the gate would pass it — nothing else', () => {
  // A signed-in remote session: the only kind a socket is handed over to.
  const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  const remote = sessions.createSession('admin', sessions.currentCredential(), { remote: true, tf: tf.secondFactorEpoch(), handedOver: true });
  const lan = sessions.createSession('admin', sessions.currentCredential());
  const signedIn = { cookie: `${sessions.REMOTE_COOKIE_NAME}=${remote.token}` };
  const https = { 'cf-ray': 'a', 'cf-visitor': '{"scheme":"https"}', host: HOST, ...signedIn };
  const on = { remoteAdminEnabled: true, appsHost: HOST };
  assert.equal(ra.claimsDashboardSocket('/trpc', https, on), true);
  // …and nobody else: a stranger, a LAN session (in either cookie), a session that ended.
  const { cookie: _c, ...stranger } = https;
  assert.equal(ra.claimsDashboardSocket('/trpc', stranger, on), false, 'a stranger holds no dashboard socket');
  assert.equal(ra.claimsDashboardSocket('/trpc', { ...stranger, cookie: `${sessions.COOKIE_NAME}=${lan.token}` }, on), false);
  assert.equal(ra.claimsDashboardSocket('/trpc', { ...stranger, cookie: `${sessions.REMOTE_COOKIE_NAME}=${lan.token}` }, on), false);
  const ended = sessions.createSession('admin', sessions.currentCredential(), { remote: true, tf: tf.secondFactorEpoch(), handedOver: true });
  sessions.destroySession(ended.token);
  assert.equal(ra.claimsDashboardSocket('/trpc', { ...stranger, cookie: `${sessions.REMOTE_COOKIE_NAME}=${ended.token}` }, on), false);
  assert.equal(ra.claimsDashboardSocket('/trpc?connectionParams=1', https, on), true);

  assert.equal(ra.claimsDashboardSocket('/trpc', {}, on), false, 'LAN sockets use the TLS listener, never this one');
  assert.equal(ra.claimsDashboardSocket('/trpc', https, { ...on, remoteAdminEnabled: false }), false, 'feature off');
  assert.equal(ra.claimsDashboardSocket('/trpc', http(), on), false, 'plain http:// is redirected by the gate, so not claimed');
  assert.equal(
    ra.claimsDashboardSocket('/trpc', { ...https, host: 'admin.example.org' }, on),
    true,
    'the gate serves the dashboard on any hostname the tunnel delivers, so the claim does too',
  );
  assert.equal(
    ra.claimsDashboardSocket('/trpc', { ...https, 'cf-visitor': '' }, on),
    true,
    'unknown scheme is served by the gate, so claimed — the same answer, not a stricter one',
  );
  for (const url of ['/trpcx', '/settings', '/', '/api/fabric/site', '/donations/trpc']) {
    assert.equal(ra.claimsDashboardSocket(url, https, on), false, url);
  }
  // EVERY spelling must be a dashboard socket — this is an allow. With `some`, a
  // dot-segment spelling of nothing (`/x/../trpc`) was claimed and answered while a
  // private app's path was destroyed, and the difference named the installed apps.
  for (const url of ['/%74rpc', '/x/../trpc', '/students/../trpc', '/x/%2e%2e/api/update', '/api/../trpc']) {
    assert.equal(ra.claimsDashboardSocket(url, https, on), false, url);
  }
  // The progress and terminal streams are dashboard sockets too — remotely, an
  // update or a terminal is nothing without them.
  for (const url of ['/api/update', '/api/apps/update?id=display', '/api/restore/run', '/api/terminal/root', '/api/terminal/app/display']) {
    assert.equal(ra.claimsDashboardSocket(url, https, on), true, url);
    assert.equal(ra.claimsDashboardSocket(url, https, { ...on, remoteAdminEnabled: false }), false, `${url} with the feature off`);
  }
  // Dashboard paths that are not sockets are not claimed as sockets — including ones
  // that merely START with a socket's path: `/api/restore/running` is a dashboard path
  // (it is under /api/restore) but it is not the restore socket.
  for (const url of ['/api/backup', '/api/files/download', '/api/branding/logo', '/api/updates', '/api/restore/upload', '/api/restore/running']) {
    assert.equal(ra.claimsDashboardSocket(url, https, on), false, url);
  }
});

test('@fastify/websocket is NOT registered on the front door', () => {
  // It attaches its own `upgrade` listener and routes every upgrade through
  // Fastify, so each app's socket was handled twice — piped to the app by the
  // ingress AND proxied as plain HTTP by its onRequest hook — and every app's
  // live socket over the tunnel died. The ingress is the one upgrade owner here.
  assert.doesNotMatch(frontDoorSource(), /front\.register\(\s*fastifyWebsocket/, '@fastify/websocket is back on the front door');
});

// ── the session cookie's Secure flag, asked of the real createContext ───────
//
// This used to be a test that the source contained `secure: COOKIE_OPTS.secure ||
// isViaTunnel(` — which pinned a BUG. `isViaTunnel` is true whenever Cloudflare's
// cf-ray is present, including on a plain http:// visit, and a browser REJECTS a
// Secure cookie delivered over plain HTTP: remote sign-in finished its second
// factor and bounced straight back to the sign-in screen. A test that checks the
// text of an expression cannot tell a right expression from a wrong one, so these
// ask the real context what cookie it would set for each kind of visitor.

const { createContext } = req('../src/trpc/context') as typeof import('../src/trpc/context');

function cookieSecureFor(headers: Record<string, string>): boolean | undefined {
  let captured: { secure?: boolean } | undefined;
  const ctx = createContext({
    req: { headers, cookies: {}, url: '/trpc/auth.login', ip: '172.17.0.1', query: {} },
    res: {
      setCookie: (_n: string, _v: string, opts: { secure?: boolean }) => {
        captured = opts;
      },
      clearCookie: () => {},
    },
  } as never);
  ctx.setSessionCookie?.('t'.repeat(43));
  return captured?.secure;
}

test('a cookie issued to an HTTPS tunnel visitor is Secure', () => {
  assert.equal(cookieSecureFor({ 'cf-ray': 'abc-LHR', 'x-forwarded-proto': 'https' }), true);
  assert.equal(cookieSecureFor({ 'cf-ray': 'abc-LHR', 'cf-visitor': '{"scheme":"https"}' }), true);
});

test('A COOKIE ISSUED TO A PLAIN-HTTP TUNNEL VISITOR IS NOT SECURE — the browser would throw it away', () => {
  assert.equal(cookieSecureFor({ 'cf-ray': 'abc-LHR', 'x-forwarded-proto': 'http' }), false);
  assert.equal(cookieSecureFor({ 'cf-ray': 'abc-LHR', 'cf-visitor': '{"scheme":"http"}' }), false);
});

test('an unknown scheme is not treated as HTTPS', () => {
  // cf-ray with nothing saying which scheme: unknown is not https.
  assert.equal(cookieSecureFor({ 'cf-ray': 'abc-LHR' }), false);
  assert.equal(cookieSecureFor({ 'cf-ray': 'abc-LHR', 'cf-visitor': 'not json' }), false);
});

test("a masjid's own LAN reverse proxy does NOT get a Secure cookie", () => {
  // `isViaTunnel` is ALSO true for a bare x-forwarded-proto: https. A Secure cookie
  // there lands on the LAN hostname, overwrites the non-Secure one in the same jar,
  // and silently ends SSO for every plain-HTTP app on the box. That is the
  // operator's call, via OPENMASJID_SECURE_COOKIE — never an automatic one.
  assert.equal(cookieSecureFor({ 'x-forwarded-proto': 'https' }), false);
  assert.equal(cookieSecureFor({}), false, 'and a plain LAN session stays non-Secure, so HTTP apps keep SSO');
});

// ── a plain-http:// tunnel visit is upgraded, not served ───────────────────

test('visitorScheme prefers cf-visitor, reads the first hop, and only says what it knows', () => {
  const { visitorScheme } = req('../src/system/via-tunnel') as typeof import('../src/system/via-tunnel');
  assert.equal(visitorScheme({ 'x-forwarded-proto': 'https' }), 'https');
  assert.equal(visitorScheme({ 'x-forwarded-proto': 'HTTP' }), 'http');
  assert.equal(visitorScheme({ 'x-forwarded-proto': 'http, https' }), 'http', 'the FIRST hop is the visitor');
  assert.equal(visitorScheme({ 'x-forwarded-proto': ['https', 'http'] }), 'https');
  assert.equal(visitorScheme({ 'cf-visitor': '{"scheme":"http"}' }), 'http');
  assert.equal(
    visitorScheme({ 'cf-visitor': '{"scheme":"https"}', 'x-forwarded-proto': 'http' }),
    'https',
    "Cloudflare's own cf-visitor wins over a rewritable x-forwarded-proto",
  );
  assert.equal(visitorScheme({ 'cf-visitor': '{broken', 'x-forwarded-proto': 'https' }), 'https', 'a malformed cf-visitor falls back');
  assert.equal(visitorScheme({ 'cf-visitor': '{"scheme":"gopher"}' }), null);
  assert.equal(visitorScheme({ 'cf-visitor': '{broken' }), null);
  assert.equal(visitorScheme({}), null);
});

const HOST = APPS;
const http = (extra: Record<string, string> = {}) => ({ 'cf-ray': 'a-LHR', 'x-forwarded-proto': 'http', host: HOST, ...extra });

const ON = { viaTunnel: true, remoteAdminEnabled: true, appsHost: HOST };
const decide = (url: string, headers: Record<string, string>, ctx = ON) => ra.frontDoorDecision(url, headers, ctx);

test('A PLAIN-HTTP TUNNEL VISIT TO THE DASHBOARD IS UPGRADED TO HTTPS', () => {
  // Serving it put the admin password and the second-factor code on the internet in
  // clear between the browser and Cloudflare's edge.
  assert.deepEqual(decide('/settings/account', http()), { kind: 'upgrade', to: `https://${HOST}/settings/account` });
  assert.deepEqual(decide('/?next=%2Fsettings', http()), { kind: 'upgrade', to: `https://${HOST}/?next=%2Fsettings` });
  assert.deepEqual(decide('/', http({ 'cf-visitor': '{"scheme":"http"}' })), { kind: 'upgrade', to: `https://${HOST}/` });
});

test("THE UPGRADE ALWAYS GOES TO THE CONFIGURED APPS' HOSTNAME — never where the request says", () => {
  // The target never comes from the request, so this can never be an open redirect:
  // whatever Host was asked for, in whatever spelling, the configured one is the target.
  for (const host of [HOST, HOST.toUpperCase(), `${HOST}.`, `${HOST}:80`, 'evil.example.com', `${HOST}.evil.example.com`, '']) {
    assert.deepEqual(decide('/', http({ host })), { kind: 'upgrade', to: `https://${HOST}/` }, `Host: ${host}`);
  }
  // The configured value is normalised before it becomes a URL.
  assert.deepEqual(decide('/', http(), { ...ON, appsHost: 'OMOS.Example.org.' }), { kind: 'upgrade', to: `https://${HOST}/` });
  // A request target that is not a path is not something to build a URL from.
  assert.deepEqual(decide('//evil.example.com/x', http()), { kind: 'pass' }, 'not a dashboard path at all');
  assert.deepEqual(decide('//settings', http()), { kind: 'refuse', reason: 'plain-http-no-host' });
});

test("WITH NO APPS' HOSTNAME CONFIGURED, A PLAIN-HTTP VISIT IS REFUSED, NEVER SERVED IN CLEAR", () => {
  for (const blank of ['', '   ']) {
    assert.deepEqual(decide('/', http(), { ...ON, appsHost: blank }), { kind: 'refuse', reason: 'plain-http-no-host' });
    // An https visit needs no address to be sent to: it is served where it arrived.
    assert.deepEqual(decide('/settings', { 'cf-ray': 'a', 'cf-visitor': '{"scheme":"https"}', host: '' }, { ...ON, appsHost: blank }), {
      kind: 'serve',
    });
  }
});

test('the upgrade never loops', () => {
  // Only an EXPLICIT http signal redirects. HTTPS is served, and so is unknown — a
  // proxy that strips the scheme header can never trap the dashboard in a loop.
  assert.deepEqual(decide('/', { 'cf-ray': 'a', 'x-forwarded-proto': 'https', host: HOST }), { kind: 'serve' });
  assert.deepEqual(decide('/', { 'cf-ray': 'a', host: HOST }), { kind: 'serve' });
});

test('A PROXY THAT REWRITES x-forwarded-proto CANNOT CAUSE A REDIRECT LOOP', () => {
  // The review: nginx's `proxy_set_header X-Forwarded-Proto $scheme` behind the tunnel
  // turns Cloudflare's https into http. Trusting it first made every HTTPS visit
  // "plain HTTP", redirected to the URL it was already on, for ever. cf-visitor is
  // Cloudflare's own statement and nothing in between touches it — so it wins.
  const rewritten = { 'cf-ray': 'a', 'x-forwarded-proto': 'http', 'cf-visitor': '{"scheme":"https"}', host: HOST };
  assert.deepEqual(decide('/', rewritten), { kind: 'serve' }, 'an HTTPS visit behind a rewriting proxy was redirected');
  assert.equal(cookieSecureFor(rewritten), true, 'and it must still get a Secure cookie');
});

test('the rest of the gate: LAN, feature off, and non-dashboard paths', () => {
  assert.deepEqual(decide('/', {}, { ...ON, viaTunnel: false }), { kind: 'lan-https' });
  assert.deepEqual(decide('/', http(), { ...ON, remoteAdminEnabled: false }), { kind: 'refuse', reason: 'lan-only-route' });
  assert.deepEqual(decide('/api/fabric/site', http()), { kind: 'pass' }, 'the Fabric guard, not this gate, owns /api');
  assert.deepEqual(decide('/donations', http()), { kind: 'pass' }, 'an app path is the ingress\'s business');
});

test('THROUGH THE FRONT DOOR: a plain-http visit is 308ed to https, and refused with the feature off', async () => {
  for (const [remoteAdmin, url] of [[true, '/'], [true, '/settings']] as const) {
    setState({ tunnel: true, remoteAdmin, twoFactor: true });
    const app = await frontDoor();
    const r = await app.inject({ method: 'GET', url, headers: http({ host: TEST_HOST }) });
    assert.equal(r.statusCode, 308, url);
    assert.equal(r.headers.location, `https://${TEST_HOST}${url}`);
    await app.close();
  }
  setState({ tunnel: true, remoteAdmin: false, twoFactor: true });
  const app = await frontDoor();
  const r = await app.inject({ method: 'GET', url: '/', headers: http({ host: TEST_HOST }) });
  assert.equal(r.statusCode, 404, 'with the feature off a plain-http visit must be refused, not upgraded');
  await app.close();
});

test('the real gate in index.ts IS frontDoorDecision, and handles all five outcomes', () => {
  // Structural, but only for the wiring — the decision itself is tested above by
  // calling the very function index.ts calls.
  const from = INDEX.indexOf('const d = frontDoorDecision(req.url, req.headers');
  assert.ok(from > 0, 'the front door no longer calls frontDoorDecision');
  const gate = INDEX.slice(from, INDEX.indexOf('front.setNotFoundHandler', from));
  assert.ok(gate.length > 0, 'the gate must come before the not-found handler');
  assert.match(gate, /appsHost:\s*appHostname\(\)/, "the gate must know the CONFIGURED apps' hostname, to upgrade plain http:// to");
  assert.match(gate, /markHandedOver\(req\.raw\);[\s\S]*?reply\.hijack\(\);/, 'a served request must be marked before it is handed over');
  assert.match(
    gate,
    /hasRemoteSession\(req\.headers\) \? null : anonymousBodyRefusal\(req\.headers\)/,
    'a stranger\'s oversized body must be refused before it is handed over',
  );
  for (const kind of ['pass', 'serve', 'lan-https', 'upgrade', 'refuse']) {
    assert.match(gate, new RegExp(`case '${kind}'`), `the gate does not handle '${kind}'`);
  }
  assert.match(gate, /case 'upgrade':\s*(\/\/[^\n]*\n\s*)*return reply\.code\(308\)\.redirect\(d\.to\)/, 'an upgrade must 308 to d.to');
  assert.match(gate, /refuseOverTunnel\(req, reply, d\.reason\)/, "a refusal must be recorded under the decision's reason");
  assert.doesNotMatch(INDEX, /httpsUpgradeTarget/, 'the old helper must not linger');
});

// ── an ENCODED spelling of a dashboard path is still gated ─────────────────
//
// The round-two review's worst finding. The gate asked `isDashboardPath`, which
// requires EVERY spelling to be a dashboard path — the right rule for deciding to
// SERVE, and exactly the wrong one for deciding whether to LOOK. `/%74rpc/auth.me`
// has a raw first segment of `%74rpc`, so the gate said "not mine" and passed it,
// and the router, which matches the decoded path, handed it to tRPC: the whole
// dashboard API, over the tunnel, with remote administration switched OFF.

const ENCODED = [
  '/%74rpc/auth.me',
  '/tr%70c/auth.me',
  '/%74rpc%2Fauth.me',
  '/as%73ets/index.js',
  '/api/../trpc/auth.me',
  '/x/../settings',
];

test('touchesDashboardPath: ANY spelling that reaches the dashboard counts', () => {
  for (const url of ENCODED) assert.equal(ra.touchesDashboardPath(url), true, url);
  // And it does not grow to cover what is not the dashboard — the public routes
  // and app paths must keep passing straight through to their own handling.
  for (const url of [
    '/api/health',
    '/api/fabric/site',
    '/api/public/logo',
    '/favicon.ico',
    '/apple-touch-icon.png',
    '/donations',
    '/%64onations',
  ]) {
    assert.equal(ra.touchesDashboardPath(url), false, url);
  }
});

test('the gate refuses an encoded dashboard path over the tunnel with the feature OFF', () => {
  const https = { 'cf-ray': 'a', 'cf-visitor': '{"scheme":"https"}', host: HOST };
  for (const url of ENCODED) {
    assert.deepEqual(
      decide(url, https, { ...ON, remoteAdminEnabled: false }),
      { kind: 'refuse', reason: 'lan-only-route' },
      url,
    );
  }
});

test('the gate redirects an encoded dashboard path on the LAN, and upgrades it on plain http', () => {
  for (const url of ENCODED) {
    assert.deepEqual(decide(url, {}, { ...ON, viaTunnel: false }), { kind: 'lan-https' }, url);
    assert.equal(decide(url, http()).kind, 'upgrade', url);
  }
});

test('THROUGH THE FRONT DOOR: /%74rpc/auth.me is NOT answered over the tunnel with the feature off', async () => {
  // First, the precondition that makes the refusal mean anything: with the feature
  // ON the router really does deliver the encoded spelling to the dashboard route.
  // Without this, a 404 below could be Fastify not matching rather than the gate.
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  const on = await frontDoor();
  const served = await on.inject({ method: 'GET', url: '/%74rpc/auth.me', headers: REMOTE });
  assert.equal(served.statusCode, 200, 'the router must deliver the encoded spelling, or this test proves nothing');
  assert.match(served.body, /dashboard/);
  await on.close();

  setState({ tunnel: true, remoteAdmin: false, twoFactor: true });
  refusals.__clearRefusalsForTests();
  const off = await frontDoor();
  for (const url of ['/%74rpc/auth.me', '/tr%70c/auth.me', '/as%73ets/index.js']) {
    const res = await off.inject({ method: 'GET', url, headers: TUNNEL });
    assert.equal(res.statusCode, 404, `${url} was answered with the feature off`);
    assert.doesNotMatch(res.body, /dashboard|bundle/, url);
    assert.ok(
      refusals.recentRefusals().some((r) => r.path === url && r.reason === 'lan-only-route'),
      `${url}: the refusal was not recorded`,
    );
  }
  await off.close();
});

test('THROUGH THE FRONT DOOR: an encoded dashboard path on the LAN is still 308ed to HTTPS', async () => {
  for (const remoteAdmin of [false, true]) {
    setState({ tunnel: true, remoteAdmin, twoFactor: true });
    const app = await frontDoor();
    for (const url of ['/%74rpc/auth.me', '/as%73ets/index.js']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 308, `${url} (remoteAdmin=${remoteAdmin})`);
    }
    await app.close();
  }
});

// ── a request target that is not a path ────────────────────────────────────
//
// HTTP also allows `GET http://host/path` (absolute form) and `GET *` (asterisk
// form). The router accepts them — find-my-way rewrites an absolute target to its
// path — but every guard here reads req.url as a path, so `http://host/trpc/x` has
// the first segment `http:` and each one said "not mine". Not reachable through the
// tunnel (Cloudflare and cloudflared always send a path), so this closes a spelling
// rather than a door; it is closed because every guard assumes one.

const { registerOriginFormGuard } = req('../src/system/via-tunnel') as typeof import('../src/system/via-tunnel');

/** Send one raw request line and return the status code. inject() cannot do this:
 *  it builds the request from a URL, so it only ever sends a path. */
function rawStatus(port: number, target: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n${extra}Connection: close\r\n\r\n`);
    });
    let got = '';
    // A response that never ends must fail the test, not hang the suite.
    sock.setTimeout(5000, () => {
      sock.destroy();
      resolve(-1);
    });
    sock.on('data', (b) => (got += b.toString('latin1')));
    sock.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(got)?.[1] ?? 0)));
    sock.on('error', reject);
  });
}

async function listening(withGuard: boolean) {
  const app = Fastify();
  if (withGuard) registerOriginFormGuard(app);
  registerFabricTunnelGuard(app);
  app.get('/trpc/auth.me', async () => ({ dashboard: true }));
  app.get('/api/fabric/site', async () => ({ fabric: true }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, port: (app.server.address() as import('node:net').AddressInfo).port };
}

test('precondition: without the guard, an absolute-form target really does walk past the Fabric guard', async () => {
  // So the refusals below are the guard's doing, and the bypass is not hypothetical.
  const { app, port } = await listening(false);
  // In a finally: a LISTENING server left open by a failed assertion keeps this
  // file's process alive, and the suite hangs instead of reporting the failure.
  try {
    assert.equal(await rawStatus(port, '/api/fabric/site', TUNNEL), 404, 'the Fabric guard refuses the path form');
    assert.equal(await rawStatus(port, 'http://omos.example.org/api/fabric/site', TUNNEL), 200, 'the absolute form walks past it');
  } finally {
    await app.close();
  }
});

test('A REQUEST TARGET THAT IS NOT A PATH IS REFUSED BEFORE ANY GUARD SEES IT', async () => {
  const { app, port } = await listening(true);
  try {
    for (const target of [
      'http://omos.example.org/api/fabric/site',
      'http://omos.example.org/trpc/auth.me',
      'https://omos.example.org/trpc/auth.me',
      '*trpc/auth.me',
      '*',
    ]) {
      assert.equal(await rawStatus(port, target, TUNNEL), 400, `tunnel ${target}`);
      assert.equal(await rawStatus(port, target), 400, `LAN ${target}`);
    }
    // And nothing a real client sends is affected.
    assert.equal(await rawStatus(port, '/trpc/auth.me'), 200);
    assert.equal(await rawStatus(port, '/api/fabric/site', TUNNEL), 404, 'the Fabric guard still does its own job');
  } finally {
    await app.close();
  }
});

test('index.ts makes the request-target guard the FIRST hook on both listeners', () => {
  const front = INDEX.indexOf('registerOriginFormGuard(front)');
  const server = INDEX.indexOf('registerOriginFormGuard(server)');
  assert.ok(front > 0, 'the front door has no request-target guard');
  assert.ok(server > 0, 'the dashboard listener has no request-target guard');
  assert.ok(front < INDEX.indexOf('attachIngress(front'), 'it must run before the ingress');
  assert.ok(front < INDEX.indexOf('registerFabricTunnelGuard(front)'), '...and before the Fabric guard');
  assert.ok(front < INDEX.indexOf('front.register(fastifyCookie)'), '...and before any plugin adds a hook');
  assert.ok(server < INDEX.indexOf('registerFabricTunnelGuard(server)'), 'on the dashboard listener too');
  assert.ok(server < INDEX.indexOf('server.register(fastifyCookie)'));
});

/** Send an upgrade with a raw target and never close: report what the SERVER does. */
function rawUpgrade(port: number, target: string): Promise<'closed' | 'answered-and-left-open' | 'left-hanging'> {
  return new Promise((resolve) => {
    let got = '';
    const sock = net.connect(port, '127.0.0.1', () =>
      sock.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      ),
    );
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(got ? 'answered-and-left-open' : 'left-hanging');
    }, 1500);
    sock.on('data', (b) => (got += b.toString('latin1')));
    sock.on('close', () => {
      clearTimeout(timer);
      resolve('closed');
    });
    sock.on('error', () => {});
  });
}

test('A REFUSED UPGRADE IS CLOSED BY THE SERVER, never answered and left open', { timeout: 20_000 }, async () => {
  // On the dashboard listener @fastify/websocket routes upgrades through the hooks and
  // only destroys the socket from its OWN hook, which a reply from an earlier one
  // skips. So the guard's 400 left every refused upgrade's socket open for good — an
  // unauthenticated descriptor each, on a daemon running as root. The client here
  // never closes, so only the server can end the connection.
  const fastifyWebsocket = req('@fastify/websocket') as typeof import('@fastify/websocket').default;
  const app = Fastify();
  registerOriginFormGuard(app);
  await app.register(fastifyWebsocket);
  app.get('/trpc', { websocket: true }, () => {});
  // Every raw connection, so the finally can cut them: a LEAKED socket is exactly what
  // this test looks for, and `app.close()` waits for it — so without this, the bug
  // made the suite hang instead of fail.
  const conns = new Set<import('node:net').Socket>();
  app.server.on('connection', (c) => conns.add(c));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as import('node:net').AddressInfo).port;
  try {
    for (const target of ['*', 'http://127.0.0.1/trpc', '*trpc']) {
      assert.equal(await rawUpgrade(port, target), 'closed', target);
    }
    await new Promise((r) => setTimeout(r, 50));
    const open = await new Promise<number>((r) => app.server.getConnections((_e, n) => r(n)));
    assert.equal(open, 0, 'the server is still holding refused sockets');
  } finally {
    for (const c of conns) c.destroy();
    await app.close();
  }
});

// ── the dashboard listener's own guards ────────────────────────────────────

test('anonymousBodyRefusal: a stranger declares a few hundred bytes, or is refused unread', () => {
  assert.equal(ra.anonymousBodyRefusal({}), null);
  assert.equal(ra.anonymousBodyRefusal({ 'content-length': '512' }), null);
  assert.equal(ra.anonymousBodyRefusal({ 'content-length': String(ra.ANONYMOUS_BODY_LIMIT) }), null);
  assert.equal(ra.anonymousBodyRefusal({ 'content-length': String(ra.ANONYMOUS_BODY_LIMIT + 1) }), 413);
  assert.equal(ra.anonymousBodyRefusal({ 'content-length': '25000000' }), 413);
  assert.equal(ra.anonymousBodyRefusal({ 'content-length': 'lots' }), 413);
  // Not refused up front — a tunnel may send a browser's fixed-size sign-in this way.
  // It is counted as it arrives instead (registerDashboardRequestLimits, below).
  assert.equal(ra.anonymousBodyRefusal({ 'transfer-encoding': 'chunked' }), null);
});

const sessionsMod = req('../src/auth/sessions') as typeof import('../src/auth/sessions');

/** A dashboard listener with the real limits, and a stand-in for the front door's mark. */
async function dashboardWithLimits() {
  const dash = Fastify({ bodyLimit: 25 * 1024 * 1024 });
  dash.addHook('onRequest', async (r) => {
    if (r.headers['x-test-handed-over']) ra.markHandedOver(r.raw);
  });
  ra.registerDashboardRequestLimits(dash);
  dash.post('/trpc/auth.login', async (r) => ({ got: JSON.stringify(r.body).length }));
  dash.get('/trpc/auth.me', async () => ({ ok: true }));
  await dash.ready();
  return dash;
}

test("A STRANGER'S BODY IS COUNTED AS IT ARRIVES — even one that never says its size", async () => {
  // The dashboard listener takes 25 MB of JSON, which a signed-in admin needs. Handed
  // the internet's requests unread, that was 25 MB per request for anyone who could
  // reach the sign-in page — a memory lever against a root process on a Pi.
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  const dash = await dashboardWithLimits();
  const { Readable } = await import('node:stream');
  const big = JSON.stringify({ x: 'a'.repeat(ra.ANONYMOUS_BODY_LIMIT + 10) });
  const json = { 'content-type': 'application/json' };
  try {
    const chunked = await dash.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      headers: { ...json, 'x-test-handed-over': '1' },
      payload: Readable.from([big.slice(0, 40_000), big.slice(40_000)]),
    });
    assert.equal(chunked.statusCode, 413, 'an undeclared body was read past the limit');
    const small = await dash.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      headers: { ...json, 'x-test-handed-over': '1' },
      payload: JSON.stringify({ username: 'admin', password: 'x' }),
    });
    assert.equal(small.statusCode, 200, 'a real sign-in must pass');
    // On the masjid's network, and for a remote admin who is signed in, the
    // dashboard's own limit applies — they upload wallpapers and paste compose files.
    const lan = await dash.inject({ method: 'POST', url: '/trpc/auth.login', headers: json, payload: big });
    assert.equal(lan.statusCode, 200);
    const remote = sessionsMod.createSession('admin', sessionsMod.currentCredential(), {
      remote: true,
      tf: tf.secondFactorEpoch(),
      handedOver: true,
    });
    const signedIn = await dash.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      headers: { ...json, 'x-test-handed-over': '1', cookie: `${sessionsMod.REMOTE_COOKIE_NAME}=${remote.token}` },
      payload: Readable.from([big]),
    });
    assert.equal(signedIn.statusCode, 200);
  } finally {
    await dash.close();
  }
});

test('tRPC TAKES JSON ONLY — its unlimited multipart path is closed to everyone', async () => {
  const dash = await dashboardWithLimits();
  try {
    for (const [url, type] of [
      ['/trpc/auth.login', 'multipart/form-data; boundary=x'],
      ['/trpc/auth.login', 'text/plain'],
      ['/trpc/auth.login', ''],
      ['/%74rpc/auth.login', 'multipart/form-data; boundary=x'],
    ] as const) {
      const res = await dash.inject({ method: 'POST', url, headers: type ? { 'content-type': type } : {}, payload: '--x--' });
      assert.equal(res.statusCode, 415, `${url} with "${type}"`);
    }
    // A query carries no body and no type, and is untouched.
    assert.equal((await dash.inject({ method: 'GET', url: '/trpc/auth.me' })).statusCode, 200);
  } finally {
    await dash.close();
  }
});

test('THE DASHBOARD LISTENER ANSWERS CLOUDFLARE ONLY THROUGH THE GATE', async () => {
  // A tunnel pointed at the dashboard's own port by mistake would otherwise serve
  // the dashboard to the internet with the switch off.
  const dash = Fastify();
  dash.addHook('onRequest', async (r) => {
    if (r.headers['x-test-handed-over']) ra.markHandedOver(r.raw);
  });
  ra.registerHandoffOnlyGuard(dash);
  dash.get('/trpc/auth.me', async () => ({ dashboard: true }));
  await dash.ready();
  try {
    refusals.__clearRefusalsForTests();
    const direct = await dash.inject({ method: 'GET', url: '/trpc/auth.me', headers: { 'cf-ray': 'abc-LHR' } });
    assert.equal(direct.statusCode, 404, 'Cloudflare traffic was answered without the gate');
    assert.doesNotMatch(direct.body, /dashboard/);
    // Recorded as what it is — a hostname pointed at the wrong port — so "Recently
    // turned away" says what to fix instead of "Local network only".
    assert.ok(
      refusals.recentRefusals().some((r) => r.path === '/trpc/auth.me' && r.reason === 'wrong-port'),
      JSON.stringify(refusals.recentRefusals()),
    );
    assert.equal((await dash.inject({ method: 'GET', url: '/trpc/auth.me' })).statusCode, 200, 'the LAN');
    assert.equal(
      (await dash.inject({ method: 'GET', url: '/trpc/auth.me', headers: { 'x-forwarded-proto': 'https' } })).statusCode,
      200,
      "a masjid's own reverse proxy is not Cloudflare",
    );
    assert.equal(
      (await dash.inject({ method: 'GET', url: '/trpc/auth.me', headers: { 'cf-ray': 'abc-LHR', 'x-test-handed-over': '1' } }))
        .statusCode,
      200,
      'handed over by the gate',
    );
  } finally {
    await dash.close();
  }
});

test('index.ts wires the dashboard listener\'s guards, and the remote-only behaviours, where they belong', () => {
  const origin = INDEX.indexOf('registerOriginFormGuard(server)');
  const handoff = INDEX.indexOf('registerHandoffOnlyGuard(server)');
  const limits = INDEX.indexOf('registerDashboardRequestLimits(server)');
  assert.ok(origin > 0 && handoff > origin, 'the hand-over guard must come straight after the request-target guard');
  assert.ok(limits > handoff, 'the request limits must be registered');
  assert.ok(handoff < INDEX.indexOf('server.register(fastifyCookie)'), 'before any plugin adds a hook');
  // The backup download starts answering before the backup is made, from outside.
  assert.match(INDEX, /if \(wasHandedOver\(req\.raw\)\) return remoteBackupDownload\(reply\);/);
  // …through api/backup-download.ts, whose behaviour test/remote-backup.test.ts drives.
  assert.match(INDEX, /import \{ remoteBackupDownload, sendBackup \} from '\.\/api\/backup-download';/);
  // Nothing of the remote dashboard is left in Cloudflare's cache.
  assert.match(
    INDEX,
    /if \(wasHandedOver\(req\.raw\)\) \{\s*reply\.header\('cdn-cache-control', 'no-store'\);\s*reply\.header\('cloudflare-cdn-cache-control', 'no-store'\);/,
  );
  // And the boot adopts emailed codes switched on before they were bound.
  assert.match(INDEX, /adoptLegacyEmailBinding\(\)/);
});
