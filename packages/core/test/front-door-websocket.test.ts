// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WebSockets on the HTTP front door — the listener Cloudflare's tunnel reaches.
 *
 * Two things share it: every app's live socket (proxied by the ingress to the
 * app's container) and, with remote administration on, the dashboard's own tRPC
 * socket. Serving the second broke the first. @fastify/websocket was registered on
 * this listener to carry the dashboard socket, and it routes EVERY upgrade through
 * Fastify — so an app's socket was piped to the app by the ingress AND run through
 * the ingress's HTTP proxy hook, and the client got an HTTP response injected into
 * its WebSocket stream. Every app that uses live sockets over the tunnel died.
 *
 * So these drive real sockets, through the real `attachIngress`, the real claim
 * rule (`claimsDashboardSocket`) and tRPC's real socket handler, against a real
 * upstream app socket. `remote-admin.test.ts` pins the index.ts wiring that this
 * cannot see; this pins what the wiring has to achieve.
 */
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net, { type AddressInfo } from 'node:net';
import Module, { createRequire } from 'node:module';
import Fastify from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { initTRPC } from '@trpc/server';
import { getWSConnectionHandler } from '@trpc/server/adapters/ws';
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

const HOST = 'omos.example.org';
const TUNNEL_HTTPS = { 'cf-ray': '7a1b2c3d4e5f-LHR', 'cf-visitor': '{"scheme":"https"}', host: HOST };

// ── an app with a live socket ──────────────────────────────────────────────

const appWss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
appWss.on('connection', (ws, r) => {
  ws.send(`app-hello ${r.url}`);
  ws.on('message', (m) => ws.send(`app-echo ${String(m)}`));
});
const appPort = (): number => (appWss.address() as AddressInfo).port;

// ── a front door wired the way startHttpFront wires it ─────────────────────

const t = initTRPC.create();
const router = t.router({ hello: t.procedure.query(() => 'dashboard-hello') });

let remoteAdminOn = true;

/** Every front door a test opened. Closed after EACH test whether it passed or not:
 *  a failed assertion skips the test's own cleanup, and a listening server left
 *  behind keeps this file's process alive — the suite hangs instead of failing. */
const openDoors = new Set<{ close: () => Promise<void> }>();
afterEach(async () => {
  for (const fd of openDoors) await fd.close();
  openDoors.clear();
  remoteAdminOn = true;
});

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
  const dashboardWss = new WebSocketServer({ noServer: true });
  const onSocket = getWSConnectionHandler({ wss: dashboardWss, router, createContext: () => ({}) });
  ingress.attachIngress(front, {
    claimUpgrade: (r, socket, head) => {
      if (!ra.claimsDashboardSocket(r.url ?? '', r.headers, { remoteAdminEnabled: remoteAdminOn, configuredHost: HOST })) {
        return false;
      }
      dashboardWss.handleUpgrade(r, socket, head, (ws) => onSocket(ws, r));
      return true;
    },
  });
  // The tRPC HTTP plugin, exactly as the front door registers it: no socket of its own.
  await front.register(fastifyTRPCPlugin, { prefix: '/trpc', useWSS: false, trpcOptions: { router } });
  ingress.__setRoutesForTests({ live: appPort() });
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
      for (const c of dashboardWss.clients) c.terminate();
      dashboardWss.close();
      for (const c of sockets) c.destroy();
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
  for (const headers of [TUNNEL_HTTPS, {}]) {
    const r = await connect(`${fd.url}/live/socket`, headers, 'ping');
    assert.equal(r.error, null, `the app socket errored (${headers === TUNNEL_HTTPS ? 'tunnel' : 'LAN'}): ${r.error}`);
    assert.equal(r.opened, true);
    assert.deepEqual(r.frames, ['app-hello /live/socket', 'app-echo ping'], 'something other than the app wrote into its socket');
  }
  await fd.close();
});

test("the app's socket keeps working with remote administration switched off", { timeout: 15_000 }, async () => {
  remoteAdminOn = false;
  const fd = await frontDoor();
  const r = await connect(`${fd.url}/live/socket`, TUNNEL_HTTPS, 'ping');
  assert.deepEqual(r.frames, ['app-hello /live/socket', 'app-echo ping']);
  await fd.close();
  remoteAdminOn = true;
});

test("the dashboard's socket is answered by tRPC over the tunnel when the feature is on", { timeout: 15_000 }, async () => {
  const fd = await frontDoor();
  const r = await connect(
    `${fd.url}/trpc`,
    TUNNEL_HTTPS,
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
    const extra = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    const sock = net.connect(port, '127.0.0.1', () =>
      sock.write(
        `GET ${p} HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
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

test('every other upgrade is DESTROYED, never left hanging', { timeout: 15_000 }, async () => {
  // Off, LAN, plain http://, and paths that are not the dashboard socket at all.
  // An abandoned upgrade holds a file descriptor until the peer gives up; on a
  // root daemon facing the internet, that is a lever nobody should be handed.
  const fd = await frontDoor();
  const port = Number(new URL(fd.url).port);
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ['/trpc', TUNNEL_HTTPS, false],
    ['/trpc', {}, true],
    ['/trpc', { 'cf-ray': 'a', 'cf-visitor': '{"scheme":"http"}', host: HOST }, true],
    ['/trpcx', TUNNEL_HTTPS, true],
    ['/settings', TUNNEL_HTTPS, true],
    ['/nothing-here', TUNNEL_HTTPS, true],
    ['/live/fabric/billing', TUNNEL_HTTPS, true],
  ];
  for (const [p, headers, on] of cases) {
    remoteAdminOn = on;
    assert.equal(await rawUpgrade(port, p, headers), 'destroyed', `${p} (feature ${on ? 'on' : 'off'})`);
  }
  // The control: the claimed case is NOT destroyed, so the probe can tell them apart.
  remoteAdminOn = true;
  assert.equal(await rawUpgrade(port, '/trpc', TUNNEL_HTTPS), 'answered-and-left-open', 'the dashboard socket itself must open');
  remoteAdminOn = true;
  await fd.close();
});
