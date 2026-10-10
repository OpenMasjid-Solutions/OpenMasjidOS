// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Everything manageable from outside: apps, and the rules that make it safe.
 *
 * Remote administration first served the dashboard at the root of the hostname the
 * apps are published on. An adversarial review showed that made every app page the
 * dashboard's own ORIGIN — a browser draws that line by scheme, host and port, never
 * by path — so any app the admin opened, or any cross-site-scripting bug in any public
 * page, could read the dashboard key and drive the admin API with the admin's cookie:
 * terminals, backups, host root. Four rules close it, and this file pins each:
 *
 *  1. **The dashboard has a hostname of its own** and no app is ever served there
 *     (system/remote-admin.ts, system/ingress.ts).
 *  2. **An app gets its own access token, never a platform session.** The remote
 *     dashboard's Open button spends a one-use ticket on the apps' hostname, which
 *     hands the browser a token for THAT app (system/app-access.ts). The ingress
 *     strips every platform session cookie from what an app receives through the
 *     tunnel — a LAN one included, which every app on the network holds.
 *  3. **From the tunnel, only a session that passed the second factor counts** —
 *     and only while that factor is unchanged.
 *  4. **Nothing private is left in Cloudflare's cache.**
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Module, { createRequire } from 'node:module';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-remote-apps-'));
process.env.OPENMASJID_DATA_DIR = DATA;
process.env.OPENMASJID_APP_PROXY_TARGET = '127.0.0.1';

const req = createRequire(__filename);

// Docker stays out of it: the routes are pinned below, and a background rebuild that
// heard "no apps" must not replace them (see front-door-websocket.test.ts). The two
// apps the Fabric knows: `private` and `shared`, each with its own key.
const managerPath = req.resolve('../src/apps/manager');
const managerStub = new Module(managerPath);
managerStub.filename = managerPath;
managerStub.loaded = true;
managerStub.exports = {
  listInstalledWithHealth: () => new Promise(() => {}),
  getAppPath: (id: string) => id,
  findFabricApp: (secret: string | null) =>
    secret === 'private-key' ? { id: 'private', sso: true } : secret === 'shared-key' ? { id: 'shared', sso: true } : null,
  appDeclaresAlert: () => false,
};
req.cache[managerPath] = managerStub;

const ingress = req('../src/system/ingress') as typeof import('../src/system/ingress');
const ra = req('../src/system/remote-admin') as typeof import('../src/system/remote-admin');
const access = req('../src/system/app-access') as typeof import('../src/system/app-access');
const refusals = req('../src/system/tunnel-refusals') as typeof import('../src/system/tunnel-refusals');
const settings = req('../src/settings/store') as typeof import('../src/settings/store');
const tf = req('../src/auth/twofactor') as typeof import('../src/auth/twofactor');
const totpLib = req('../src/auth/totp') as typeof import('../src/auth/totp');
const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
const store = req('../src/auth/store') as typeof import('../src/auth/store');
const { isViaTunnel } = req('../src/system/via-tunnel') as typeof import('../src/system/via-tunnel');
const { createContext } = req('../src/trpc/context') as typeof import('../src/trpc/context');
const appUrl = req(path.join(__dirname, '..', '..', 'ui', 'src', 'lib', 'app-url.ts')) as typeof import('../../ui/src/lib/app-url');

const ADMIN = 'admin.example.org';
const APPS = 'omos.example.org';
const VIA = { 'cf-ray': '7a1b2c3d4e5f-LHR', 'cf-visitor': '{"scheme":"https"}' };
const TO_APPS = { ...VIA, host: APPS };
const TO_ADMIN = { ...VIA, host: ADMIN };

function setRemoteAdmin(on: boolean): void {
  if (!store.isConfigured()) store.setCredentials('admin', '$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb');
  settings.updateCloudflare({ enabled: true, remoteAdmin: on, domain: APPS, adminHost: ADMIN });
  if (!tf.twoFactorActive()) {
    const { secret } = tf.beginEnrolment('admin');
    tf.confirmEnrolment(totpLib.totp(secret, Date.now()));
  }
}
setRemoteAdmin(true);

const lanSession = () => sessions.createSession('admin', sessions.currentCredential());
const remoteSession = () =>
  sessions.createSession('admin', sessions.currentCredential(), { remote: true, tf: tf.secondFactorEpoch(), handedOver: true });
const lanCookie = (s: { token: string }) => ({ cookie: `${sessions.COOKIE_NAME}=${s.token}` });
const tokenFor = (s: { token: string }, app: string) => sessions.appAccessToken(s.token, app)!;
const appCookie = (s: { token: string }, app: string) => ({ cookie: `${sessions.COOKIE_NAME}=${tokenFor(s, app)}` });

// ── an app, and a front door wired the way startHttpFront wires it ─────────

/** The app's end of every live stream it has begun, newest last: resolves when it is closed. */
const streamEnds: Promise<true>[] = [];
const app = http.createServer((r, res) => {
  if (r.url?.endsWith('/stream')) {
    // A live event stream: one event, then it stays open for as long as it is read.
    streamEnds.push(new Promise((resolve) => res.once('close', () => resolve(true))));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write('data: hello\n\n');
    return;
  }
  if (r.url?.endsWith('/sets')) {
    // An app that tries to plant a platform cookie and widen a service worker's reach.
    res.writeHead(200, {
      'content-type': 'text/plain',
      'set-cookie': ['omos_session=planted; Path=/private', 'app_pref=1; Path=/shared'],
      'service-worker-allowed': '/',
      'cache-control': 'public, max-age=3600',
    });
    res.end('sets');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'public, max-age=3600' });
  res.end(`app saw ${r.url} cookie=${r.headers.cookie ?? ''}`);
});
const appReady = new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()));
after(() => app.close());

async function frontDoor() {
  await appReady;
  const front = Fastify();
  ingress.attachIngress(front);
  access.registerAppOpen(front);
  // `shared` is shared online; `private` is the same app, not shared.
  const port = (app.address() as AddressInfo).port;
  ingress.__setRoutesForTests({ shared: port, private: { port, exposed: false } });
  // THE REAL reason mapping index.ts uses, not a copy of it — and its worker answer.
  front.setNotFoundHandler((r, reply) => {
    if (ingress.isBareAppAddress(r.url) && ingress.isWorkerScriptFetch(r.headers)) {
      return ingress.answerBareWorkerFetch(r, reply, { record: isViaTunnel(r) });
    }
    if (isViaTunnel(r)) return refusals.refuseOverTunnel(r, reply, refusals.notFoundReason(r.url, ingress.declinedReason(r.raw)));
    return reply.code(308).redirect(`https://example${r.url}`);
  });
  await front.ready();
  return front;
}

// ── private apps over HTTP ─────────────────────────────────────────────────

test('A PRIVATE APP IS SERVED WITH ITS ACCESS TOKEN — and receives that token and no session', async () => {
  setRemoteAdmin(true);
  const front = await frontDoor();
  const remote = remoteSession();
  const lan = lanSession();
  const token = tokenFor(remote, 'private');
  // Everything a browser might be carrying for this hostname, valid token last.
  const cookie = `${sessions.COOKIE_NAME}=${lan.token}; theme=dark; ${sessions.REMOTE_COOKIE_NAME}=${remote.token}; ${sessions.COOKIE_NAME}=${token}`;
  const res = await front.inject({ method: 'GET', url: '/private/dashboard', headers: { ...TO_APPS, cookie } });
  assert.equal(res.statusCode, 200);
  assert.equal(
    res.body,
    `app saw /private/dashboard cookie=${sessions.COOKIE_NAME}=${token}; theme=dark`,
    'the app must get its full path, its own token FIRST, and no platform session',
  );
  await front.close();
});

test('...AND TO NOBODY ELSE — the same 404 an empty address gets', async () => {
  setRemoteAdmin(true);
  const front = await frontDoor();
  const lan = lanSession();
  const remote = remoteSession();
  const ended = remoteSession();
  const endedToken = tokenFor(ended, 'private');
  sessions.destroySession(ended.token);
  for (const accept of ['text/html', 'application/json']) {
    const empty = await front.inject({ method: 'GET', url: '/nothing-here/x', headers: { ...TO_APPS, accept } });
    const cases: Array<[string, Record<string, string>, boolean]> = [
      ['nobody signed in', {}, true],
      ['a LAN session', lanCookie(lan), true],
      ["the remote DASHBOARD's session, as omos_session", lanCookie(remote), true],
      ["the remote dashboard's own cookie", { cookie: `${sessions.REMOTE_COOKIE_NAME}=${remote.token}` }, true],
      ["ANOTHER app's token", appCookie(remote, 'shared'), true],
      ['its token, feature off', appCookie(remote, 'private'), false],
      ['its token, after the session that made it signed out', { cookie: `${sessions.COOKIE_NAME}=${endedToken}` }, true],
      ['a forged token', { cookie: `${sessions.COOKIE_NAME}=a1.${'A'.repeat(22)}.${'B'.repeat(43)}` }, true],
    ];
    for (const [who, extra, on] of cases) {
      setRemoteAdmin(on);
      const res = await front.inject({ method: 'GET', url: '/private/x', headers: { ...TO_APPS, ...extra, accept } });
      assert.equal(res.statusCode, 404, `${who} reached a private app`);
      // The body differs only by the six-character reference. A private app must be
      // indistinguishable from nothing at all to whoever cannot open it.
      const strip = (b: string) => b.replace(/[0-9a-f]{6}/g, 'REF');
      assert.equal(strip(res.body), strip(empty.body), `${who}: the 404 gives away that something is there (${accept})`);
    }
    setRemoteAdmin(true);
  }
  await front.close();
});

test('REPLACING THE SECOND FACTOR ENDS EVERY APP TOKEN made under the old one', async () => {
  setRemoteAdmin(true);
  const front = await frontDoor();
  const remote = remoteSession();
  const cookie = appCookie(remote, 'private');
  assert.equal((await front.inject({ method: 'GET', url: '/private/x', headers: { ...TO_APPS, ...cookie } })).statusCode, 200);
  tf.regenerateBackupCodes(); // a new epoch: the old factor's sessions are over
  assert.equal(
    (await front.inject({ method: 'GET', url: '/private/x', headers: { ...TO_APPS, ...cookie } })).statusCode,
    404,
    'an app token outlived the factor its session proved',
  );
  await front.close();
});

test('the refusal is recorded as a private app, for the admin — by the REAL reason mapping', async () => {
  setRemoteAdmin(true);
  refusals.__clearRefusalsForTests();
  const front = await frontDoor();
  await front.inject({ method: 'GET', url: '/private/page', headers: TO_APPS });
  assert.ok(refusals.recentRefusals().some((r) => r.path === '/private/page' && r.reason === 'app-not-shared'));
  // And index.ts's not-found handler is that same mapping — not its own copy.
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const handler = index.slice(index.indexOf('front.setNotFoundHandler'));
  assert.match(handler, /refuseOverTunnel\(req, reply, notFoundReason\(req\.url, declinedReason\(req\.raw\)\)\)/);
  // …and it answers a worker's script at a bare address as the ingress does, first.
  assert.match(
    handler,
    /if \(isBareAppAddress\(req\.url\) && isWorkerScriptFetch\(req\.headers\)\) \{\s*return answerBareWorkerFetch\(req, reply, \{ record: isViaTunnel\(req\) \}\);/,
  );
  assert.ok(handler.indexOf('answerBareWorkerFetch') < handler.indexOf('refuseOverTunnel'), 'before the refusal');
  assert.equal(refusals.notFoundReason('/api/x', null), 'lan-only-route');
  assert.equal(refusals.notFoundReason('/x', null), 'no-app-at-path');
  assert.equal(refusals.notFoundReason('/x', 'app-on-admin-host'), 'app-on-admin-host');
  await front.close();
});

test("an access token does not open a private app's /fabric space either", async () => {
  setRemoteAdmin(true);
  const front = await frontDoor();
  const res = await front.inject({
    method: 'GET',
    url: '/private/fabric/billing/x',
    headers: { ...TO_APPS, ...appCookie(remoteSession(), 'private') },
  });
  assert.equal(res.statusCode, 404);
  await front.close();
});

test("on the masjid's network nothing changes: the front door does not serve a private app", async () => {
  // It is reached at its own port on the LAN, as always.
  setRemoteAdmin(true);
  const front = await frontDoor();
  const res = await front.inject({
    method: 'GET',
    url: '/private/x',
    headers: { host: APPS, ...appCookie(remoteSession(), 'private') },
  });
  assert.equal(res.statusCode, 308, 'a private app was served over plain HTTP on the LAN front door');
  await front.close();
});

test('NO APP IS EVER SERVED ON THE ADMIN HOSTNAME — shared or private, token or not', async () => {
  // That origin holds the dashboard's cookie and key. An app page there could act as
  // the admin; it is the other half of the gate serving the dashboard only there.
  setRemoteAdmin(true);
  refusals.__clearRefusalsForTests();
  const front = await frontDoor();
  const remote = remoteSession();
  for (const [url, extra] of [
    ['/shared/x', {}],
    ['/shared/x', appCookie(remote, 'shared')],
    ['/private/x', appCookie(remote, 'private')],
  ] as const) {
    const res = await front.inject({ method: 'GET', url, headers: { ...TO_ADMIN, ...extra } });
    assert.equal(res.statusCode, 404, `${url} was served on the admin hostname`);
    assert.doesNotMatch(res.body, /app saw/);
  }
  assert.ok(refusals.recentRefusals().some((r) => r.reason === 'app-on-admin-host'));
  // In any spelling of that hostname.
  for (const host of [ADMIN.toUpperCase(), `${ADMIN}.`, `${ADMIN}:443`]) {
    const res = await front.inject({ method: 'GET', url: '/shared/x', headers: { ...VIA, host } });
    assert.equal(res.statusCode, 404, `Host: ${host}`);
  }
  await front.close();
});

test('a SHARED app is unchanged for the public: served to anyone, cache headers its own', async () => {
  setRemoteAdmin(false);
  const front = await frontDoor();
  const res = await front.inject({ method: 'GET', url: '/shared/x', headers: TO_APPS });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'public, max-age=3600', 'a public page may be cached as the app says');
  await front.close();
  setRemoteAdmin(true);
});

test('A LAN SESSION PRESENTED THROUGH THE TUNNEL NEVER REACHES A SHARED APP', async () => {
  // Every app on the masjid's network receives the admin's LAN cookie. Relayed to a
  // shared app from outside, that app's sign-in check would accept it — a password-only
  // session working from the internet with no second factor.
  setRemoteAdmin(true);
  const front = await frontDoor();
  const res = await front.inject({ method: 'GET', url: '/shared/x', headers: { ...TO_APPS, ...lanCookie(lanSession()) } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'app saw /shared/x cookie=', 'the LAN cookie was relayed to the app');
  await front.close();
});

test("NOTHING PRIVATE IS LEFT IN CLOUDFLARE'S CACHE", async () => {
  // Cloudflare keys its cache on the address alone and keeps .js, .png, .pdf… by
  // default. A private page, or anything served to the admin's token, must not be
  // there for the next person to ask; nor may a refusal be cached and served to them.
  setRemoteAdmin(true);
  const front = await frontDoor();
  const remote = remoteSession();
  for (const [url, cookie] of [
    ['/private/report.pdf', appCookie(remote, 'private')],
    ['/shared/admin/export.csv', appCookie(remote, 'shared')],
  ] as const) {
    const res = await front.inject({ method: 'GET', url, headers: { ...TO_APPS, ...cookie } });
    assert.equal(res.statusCode, 200, url);
    assert.equal(res.headers['cache-control'], 'private, no-store', url);
    assert.equal(res.headers['cloudflare-cdn-cache-control'], 'no-store', url);
    assert.equal(res.headers['cdn-cache-control'], 'no-store', url);
  }
  const refused = await front.inject({ method: 'GET', url: '/private/report.pdf', headers: TO_APPS });
  assert.equal(refused.statusCode, 404);
  assert.equal(refused.headers['cloudflare-cdn-cache-control'], 'no-store', 'a refusal was left cacheable');
  await front.close();
});

test('AN APP CANNOT PLANT A PLATFORM COOKIE, OR A WORKER OVER THE WHOLE HOSTNAME', async () => {
  setRemoteAdmin(true);
  const front = await frontDoor();
  const res = await front.inject({ method: 'GET', url: '/shared/sets', headers: TO_APPS });
  assert.equal(res.statusCode, 200);
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  assert.deepEqual(cookies, ['app_pref=1; Path=/shared'], "the app's own cookie stays; a platform one does not");
  assert.equal(res.headers['service-worker-allowed'], undefined);
  await front.close();
});

test('a private app has no PUBLIC address — opening it remotely does not publish it', async () => {
  await frontDoor().then((f) => f.close());
  assert.equal(ingress.isRouted('shared'), true);
  assert.equal(ingress.isRouted('private'), false);
});

test('A PRIVATE APP NEVER TAKES A SHARED APP\'S PATH', () => {
  // Before every app was in the routing table a private one could never displace a
  // shared one. Now it is, so the rule is explicit — or a donations page goes dark.
  const next = new Map<string, { id: string; port: number; exposed: boolean }>();
  const clashes: string[] = [];
  ingress.placeRoute(next, 'donate', { id: 'donations', port: 1, exposed: true }, clashes);
  ingress.placeRoute(next, 'donate', { id: 'old-donations', port: 2, exposed: false }, clashes);
  assert.equal(next.get('donate')?.id, 'donations', 'a private app displaced a shared one');
  assert.equal(clashes.length, 1, 'the clash must be reported');
  // Otherwise the later app wins, as it always did.
  ingress.placeRoute(next, 'kiosk', { id: 'a', port: 3, exposed: false }, clashes);
  ingress.placeRoute(next, 'kiosk', { id: 'b', port: 4, exposed: true }, clashes);
  assert.equal(next.get('kiosk')?.id, 'b');
});

test('isRouted names the app that HOLDS the path, not every app that wants it', async () => {
  // A clash can still exist (an older install, a restore). The app that lost the path
  // must not be told — through the Fabric's `site`, which apps use for Stripe return
  // links and QR codes — that it is published at an address serving another app.
  ingress.__setRoutesForTests({ donate: { id: 'donations', port: 1, exposed: true } });
  // getAppPath is the identity in this file, so the app CALLED `donate` wants /donate.
  assert.equal(ingress.isRouted('donate'), false, 'told it is public at an address that serves another app');
  ingress.__setRoutesForTests({ shared: 1 });
  assert.equal(ingress.isRouted('shared'), true);
  await frontDoor().then((f) => f.close()); // put this file's routes back
});

test("A PRIVATE APP'S ADDRESS ANSWERS EXACTLY AS AN EMPTY ONE — /fabric, broken and oversized bodies too", async () => {
  // The /fabric refusal used to answer at once for every routed app, before the body
  // was read, while an empty address went on to the not-found route, where the body
  // IS read: a malformed or oversized POST got 404 at an installed app's path and
  // 400/413 at an empty one. A stranger could list the apps the masjid had installed.
  setRemoteAdmin(true);
  const front = await frontDoor();
  const strip = (b: string) => b.replace(/[0-9a-f]{6}/g, 'REF');
  const json = { 'content-type': 'application/json' };
  const probes: Array<[string, 'GET' | 'POST', Record<string, string>, string | undefined]> = [
    ['/fabric/billing/x', 'POST', json, '{'],
    ['/fabric/billing/x', 'POST', json, JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) })],
    ['/fabric/billing/x', 'GET', {}, undefined],
    ['/fabric', 'POST', json, '{'],
    ['/page', 'POST', json, '{'],
    ['/page', 'POST', json, JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) })],
  ];
  for (const [suffix, method, headers, payload] of probes) {
    const at = (seg: string) =>
      front.inject({ method, url: `/${seg}${suffix}`, headers: { ...TO_APPS, ...headers }, payload });
    const priv = await at('private');
    const empty = await at('nothing-here');
    const what = `${method} ${suffix} (${payload ? payload.length : 0} bytes)`;
    assert.equal(priv.statusCode, empty.statusCode, `${what}: the status gives the app away`);
    assert.equal(strip(priv.body), strip(empty.body), `${what}: the body gives the app away`);
  }
  await front.close();
});

test("AN APP'S BARE ADDRESS NEVER SERVES THE APP'S WORKER — only one that removes itself — and nothing there is cached", async () => {
  // A script served at https://<apps host>/<app> — no trailing slash — sits in the
  // directory "/", so a service worker registered from it may claim the WHOLE apps
  // hostname with no header at all: every other app, and the /_omos/open hand-off.
  // Stripping Service-Worker-Allowed only confines a worker under /<app>/. And a 404
  // stopped new ones only: a worker registered by an older build stays, because a failed
  // update check leaves a registration in place. What is served instead removes itself.
  setRemoteAdmin(true);
  refusals.__clearRefusalsForTests();
  const front = await frontDoor();
  const remote = remoteSession();
  // A worker's script, fetched the way a browser fetches one, at a shared app's bare
  // address, a private one's with its token, a private one's WITHOUT it and an empty
  // address — the same answer each time, so it says nothing about what is installed.
  for (const [url, extra] of [
    ['/shared', {}],
    ['/shared?x=1&y=2', {}],
    ['/private', appCookie(remote, 'private')],
    ['/private', {}],
    ['/nothing-here', {}],
  ] as const) {
    for (const sw of [{ 'service-worker': 'script' }, { 'sec-fetch-dest': 'serviceworker' }, { 'Service-Worker': ' SCRIPT ' }]) {
      const res = await front.inject({ method: 'GET', url, headers: { ...TO_APPS, ...extra, ...sw } });
      assert.equal(res.statusCode, 200, `${url} ${JSON.stringify(sw)}`);
      assert.equal(res.body, ingress.SELF_REMOVING_WORKER, `${url}: not the self-removing worker`);
      assert.match(String(res.headers['content-type']), /^text\/javascript/);
      assert.equal(res.headers['cache-control'], 'private, no-store', `${url}: cacheable`);
      assert.equal(res.headers['cloudflare-cdn-cache-control'], 'no-store', `${url}: cacheable at Cloudflare`);
    }
  }
  // It removes itself, and does nothing else.
  assert.match(ingress.SELF_REMOVING_WORKER, /self\.registration\.unregister\(\)/);
  assert.doesNotMatch(ingress.SELF_REMOVING_WORKER, /caches|fetch|clients/, 'it must touch nothing that belongs to the apps');
  assert.ok(refusals.recentRefusals().some((r) => r.path === '/shared' && r.reason === 'worker-at-bare-address'));
  assert.ok(refusals.recentRefusals().some((r) => r.path === '/nothing-here' && r.reason === 'worker-at-bare-address'));
  // …and on the masjid's network too — kept out of the record, which is a list of what
  // came in from outside.
  const recorded = JSON.stringify(refusals.recentRefusals());
  for (const url of ['/shared', '/nothing-here']) {
    const lan = await front.inject({ method: 'GET', url, headers: { host: APPS, 'service-worker': 'script' } });
    assert.equal(lan.body, ingress.SELF_REMOVING_WORKER, `${url} on the masjid's network`);
  }
  assert.equal(JSON.stringify(refusals.recentRefusals()), recorded, 'a request from the masjid’s network was recorded as one from outside');
  // Under the app's own path a worker is the app's business: its reach ends at /<app>/.
  const under = await front.inject({ method: 'GET', url: '/shared/sw.js', headers: { ...TO_APPS, 'service-worker': 'script' } });
  assert.equal(under.body, 'app saw /shared/sw.js cookie=');
  // Everything else at the bare address reaches the app as it always did — an app that
  // sends /<app>/ back to /<app> must not bounce for ever, as it did when this was a
  // redirect — and is never cached, by the browser or Cloudflare.
  for (const method of ['GET', 'HEAD', 'POST'] as const) {
    const res = await front.inject({
      method,
      url: '/shared?x=1',
      headers: { ...TO_APPS, 'content-type': 'text/plain' },
      payload: method === 'POST' ? 'x' : undefined,
    });
    assert.equal(res.statusCode, 200, method);
    if (method !== 'HEAD') assert.equal(res.body, 'app saw /shared?x=1 cookie=', method);
    assert.equal(res.headers['cache-control'], 'private, no-store', method);
    assert.equal(res.headers['cloudflare-cdn-cache-control'], 'no-store', method);
  }
  const lanBare = await front.inject({ method: 'GET', url: '/shared', headers: { host: APPS } });
  assert.equal(lanBare.body, 'app saw /shared cookie=');
  assert.equal(lanBare.headers['cache-control'], 'private, no-store', 'cacheable on the masjid’s network');
  // A private app's bare address, without its token, is still nothing at all.
  const strip = (b: string) => b.replace(/[0-9a-f]{6}/g, 'REF');
  const empty = await front.inject({ method: 'GET', url: '/nothing-here', headers: TO_APPS });
  const stranger = await front.inject({ method: 'GET', url: '/private', headers: TO_APPS });
  assert.equal(stranger.statusCode, 404);
  assert.equal(strip(stranger.body), strip(empty.body));
  await front.close();
});

test('isWorkerScriptFetch: the two marks a browser puts on a worker script fetch', () => {
  assert.equal(ingress.isWorkerScriptFetch({ 'service-worker': 'script' }), true);
  assert.equal(ingress.isWorkerScriptFetch({ 'sec-fetch-dest': 'serviceworker' }), true);
  assert.equal(ingress.isWorkerScriptFetch({ 'sec-fetch-dest': 'document' }), false);
  assert.equal(ingress.isWorkerScriptFetch({}), false);
});

test('the bare-address test, spelling by spelling', () => {
  for (const url of ['/shared', '/shared?x', '/SHARED', '/%73hared', '//shared']) {
    assert.equal(ingress.isBareAppAddress(url), true, url);
  }
  for (const url of ['/shared/', '/shared/?x', '/shared/x', '/shared/x/', '/']) {
    assert.equal(ingress.isBareAppAddress(url), false, url);
  }
});

// ── access tokens ──────────────────────────────────────────────────────────

test('AN ACCESS TOKEN OPENS ONE APP, ONLY WHILE ITS REMOTE SESSION LIVES', () => {
  setRemoteAdmin(true);
  const remote = remoteSession();
  const token = tokenFor(remote, 'private');
  // Shaped to pass the check every OpenMasjid app applies before forwarding it.
  assert.match(token, /^[A-Za-z0-9._~%+/=-]{1,4096}$/);
  assert.equal(sessions.appAccessUser(token, 'private'), 'admin');
  assert.equal(sessions.appAccessUser(token, 'shared'), null, 'it is not a key to another app');
  assert.equal(sessions.getSessionUser(token), null, 'it is not a session');
  assert.equal(token.includes(remote.token), false, 'it must not carry the session itself');
  assert.equal(sessions.appAccessToken(lanSession().token, 'private'), null, 'a LAN session cannot make one');
  // Nor can one be FORGED from a LAN session by someone who holds that session's token —
  // which every app on the masjid's network does. The session is still stored and still
  // valid on the LAN; what makes the token worthless is that it is not a remote session.
  const lan = lanSession();
  const forged = `a1.${crypto.createHash('sha256').update(`omos-session-handle:${lan.token}`).digest('base64url').slice(0, 22)}.${crypto
    .createHmac('sha256', lan.token)
    .update('omos-app-access:v1:private')
    .digest('base64url')}`;
  assert.equal(sessions.getSessionUser(lan.token), 'admin', 'precondition: the LAN session is alive');
  assert.equal(sessions.appAccessUser(forged, 'private'), null, 'a token derived from a LAN session was honoured');
  sessions.destroySession(remote.token);
  assert.equal(sessions.appAccessUser(token, 'private'), null, 'it outlived its session');
});

test('appAccessFromCookie finds the valid token among several, and nothing with the door shut', () => {
  setRemoteAdmin(true);
  const remote = remoteSession();
  const token = tokenFor(remote, 'private');
  const header = `${sessions.COOKIE_NAME}=planted; ${sessions.COOKIE_NAME}=${token}`;
  assert.equal(access.appAccessFromCookie(header, 'private'), token, 'a planted value must not shadow the real one');
  assert.equal(access.appAccessFromCookie(header, 'shared'), null);
  setRemoteAdmin(false);
  assert.equal(access.appAccessFromCookie(header, 'private'), null, 'the door is shut');
  setRemoteAdmin(true);
});

test('a Cookie header stuffed with token-shaped values buys a stranger eight checks, no more', () => {
  // Each candidate costs hashing on a root daemon's one thread, and anyone on the
  // internet can send a request to an app path. A browser holds a handful at most.
  setRemoteAdmin(true);
  const token = tokenFor(remoteSession(), 'private');
  const junk = Array.from(
    { length: 8 },
    (_, i) => `${sessions.COOKIE_NAME}=a1.${'A'.repeat(22)}.${String(i).padStart(43, 'B')}`,
  ).join('; ');
  assert.equal(access.appAccessFromCookie(`${junk}; ${sessions.COOKIE_NAME}=${token}`, 'private'), null, 'a ninth value was checked');
  assert.equal(access.appAccessFromCookie(`${sessions.COOKIE_NAME}=${token}; ${junk}`, 'private'), token);
});

test('cookieHeaderForApp: every platform session cookie out, the app\'s own token first', () => {
  const header = `a=1; ${sessions.COOKIE_NAME}=lan; ${sessions.REMOTE_COOKIE_NAME}=remote; b=2; ${sessions.COOKIE_NAME} =spaced`;
  assert.equal(access.cookieHeaderForApp(header, null), 'a=1; b=2');
  assert.equal(access.cookieHeaderForApp(header, 'TOKEN'), `${sessions.COOKIE_NAME}=TOKEN; a=1; b=2`);
  assert.equal(access.cookieHeaderForApp(`${sessions.COOKIE_NAME}=x`, null), undefined, 'nothing left: no header at all');
  assert.equal(access.cookieHeaderForApp(undefined, null), undefined);
});

// ── the Open hand-off ──────────────────────────────────────────────────────

test('A TICKET IS ONE-USE, SHORT-LIVED, AND ONLY FOR A REMOTE SESSION', () => {
  setRemoteAdmin(true);
  const remote = remoteSession();
  assert.equal(access.mintAppTicket(lanSession().token, 'private'), null, 'a LAN session cannot mint one');
  const t1 = access.mintAppTicket(remote.token, 'private')!;
  assert.ok(t1 && t1.length >= 40);
  assert.equal(access.redeemAppTicket(t1)?.appId, 'private');
  assert.equal(access.redeemAppTicket(t1), null, 'spent');
  const t2 = access.mintAppTicket(remote.token, 'private', 1_000)!;
  assert.equal(access.redeemAppTicket(t2, 1_000 + access.TICKET_TTL_MS + 1), null, 'expired');
});

test('OPEN SETS THE APP\'S TOKEN ON THE APPS\' HOSTNAME, FOR ITS PATH ONLY, AND SENDS THE BROWSER ON', async () => {
  setRemoteAdmin(true);
  const front = await frontDoor();
  const remote = remoteSession();
  const ticket = access.mintAppTicket(remote.token, 'private')!;
  const res = await front.inject({ method: 'GET', url: `/_omos/open?t=${ticket}`, headers: TO_APPS });
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, '/private/');
  const set = String(res.headers['set-cookie']);
  assert.match(set, new RegExp(`^${sessions.COOKIE_NAME}=a1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; Path=/private; Max-Age=\\d+; Secure; HttpOnly; SameSite=Lax$`));
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  // The cookie it set opens the app.
  const token = set.split(';')[0]!.split('=').slice(1).join('=');
  assert.equal(sessions.appAccessUser(token, 'private'), 'admin');
  // Spent: the same link does nothing a second time.
  const again = await front.inject({ method: 'GET', url: `/_omos/open?t=${ticket}`, headers: TO_APPS });
  assert.equal(again.statusCode, 410);
  assert.equal(again.headers['set-cookie'], undefined);
  await front.close();
});

test('OPEN IS REFUSED on the admin hostname, on the LAN, and with the door shut', async () => {
  setRemoteAdmin(true);
  const front = await frontDoor();
  const remote = remoteSession();
  const tryWith = async (headers: Record<string, string>) =>
    front.inject({ method: 'GET', url: `/_omos/open?t=${access.mintAppTicket(remote.token, 'private')}`, headers });
  for (const [what, headers] of [
    ['the admin hostname', TO_ADMIN],
    ['the LAN', { host: APPS }],
  ] as const) {
    const res = await tryWith(headers);
    assert.equal(res.statusCode, 404, what);
    assert.equal(res.headers['set-cookie'], undefined, `${what}: an app cookie was set`);
  }
  const ticket = access.mintAppTicket(remote.token, 'private')!;
  setRemoteAdmin(false);
  const off = await front.inject({ method: 'GET', url: `/_omos/open?t=${ticket}`, headers: TO_APPS });
  assert.equal(off.statusCode, 404);
  setRemoteAdmin(true);
  // A ticket whose session has since ended opens nothing.
  const t2 = access.mintAppTicket(remote.token, 'private')!;
  sessions.destroySession(remote.token);
  const ended = await front.inject({ method: 'GET', url: `/_omos/open?t=${t2}`, headers: TO_APPS });
  assert.equal(ended.statusCode, 410);
  assert.equal(ended.headers['set-cookie'], undefined);
  await front.close();
});

// ── single sign-on with an access token ────────────────────────────────────

test('THE PLATFORM\'S SIGN-IN CHECK ACCEPTS AN ACCESS TOKEN FROM ITS OWN APP, AND NO OTHER', async () => {
  setRemoteAdmin(true);
  const { registerFabric } = req('../src/api/fabric') as typeof import('../src/api/fabric');
  const server = Fastify();
  await server.register(fastifyCookie);
  registerFabric(server);
  await server.ready();
  const remote = remoteSession();
  const token = tokenFor(remote, 'private');
  const check = async (secret: string) =>
    JSON.parse(
      (
        await server.inject({
          method: 'GET',
          url: '/api/auth/session',
          headers: { 'x-openmasjid-app-secret': secret, cookie: `${sessions.COOKIE_NAME}=${token}` },
        })
      ).body,
    ) as { authenticated: boolean };
  assert.equal((await check('private-key')).authenticated, true, 'the app the token was made for');
  assert.equal((await check('shared-key')).authenticated, false, 'ANOTHER app presenting it');
  setRemoteAdmin(false);
  assert.equal((await check('private-key')).authenticated, false, 'with the door shut');
  setRemoteAdmin(true);
  await server.close();
});

// ── the session rule ───────────────────────────────────────────────────────

test('FROM THE TUNNEL, ONLY A SESSION THAT PASSED THE SECOND FACTOR COUNTS', () => {
  const lan = lanSession();
  const remote = remoteSession();
  assert.equal(sessions.getSessionUserFor(lan.token, { viaTunnel: false }), 'admin', 'a LAN session works on the LAN');
  assert.equal(sessions.getSessionUserFor(remote.token, { viaTunnel: false }), 'admin', 'a remote session works on the LAN too');
  assert.equal(sessions.getSessionUserFor(remote.token, { viaTunnel: true }), 'admin');
  assert.equal(sessions.getSessionUserFor(lan.token, { viaTunnel: true }), null, 'A LAN SESSION WAS ACCEPTED FROM THE TUNNEL');
  // Refused there, not discarded: it still works where it was made.
  assert.equal(sessions.getSessionUser(lan.token), 'admin');
});

test('...AND ONLY WHILE THAT SECOND FACTOR IS UNCHANGED — except for the session that changed it', () => {
  const remote = remoteSession();
  const caller = remoteSession();
  const lan = lanSession();
  tf.regenerateBackupCodes();
  assert.equal(sessions.getSessionUserFor(remote.token, { viaTunnel: true }), null, 'a remote session outlived its factor');
  assert.equal(sessions.getSessionUserFor(remote.token, { viaTunnel: false }), 'admin', 'it is not discarded on the LAN');
  assert.equal(sessions.getSessionUserFor(lan.token, { viaTunnel: false }), 'admin', 'a LAN session is not affected');
  // The admin who made the change from outside keeps their own session.
  sessions.rebindRemoteSession(caller.token, tf.secondFactorEpoch());
  assert.equal(sessions.getSessionUserFor(caller.token, { viaTunnel: true }), 'admin');
  assert.equal(sessions.getSessionUserFor(remote.token, { viaTunnel: true }), null, 'and only them');
  // A LAN session cannot be "rebound" into a remote one.
  sessions.rebindRemoteSession(lan.token, tf.secondFactorEpoch());
  assert.equal(sessions.getSessionUserFor(lan.token, { viaTunnel: true }), null);
});

/** A request the front door handed over, for the given hostname and cookie. */
function handedOver(host: string, cookie: string) {
  const raw = {} as import('node:http').IncomingMessage;
  ra.markHandedOver(raw);
  return { raw, headers: { ...VIA, host, cookie }, url: '/trpc/auth.me', ip: '172.17.0.1', query: {} };
}

test('the dashboard API (tRPC) applies the rule — and reads ONLY the remote cookie, only on the admin hostname', () => {
  setRemoteAdmin(true);
  const ctxFor = (r: object) => createContext({ req: r, res: undefined } as never);
  const lan = lanSession();
  const remote = remoteSession();
  // Not handed over (the LAN): the LAN cookie, as always.
  assert.equal(ctxFor({ headers: { cookie: `${sessions.COOKIE_NAME}=${lan.token}` }, url: '/trpc/auth.me', ip: 'x', query: {} }).username, 'admin');
  // Handed over: the remote cookie on the admin hostname, nothing else.
  const remoteCookie = `${sessions.REMOTE_COOKIE_NAME}=${remote.token}`;
  assert.equal(ctxFor(handedOver(ADMIN, remoteCookie)).username, 'admin');
  assert.equal(ctxFor(handedOver(ADMIN, `${sessions.COOKIE_NAME}=${remote.token}`)).username, null, 'the LAN cookie name, from outside');
  assert.equal(ctxFor(handedOver(ADMIN, `${sessions.REMOTE_COOKIE_NAME}=${lan.token}`)).username, null, 'a LAN session, from outside');
  assert.equal(ctxFor(handedOver(APPS, remoteCookie)).username, null, "on the apps' hostname");
  setRemoteAdmin(false);
  assert.equal(ctxFor(handedOver(ADMIN, remoteCookie)).username, null, 'with the door shut');
  setRemoteAdmin(true);
});

test("the dashboard's raw routes apply it too — files, terminals, backups, restore, updates", () => {
  // They share one helper, so checking it checks them all; and every one of them must
  // use it rather than reading the session itself.
  setRemoteAdmin(true);
  const { requestUser } = req('../src/api/ws-auth') as typeof import('../src/api/ws-auth');
  const lan = lanSession();
  const remote = remoteSession();
  const lanReq = (headers: Record<string, string>) => ({ raw: {}, headers, cookies: {} }) as never;
  assert.equal(requestUser(lanReq({ cookie: `${sessions.COOKIE_NAME}=${lan.token}` })), 'admin');
  assert.equal(requestUser(lanReq({ ...VIA, cookie: `${sessions.COOKIE_NAME}=${lan.token}` })), null);
  const over = (host: string, cookie: string) => ({ ...handedOver(host, cookie), cookies: {} }) as never;
  assert.equal(requestUser(over(ADMIN, `${sessions.REMOTE_COOKIE_NAME}=${remote.token}`)), 'admin');
  assert.equal(requestUser(over(APPS, `${sessions.REMOTE_COOKIE_NAME}=${remote.token}`)), null);
  setRemoteAdmin(false);
  assert.equal(requestUser(over(ADMIN, `${sessions.REMOTE_COOKIE_NAME}=${remote.token}`)), null, 'the door is shut');
  setRemoteAdmin(true);

  const src = path.join(__dirname, '..', 'src');
  for (const file of ['api/files.ts', 'api/restore.ts', 'api/branding.ts', 'api/terminals.ts', 'api/update.ts', 'api/app-update.ts', 'index.ts']) {
    const text = fs.readFileSync(path.join(src, file), 'utf8');
    assert.doesNotMatch(text, /getSessionUser\(/, `${file} reads the session itself instead of through requestUser`);
  }
});

test('EVERY PROTECTED CALL FROM OUTSIDE RE-CHECKS THE DOOR AND THE SESSION — not just the first', async () => {
  // A WebSocket context is built once, when the connection opens, and lives as long as
  // it does. A review found such a connection still able to call anything — including
  // the switch that turns remote administration back on — after it had been turned off.
  const { router, protectedProcedure } = req('../src/trpc/trpc') as typeof import('../src/trpc/trpc');
  const r = router({ ping: protectedProcedure.query(() => 'pong') });
  const call = (ctx: Record<string, unknown>) => r.createCaller(ctx as never).ping();
  const refused = (e: { code?: string }) => e.code === 'UNAUTHORIZED';
  setRemoteAdmin(true);
  const remote = remoteSession();
  const fromOutside = (over: Record<string, unknown> = {}) => ({
    username: 'admin',
    sessionToken: remote.token,
    csrf: remote.csrf,
    isWebSocket: true,
    ip: '172.17.0.1',
    host: ADMIN,
    viaTunnel: true,
    handedOver: true,
    remoteIp: '203.0.113.7',
    ...over,
  });
  assert.equal(await call(fromOutside()), 'pong');
  setRemoteAdmin(false);
  await assert.rejects(call(fromOutside()), refused, 'a connection opened before the door shut kept working');
  setRemoteAdmin(true);
  assert.equal(await call(fromOutside()), 'pong');
  await assert.rejects(call(fromOutside({ host: APPS })), refused, "on the apps' hostname");
  // On the masjid's network the door does not apply at all.
  const lan = lanSession();
  setRemoteAdmin(false);
  const fromLan = { ...fromOutside({ sessionToken: lan.token, csrf: lan.csrf, host: '192.168.1.50' }), viaTunnel: false, handedOver: false };
  assert.equal(await call(fromLan), 'pong', 'the door must not touch the LAN');
  setRemoteAdmin(true);
  // A change to the second factor ends the remote one on its next call.
  tf.regenerateBackupCodes();
  await assert.rejects(call(fromOutside()), refused, 'a connection outlived the factor its session proved');
});

test('a terminal re-checks before every keystroke, and protected calls re-check the door', () => {
  const terminals = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'terminals.ts'), 'utf8');
  assert.match(terminals, /socket\.on\('message', \(data: Buffer\) => \{\s*if \(!stillAllowed\(\)\)/, 'the check must come first');
  assert.match(terminals, /bridge\(socket, await rootTerminal\(\), \(\) => Boolean\(requestUser\(req\)\)/);
  assert.match(terminals, /bridge\(socket, await appTerminal\(id\), \(\) => Boolean\(requestUser\(req\)\)/);
  const trpc = fs.readFileSync(path.join(__dirname, '..', 'src', 'trpc', 'trpc.ts'), 'utf8');
  assert.match(trpc, /ctx\.handedOver && !\(remoteDoorOpen\(ctx\.host\) && isRemoteSession\(ctx\.sessionToken\)\)/);
});

test('a remote session is remembered across a restart, with its factor — and a hand-edited one is not', () => {
  const remote = remoteSession();
  const file = sessions.SESSIONS_FILE;
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions: Array<{ token: string; remote?: unknown; tf?: unknown }> };
  const mine = stored.sessions.find((x) => x.token === remote.token);
  assert.equal(mine?.remote, true, 'the flag was not saved');
  assert.equal(mine?.tf, tf.secondFactorEpoch(), 'the factor it proved was not saved');

  // A LAN session promoted by editing the file must not become usable from outside.
  const lan = lanSession();
  const edited = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions: Array<{ token: string; remote?: unknown }> };
  edited.sessions.find((x) => x.token === lan.token)!.remote = 'yes';
  fs.writeFileSync(file, JSON.stringify(edited));

  const sessionsPath = req.resolve('../src/auth/sessions');
  const shared = req.cache[sessionsPath];
  delete req.cache[sessionsPath];
  try {
    const rebooted = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
    assert.equal(rebooted.getSessionUserFor(remote.token, { viaTunnel: true }), 'admin', 'a remote session did not survive a restart');
    assert.equal(rebooted.getSessionUserFor(lan.token, { viaTunnel: true }), null, '"remote": "yes" in the file was believed');
    assert.equal(rebooted.getSessionUserFor(lan.token, { viaTunnel: false }), 'admin');
  } finally {
    req.cache[sessionsPath] = shared;
  }
});

test('completing a remote sign-in mints a REMOTE session bound to the factor it proved', () => {
  // completeLogin is the only way a tunnel sign-in becomes a session, so that is
  // exactly where `remote` is set — and a password change carries it over.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'trpc', 'routers', 'auth.ts'), 'utf8');
  assert.match(
    src,
    /createSession\(\s*claim\.username,\s*claim\.cred,\s*ctx\.viaTunnel \? \{ remote: true, tf: result\.epoch, handedOver: ctx\.handedOver \} : \{\},?\s*\)/,
  );
  assert.match(src, /remoteGrant !== null \? \{ remote: true, tf: remoteGrant\.tf, handedOver: remoteGrant\.handedOver \} : \{\}/);
  assert.match(src, /createSession\(input\.username, verified\.cred\)/, 'the password-only sign-in must stay a LAN session');
  assert.match(src, /createSession\(input\.name, credentialFingerprint\(hash\)\)/, 'first-run setup must stay a LAN session');
});

// ── where Open goes ────────────────────────────────────────────────────────

test('AT THE MASJID an app opens at its own port; FROM OUTSIDE there is no URL to build', () => {
  const lan = { remote: false, appOrigin: null, hostname: '192.168.1.50' };
  const out = { remote: true, appOrigin: `https://${APPS}`, hostname: ADMIN };
  const display = { openPort: 8080, https: false, path: 'display', exposed: true };
  assert.equal(appUrl.appOpenUrl(display, lan), 'http://192.168.1.50:8080');
  assert.equal(appUrl.appOpenUrl({ ...display, https: true, openPort: 9443 }, lan), 'https://192.168.1.50:9443');
  // From outside an app is opened through a one-use address the platform hands out,
  // on the apps' hostname — never one built here, and never on the dashboard's.
  assert.equal(appUrl.appOpenUrl(display, out), null);
});

test("FROM OUTSIDE, only a SHARED app's public files are addressed — on the APPS' hostname", () => {
  const out = { remote: true, appOrigin: `https://${APPS}`, hostname: ADMIN };
  assert.equal(appUrl.appBaseUrl({ openPort: 80, path: 'display', exposed: true }, out), `https://${APPS}/display`);
  assert.equal(appUrl.appBaseUrl({ openPort: 80, path: 'display', exposed: false }, out), null, 'a private app');
  assert.equal(appUrl.appBaseUrl({ openPort: 80, path: 'display' }, out), null, 'unknown means private');
  assert.equal(appUrl.appBaseUrl({ openPort: 80, path: 'display', exposed: true }, { ...out, appOrigin: null }), null);
  assert.equal(appUrl.appBaseUrl({ openPort: null, path: 'db', exposed: true }, out), null, 'no web port');
});

test("a tunnel request never teaches the platform this box's address", () => {
  // Apps are told to reach the dashboard at the address the admin's browser used, which
  // the context learns from signed-in requests. From outside, that is the public
  // hostname — never an address an app container can use, and not the remote side's
  // to choose. The control proves the learning path itself works here.
  const { desiredAddress } = req('../src/system/platform-address') as typeof import('../src/system/platform-address');
  const ctxAt = (host: string, token: string, extra: Record<string, string>) =>
    createContext({
      req: { headers: { ...extra, host, cookie: `${sessions.COOKIE_NAME}=${token}` }, url: '/trpc/auth.me', ip: '172.17.0.1', query: {} },
      res: undefined,
    } as never);
  ctxAt('10.66.66.67', lanSession().token, {});
  assert.equal(desiredAddress(), '10.66.66.67', 'precondition: a LAN request is learnt from');
  ctxAt('10.66.66.66', remoteSession().token, VIA);
  assert.equal(desiredAddress(), '10.66.66.67', 'an address was learnt from a request that came through the tunnel');
});


test('A REVERSE PROXY ON THE MASJID\'S OWN NETWORK IS NOT "OUTSIDE" — apps open at their own ports there', async () => {
  // Behind nginx or Caddy on the masjid's network: `X-Forwarded-Proto: https`, no
  // cf-ray, never handed over by the front door. The header still demands the second
  // factor at sign-in (the security rules keep it); what the dashboard DOES must not
  // change — every Open button went down the from-outside path and was refused.
  setRemoteAdmin(true);
  const { authRouter } = req('../src/trpc/routers/auth') as typeof import('../src/trpc/routers/auth');
  const { appsRouter } = req('../src/trpc/routers/apps') as typeof import('../src/trpc/routers/apps');
  const session = remoteSession(); // as a sign-in through such a proxy makes one
  const proxied = createContext({
    req: {
      headers: { 'x-forwarded-proto': 'https', host: 'omos.lan', cookie: `${sessions.COOKIE_NAME}=${session.token}`, 'x-omos-csrf': session.csrf },
      url: '/trpc/auth.me',
      ip: '172.17.0.1',
      query: {},
    },
    res: undefined,
  } as never);
  assert.equal(proxied.viaTunnel, true, 'precondition: the header still counts for the security rules');
  assert.equal(proxied.handedOver, false);
  assert.equal(proxied.username, 'admin');
  const me = await authRouter.createCaller(proxied).me();
  assert.equal(me.remote, false, 'a masjid behind its own reverse proxy was told it is outside');
  assert.equal(me.appOrigin, null);
  await assert.rejects(appsRouter.createCaller(proxied).openRemote({ id: 'private' }), (e: { code?: string }) => e.code === 'FORBIDDEN');

  // The remote dashboard itself — handed over, on the admin hostname — is outside.
  const over = createContext({ req: handedOver(ADMIN, `${sessions.REMOTE_COOKIE_NAME}=${session.token}`), res: undefined } as never);
  const meOver = await authRouter.createCaller(over).me();
  assert.equal(meOver.remote, true);
  assert.equal(meOver.appOrigin, `https://${APPS}`);
});

test("A BROWSER THAT LEAVES PART-WAY ENDS THE APP'S RESPONSE TOO — a live stream is not held open for nobody", { timeout: 10_000 }, async () => {
  // pipe() only pauses the app's response when the browser goes, so a live event stream,
  // a long poll or a big download held the app's connection until the app gave up.
  setRemoteAdmin(true);
  const front = await frontDoor();
  await front.listen({ port: 0, host: '127.0.0.1' });
  try {
    const port = (front.server.address() as AddressInfo).port;
    for (const headers of [TO_APPS, { host: APPS }]) {
      const before = streamEnds.length;
      const browser = http.get({ host: '127.0.0.1', port, path: '/shared/stream', headers });
      browser.on('error', () => {});
      const first = await new Promise<string>((resolve) => browser.once('response', (res) => res.once('data', (d) => resolve(String(d)))));
      assert.equal(first, 'data: hello\n\n');
      assert.equal(streamEnds.length, before + 1, 'setup: the app saw the stream begin');
      browser.destroy(); // the browser leaves
      const ended = await Promise.race([streamEnds.at(-1)!, new Promise<false>((r) => setTimeout(() => r(false), 3000))]);
      assert.equal(ended, true, `${headers === TO_APPS ? 'through the tunnel' : "on the masjid's network"}: the app's stream was left open`);
    }
  } finally {
    await front.close();
  }
});

test('A SIGN-IN THROUGH A REVERSE PROXY AT THE MASJID IS NEVER USABLE FROM OUTSIDE — however its cookie travels', async () => {
  // Through the masjid's own proxy sign-in still demands the second factor, and the
  // session is remote — but it sits in the LAN cookie that every app opened from that
  // page receives. A review showed any one of those apps could compute, by the public
  // formula, an access token for EVERY app and use it from the internet, private apps
  // included. Only a session the remote dashboard made itself counts outside now.
  setRemoteAdmin(true);
  const proxy = sessions.createSession('admin', sessions.currentCredential(), {
    remote: true,
    tf: tf.secondFactorEpoch(),
    handedOver: false,
  });
  assert.equal(sessions.getSessionUserFor(proxy.token, { viaTunnel: true }), 'admin', 'it must go on working through the proxy');
  assert.equal(sessions.isRemoteSession(proxy.token), false);
  assert.equal(sessions.appAccessToken(proxy.token, 'private'), null);
  // What an app holding that cookie could compute.
  const handle = crypto.createHash('sha256').update(`omos-session-handle:${proxy.token}`).digest('base64url').slice(0, 22);
  const mac = crypto.createHmac('sha256', proxy.token).update('omos-app-access:v1:private').digest('base64url');
  const forged = `a1.${handle}.${mac}`;
  assert.equal(sessions.appAccessUser(forged, 'private'), null, 'a token derived from a proxy sign-in was honoured');
  const front = await frontDoor();
  const res = await front.inject({ method: 'GET', url: '/private/', headers: { ...TO_APPS, cookie: `${sessions.COOKIE_NAME}=${forged}` } });
  assert.equal(res.statusCode, 404, 'a private app was served to a token derived from a proxy sign-in');
  await front.close();
  // Nor does the remote dashboard take it, in the one cookie it reads.
  const over = createContext({ req: handedOver(ADMIN, `${sessions.REMOTE_COOKIE_NAME}=${proxy.token}`), res: undefined } as never);
  assert.equal(over.username, null, 'the remote dashboard honoured a session it did not make');
  // The same formula on a session the remote dashboard DID make is the real thing.
  const real = remoteSession();
  assert.equal(sessions.appAccessUser(sessions.appAccessToken(real.token, 'private'), 'private'), 'admin');
});
