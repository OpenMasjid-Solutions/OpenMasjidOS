// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * From outside, the dashboard shares its address with the app pages — and the KEY is
 * what keeps them apart.
 *
 * A browser draws its line around "this site's own data" by scheme + host + port, never
 * by path, so on the tunnel address every app page is the dashboard's own origin: its
 * script can read this origin's storage and send requests that carry the admin's cookie.
 * Signed-in requests also need the dashboard key, so the whole property is that no app
 * page can ever get the key (system/remote-admin.ts, the key rule in its header):
 *  - the remote dashboard keeps it in the tab's memory, never in storage;
 *  - the server hands it back only inside the dashboard's own page, and only for a
 *    top-level load the browser marks as one — never a fetch, a frame or an embed;
 *  - that page cuts off any window an app page opened on it (COOP), and refuses frames.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Fastify from 'fastify';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-remote-key-'));
process.env.OPENMASJID_DATA_DIR = DATA;

const req = createRequire(__filename);
const ra = req('../src/system/remote-admin') as typeof import('../src/system/remote-admin');
const staticUi = req('../src/api/static-ui') as typeof import('../src/api/static-ui');
const settings = req('../src/settings/store') as typeof import('../src/settings/store');
const store = req('../src/auth/store') as typeof import('../src/auth/store');
const tf = req('../src/auth/twofactor') as typeof import('../src/auth/twofactor');
const totpLib = req('../src/auth/totp') as typeof import('../src/auth/totp');
const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');

const APPS = 'omos.example.org';
/** A request the front door handed over: through Cloudflare, marked by the test hook below. */
const OUT = { 'cf-ray': '7a1b2c3d4e5f-LHR', 'cf-visitor': '{"scheme":"https"}', host: APPS, 'x-test-handed-over': '1' };
/** What a browser sends when the admin loads the page themselves. No script can set these. */
const NAV = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };

store.setCredentials('admin', '$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb');
settings.updateCloudflare({ enabled: true, remoteAdmin: true, domain: APPS });
{
  const { secret } = tf.beginEnrolment('admin');
  tf.confirmEnrolment(totpLib.totp(secret, Date.now()));
}
assert.equal(ra.remoteAdminEnabled(), true, 'setup: the door is open');

const remote = sessions.createSession('admin', sessions.currentCredential(), {
  remote: true,
  tf: tf.secondFactorEpoch(),
  handedOver: true,
});
const remoteCookie = { cookie: `${sessions.REMOTE_COOKIE_NAME}=${remote.token}` };

const UI = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-remote-key-ui-'));
const INDEX = '<!doctype html><html lang="en"><head><title>OpenMasjidOS</title></head><body><div id="root"></div></body></html>';
fs.writeFileSync(path.join(UI, 'index.html'), INDEX);
fs.mkdirSync(path.join(UI, 'assets'));
fs.writeFileSync(path.join(UI, 'assets', 'app.js'), 'console.log(1)');

const server = Fastify();
before(async () => {
  // Stands in for the front door's hand-over (index.ts), which marks the request before
  // the dashboard listener's own hooks see it.
  server.addHook('onRequest', (r, _reply, done) => {
    if (r.headers['x-test-handed-over']) ra.markHandedOver(r.raw);
    done();
  });
  assert.equal(await staticUi.registerStaticUI(server, UI), true);
});
after(() => server.close());

async function load(url: string, headers: Record<string, string>) {
  const res = await server.inject({ method: 'GET', url, headers });
  const m = /<meta name="omos-key" content="([^"]*)">/.exec(res.body);
  return { res, key: m ? m[1] : null };
}

test('THE DASHBOARD HANDS ITS KEY BACK ONLY INSIDE ITS OWN PAGE, LOADED BY THE BROWSER ITSELF', async () => {
  for (const url of ['/', '/index.html', '/settings', '/settings/remote', '/store', '/files', '/%73ettings']) {
    const { res, key } = await load(url, { ...OUT, ...NAV, ...remoteCookie });
    assert.equal(res.statusCode, 200, url);
    assert.equal(key, remote.csrf, `${url}: a reload from outside lost the key`);
    // Nothing an app page could use to reach it.
    assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin', url);
    assert.equal(res.headers['x-frame-options'], 'DENY', url);
    assert.equal(res.headers['content-security-policy'], "frame-ancestors 'none'", url);
    assert.equal(res.headers['cache-control'], 'no-store', url);
    assert.match(res.body, /<div id="root"><\/div>/, `${url}: not the dashboard`);
  }
});

test('AN APP PAGE ASKING FOR THE DASHBOARD GETS IT WITHOUT THE KEY — a fetch, a frame, an embed', async () => {
  // What a script on an app page sharing this address can cause the browser to send.
  // Every one carries the admin's cookie, because it is the same site.
  const asked: Record<string, string>[] = [
    {}, // an old browser, or anything that says nothing
    { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' }, // fetch() / XHR
    { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'same-origin' },
    { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' },
    { 'sec-fetch-dest': 'frame', 'sec-fetch-mode': 'navigate' },
    { 'sec-fetch-dest': 'object', 'sec-fetch-mode': 'navigate' },
    { 'sec-fetch-dest': 'embed', 'sec-fetch-mode': 'navigate' },
    { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'no-cors' },
  ];
  for (const h of asked) {
    const { res, key } = await load('/', { ...OUT, ...h, ...remoteCookie });
    assert.equal(key, '', `the key was handed to ${JSON.stringify(h)}`);
    // Still marked as the remote dashboard, so it keeps whatever key it gets in memory.
    assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
  }
});

test('no key without a live remote session through an open door', async () => {
  // A stranger.
  assert.equal((await load('/', { ...OUT, ...NAV })).key, '');
  // A LAN session presented from outside counts for nothing there.
  const lan = sessions.createSession('admin', sessions.currentCredential());
  assert.equal((await load('/', { ...OUT, ...NAV, cookie: `${sessions.REMOTE_COOKIE_NAME}=${lan.token}` })).key, '');
  // A remote session made through a reverse proxy at the masjid is never usable from outside.
  const proxied = sessions.createSession('admin', sessions.currentCredential(), {
    remote: true,
    tf: tf.secondFactorEpoch(),
    handedOver: false,
  });
  assert.equal((await load('/', { ...OUT, ...NAV, cookie: `${sessions.REMOTE_COOKIE_NAME}=${proxied.token}` })).key, '');
  // The door shut.
  settings.updateCloudflare({ remoteAdmin: false });
  try {
    assert.equal((await load('/', { ...OUT, ...NAV, ...remoteCookie })).key, '');
  } finally {
    settings.updateCloudflare({ remoteAdmin: true });
  }
  assert.equal((await load('/', { ...OUT, ...NAV, ...remoteCookie })).key, remote.csrf, 'and back');
});

test("on the masjid's network nothing changes: the plain page, the key stays where it always was", async () => {
  const { res, key } = await load('/', { host: '192.168.1.50', ...NAV, ...remoteCookie });
  assert.equal(key, null, 'a LAN page was marked as the remote dashboard');
  assert.equal(res.body, INDEX);
  assert.equal(res.headers['cross-origin-opener-policy'], undefined);
  // And the remote dashboard's own scripts are served as files, not as the page.
  const asset = await server.inject({ method: 'GET', url: '/assets/app.js', headers: { ...OUT, ...NAV, ...remoteCookie } });
  assert.equal(asset.body, 'console.log(1)');
});

test('FROM OUTSIDE THE PLAIN PAGE IS NEVER SERVED — a miss is a 404, not the dashboard without its headers', async () => {
  // The SPA fallback answered a handed-over `/assets/x` with plain index.html: no meta (so
  // LAN mode, storing the key), no COOP, frameable. An app page could frame it, the admin
  // signs in there, and the key lands in storage that app page can read.
  // The dot-segment spellings matter most: the gate hands them over because they RESOLVE
  // to a dashboard page, while the page hook reads their first segment and declines them.
  const misses = [
    '/assets/missing.js',
    '/assets/../settings',
    '/assets/%2e%2e/settings',
    '/%61ssets/x',
    '/assets/',
    '/x/../settings',
    '/x/%2e%2e/settings',
    '/nope/../store',
  ];
  // Over real HTTP: inject() normalises `..` before routing, which is exactly what a raw
  // request target does not get.
  await server.listen({ port: 0, host: '127.0.0.1' });
  const port = (server.server.address() as import('node:net').AddressInfo).port;
  const get = (target: string, headers: Record<string, string>) =>
    new Promise<{ status: number; coop: unknown; body: string }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: target, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, coop: res.headers['cross-origin-opener-policy'], body }));
      });
      r.on('error', reject);
      r.end();
    });
  for (const url of misses) {
    for (const h of [NAV, {}]) {
      const res = await get(url, { ...OUT, ...h, ...remoteCookie });
      const keyRulePage = res.coop === 'same-origin' && /name="omos-key"/.test(res.body);
      const plainPage = /<div id="root"><\/div>/.test(res.body) && !keyRulePage;
      assert.ok(!plainPage, `${url} served the plain dashboard page from outside`);
      assert.ok(res.status === 404 || keyRulePage, `${url}: ${res.status} without the key rule's page`);
    }
  }
  // The dashboard listener's own header hook must not undo the page's framing refusal.
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.match(index, /if \(!reply\.getHeader\('x-frame-options'\)\) reply\.header\('X-Frame-Options', 'SAMEORIGIN'\)/);
});

test('sessionKey answers only for a live session', () => {
  assert.equal(sessions.sessionKey(remote.token), remote.csrf);
  assert.equal(sessions.sessionKey('not-a-session'), null);
  assert.equal(sessions.sessionKey(null), null);
  const gone = sessions.createSession('admin', sessions.currentCredential());
  sessions.destroySession(gone.token);
  assert.equal(sessions.sessionKey(gone.token), null);
});

test('FROM OUTSIDE, auth.me SAYS WHO IS SIGNED IN ONLY TO A CALLER HOLDING THE KEY — any app page can call it', async () => {
  const { createContext } = req('../src/trpc/context') as typeof import('../src/trpc/context');
  const { authRouter } = req('../src/trpc/routers/auth') as typeof import('../src/trpc/routers/auth');
  const me = (headers: Record<string, string>, handedOver = true) => {
    const raw = {} as import('node:http').IncomingMessage;
    if (handedOver) ra.markHandedOver(raw);
    const r = { raw, headers, url: '/trpc/auth.me', ip: '172.17.0.1', query: {} };
    return authRouter.createCaller(createContext({ req: r, res: undefined } as never)).me();
  };
  // An app page's script: the admin's cookie rides along, the key does not.
  const asApp = await me({ ...OUT, ...remoteCookie });
  assert.equal(asApp.authenticated, false, "an app page was told it is the admin's dashboard");
  for (const k of ['username', 'name', 'email', 'phone', 'version', 'appOrigin'] as const) {
    assert.equal(asApp[k], null, `${k} was handed to an app page`);
  }
  assert.equal((await me({ ...OUT, ...remoteCookie, 'x-omos-csrf': 'not-the-key' })).authenticated, false);
  // The dashboard itself.
  const own = await me({ ...OUT, ...remoteCookie, 'x-omos-csrf': remote.csrf });
  assert.equal(own.authenticated, true);
  assert.equal(own.username, 'admin');
  assert.ok(own.version);
  // And never the key, to anyone.
  assert.ok(!JSON.stringify(own).includes(remote.csrf), 'auth.me returned the key');
  // On the masjid's network an app is another origin, so nothing changes there.
  const lan = sessions.createSession('admin', sessions.currentCredential());
  const atMasjid = await me({ host: '192.168.1.50', cookie: `${sessions.COOKIE_NAME}=${lan.token}` }, false);
  assert.equal(atMasjid.authenticated, true);
});

test('A FILE VIEWED FROM THE FILE EXPLORER NEVER SENDS ITS ADDRESS ON — the key is in it', async () => {
  // An SVG opened in a tab may load images from the same origin, which from outside is
  // every app's too: a Referer would hand the app the ?k= in this address.
  const { registerFiles } = req('../src/api/files') as typeof import('../src/api/files');
  fs.writeFileSync(path.join(DATA, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><image href="/donations/x.png"/></svg>');
  const files = Fastify();
  files.addHook('onRequest', (r, _reply, done) => {
    if (r.headers['x-test-handed-over']) ra.markHandedOver(r.raw);
    done();
  });
  registerFiles(files);
  try {
    const url = `/api/files/raw?path=/pic.svg&k=${encodeURIComponent(remote.csrf)}`;
    const res = await files.inject({ method: 'GET', url, headers: { ...OUT, ...remoteCookie } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  } finally {
    await files.close();
  }
});

// ── the dashboard's side: ui/src/lib/session.ts ─────────────────────────────

type Globals = Record<string, unknown>;
const SESSION_TS = path.join(__dirname, '..', '..', 'ui', 'src', 'lib', 'session.ts');
/** session.ts's exports, written out: importing its type would pull a DOM module into the core's typecheck. */
type SessionModule = {
  getCsrf(): string;
  setCsrf(value: string | undefined | null): void;
  clearCsrf(): void;
  withKey(pathOrUrl: string): string;
};

/** Load session.ts afresh against a page with (or without) the remote marker. */
function loadSessionModule(meta: string | null, stored: Record<string, string>) {
  const calls: string[] = [];
  const g = globalThis as unknown as Globals;
  g.localStorage = {
    getItem: (k: string) => (k in stored ? stored[k] : null),
    setItem: (k: string, v: string) => {
      calls.push(`set ${k}`);
      stored[k] = v;
    },
    removeItem: (k: string) => {
      calls.push(`remove ${k}`);
      delete stored[k];
    },
  };
  g.document = { querySelector: (sel: string) => (meta !== null && sel === 'meta[name="omos-key"]' ? { getAttribute: () => meta } : null) };
  delete req.cache[req.resolve(SESSION_TS)];
  const mod = req(SESSION_TS) as SessionModule;
  return { mod, calls };
}

after(() => {
  const g = globalThis as unknown as Globals;
  delete g.localStorage;
  delete g.document;
});

test('FROM OUTSIDE THE DASHBOARD NEVER STORES THE KEY — it lives in the page’s memory', () => {
  const stored: Record<string, string> = { 'omos.dashboardKey': 'left-from-before' };
  const { mod, calls } = loadSessionModule('KEY-FROM-PAGE', stored);
  assert.equal(mod.getCsrf(), 'KEY-FROM-PAGE');
  assert.equal(stored['omos.dashboardKey'], undefined, 'a key left in storage was not cleared');
  mod.setCsrf('KEY-FROM-SIGN-IN');
  assert.equal(mod.getCsrf(), 'KEY-FROM-SIGN-IN');
  assert.match(mod.withKey('/api/backup'), /k=KEY-FROM-SIGN-IN$/);
  mod.clearCsrf();
  assert.equal(mod.getCsrf(), '');
  assert.deepEqual(calls.filter((c) => c.startsWith('set')), [], 'the key was written to storage an app page can read');
  // A page loaded without the key (an old browser) starts signed out, and still stores nothing.
  const bare = loadSessionModule('', {});
  assert.equal(bare.mod.getCsrf(), '');
  bare.mod.setCsrf('K');
  assert.deepEqual(bare.calls.filter((c) => c.startsWith('set')), []);
});

test("on the masjid's network the dashboard keeps its key in this origin's storage, as before", () => {
  const stored: Record<string, string> = {};
  const { mod, calls } = loadSessionModule(null, stored);
  assert.equal(mod.getCsrf(), '');
  mod.setCsrf('LAN-KEY');
  assert.equal(stored['omos.dashboardKey'], 'LAN-KEY');
  assert.equal(mod.getCsrf(), 'LAN-KEY');
  mod.clearCsrf();
  assert.ok(calls.includes('remove omos.dashboardKey'));
});
