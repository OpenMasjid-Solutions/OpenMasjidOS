// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Regressions from a review of the WhatsApp subsystem.
 *
 * Most of these drive the real queue against a stub gateway that answers like OpenWA,
 * because the bugs lived BETWEEN calls: a Discard landing during a send, a backlog outliving
 * its bound while the core stayed up, a failed lookup remembered as an answer, a status
 * check's "no" forgotten at the next tick. A check of the code's shape passes on all of them.
 *
 * Order matters below: the tests share one process, one queue and one data folder, and the
 * inbound-socket tests come last because they start a supervisor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-wa-fixes-'));
process.env.OPENMASJID_DATA_DIR = DATA;
const CONFIG = path.join(DATA, 'config');

const req = createRequire(__filename);
const wa = req('../src/notify/whatsapp') as typeof import('../src/notify/whatsapp');
const waGateway = req('../src/notify/whatsapp-gateway') as typeof import('../src/notify/whatsapp-gateway');
const store = req('../src/store/whatsapp') as typeof import('../src/store/whatsapp');
const qstore = req('../src/notify/whatsapp-queue-store') as typeof import('../src/notify/whatsapp-queue-store');
const phone = req('../src/util/phone') as typeof import('../src/util/phone');
const commands = req('../src/store/commands') as typeof import('../src/store/commands');
const mon = req('../src/system/whatsapp-monitor') as typeof import('../src/system/whatsapp-monitor');

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
/** The masjid's own number, as the gateway reports it. */
const LINKED = '447700900000';
const PARENT = '+1 555 010 1234';
const GROUP = '120363012345678901@g.us';
const PNG = Buffer.from('not a real png, but real bytes').toString('base64');
const DAY = 86_400_000;

/** Source with comments stripped — structural assertions are about code, never prose. */
const codeOf = (rel: string) =>
  fs
    .readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Let the queue drain, and the pump's last "offline" presence call land. */
async function settle(): Promise<void> {
  await waitFor('the queue to drain', () => wa.queueDepth() === 0);
  await sleep(300);
}

// An outage confirmed three days ago, with nine of the students app's messages reported sent
// in its blind window. Written before anything reads the health file.
fs.mkdirSync(CONFIG, { recursive: true });
fs.writeFileSync(
  path.join(CONFIG, 'whatsapp-health.json'),
  JSON.stringify({
    down: true,
    detectedAt: Date.now() - 3 * DAY,
    lastKnownGood: Date.now() - 3 * DAY - 3_600_000,
    reason: "the gateway's connection to WhatsApp has died",
    cause: 'session-expired',
    incidents: [
      {
        from: Date.now() - 3 * DAY - 3_600_000,
        to: Date.now() - 3 * DAY,
        cause: 'session-expired',
        reason: "the gateway's connection to WhatsApp has died",
        perSource: [{ source: 'students', count: 9, ids: [], truncated: false }],
      },
    ],
  }),
);

// ── a stub gateway ───────────────────────────────────────────────────────────────

type Reply = { status: number; body?: unknown } | 'hold';
type Route = (method: string, url: string) => Reply | undefined;

/** What a linked, healthy OpenWA answers. */
function linkedGateway(method: string, url: string): { status: number; body?: unknown } {
  if (method === 'GET' && url === '/api/sessions/:id') {
    return { status: 200, body: { id: SESSION_ID, status: 'ready', engineLoaded: true, phone: LINKED } };
  }
  if (url.includes('/contacts/check/')) return { status: 200, body: { exists: true } };
  if (url.endsWith('/presence') || url.endsWith('/chats/typing') || url.includes('/messages/send-')) {
    return { status: 200, body: { id: 'm1' } };
  }
  if (url.endsWith('/chats?limit=1')) return { status: 200, body: [] };
  return { status: 404, body: { message: 'not found' } };
}

/**
 * A gateway answering like a linked OpenWA unless `route` says otherwise ('hold' keeps the
 * reply until the test releases it), recording each call with the session id as `:id` and
 * the text of every send-text in order. Configures WhatsApp to use it.
 */
async function stubGateway(route: Route = () => undefined) {
  const calls: string[] = [];
  const texts: string[] = [];
  const held: (() => void)[] = [];
  const server = http.createServer((r, res) => {
    let raw = '';
    r.on('data', (c) => (raw += c));
    r.on('end', () => {
      const method = r.method ?? 'GET';
      const url = (r.url ?? '').replace(SESSION_ID, ':id');
      calls.push(`${method} ${url}`);
      if (url.endsWith('/messages/send-text')) texts.push(String((JSON.parse(raw) as { text?: unknown }).text));
      const send = (status: number, body: unknown = {}) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const reply = route(method, url) ?? linkedGateway(method, url);
      if (reply === 'hold') held.push(() => send(200, { id: 'm1' }));
      else send(reply.status, reply.body);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  store.saveWhatsAppConfig({ provider: 'openwa', apiKey: 'k', baseUrl: `http://127.0.0.1:${port}` });
  store.recordSessionId(SESSION_ID);
  return {
    calls,
    texts,
    held,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

const person = (id: string, text: string, enqueuedAt = Date.now()) => ({
  id,
  text,
  source: 'students',
  target: { kind: 'person' as const, digits: '15550101234' },
  enqueuedAt,
  attempts: 0,
});
const image = (id: string) => ({
  id,
  text: 'poster',
  source: 'display',
  target: { kind: 'group' as const, groupId: GROUP },
  media: { data: PNG, mimeType: 'image/png' },
  enqueuedAt: Date.now(),
  attempts: 0,
});
const noHistory = () => ({ sends: [], groupSends: [], lastPerRecipient: new Map<string, number>(), outcomes: [] });

// ── the pump ─────────────────────────────────────────────────────────────────────

test('A DISCARD DURING A SEND NEVER COSTS A NEWER MESSAGE — the sent one is found again', async () => {
  // The pump removed the item it had sent by the index it found BEFORE the send. Discard
  // empties the queue meanwhile, an app enqueues again, and that index now named the newer
  // message: it was dropped unsent, its outcome stuck at "queued" for ever.
  let first = true;
  const gw = await stubGateway((_m, url) => {
    if (url.endsWith('/messages/send-text') && first) {
      first = false;
      return 'hold';
    }
    return undefined;
  });
  try {
    wa.__resetPacingForTests();
    const a = wa.enqueue({ to: PARENT, text: 'first', source: 'students' });
    await waitFor('the first send to reach the gateway', () => gw.held.length === 1);

    wa.discardHeldMessages();
    assert.match(
      String(wa.whatsappOutcome(a.id!, 'students')?.reason),
      /discarded by an admin before it was sent/,
      'nothing was paused, so the record must not blame a lost link',
    );
    const b = wa.enqueue({ to: PARENT, text: 'second', source: 'students' });
    gw.held.shift()!();

    await waitFor('the newer message to go out', () => wa.whatsappOutcome(b.id!, 'students')?.state === 'sent');
    assert.deepEqual(gw.texts, ['first', 'second'], 'the newer message really was sent');
    assert.equal(wa.whatsappOutcome(a.id!, 'students')?.state, 'sent', 'and the discarded one is recorded as having gone');
  } finally {
    await settle();
    await gw.close();
  }
});

test('a discard during an outage says so', async () => {
  const gw = await stubGateway();
  try {
    wa.pauseQueue('test');
    const r = wa.enqueue({ to: PARENT, text: 'held', source: 'students' });
    wa.discardHeldMessages();
    assert.match(String(wa.whatsappOutcome(r.id!, 'students')?.reason), /after the WhatsApp link was lost/);
    assert.equal(wa.isQueuePaused(), false);
  } finally {
    await gw.close();
  }
});

test('A BACKLOG OLDER THAN A DAY IS DROPPED WHILE RUNNING, not only at boot', async () => {
  // The bound was applied only when the queue was loaded at boot, so a core that stayed up
  // through a long gateway outage sent the whole backlog back to back when it returned.
  const gw = await stubGateway();
  try {
    const now = Date.now();
    qstore.saveQueueState({
      ...noHistory(),
      queue: [person('stale-1', 'yesterday', now - qstore.MAX_HELD_MS - 60_000), person('fresh-1', 'today', now - 60_000)],
    });
    // Loaded as at a boot two minutes ago, when the old one was still inside the bound.
    assert.equal(qstore.loadQueueState(now - 2 * 60_000).queue.length, 2, 'precondition: both were inside it then');
    wa.restoreWhatsAppQueue(now - 2 * 60_000);

    await waitFor('the fresh message to go out', () => wa.whatsappOutcome('fresh-1', 'students')?.state === 'sent');
    assert.equal(wa.whatsappOutcome('stale-1', 'students')?.state, 'expired');
    assert.deepEqual(gw.texts, ['today'], 'the day-old message never reached the gateway');
  } finally {
    await settle();
    await gw.close();
  }
});

test('WHO WAS MESSAGED IS KEPT FOR A DAY, not for ever', async () => {
  // `lastToRecipient` was never pruned: a persisted, ever-growing list of every number the
  // masjid had messaged, read by nothing.
  const gw = await stubGateway();
  try {
    const now = Date.now();
    qstore.saveQueueState({
      ...noHistory(),
      queue: [person('fresh-2', 'hello', now)],
      lastPerRecipient: new Map([['15550109999', now - 3 * DAY]]),
    });
    wa.restoreWhatsAppQueue(now);
    await waitFor('the message to go out', () => wa.whatsappOutcome('fresh-2', 'students')?.state === 'sent');

    const saved = JSON.parse(fs.readFileSync(path.join(CONFIG, 'whatsapp-queue.json'), 'utf8')) as {
      lastPerRecipient: [string, number][];
    };
    const numbers = saved.lastPerRecipient.map(([key]) => key);
    assert.ok(!numbers.includes('15550109999'), 'a number messaged three days ago is no longer on disk');
    assert.ok(numbers.includes('15550101234'), "today's is kept");
  } finally {
    await settle();
    await gw.close();
  }
});

// ── images on disk ───────────────────────────────────────────────────────────────

test('AN IMAGE IS WRITTEN ONCE, BESIDE THE QUEUE FILE — never rewritten inside it', () => {
  // Inline, up to ~11 MB of base64 was rewritten (and fsynced) on every enqueue and send.
  const id = 'aaaaaaaa-1111-2222-3333-444444444444';
  const img = path.join(CONFIG, 'whatsapp-media', id);
  qstore.saveQueueState({ ...noHistory(), queue: [image(id)] });

  const raw = fs.readFileSync(path.join(CONFIG, 'whatsapp-queue.json'), 'utf8');
  assert.ok(!raw.includes(PNG), 'the bytes are not in the queue file');
  assert.ok(!raw.includes('\n'), 'and the queue file is compact');
  assert.equal(fs.readFileSync(img, 'utf8'), PNG);
  assert.equal(fs.statSync(img).mode & 0o777, 0o600, 'an image can carry a child’s photo');

  const ino = fs.statSync(img).ino;
  qstore.saveQueueState({ ...noHistory(), queue: [image(id)] });
  assert.equal(fs.statSync(img).ino, ino, 'an image already on disk is not written again');

  assert.equal(qstore.loadQueueState(Date.now()).queue[0]?.media?.data, PNG, 'the bytes come back for the send');

  qstore.saveQueueState({ ...noHistory(), queue: [] });
  assert.equal(fs.existsSync(img), false, 'and go once the message has left the queue');
});

test('an image that cannot be read back fails that message alone — the queue goes on', async () => {
  // A restore puts the backup's config/ in place while the old core runs on with its own
  // queue, so a queue file can name an image that is not there.
  const gw = await stubGateway();
  try {
    store.approveGroup(GROUP, 'Parents');
    const lost = 'bbbbbbbb-1111-2222-3333-444444444444';
    qstore.saveQueueState({ ...noHistory(), queue: [image(lost), person('text-1', 'still goes')] });
    fs.rmSync(path.join(CONFIG, 'whatsapp-media', lost));

    wa.restoreWhatsAppQueue();
    assert.equal(wa.whatsappOutcome(lost, 'display')?.state, 'failed');
    assert.match(String(wa.whatsappOutcome(lost, 'display')?.reason), /image could not be read back/);
    await waitFor('the other message to go out', () => wa.whatsappOutcome('text-1', 'students')?.state === 'sent');
    assert.ok(!gw.calls.some((c) => c.includes('send-image')), 'nothing was sent for the lost image');
  } finally {
    await settle();
    await gw.close();
  }
});

test('a queue file written with the image inside still loads, and the image moves out', () => {
  const id = 'cccccccc-1111-2222-3333-444444444444';
  fs.writeFileSync(
    path.join(CONFIG, 'whatsapp-queue.json'),
    JSON.stringify({ queue: [image(id)], sends: [], groupSends: [], lastPerRecipient: [], outcomes: [] }),
  );
  const loaded = qstore.loadQueueState(Date.now());
  assert.equal(loaded.queue[0]?.media?.data, PNG, 'the inline bytes are kept');
  qstore.saveQueueState({ ...noHistory(), queue: loaded.queue });
  assert.equal(fs.readFileSync(path.join(CONFIG, 'whatsapp-media', id), 'utf8'), PNG);
  assert.ok(!fs.readFileSync(path.join(CONFIG, 'whatsapp-queue.json'), 'utf8').includes(PNG));

  qstore.clearQueueStore();
  assert.equal(fs.existsSync(path.join(CONFIG, 'whatsapp-media')), false, 'deleting WhatsApp takes the images too');
});

test('an id read off disk never becomes a path', () => {
  fs.mkdirSync(CONFIG, { recursive: true });
  fs.writeFileSync(
    path.join(CONFIG, 'whatsapp-queue.json'),
    JSON.stringify({ queue: [{ ...image('../../escape'), media: { mimeType: 'image/png' } }] }),
  );
  const loaded = qstore.loadQueueState(Date.now());
  assert.deepEqual(loaded.queue, []);
  assert.deepEqual(
    loaded.lost.map((l) => l.id),
    ['../../escape'],
    'refused as unreadable, never looked up',
  );
  qstore.clearQueueStore();
});

// ── the gateway client ───────────────────────────────────────────────────────────

test('A FAILED PRIVACY-ID LOOKUP IS ASKED AGAIN — only a real answer is remembered', async () => {
  // A 503 while the gateway restarted was cached as "no number", so a trustee writing from a
  // @lid chat was dropped as unidentifiable until the core itself restarted.
  let restarting = true;
  const gw = await stubGateway((_m, url) => {
    if (url.includes('/contacts/111%40lid/phone')) {
      if (restarting) {
        restarting = false;
        return { status: 503, body: { message: 'restarting' } };
      }
      return { status: 200, body: { phone: '+1 555 010 1234' } };
    }
    if (url.includes('/contacts/222%40lid/phone')) return { status: 404, body: { message: 'unknown' } };
    return undefined;
  });
  try {
    assert.equal(await waGateway.resolveLidPhone('111@lid'), null, 'the gateway was restarting');
    assert.equal(await waGateway.resolveLidPhone('111@lid'), '15550101234', 'so it is asked again');
    assert.equal(await waGateway.resolveLidPhone('111@lid'), '15550101234');
    assert.equal(gw.calls.filter((c) => c.includes('111%40lid')).length, 2, 'a real answer is remembered');

    assert.equal(await waGateway.resolveLidPhone('222@lid'), null);
    assert.equal(await waGateway.resolveLidPhone('222@lid'), null);
    assert.equal(gw.calls.filter((c) => c.includes('222%40lid')).length, 1, '"no number" is an answer too');
  } finally {
    await gw.close();
  }
});

test('A SEND THAT TIMED OUT IS REPORTED, NOT SENT AGAIN — and a send has time to finish', () => {
  // Every gateway call had 15 s, a 2 MB send-image included, and a timed-out send (usually
  // delivered anyway) was retried as transient: up to five copies into a 200-member group.
  const code = codeOf('notify/whatsapp.ts');
  const limit = Number(/const SEND_TIMEOUT_MS = ([\d_]+)/.exec(code)?.[1]?.replace(/_/g, ''));
  assert.ok(limit >= 60_000, `a send needs far longer than a status read; got ${limit}`);

  const fn = code.slice(code.indexOf('async function sendOne'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.equal((body.match(/SEND_TIMEOUT_MS/g) ?? []).length, 2, 'send-text and send-image both get it');
  const at = body.indexOf('if (r.timedOut)');
  assert.ok(at > 0, 'a timeout is told apart from a refusal');
  const branch = body.slice(at, body.indexOf('\n    }\n', at));
  assert.match(branch, /retryable: false/, 'and is never retried');
  assert.match(branch, /may or may not have arrived/, 'and the record says what is known, and no more');
  assert.match(codeOf('notify/whatsapp-gateway.ts'), /timedOut: \(err as Error\)\?\.name === 'TimeoutError'/);
});

test('A TEST BEFORE A PHONE IS LINKED SAYS SO — no fake typing, no bare gateway error', async () => {
  let linked = false;
  const gw = await stubGateway((method, url) => {
    if (linked) return undefined;
    if (method === 'GET' && url === '/api/sessions/:id') {
      return { status: 200, body: { id: SESSION_ID, status: 'qr_ready', engineLoaded: true } };
    }
    if (url.includes('/chats/') || url.includes('/messages/')) return { status: 400, body: { message: 'not ready' } };
    return undefined;
  });
  try {
    store.approveGroup(GROUP, 'Parents');
    const started = Date.now();
    const toPerson = await wa.sendTestMessage(PARENT, 'test');
    const toGroup = await wa.sendTestToGroup(GROUP, 'test');
    assert.equal(toPerson.ok, false);
    assert.match(String(toPerson.error), /Link a phone first/);
    assert.match(String(toGroup.error), /Link a phone first/);
    assert.ok(Date.now() - started < 1_500, 'answered at once, not after seconds of "typing"');
    assert.ok(!gw.calls.some((c) => /\/chats\/typing|\/messages\//.test(c)), 'nothing went towards a phone');

    linked = true;
    assert.equal((await wa.sendTestMessage(PARENT, 'test')).ok, true, 'a linked phone is not held up by the check');
  } finally {
    await gw.close();
  }
});

test('an already-linked phone is changed in Settings, never in OpenWA’s own screen', async () => {
  const gw = await stubGateway();
  try {
    const r = await waGateway.requestPairingCode(PARENT);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /Settings → WhatsApp/);
    assert.doesNotMatch(String(r.error), /in OpenWA/);
  } finally {
    await gw.close();
  }
});

test('A NUMBER STARTING WITH 0 IS REFUSED — no country code starts with one', () => {
  // "07700 900123" (a national number) and "0044 7700 900123" (a dialling prefix) were both
  // accepted, answered 202, and became a chat id WhatsApp can never deliver to.
  assert.equal(phone.toDigits('07700 900123'), null);
  assert.equal(phone.toDigits('0044 7700 900123'), null);
  assert.equal(phone.toDigits('+44 7700 900123'), '447700900123', 'written properly it still works');
  store.saveWhatsAppConfig({ provider: 'openwa', apiKey: 'k', baseUrl: 'http://127.0.0.1:1' });
  const r = wa.enqueue({ to: '0044 7700 900123', text: 'hello', source: 'students' });
  assert.equal(r.queued, false, 'refused at the door, while the app is still listening');
  assert.match(String(r.error), /country code/);
});

test('the cause apps are told comes from the status code, never from the wording', async () => {
  for (const [status, cause] of [
    [503, 'session-expired'],
    [401, 'key-rejected'],
    [403, 'key-rejected'],
  ] as const) {
    const gw = await stubGateway((_m, url) => (url.endsWith('/chats?limit=1') ? { status } : undefined));
    try {
      const probe = await waGateway.probeLink();
      assert.equal(probe.alive, false);
      assert.equal(probe.cause, cause, `a ${status}`);
    } finally {
      await gw.close();
    }
  }
});

// ── turning it off, and the outage record ────────────────────────────────────────

function signedIn() {
  const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
  const { whatsappRouter } = req('../src/trpc/routers/whatsapp') as typeof import('../src/trpc/routers/whatsapp');
  const { token, csrf } = sessions.createSession('admin', sessions.currentCredential());
  return whatsappRouter.createCaller({
    username: 'admin',
    sessionToken: token,
    csrf,
    isWebSocket: false,
    ip: '172.17.0.1',
    host: 'openmasjidos.local',
    viaTunnel: false,
    handedOver: false,
    remoteIp: null,
  } as never);
}

test('"MAY NOT HAVE ARRIVED" COMES FROM THE OUTAGE ITSELF — not a recount of a one-day history', async () => {
  // Recounted from the outcome history, which keeps a day, it read 0 after a weekend
  // outage: exactly when the admin came to look.
  const held = await signedIn().held();
  assert.equal(held.health.down, true, 'precondition: an outage is open');
  assert.deepEqual(
    held.suspect.map((s) => [s.source, s.count]),
    [['students', 9]],
  );
});

test('TURNING WHATSAPP OFF CLOSES THE OUTAGE — the dashboard banner cannot outlive the feature', async () => {
  // The monitor stops looking once WhatsApp is off, so nothing else would ever clear it.
  await signedIn().disable({ deleteEverything: false });
  const health = mon.whatsAppHealth();
  assert.equal(health.down, false);
  assert.equal(health.incidents.length, 1, 'the record of what happened is kept for the apps that ask');
});

test('deleting WhatsApp closes the outage too, before the gateway app goes', () => {
  // Driven structurally: the delete branch removes a Docker app, which a test must not do.
  const src = codeOf('trpc/routers/whatsapp.ts');
  const runtime = src.indexOf('clearWhatsAppRuntime()');
  const incident = src.indexOf('clearWhatsAppIncident()', runtime);
  const remove = src.indexOf('removeApp(OPENWA_APP_ID');
  assert.ok(runtime > 0 && incident > runtime && incident < remove);
});

test('A FULL OR READ-ONLY CARD CANNOT STOP AN OUTAGE BEING HANDLED — saving the link state never throws', async () => {
  // save() threw between pausing the queue and telling the admin; every later tick then saw
  // `down` and returned. Paused, with nobody told.
  const gw = await stubGateway((_m, url) => (url.endsWith('/chats?limit=1') ? { status: 503 } : undefined));
  try {
    store.recordLinkedPhone(LINKED);
    await mon.checkWhatsAppHealthNow();
    await mon.checkWhatsAppHealthNow(); // two agreeing ticks
    assert.equal(mon.whatsAppHealth().down, true, 'precondition: the outage is confirmed');
    assert.equal(mon.whatsAppHealth().cause, 'session-expired');

    const tmp = path.join(CONFIG, 'whatsapp-health.json.tmp');
    fs.mkdirSync(tmp); // the write's temp file is a folder, so the write fails
    try {
      assert.doesNotThrow(() => mon.clearWhatsAppIncident());
      assert.equal(mon.whatsAppHealth().down, false, 'the copy everything reads is still right');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    wa.releaseQueue(); // the confirmed outage paused it
    await gw.close();
  }
});

test('DELETING WHATSAPP FORGETS THE PAUSE — the next setup’s first message is not held', async () => {
  const gw = await stubGateway((_m, url) => (url.endsWith('/messages/send-text') ? { status: 401 } : undefined));
  try {
    wa.__resetPacingForTests();
    const r = wa.enqueue({ to: PARENT, text: 'turned down', source: 'students' });
    await waitFor('the refusal to be recorded', () => wa.whatsappOutcome(r.id!, 'students')?.state === 'failed');
    assert.equal(wa.sendPathSignals().authFailures, 1, 'precondition: the send path saw a refused key');
    wa.pauseQueue('test');

    wa.clearWhatsAppRuntime();
    assert.equal(wa.isQueuePaused(), false);
    assert.deepEqual(wa.sendPathSignals(), { authFailures: 0, lastAuthFailAt: 0 });

    wa.enqueue({ to: PARENT, text: 'a fresh start', source: 'students' });
    const saved = JSON.parse(fs.readFileSync(path.join(CONFIG, 'whatsapp-queue.json'), 'utf8')) as { paused: boolean };
    assert.equal(saved.paused, false, 'it is saved as running, not held for an outage that was deleted');
  } finally {
    await settle();
    await gw.close();
  }
});

// ── the inbound socket ───────────────────────────────────────────────────────────

/**
 * OpenWA's status route plus just enough of its Socket.IO endpoint, over long-polling, to
 * refuse a key the way it does: accept the connection, send an UNAUTHORIZED error frame,
 * then disconnect. Engine.IO v4 framing — packets in one poll are joined by \x1e, and "4"
 * carries a Socket.IO packet ("0" connect, "1" disconnect, "2" event) for the namespace.
 */
async function refusingGateway(statusCode: number) {
  const text = (res: http.ServerResponse, body: string) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=UTF-8' });
    res.end(body);
  };
  const refusal = [
    '40/events,{"sid":"N1"}',
    '42/events,["message",{"type":"error","code":"UNAUTHORIZED"}]',
    '41/events,',
  ].join('\x1e');
  const polls: http.ServerResponse[] = [];
  let joinAsked = false;
  let refused = false;
  let socketRequests = 0;
  const flush = () => {
    if (!joinAsked || refused || polls.length === 0) return;
    refused = true;
    text(polls.shift()!, refusal);
  };
  const server = http.createServer((r, res) => {
    let raw = '';
    r.on('data', (c) => (raw += c));
    r.on('end', () => {
      const url = r.url ?? '';
      if (!url.startsWith('/socket.io/')) {
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: SESSION_ID, status: 'ready', engineLoaded: true, phone: LINKED }));
        return;
      }
      socketRequests += 1;
      if (!new URL(url, 'http://x').searchParams.get('sid')) {
        const open = { sid: 'S1', upgrades: [], pingInterval: 25_000, pingTimeout: 20_000, maxPayload: 1_000_000 };
        return text(res, `0${JSON.stringify(open)}`);
      }
      if (r.method === 'POST') {
        text(res, 'ok');
        if (raw.includes('40/events')) joinAsked = true;
        return flush();
      }
      polls.push(res); // the long poll, answered once the client has asked to join /events
      flush();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  store.saveWhatsAppConfig({ provider: 'openwa', apiKey: 'k', baseUrl: `http://127.0.0.1:${port}` });
  store.recordSessionId(SESSION_ID);
  return {
    socketRequests: () => socketRequests,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

test('THE INBOUND SOCKET RECORDS RAW TRAFFIC, AND A REFUSED KEY SAYS SO when the gateway hangs up', async () => {
  // Two bugs on one connection. The packet listener was attached before connect(), when the
  // engine does not exist yet, so `lastPacketAt` was never set. And OpenWA's refusal (an
  // error frame, then a disconnect) ended as "the gateway connection dropped".
  const inbound = req('../src/notify/whatsapp-inbound') as typeof import('../src/notify/whatsapp-inbound');
  const gw = await refusingGateway(200);
  try {
    commands.setCommandsEnabled(true);
    commands.addCommandPerson('15550101234', 'Imam', []);
    inbound.startWhatsAppInbound();
    await waitFor('the gateway to hang up', () => inbound.inboundStatus().retryInMs !== null, 10_000);

    const s = inbound.inboundStatus();
    assert.equal(s.detail, 'The gateway refused the connection (UNAUTHORIZED).', 'the refusal, not "dropped"');
    assert.ok(s.lastPacketAt, 'raw transport traffic is recorded');
  } finally {
    inbound.stopWhatsAppInbound();
    await gw.close();
  }
});

test('A "NO" FROM THE STATUS CHECK HOLDS UNTIL IT IS ASKED AGAIN — the next tick does not connect anyway', async () => {
  // The check runs at most once a minute, and its "no" counted for one reconcile only: 30 s
  // later the supervisor connected regardless, to a gateway that had just turned it down.
  delete req.cache[req.resolve('../src/notify/whatsapp-inbound')];
  const inbound = req('../src/notify/whatsapp-inbound') as typeof import('../src/notify/whatsapp-inbound');
  const gw = await refusingGateway(401);
  try {
    inbound.startWhatsAppInbound();
    await waitFor('the status check to refuse', () => inbound.inboundStatus().state === 'bad-key');

    inbound.reconcileWhatsAppInbound(); // what the 30-second tick does
    await sleep(1_500);
    assert.equal(inbound.inboundStatus().state, 'bad-key');
    assert.equal(gw.socketRequests(), 0, 'no connection was opened');
  } finally {
    inbound.stopWhatsAppInbound();
    commands.setCommandsEnabled(false);
    await gw.close();
  }
});

test('a refused key adds up across reconnects, and only a confirmed subscribe resets the count', () => {
  // OpenWA accepts the connection before refusing the key, so resetting on connect meant the
  // connect, error, disconnect cycle never reached AUTH_FAIL_LIMIT.
  const code = codeOf('notify/whatsapp-inbound.ts');
  const onConnect = code.slice(code.indexOf("s.on('connect'"), code.indexOf("s.on('connect_error'"));
  assert.doesNotMatch(onConnect, /authFailures = 0/);
  const frame = code.slice(code.indexOf('function handleFrame'));
  assert.match(frame.slice(frame.indexOf("type === 'subscribed'"), frame.indexOf("type === 'error'")), /authFailures = 0/);
  const drop = code.slice(code.indexOf("s.on('disconnect'"), code.indexOf('s.on(FRAME_CHANNEL'));
  assert.match(drop, /authFailures >= AUTH_FAIL_LIMIT/, 'the refusals that end in a disconnect are what count');
});
