// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Linking a phone to the WhatsApp gateway.
 *
 * OpenWA's lifecycle is create → **start** → pair, and a session that was only created has
 * no engine, so every engine route answers `400 Session is not started`. The first version
 * created the session and asked for a pairing code straight away, so linking failed with
 * "the gateway returned 400" on every install — while the status panel truthfully said
 * "gateway running, no phone linked yet", which made it look like a WhatsApp problem
 * rather than a missing call.
 *
 * These tests run against a stub gateway that enforces the same preconditions OpenWA
 * documents, so the sequence is verified rather than assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-walink-'));

const req = createRequire(__filename);
const wa = req('../src/notify/whatsapp') as typeof import('../src/notify/whatsapp');
const store = req('../src/store/whatsapp') as typeof import('../src/store/whatsapp');

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

interface StubOptions {
  /** Sessions that exist at boot, so a test can start from "already created". */
  status?: string;
  engineLoaded?: boolean;
  /** Answer the first N pairing-code requests with 409, as a still-initializing engine does. */
  notReadyTimes?: number;
}

/** A gateway that enforces OpenWA's documented preconditions, and records what it was asked. */
function stubGateway(opts: StubOptions = {}) {
  const calls: string[] = [];
  let status = opts.status ?? 'created';
  let engineLoaded = opts.engineLoaded ?? false;
  let notReady = opts.notReadyTimes ?? 0;

  const server = http.createServer((r, res) => {
    calls.push(`${r.method} ${(r.url ?? '').replace(SESSION_ID, ':id')}`);
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = r.url ?? '';

    if (r.method === 'GET' && url === `/api/sessions/${SESSION_ID}`) {
      return send(200, { id: SESSION_ID, name: 'openmasjid', status, engineLoaded });
    }
    if (r.method === 'POST' && url === `/api/sessions/${SESSION_ID}/start`) {
      if (engineLoaded) return send(400, { message: 'Session already started' });
      engineLoaded = true;
      status = 'initializing';
      return send(200, { id: SESSION_ID, status, engineLoaded });
    }
    if (r.method === 'POST' && url === `/api/sessions/${SESSION_ID}/pairing-code`) {
      // The bug, enforced: no engine means no pairing code.
      if (!engineLoaded) return send(400, { message: 'Session is not started' });
      if (status === 'ready') return send(400, { message: 'Session already authenticated' });
      if (notReady > 0) {
        notReady -= 1;
        return send(409, { message: 'engine not ready' });
      }
      return send(201, { pairingCode: 'ABCD1234', status: 'qr_ready' });
    }
    return send(404, { message: 'not found' });
  });

  return {
    calls,
    listen: async () => {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return (server.address() as { port: number }).port;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function configure(port: number) {
  store.saveWhatsAppConfig({ provider: 'openwa', apiKey: 'k', baseUrl: `http://127.0.0.1:${port}` });
  store.recordSessionId(SESSION_ID); // the session already exists; this test is about starting it
}

test('a created-but-unstarted session is started before a code is requested', async () => {
  const gw = stubGateway({ status: 'created', engineLoaded: false });
  const port = await gw.listen();
  try {
    await configure(port);
    const r = await wa.requestPairingCode('+1 555 010 1234');
    assert.equal(r.ok, true, `linking should succeed: ${r.error ?? ''}`);
    assert.equal(r.code, 'ABCD1234');
    // The order is the fix. Reading state, then start, then pair.
    assert.deepEqual(gw.calls, [
      'GET /api/sessions/:id',
      'POST /api/sessions/:id/start',
      'POST /api/sessions/:id/pairing-code',
    ]);
  } finally {
    await gw.close();
  }
});

test('an already-started session is not started twice', async () => {
  // `start` explicitly refuses when an engine is live, so re-starting would turn a
  // working link into an error.
  const gw = stubGateway({ status: 'qr_ready', engineLoaded: true });
  const port = await gw.listen();
  try {
    await configure(port);
    const r = await wa.requestPairingCode('+1 555 010 1234');
    assert.equal(r.ok, true, `linking should succeed: ${r.error ?? ''}`);
    assert.ok(!gw.calls.includes('POST /api/sessions/:id/start'), 'must not restart a live engine');
  } finally {
    await gw.close();
  }
});

test('a still-initializing engine is waited for, not reported as a failure', async () => {
  // Starting is asynchronous: for a second or two the engine exists but cannot talk to
  // WhatsApp, and OpenWA answers 409 "wait for ready and retry". Surfacing that to the
  // admin would make a working setup look broken.
  const gw = stubGateway({ status: 'created', engineLoaded: false, notReadyTimes: 2 });
  const port = await gw.listen();
  try {
    await configure(port);
    const r = await wa.requestPairingCode('+1 555 010 1234');
    assert.equal(r.ok, true, `a transient 409 must be retried: ${r.error ?? ''}`);
    assert.equal(r.code, 'ABCD1234');
    const attempts = gw.calls.filter((c) => c.endsWith('/pairing-code')).length;
    assert.equal(attempts, 3, 'two refusals then the code');
  } finally {
    await gw.close();
  }
});

test('an already-linked phone is explained, not reported as a gateway error', async () => {
  const gw = stubGateway({ status: 'ready', engineLoaded: true });
  const port = await gw.listen();
  try {
    await configure(port);
    const r = await wa.requestPairingCode('+1 555 010 1234');
    assert.equal(r.ok, false);
    assert.match(String(r.error), /already linked/i, `unhelpful message: ${r.error}`);
    assert.ok(!gw.calls.some((c) => c.endsWith('/pairing-code')), 'no point asking');
  } finally {
    await gw.close();
  }
});

test('a number with no country code never reaches the gateway', async () => {
  const gw = stubGateway();
  const port = await gw.listen();
  try {
    await configure(port);
    const r = await wa.requestPairingCode('555 0123');
    assert.equal(r.ok, false);
    assert.match(String(r.error), /country code/i);
    assert.equal(gw.calls.length, 0, 'refused locally');
  } finally {
    await gw.close();
  }
});

test('a WhatsApp-imposed restriction on the number is surfaced, never swallowed', async () => {
  // This is the risk the entire feature is hedged against actually happening. The gateway
  // reports it; the admin must see it.
  const server = http.createServer((r, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: SESSION_ID,
        status: 'ready',
        phone: '15550101234',
        restriction: { kind: 'tos_block', code: 'TOS_BLOCK' },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await configure(port);
    const s = await wa.gatewayStatus();
    assert.equal(s.state, 'ready');
    assert.equal(s.restriction, 'tos_block');
    assert.equal(s.phone, '15550101234');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
