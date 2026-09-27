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
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { createRequire } from 'node:module';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-remote-admin-'));

const req = createRequire(__filename);
const ra = req('../src/system/remote-admin') as typeof import('../src/system/remote-admin');
const settings = req('../src/settings/store') as typeof import('../src/settings/store');
const tf = req('../src/auth/twofactor') as typeof import('../src/auth/twofactor');
const totpLib = req('../src/auth/totp') as typeof import('../src/auth/totp');
const refusals = req('../src/system/tunnel-refusals') as typeof import('../src/system/tunnel-refusals');
const { registerFabricTunnelGuard, isViaTunnel } = req(
  '../src/system/via-tunnel',
) as typeof import('../src/system/via-tunnel');

const TUNNEL = { 'cf-ray': '7a1b2c3d4e5f-LHR' };
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

/** Enrol a second factor, so the "2FA is required" precondition can be met. */
function enrolTwoFactor(): void {
  const { secret } = tf.beginEnrolment('admin');
  tf.confirmEnrolment(totpLib.totp(secret, Date.now()));
}

function setState(o: { tunnel: boolean; remoteAdmin: boolean; twoFactor: boolean }): void {
  settings.updateCloudflare({ enabled: o.tunnel, remoteAdmin: o.remoteAdmin, domain: 'omos.example.org' });
  tf.disableTwoFactor();
  if (o.twoFactor) enrolTwoFactor();
}

// ── the decision ───────────────────────────────────────────────────────────

test('remote administration is OFF until all three conditions hold', () => {
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
  const cf = { enabled: true, domain: 'omos.example.org' } as never;
  settings.updateSettings({ cloudflare: cf });
  enrolTwoFactor();
  assert.equal(ra.remoteAdminEnabled(), false);
});

// ── which paths the dashboard owns ─────────────────────────────────────────

test('NOTHING UNDER /api IS EVER A DASHBOARD PATH', () => {
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
    '/api/files/read?path=config/stripe.json',
    '/api/backup',
  ]) {
    assert.equal(ra.isDashboardPath(url), false, url);
  }
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
 * A front door mirroring `startHttpFront`: the Fabric guard, then the gate, then
 * the dashboard routes, then the not-found handler. The structural tests below
 * check this mirror has not drifted from the real thing.
 */
async function frontDoor() {
  const app = Fastify();
  registerFabricTunnelGuard(app);
  app.get('/api/health', async (r, reply) =>
    isViaTunnel(r) ? reply.code(404).send({ error: 'Not found.' }) : { status: 'ok', version: '9.9.9' },
  );
  app.get('/api/fabric/site', async () => ({ ok: true }));

  app.addHook('onRequest', (r, reply, done) => {
    if (!ra.isDashboardPath(r.url)) return done();
    if (!isViaTunnel(r)) return reply.code(308).redirect(`https://example${r.url}`);
    if (ra.remoteAdminEnabled()) return done();
    const ref = refusals.noteRefusal(
      r.url,
      { host: String(r.headers.host ?? ''), method: r.method, cfRay: '', accept: '', agent: '' },
      'lan-only-route',
    );
    return reply.code(404).send(ref ? { error: 'Not found.', ref } : { error: 'Not found.' });
  });

  app.get('/trpc/auth.me', async () => ({ dashboard: true }));
  // REGISTERED ROUTES for the built UI, and they are the point of this mirror.
  // The first version of this test had only the tRPC route and a not-found
  // handler, so `GET /` fell through to the handler and got the HTTPS redirect —
  // while the real front door matched @fastify/static and served index.html over
  // plain HTTP on the masjid's LAN. A registered route skips the not-found
  // handler; a mirror without one cannot see that, and did not.
  app.get('/', async () => 'index.html');
  app.get('/assets/index.js', async () => 'bundle');
  app.setNotFoundHandler((r, reply) => {
    if (isViaTunnel(r) && ra.remoteAdminEnabled() && ra.isDashboardPath(r.url)) {
      return reply.type('text/html').send('<!doctype html><title>OpenMasjidOS</title>');
    }
    if (isViaTunnel(r)) {
      refusals.noteRefusal(
        r.url,
        { host: String(r.headers.host ?? ''), method: r.method, cfRay: '', accept: '', agent: '' },
        'no-app-at-path',
      );
      return reply.code(404).send({ error: 'Not found.' });
    }
    return reply.code(308).redirect(`https://example${r.url}`);
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

test('with the feature ON, the dashboard is served over the tunnel', async () => {
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  const app = await frontDoor();
  assert.equal((await app.inject({ method: 'GET', url: '/trpc/auth.me', headers: TUNNEL })).statusCode, 200);
  const page = await app.inject({ method: 'GET', url: '/settings/account', headers: TUNNEL });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /OpenMasjidOS/);
  await app.close();
});

test('THE FABRIC STAYS REFUSED even with the feature on', async () => {
  // The half of §15 that does not move. These carry every app's 256-bit secret
  // and every configured Stripe live key.
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  const app = await frontDoor();
  assert.equal((await app.inject({ method: 'GET', url: '/api/fabric/site', headers: TUNNEL })).statusCode, 404);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/%66abric/site', headers: TUNNEL })).statusCode,
    404,
    'the encoded spelling too',
  );
  await app.close();
});

test('the version stays withheld even with the feature on', async () => {
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  const app = await frontDoor();
  const res = await app.inject({ method: 'GET', url: '/api/health', headers: TUNNEL });
  assert.equal(res.statusCode, 404);
  assert.doesNotMatch(res.body, /9\.9\.9/);
  await app.close();
});

test('a wrong public address still 404s with the feature on', async () => {
  // Not "everything that is not an app is now the dashboard". A donor who
  // mistypes the donations path gets "no page here", not an admin sign-in box.
  setState({ tunnel: true, remoteAdmin: true, twoFactor: true });
  const app = await frontDoor();
  const res = await app.inject({ method: 'GET', url: '/donatoins', headers: TUNNEL });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('LAN TRAFFIC ON THE HTTP FRONT DOOR IS UNCHANGED, feature on or off', async () => {
  // Publishing the dashboard to the internet must not start serving it
  // unencrypted on the masjid's own network.
  for (const remoteAdmin of [false, true]) {
    setState({ tunnel: true, remoteAdmin, twoFactor: true });
    const app = await frontDoor();
    // '/' and '/assets/index.js' are REGISTERED here, deliberately: they are the
    // spellings that skip the not-found handler, and they are what broke.
    for (const url of ['/', '/settings', '/assets/index.js']) {
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
  const guard = INDEX.indexOf('registerFabricTunnelGuard(front)');
  const gate = INDEX.indexOf('isDashboardPath(req.url)');
  assert.ok(guard > 0, 'the front-door Fabric guard is gone');
  assert.ok(gate > 0, 'the remote-admin gate is gone');
  assert.ok(guard < gate, 'the Fabric guard must be registered before the gate');
});

test('the CSRF and header hooks are added BEFORE the dashboard routes', () => {
  // Fastify binds a route's hook chain when the route is registered, so a hook
  // added afterwards can silently not apply — "the guard is there but never
  // runs", which is the failure shape §15 records for discoverApps.
  const csrf = INDEX.indexOf("urlHasPrefix(req.url, '/trpc') && !isWebSocketUpgrade(req)", INDEX.indexOf('startHttpFront'));
  const headers = INDEX.indexOf("reply.header('X-Frame-Options', 'SAMEORIGIN')", INDEX.indexOf('startHttpFront'));
  const trpc = INDEX.indexOf('front.register(fastifyTRPCPlugin', INDEX.indexOf('startHttpFront'));
  const statics = INDEX.indexOf('registerStaticFiles(front', INDEX.indexOf('startHttpFront'));
  for (const [name, at] of Object.entries({ csrf, headers, trpc, statics })) {
    assert.ok(at > 0, `${name} is missing from the front door`);
  }
  assert.ok(csrf < trpc, 'the /trpc origin check must be registered before the tRPC plugin');
  assert.ok(headers < trpc && headers < statics, 'security headers must be hooked before the routes');
});

test('the front door only lets the dashboard WebSocket through', () => {
  // `attachIngress` destroys every non-app upgrade on purpose — an abandoned
  // socket is an unauthenticated file-descriptor leak on a root daemon. The one
  // exception must stay narrow and must check all three conditions.
  const call = INDEX.slice(INDEX.indexOf('attachIngress(front'), INDEX.indexOf('registerFabricTunnelGuard(front)'));
  assert.match(call, /allowUpgrade/, 'the upgrade allowance is gone');
  assert.match(call, /isViaTunnelHeaders/, 'it must only apply to tunnel traffic');
  assert.match(call, /remoteAdminEnabled\(\)/, 'it must respect the setting');
  assert.match(call, /'\/trpc'/, 'it must be limited to the dashboard socket');
});

test('the session cookie is Secure on a tunnel-origin session', () => {
  const ctx = fs.readFileSync(path.join(__dirname, '..', 'src', 'trpc', 'context.ts'), 'utf8');
  assert.match(
    ctx,
    /secure:\s*COOKIE_OPTS\.secure\s*\|\|\s*isViaTunnel\(/,
    'a session issued over the public internet must not be sent back in clear',
  );
});
