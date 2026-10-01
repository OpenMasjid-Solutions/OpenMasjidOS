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
 * the dashboard routes, then the not-found handler.
 *
 * THE GATE IS THE REAL ONE. Its decision is `frontDoorDecision`, the same pure
 * function index.ts calls; only the four-way mapping to a reply is repeated here.
 * The first version of this mirror re-implemented the decision by hand, and a
 * review found it had already drifted — it had no upgrade branch at all, so no
 * test ever sent a plain-http tunnel visit through a gate.
 */
const TEST_HOST = 'omos.example.org';
async function frontDoor() {
  const app = Fastify();
  registerFabricTunnelGuard(app);
  app.get('/api/health', async (r, reply) =>
    isViaTunnel(r) ? reply.code(404).send({ error: 'Not found.' }) : { status: 'ok', version: '9.9.9' },
  );
  app.get('/api/fabric/site', async () => ({ ok: true }));

  app.addHook('onRequest', (r, reply, done) => {
    const d = ra.frontDoorDecision(r.url, r.headers, {
      viaTunnel: isViaTunnel(r),
      remoteAdminEnabled: ra.remoteAdminEnabled(),
      configuredHost: TEST_HOST,
    });
    if (d.kind === 'pass') return done();
    if (d.kind === 'lan-https') return reply.code(308).redirect(`https://example${r.url}`);
    if (d.kind === 'upgrade') return reply.code(308).redirect(d.to);
    const ref = refusals.noteRefusal(
      r.url,
      { host: String(r.headers.host ?? ''), method: r.method, cfRay: '', accept: '', agent: '' },
      d.reason,
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
  // The gate is the onRequest hook's call, `frontDoorDecision(req.url, req.headers` —
  // the only call to it in index.ts. The WebSocket claim reaches the same function
  // through `claimsDashboardSocket`, inside system/remote-admin.ts.
  const guard = INDEX.indexOf('registerFabricTunnelGuard(front)');
  const gate = INDEX.indexOf('frontDoorDecision(req.url, req.headers');
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
  assert.match(call, /configuredHost:\s*publicHost\(\)/);
  assert.match(call, /if \(!ok\) return false;/, 'a declined upgrade must be handed back (and so destroyed)');
  assert.match(call, /handleUpgrade\(/, 'a claimed socket must actually be handled');
});

test('claimsDashboardSocket: the dashboard socket, over the tunnel, when the gate would pass it — nothing else', () => {
  const https = { 'cf-ray': 'a', 'cf-visitor': '{"scheme":"https"}', host: HOST };
  const on = { remoteAdminEnabled: true, configuredHost: HOST };
  assert.equal(ra.claimsDashboardSocket('/trpc', https, on), true);
  assert.equal(ra.claimsDashboardSocket('/trpc?connectionParams=1', https, on), true);
  assert.equal(ra.claimsDashboardSocket('/%74rpc', https, on), true, 'the same request the HTTP gate passes');

  assert.equal(ra.claimsDashboardSocket('/trpc', {}, on), false, 'LAN sockets use the TLS listener, never this one');
  assert.equal(ra.claimsDashboardSocket('/trpc', https, { ...on, remoteAdminEnabled: false }), false, 'feature off');
  assert.equal(ra.claimsDashboardSocket('/trpc', http(), on), false, 'plain http:// is redirected by the gate, so not claimed');
  assert.equal(
    ra.claimsDashboardSocket('/trpc', { ...https, 'cf-visitor': '' }, { ...on, configuredHost: '' }),
    true,
    'unknown scheme is served by the gate, so claimed — the same answer, not a stricter one',
  );
  for (const url of ['/trpcx', '/settings', '/', '/api/fabric/site', '/donations/trpc']) {
    assert.equal(ra.claimsDashboardSocket(url, https, on), false, url);
  }
});

test('@fastify/websocket is NOT registered on the front door', () => {
  // It attaches its own `upgrade` listener and routes every upgrade through
  // Fastify, so each app's socket was handled twice — piped to the app by the
  // ingress AND proxied as plain HTTP by its onRequest hook — and every app's
  // live socket over the tunnel died. The ingress is the one upgrade owner here.
  const fn = INDEX.slice(INDEX.indexOf('async function startHttpFront'));
  const end = fn.indexOf('\n  }\n');
  const body = end > 0 ? fn.slice(0, end) : fn;
  assert.ok(body.includes('const front = Fastify('), 'could not find the front door');
  assert.doesNotMatch(body, /front\.register\(\s*fastifyWebsocket/, '@fastify/websocket is back on the front door');
  assert.match(
    body,
    /front\.register\(fastifyTRPCPlugin,\s*\{\s*\.\.\.trpcPluginOptions,\s*useWSS:\s*false\s*\}\)/,
    'tRPC on the front door must not try to serve its own WebSocket',
  );
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

const HOST = 'omos.example.org';
const http = (extra: Record<string, string> = {}) => ({ 'cf-ray': 'a-LHR', 'x-forwarded-proto': 'http', host: HOST, ...extra });

const ON = { viaTunnel: true, remoteAdminEnabled: true, configuredHost: HOST };
const decide = (url: string, headers: Record<string, string>, ctx = ON) => ra.frontDoorDecision(url, headers, ctx);

test('A PLAIN-HTTP TUNNEL VISIT TO THE DASHBOARD IS UPGRADED TO HTTPS', () => {
  // Serving it put the admin password and the second-factor code on the internet in
  // clear between the browser and Cloudflare's edge.
  assert.deepEqual(decide('/settings/account', http()), { kind: 'upgrade', to: `https://${HOST}/settings/account` });
  assert.deepEqual(decide('/?next=%2Fsettings', http()), { kind: 'upgrade', to: `https://${HOST}/?next=%2Fsettings` });
  assert.deepEqual(decide('/', http({ 'cf-visitor': '{"scheme":"http"}' })), { kind: 'upgrade', to: `https://${HOST}/` });
});

test('THE UPGRADE ALWAYS GOES TO OUR HOSTNAME — never where the request says', () => {
  // The target never comes from the request, so this can never be an open redirect
  // whatever Host is sent. The first version ALSO required Host to equal ours, which
  // protected nothing and meant a second hostname routed to the tunnel was served
  // in clear; a review caught it.
  for (const host of ['evil.example.com', `${HOST}.evil.example.com`, 'app.example.org', '']) {
    assert.deepEqual(decide('/', http({ host })), { kind: 'upgrade', to: `https://${HOST}/` }, `Host: ${host}`);
  }
  // A request target that is not a path is not something to build a URL from.
  assert.deepEqual(decide('//evil.example.com/x', http()), { kind: 'pass' }, 'not a dashboard path at all');
});

test('WITH NO HOSTNAME CONFIGURED, A PLAIN-HTTP VISIT IS REFUSED, NOT SERVED IN CLEAR', () => {
  assert.deepEqual(decide('/', http(), { ...ON, configuredHost: '' }), { kind: 'refuse', reason: 'plain-http-no-host' });
  assert.deepEqual(decide('/settings', http(), { ...ON, configuredHost: '   ' }), {
    kind: 'refuse',
    reason: 'plain-http-no-host',
  });
});

test('the upgrade never loops', () => {
  // Only an EXPLICIT http signal redirects. HTTPS is served, and so is unknown — a
  // proxy that strips the scheme header can never trap the dashboard in a loop.
  assert.deepEqual(decide('/', { 'cf-ray': 'a', 'x-forwarded-proto': 'https', host: HOST }), { kind: 'pass' });
  assert.deepEqual(decide('/', { 'cf-ray': 'a', host: HOST }), { kind: 'pass' });
});

test('A PROXY THAT REWRITES x-forwarded-proto CANNOT CAUSE A REDIRECT LOOP', () => {
  // The review: nginx's `proxy_set_header X-Forwarded-Proto $scheme` behind the tunnel
  // turns Cloudflare's https into http. Trusting it first made every HTTPS visit
  // "plain HTTP", redirected to the URL it was already on, for ever. cf-visitor is
  // Cloudflare's own statement and nothing in between touches it — so it wins.
  const rewritten = { 'cf-ray': 'a', 'x-forwarded-proto': 'http', 'cf-visitor': '{"scheme":"https"}', host: HOST };
  assert.deepEqual(decide('/', rewritten), { kind: 'pass' }, 'an HTTPS visit behind a rewriting proxy was redirected');
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

test('the real gate in index.ts IS frontDoorDecision, and handles all four outcomes', () => {
  // Structural, but only for the wiring — the decision itself is tested above by
  // calling the very function index.ts calls.
  const from = INDEX.indexOf('const d = frontDoorDecision(req.url, req.headers');
  assert.ok(from > 0, 'the front door no longer calls frontDoorDecision');
  const gate = INDEX.slice(from, INDEX.indexOf('front.register(fastifyTRPCPlugin', from));
  assert.ok(gate.length > 0, 'the gate must come before the tRPC plugin');
  assert.match(gate, /configuredHost:\s*publicHost\(\)/, 'the upgrade must target the CONFIGURED hostname');
  for (const kind of ['pass', 'lan-https', 'upgrade', 'refuse']) {
    assert.match(gate, new RegExp(`case '${kind}'`), `the gate does not handle '${kind}'`);
  }
  assert.match(gate, /case 'upgrade':\s*(\/\/[^\n]*\n\s*)*return reply\.code\(308\)\.redirect\(d\.to\)/, 'an upgrade must 308 to d.to');
  assert.match(gate, /noteRefusal\([\s\S]*?d\.reason/, "a refusal must be recorded under the decision's reason");
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
  const served = await on.inject({ method: 'GET', url: '/%74rpc/auth.me', headers: TUNNEL });
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
