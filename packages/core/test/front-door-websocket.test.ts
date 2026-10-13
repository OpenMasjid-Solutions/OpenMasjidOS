// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WebSockets on the HTTP front door — the listener Cloudflare's tunnel reaches.
 *
 * Two things share it: every app's live socket (proxied by the ingress to the
 * app's container) and, with remote administration on, the dashboard's own sockets —
 * its live data, its progress streams, its terminals — which the front door hands to
 * the dashboard listener. Serving the second broke the first. @fastify/websocket was registered on
 * this listener to carry the dashboard socket, and it routes EVERY upgrade through
 * Fastify — so an app's socket was piped to the app by the ingress AND run through
 * the ingress's HTTP proxy hook, and the client got an HTTP response injected into
 * its WebSocket stream. Every app that uses live sockets over the tunnel died.
 *
 * So these drive real sockets, through the real `attachIngress`, the real claim
 * rule (`claimsDashboardSocket`), and a dashboard listener with @fastify/websocket
 * and tRPC's real socket handler — handed the upgrade the way index.ts hands it —
 * against a real upstream app socket. `remote-admin.test.ts` pins the index.ts wiring
 * that this cannot see; this pins what the wiring has to achieve.
 *
 * Both live on the same tunnel hostname: the claim tells them apart by path and by
 * session, never by Host (system/remote-admin.ts). And an app that is not shared online
 * opens only with ITS access token — the one the remote dashboard's Open button hands
 * the browser (system/app-access.ts) — never with a session cookie, LAN or remote.
 */
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net, { type AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import Module, { createRequire } from 'node:module';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { WebSocketServer, WebSocket } from 'ws';
import { initTRPC } from '@trpc/server';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-front-ws-'));
// The ingress reaches apps at host.docker.internal in production; here the "app"
// is a socket server on this machine. Read once, when ingress.ts loads.
process.env.OPENMASJID_APP_PROXY_TARGET = '127.0.0.1';

const req = createRequire(__filename);

/**
 * Docker, as the ingress sees it, answering the way a reachable daemon does: "no
 * apps here". Stubbed rather than left to whatever the machine running the tests
 * has, because the two cases behave differently and the first version of this file
 * only ever met one. On a box with no Docker the ingress logs "could not read
 * Docker" and keeps its routes, so the tests passed; on CI, where Docker answers,
 * the rebuild that `attachIngress` starts finished AFTER the test pinned its routes
 * and replaced them with nothing. Each answer is released by `frontDoor` only once
 * the routes are pinned, so every run takes the path CI took.
 */
const pendingAnswers: Array<() => void> = [];
let rebuildsAnswered = 0;
const managerPath = req.resolve('../src/apps/manager');
const managerStub = new Module(managerPath);
managerStub.filename = managerPath;
managerStub.loaded = true;
managerStub.exports = {
  listInstalledWithHealth: () =>
    new Promise((resolve) =>
      pendingAnswers.push(() => {
        rebuildsAnswered += 1;
        resolve({ apps: [], discoveryOk: true });
      }),
    ),
  getAppPath: (id: string) => id,
};
req.cache[managerPath] = managerStub;

const ingress = req('../src/system/ingress') as typeof import('../src/system/ingress');
const ra = req('../src/system/remote-admin') as typeof import('../src/system/remote-admin');
const remoteSockets = req('../src/system/remote-sockets') as typeof import('../src/system/remote-sockets');
const settings = req('../src/settings/store') as typeof import('../src/settings/store');
const tf = req('../src/auth/twofactor') as typeof import('../src/auth/twofactor');
const totpLib = req('../src/auth/totp') as typeof import('../src/auth/totp');
const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
const store = req('../src/auth/store') as typeof import('../src/auth/store');

/** The tunnel hostname: the apps', and the dashboard's from outside too. */
const APPS = 'omos.example.org';
const VIA = { 'cf-ray': '7a1b2c3d4e5f-LHR', 'cf-visitor': '{"scheme":"https"}' };
/** A tunnel request for that hostname. */
const TO_APPS = { ...VIA, host: APPS };

/** Remote administration on or off, for real: the tunnel, the switch, a second factor. */
function setRemoteAdmin(on: boolean): void {
  if (!store.isConfigured()) store.setCredentials('admin', '$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb');
  settings.updateCloudflare({ enabled: true, remoteAdmin: on, domain: APPS });
  if (!tf.twoFactorActive()) {
    const { secret } = tf.beginEnrolment('admin');
    tf.confirmEnrolment(totpLib.totp(secret, Date.now()));
  }
}
setRemoteAdmin(true);

const remoteSession = () =>
  sessions.createSession('admin', sessions.currentCredential(), { remote: true, tf: tf.secondFactorEpoch(), handedOver: true });
/** The remote dashboard's own cookie — set only through the tunnel, in real life. */
const dashCookie = (s: { token: string }) => ({ cookie: `${sessions.REMOTE_COOKIE_NAME}=${s.token}` });
/** A LAN session's cookie. */
const lanCookie = (s: { token: string }) => ({ cookie: `${sessions.COOKIE_NAME}=${s.token}` });
/** The access token for one app, as the Open button's hand-off sets it. */
const appCookie = (s: { token: string }, app: string) => ({
  cookie: `${sessions.COOKIE_NAME}=${sessions.appAccessToken(s.token, app)}`,
});

// ── an app with a live socket ──────────────────────────────────────────────

const appWss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
/** The app's end of every socket, newest last — so a test can see whether the app was
 *  told when the browser's end was closed. */
const appEnds: { ws: WebSocket; closed: Promise<true> }[] = [];
appWss.on('connection', (ws, r) => {
  appEnds.push({ ws, closed: new Promise((resolve) => ws.once('close', () => resolve(true))) });
  ws.send(`app-hello ${r.url}`);
  ws.on('message', (m) => {
    // Lets a test see exactly which cookies reached the app.
    if (String(m) === 'cookie?') ws.send(`app-cookie ${r.headers.cookie ?? ''}`);
    else ws.send(`app-echo ${String(m)}`);
  });
});
const appPort = (): number => (appWss.address() as AddressInfo).port;

// ── a front door wired the way startHttpFront wires it ─────────────────────

const t = initTRPC.create();
const router = t.router({ hello: t.procedure.query(() => 'dashboard-hello') });

/** Every front door a test opened. Closed after EACH test whether it passed or not:
 *  a failed assertion skips the test's own cleanup, and a listening server left
 *  behind keeps this file's process alive — the suite hangs instead of failing. */
const openDoors = new Set<{ close: () => Promise<void> }>();
afterEach(async () => {
  for (const fd of openDoors) await fd.close();
  openDoors.clear();
  setRemoteAdmin(true);
});

/** The dashboard heartbeat, sped up from DASHBOARD_WS_HEARTBEAT_MS for the tests. */
const HEARTBEAT_TEST_MS = 100;

async function frontDoor(): Promise<{ url: string; close: () => Promise<void> }> {
  const front = Fastify();
  // Every raw connection, so close() can cut them all. An upgraded socket is no
  // longer the HTTP server's to close, and one left open keeps this file's process
  // alive for ever — a broken build must FAIL here, not hang the suite.
  const sockets = new Set<import('node:net').Socket>();
  front.server.on('connection', (c) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
  });
  // The dashboard listener: @fastify/websocket, tRPC with its socket, and one of the
  // progress streams — what the HTTPS listener has. Never listening: the front door
  // hands it upgrades as events, exactly as index.ts does.
  const dash = Fastify();
  // With the frame limit index.ts gives the real listener — and its heartbeat, faster.
  await dash.register(fastifyWebsocket, { options: { maxPayload: ra.DASHBOARD_WS_MAX_PAYLOAD } });
  const stopHeartbeat = ra.startDashboardHeartbeat(dash.websocketServer, HEARTBEAT_TEST_MS);
  await dash.register(fastifyTRPCPlugin, { prefix: '/trpc', useWSS: true, trpcOptions: { router } });
  dash.get('/api/update', { websocket: true }, (socket) => {
    socket.send('update-progress');
  });
  await dash.ready();
  ingress.attachIngress(front, {
    // As index.ts: the shared rule, then track, mark and hand over.
    claimUpgrade: (r, socket, head) => {
      const ok = ra.claimsDashboardSocket(r.url ?? '', r.headers, {
        remoteAdminEnabled: ra.remoteAdminEnabled(),
        appsHost: ra.appHostname(),
      });
      if (!ok) return false;
      if (!remoteSockets.trackHandedOverSocket(r, socket)) return false;
      ra.markHandedOver(r);
      dash.server.emit('upgrade', r, socket, head);
      return true;
    },
  });
  // `live` is shared online; `private` is the same app, not shared.
  ingress.__setRoutesForTests({ live: appPort(), private: { port: appPort(), exposed: false } });
  // NOW let the rebuild `attachIngress` started hear back from "Docker".
  for (const answer of pendingAnswers.splice(0)) answer();
  await new Promise((r) => setImmediate(r));
  await front.listen({ port: 0, host: '127.0.0.1' });
  const port = (front.server.address() as AddressInfo).port;
  let closed = false;
  const door = {
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      openDoors.delete(door);
      stopHeartbeat();
      for (const c of dash.websocketServer.clients) c.terminate();
      for (const c of sockets) c.destroy();
      await dash.close();
      await front.close();
    },
  };
  openDoors.add(door);
  return door;
}

/** Open a socket and collect what happens to it within a short window. */
function connect(
  url: string,
  headers: Record<string, string>,
  send?: string,
  want = 2,
): Promise<{ opened: boolean; frames: string[]; error: string | null }> {
  return new Promise((resolve) => {
    const frames: string[] = [];
    let opened = false;
    let error: string | null = null;
    const ws = new WebSocket(url, { headers });
    const done = () => {
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
      resolve({ opened, frames, error });
    };
    const timer = setTimeout(done, 1500);
    ws.on('open', () => {
      opened = true;
      if (send) ws.send(send);
    });
    ws.on('message', (m) => {
      frames.push(String(m));
      // Stop waiting once everything the case expects has arrived.
      if (frames.length >= want) done();
    });
    ws.on('error', (e) => {
      error = e.message;
    });
    ws.on('close', () => setTimeout(done, 20));
  });
}

after(() => {
  for (const c of appWss.clients) c.terminate();
  appWss.close();
});

// MUST STAY THE FIRST TEST. Pinning is permanent for the process, so only the first
// `attachIngress` starts a rebuild before the pin — every later one stops at the
// entry check. Moved down, this would pass whether or not the bug is fixed.
test('a rebuild already waiting on Docker when the routes are pinned does not replace them', { timeout: 15_000 }, async () => {
  const before = rebuildsAnswered;
  await frontDoor();
  assert.ok(rebuildsAnswered > before, 'precondition: the in-flight rebuild must have heard back from "Docker"');
  assert.equal(ingress.isRouted('live'), true, 'a late rebuild wiped the pinned routes');
});

test("AN APP'S WEBSOCKET THROUGH THE FRONT DOOR GETS THE APP, AND ONLY THE APP", { timeout: 15_000 }, async () => {
  const fd = await frontDoor();
  for (const headers of [TO_APPS, {}]) {
    const r = await connect(`${fd.url}/live/socket`, headers, 'ping');
    assert.equal(r.error, null, `the app socket errored (${headers === TO_APPS ? 'tunnel' : 'LAN'}): ${r.error}`);
    assert.equal(r.opened, true);
    assert.deepEqual(r.frames, ['app-hello /live/socket', 'app-echo ping'], 'something other than the app wrote into its socket');
  }
  await fd.close();
});

test("the app's socket keeps working with remote administration switched off", { timeout: 15_000 }, async () => {
  setRemoteAdmin(false);
  const fd = await frontDoor();
  const r = await connect(`${fd.url}/live/socket`, TO_APPS, 'ping');
  assert.deepEqual(r.frames, ['app-hello /live/socket', 'app-echo ping']);
  await fd.close();
});

test("the dashboard's socket is answered by tRPC over the tunnel when the feature is on", { timeout: 15_000 }, async () => {
  const fd = await frontDoor();
  const r = await connect(
    `${fd.url}/trpc`,
    { ...TO_APPS, ...dashCookie(remoteSession()) },
    JSON.stringify({ id: 1, method: 'query', params: { path: 'hello', input: undefined } }),
    1,
  );
  assert.equal(r.opened, true, `the dashboard socket did not open: ${r.error}`);
  assert.ok(
    r.frames.some((f) => f.includes('dashboard-hello')),
    `tRPC did not answer over the socket: ${JSON.stringify(r.frames)}`,
  );
  await fd.close();
});

test("the dashboard's progress streams are handed over too — an update is nothing without one", { timeout: 15_000 }, async () => {
  const fd = await frontDoor();
  const r = await connect(`${fd.url}/api/update`, { ...TO_APPS, ...dashCookie(remoteSession()) }, undefined, 1);
  assert.equal(r.opened, true, `the update stream did not open: ${r.error}`);
  assert.deepEqual(r.frames, ['update-progress']);
  await fd.close();
});

// ── apps that are not shared online ────────────────────────────────────────

test('A PRIVATE APP OPENS OVER THE TUNNEL WITH ITS ACCESS TOKEN', { timeout: 15_000 }, async () => {
  // The point of the feature: the admin, signed in from outside with the second
  // factor, presses Open, and can use an app they have not shared with the public.
  const fd = await frontDoor();
  const remote = remoteSession();
  const r = await connect(`${fd.url}/private/socket`, { ...TO_APPS, ...appCookie(remote, 'private') }, 'ping');
  assert.equal(r.error, null, `the private app's socket errored: ${r.error}`);
  assert.deepEqual(r.frames, ['app-hello /private/socket', 'app-echo ping']);
  await fd.close();
});

test('AN APP RECEIVES ITS OWN TOKEN AND NO PLATFORM SESSION, whatever the browser sent', { timeout: 15_000 }, async () => {
  // Every app on the masjid's network receives the admin's LAN cookie — that is how
  // single sign-on works there — so a LAN cookie presented through the tunnel must
  // not reach an app, or an app that kept one could sign in to another from outside
  // with no second factor. Nor may the remote dashboard's own cookie.
  const fd = await frontDoor();
  const remote = remoteSession();
  const lan = sessions.createSession('admin', sessions.currentCredential());
  const token = sessions.appAccessToken(remote.token, 'live')!;
  const cookie =
    `${sessions.COOKIE_NAME}=${lan.token}; theme=dark; ${sessions.REMOTE_COOKIE_NAME}=${remote.token}; ` +
    `${sessions.COOKIE_NAME}=${token}`;
  const r = await connect(`${fd.url}/live/socket`, { ...TO_APPS, cookie }, 'cookie?');
  assert.equal(r.frames[1], `app-cookie ${sessions.COOKIE_NAME}=${token}; theme=dark`);
  // And with no valid token at all, no platform cookie reaches it.
  const bare = await connect(`${fd.url}/live/socket`, { ...TO_APPS, ...lanCookie(lan) }, 'cookie?');
  assert.equal(bare.frames[1], 'app-cookie ');
  await fd.close();
});

test('THE DASHBOARD SOCKET IS CLOSED WHEN REMOTE ADMINISTRATION IS SWITCHED OFF', { timeout: 15_000 }, async () => {
  // A socket is one request that lasts for hours; the gate decides once, at its start.
  // A review found a live tRPC socket able to switch remote administration back on
  // after it had been turned off, and a root terminal outliving everything.
  const fd = await frontDoor();
  const remote = remoteSession();
  const ws = new WebSocket(`${fd.url}/trpc`, { headers: { ...TO_APPS, ...dashCookie(remote) } });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const closed = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    ws.on('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.ok(remoteSockets.handedOverSocketCount() >= 1, 'the socket was not recorded');
  setRemoteAdmin(false);
  remoteSockets.sweepHandedOverSockets();
  assert.equal(await closed, true, 'the socket stayed open after the door was shut');
  await fd.close();
});

test("THE DASHBOARD SOCKET IS CLOSED WHEN ITS SESSION ENDS", { timeout: 15_000 }, async () => {
  const fd = await frontDoor();
  const remote = remoteSession();
  const ws = new WebSocket(`${fd.url}/trpc`, { headers: { ...TO_APPS, ...dashCookie(remote) } });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const closed = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    ws.on('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  // Still qualifying: a sweep leaves it alone.
  remoteSockets.sweepHandedOverSockets();
  assert.equal(ws.readyState, WebSocket.OPEN, 'a socket that still qualifies must not be closed');
  sessions.destroySession(remote.token);
  remoteSockets.sweepHandedOverSockets();
  assert.equal(await closed, true, 'the socket outlived its session');
  await fd.close();
});

/**
 * Send an upgrade over a raw socket that NEVER closes, and report what the SERVER did.
 *
 * Raw, not the `ws` client: on any non-101 answer `ws` aborts and destroys its own
 * socket at once, so a client-side check passes whether the server destroyed the
 * connection or answered it and left it open — the half-open state that holds a
 * descriptor and that cloudflared would hand to the next visitor. Only the server
 * can end this connection.
 */
function rawUpgrade(
  port: number,
  p: string,
  headers: Record<string, string>,
): Promise<'destroyed' | 'answered-and-left-open' | 'left-hanging'> {
  return new Promise((resolve) => {
    let got = '';
    const { host = APPS, ...rest } = headers;
    const extra = Object.entries(rest)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    const sock = net.connect(port, '127.0.0.1', () =>
      sock.write(
        `GET ${p} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
      ),
    );
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(got ? 'answered-and-left-open' : 'left-hanging');
    }, 1500);
    sock.on('data', (b) => (got += b.toString('latin1')));
    sock.on('close', () => {
      clearTimeout(timer);
      resolve(got ? 'answered-and-left-open' : 'destroyed');
    });
    sock.on('error', () => {});
  });
}

test('every other upgrade is DESTROYED, never left hanging', { timeout: 30_000 }, async () => {
  // Off, LAN, plain http://, nobody signed in, and paths that are not the dashboard
  // socket at all. An abandoned upgrade holds a file descriptor until the peer gives
  // up; on a root daemon facing the internet, that is a lever nobody should be handed.
  const fd = await frontDoor();
  const port = Number(new URL(fd.url).port);
  const lan = sessions.createSession('admin', sessions.currentCredential());
  const remote = remoteSession();
  const ended = remoteSession();
  sessions.destroySession(ended.token);
  const cases: Array<[string, Record<string, string>, boolean, string]> = [
    ['/trpc', { ...TO_APPS, ...dashCookie(remote) }, false, 'the dashboard socket, feature off'],
    // Nobody signed in: a stranger may not hold the dashboard's sockets open at all.
    ['/trpc', TO_APPS, true, 'the dashboard socket, nobody signed in'],
    ['/api/terminal/root', TO_APPS, true, 'a terminal, nobody signed in'],
    ['/api/update', TO_APPS, true, 'a progress stream, nobody signed in'],
    ['/trpc', { ...TO_APPS, ...lanCookie(lan) }, true, 'the dashboard socket, a LAN session'],
    ['/trpc', { ...TO_APPS, ...dashCookie(lan) }, true, "the dashboard socket, a LAN session in the remote cookie's name"],
    ['/trpc', { ...TO_APPS, ...dashCookie(ended) }, true, 'the dashboard socket, a signed-out remote session'],
    ['/trpc', { host: APPS, ...dashCookie(remote) }, true, 'from the LAN'],
    ['/trpc', { 'cf-ray': 'a', 'cf-visitor': '{"scheme":"http"}', host: APPS, ...dashCookie(remote) }, true, 'plain http://'],
    ['/trpcx', TO_APPS, true, 'a near miss'],
    ['/settings', TO_APPS, true, 'a dashboard page, not a socket'],
    ['/nothing-here', TO_APPS, true, 'nothing'],
    ['/live/fabric/billing', TO_APPS, true, "an app's own /fabric"],
    ['/api/update', TO_APPS, false, 'a progress stream, feature off'],
    // A private app: nobody signed in; a LAN session; the remote DASHBOARD session's
    // cookie (not an app token); a token for ANOTHER app; its own token with the
    // feature off; its own token from the LAN; and its own /fabric, which nothing opens.
    ['/private/socket', TO_APPS, true, 'private, no token'],
    ['/private/socket', { ...TO_APPS, ...lanCookie(lan) }, true, 'private, a LAN session'],
    ['/private/socket', { ...TO_APPS, ...lanCookie(remote) }, true, "private, the remote dashboard's session"],
    ['/private/socket', { ...TO_APPS, ...appCookie(remote, 'live') }, true, "private, ANOTHER app's token"],
    ['/private/socket', { ...TO_APPS, ...appCookie(remote, 'private') }, false, 'private, its token, feature off'],
    ['/private/socket', { host: APPS, ...appCookie(remote, 'private') }, true, 'private, its token, from the LAN'],
    ['/private/fabric/billing', { ...TO_APPS, ...appCookie(remote, 'private') }, true, "private, its own /fabric"],
    // A dot-segment spelling must not tell a private app from nothing: both destroyed.
    ['/private/../trpc', TO_APPS, true, 'a private app dot-spelled into the dashboard socket'],
    ['/nothing-here/../trpc', TO_APPS, true, 'nothing, dot-spelled into the dashboard socket'],
    // …and with a signed-in remote session, so it is the SPELLING rule refusing them —
    // without one, the session rule refuses them first and would hide its loss.
    ['/private/../trpc', { ...TO_APPS, ...dashCookie(remote) }, true, 'a private app dot-spelled into the dashboard socket, signed in'],
    ['/nothing-here/../trpc', { ...TO_APPS, ...dashCookie(remote) }, true, 'nothing, dot-spelled into the dashboard socket, signed in'],
  ];
  for (const [p, headers, on, what] of cases) {
    setRemoteAdmin(on);
    assert.equal(await rawUpgrade(port, p, headers), 'destroyed', `${p}: ${what}`);
  }
  // The controls: the claimed and permitted cases are NOT destroyed, so the probe can
  // tell them apart — the dashboard's socket and the apps', side by side on one hostname.
  setRemoteAdmin(true);
  assert.equal(
    await rawUpgrade(port, '/trpc', { ...TO_APPS, ...dashCookie(remote) }),
    'answered-and-left-open',
    'the dashboard socket itself must open, for a signed-in remote session',
  );
  assert.equal(
    await rawUpgrade(port, '/private/socket', { ...TO_APPS, ...appCookie(remote, 'private') }),
    'answered-and-left-open',
    'the private app must open with its token, on the same hostname',
  );
  assert.equal(await rawUpgrade(port, '/live/socket', TO_APPS), 'answered-and-left-open', 'a shared app, beside the dashboard');
  await fd.close();
});


// ── what a socket may cost ─────────────────────────────────────────────────

test('A DASHBOARD SOCKET REFUSES A MESSAGE OVER THE LIMIT', { timeout: 15_000 }, async () => {
  // The library default is 100 MB a message, buffered, stringified and parsed by the
  // daemon on a Raspberry Pi running as root. Nothing the dashboard sends comes near
  // the limit; a message past it closes the socket before it is held in memory.
  const fd = await frontDoor();
  const ws = new WebSocket(`${fd.url}/trpc`, { headers: { ...TO_APPS, ...dashCookie(remoteSession()) } });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const code = await new Promise<number>((resolve) => {
    ws.on('close', (c) => resolve(c));
    ws.on('error', () => {});
    ws.send(Buffer.alloc(ra.DASHBOARD_WS_MAX_PAYLOAD + 1, 0x61));
  });
  assert.equal(code, 1009, 'a message over the limit must close the socket as "too big"');
  // The limit is the real listener's: index.ts registers it with this very constant.
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.match(index, /server\.register\(fastifyWebsocket, \{ options: \{ maxPayload: DASHBOARD_WS_MAX_PAYLOAD \} \}\)/);
  await fd.close();
});

test('the table of open connections from outside is bounded', () => {
  // Every socket recorded belongs to a signed-in remote session, so the admin never
  // nears the bound; it is there because the table is filled from the internet.
  setRemoteAdmin(true);
  const remote = remoteSession();
  const req = { headers: { host: APPS, ...dashCookie(remote) } } as unknown as import('node:http').IncomingMessage;
  const before = remoteSockets.handedOverSocketCount();
  const made: PassThrough[] = [];
  try {
    for (let i = before; i < remoteSockets.MAX_TRACKED_SOCKETS; i++) {
      const s = new PassThrough();
      made.push(s);
      assert.equal(remoteSockets.trackHandedOverSocket(req, s), true, `socket ${i} refused below the bound`);
    }
    const one = new PassThrough();
    assert.equal(remoteSockets.trackHandedOverSocket(req, one), false, 'the bound was not enforced');
    assert.equal(remoteSockets.trackAppSocket(one, 'private', 'a1.x.y'), false, "an app's socket counts too");
  } finally {
    for (const s of made) s.destroy();
  }
});

test("AN APP CANNOT TAKE THE LAST PLACES — the dashboard's own connections always have room", async () => {
  // An app's page opens sockets with the admin's token whenever it likes, and a hostile
  // or leaky one filled the whole table: every terminal, update and restore from outside
  // then failed to start, on every device, for as long as that tab stayed open.
  setRemoteAdmin(true);
  const remote = remoteSession();
  const req = { headers: { host: APPS, ...dashCookie(remote) } } as unknown as import('node:http').IncomingMessage;
  // Sockets destroyed by earlier tests leave the table as their 'close' events land.
  for (let i = 0; i < 50 && remoteSockets.handedOverSocketCount() > 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(remoteSockets.handedOverSocketCount(), 0, 'setup: an empty table');
  const made: PassThrough[] = [];
  const track = (fn: (s: PassThrough) => boolean) => {
    const s = new PassThrough();
    made.push(s);
    return fn(s);
  };
  try {
    for (let i = 0; i < remoteSockets.MAX_APP_SOCKETS; i++) {
      assert.equal(track((s) => remoteSockets.trackAppSocket(s, 'private', 'a1.x.y')), true, `app socket ${i} refused below its bound`);
    }
    assert.equal(track((s) => remoteSockets.trackAppSocket(s, 'live', 'a1.x.y')), false, 'apps took more than their share');
    for (let i = remoteSockets.MAX_APP_SOCKETS; i < remoteSockets.MAX_TRACKED_SOCKETS; i++) {
      assert.equal(track((s) => remoteSockets.trackHandedOverSocket(req, s)), true, `the dashboard was refused at ${i}`);
    }
    assert.equal(track((s) => remoteSockets.trackHandedOverSocket(req, s)), false, 'the whole table is still bounded');
  } finally {
    for (const s of made) s.destroy();
  }
});

test("AN APP'S SOCKET OPENED WITH THE ADMIN'S TOKEN CLOSES WHEN THAT SIGN-IN ENDS", { timeout: 20_000 }, async () => {
  // The dashboard's sockets closed on sign-out, a new password, a changed second factor
  // or the door shutting; an app's socket opened with the admin's token did not, so a
  // private app went on answering a socket opened before the admin signed out.
  const fd = await frontDoor();
  const openApp = async (path: string, cookie: Record<string, string>) => {
    const ws = new WebSocket(`${fd.url}${path}`, { headers: { ...TO_APPS, ...cookie } });
    const first = await new Promise<string>((resolve, reject) => {
      ws.once('message', (m) => resolve(String(m)));
      ws.on('error', reject);
    });
    const closed = within(new Promise<true>((resolve) => ws.on('close', () => resolve(true))));
    // The app's end of this same socket: registered before its first message was sent.
    const app = appEnds.at(-1)!;
    return { ws, first, closed, appClosed: within(app.closed), app: app.ws };
  };

  for (const end of ['sign-out', 'door shut', 'new second factor'] as const) {
    setRemoteAdmin(true);
    const remote = remoteSession();
    const priv = await openApp('/private/socket', appCookie(remote, 'private'));
    assert.equal(priv.first, 'app-hello /private/socket');
    const shared = await openApp('/live/socket', appCookie(remote, 'live')); // the admin, in a shared app
    const pub = await openApp('/live/socket', {}); // the public, in the same shared app
    remoteSockets.sweepHandedOverSockets();
    assert.equal(priv.ws.readyState, WebSocket.OPEN, `${end}: a socket that still qualifies was closed`);
    if (end === 'sign-out') sessions.destroySession(remote.token);
    else if (end === 'door shut') setRemoteAdmin(false);
    else tf.regenerateBackupCodes();
    remoteSockets.sweepHandedOverSockets();
    assert.equal(await priv.closed, true, `${end}: the private app's socket outlived it`);
    assert.equal(await shared.closed, true, `${end}: the admin's socket in a shared app outlived it`);
    // And the APP is told. Cutting off only the browser left the connection to the app
    // open, held by this daemon until the app noticed by itself.
    assert.equal(await priv.appClosed, true, `${end}: the private app's end of the socket was left open`);
    assert.equal(await shared.appClosed, true, `${end}: the shared app's end of the admin's socket was left open`);
    assert.equal(pub.ws.readyState, WebSocket.OPEN, `${end}: a public socket, opened with no token, must be left alone`);
    assert.equal(pub.app.readyState, WebSocket.OPEN, `${end}: the app's end of a public socket must be left alone`);
    pub.ws.terminate();
  }
  await fd.close();
});

test('A QUIET DASHBOARD SOCKET IS PINGED — Cloudflare closes one that carries nothing for ~100 s', { timeout: 10_000 }, async () => {
  // A remote terminal at a prompt, or an update between download lines, sends nothing;
  // without a ping the window printed "[Session closed]" in any pause of about 100 s.
  const fd = await frontDoor();
  const ws = new WebSocket(`${fd.url}/api/update`, { headers: { ...TO_APPS, ...dashCookie(remoteSession()) } });
  ws.on('error', () => {});
  const pinged = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000);
    ws.once('ping', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  ws.terminate();
  assert.equal(pinged, true, 'a quiet dashboard socket from outside was never pinged');
  // The real listener starts the same heartbeat, well inside Cloudflare's limit.
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.match(index, /startDashboardHeartbeat\(server\.websocketServer\)/);
  assert.ok(ra.DASHBOARD_WS_HEARTBEAT_MS <= 45_000, 'the heartbeat must beat well inside ~100 s');
  await fd.close();
});

/** Resolves with what `p` resolves with, or `false` after three seconds. */
function within<T>(p: Promise<T>): Promise<T | false> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    void p.then((v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}
