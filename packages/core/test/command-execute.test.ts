// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Calling an app to run one of its declared commands, and the structural rules that
 * keep the whole feature from turning into a spam gateway.
 *
 * The HTTP half runs against a real loopback server rather than a mock, because the
 * things worth testing here — no redirects, the response cap, the exact header set —
 * are properties of the transport, not of our intentions about it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-exec-'));
process.env.OPENMASJID_DATA_DIR = dataDir;
// The proxy resolves an app's host through system/app-host.ts; point it at loopback
// so the test server stands in for a published container port.
process.env.OPENMASJID_APP_PROXY_TARGET = '127.0.0.1';

const req = createRequire(__filename);
const proxy = req('../src/fabric/proxy') as typeof import('../src/fabric/proxy');
const { proxyToTarget, PLATFORM_CALLER_ID, CodedError } = proxy;

const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

interface Served {
  port: number;
  close: () => void;
  seen: { headers: http.IncomingHttpHeaders; body: string; url?: string }[];
}

function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Served> {
  const seen: Served['seen'] = [];
  const server = http.createServer((rq, rs) => {
    const chunks: Buffer[] = [];
    rq.on('data', (c: Buffer) => chunks.push(c));
    rq.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ headers: rq.headers, body, url: rq.url });
      handler(rq, rs, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => server.close(), seen });
    });
  });
}

const call = (port: number, extra: Partial<Parameters<typeof proxyToTarget>[0]> = {}) =>
  proxyToTarget({
    host: '127.0.0.1',
    port,
    path: '/fabric/commands/run',
    body: Buffer.from(JSON.stringify({ command: 'reload' })),
    targetSecret: 'the-target-own-secret',
    callerId: PLATFORM_CALLER_ID,
    timeoutMs: 2000,
    ...extra,
  });

test('the app sees its OWN secret and a caller no app can impersonate', async () => {
  const s = await serve((_rq, rs) => {
    rs.writeHead(200, { 'content-type': 'application/json' });
    rs.end(JSON.stringify({ ok: true, text: 'Done.' }));
  });
  try {
    await call(s.port);
    const h = s.seen[0]!.headers;
    assert.equal(h['x-openmasjid-app-secret'], 'the-target-own-secret');
    assert.equal(h['x-openmasjid-caller-app'], 'omos:platform');
    assert.equal(h['content-type'], 'application/json');
    // Nothing else identity-shaped is forwarded.
    assert.equal(h['x-forwarded-for'], undefined);
    assert.equal(h.cookie, undefined);
    assert.equal(h.authorization, undefined);
  } finally {
    s.close();
  }
});

test('a redirect is NOT followed', async () => {
  // An app that answers 302 must not be able to aim the platform at another host.
  const s = await serve((_rq, rs) => {
    rs.writeHead(302, { location: 'http://example.com/somewhere' });
    rs.end();
  });
  try {
    const res = await call(s.port);
    assert.equal(res.status, 302, 'the redirect is returned, never chased');
    assert.equal(s.seen.length, 1);
  } finally {
    s.close();
  }
});

test('an oversized response is aborted at the command cap, not the broker cap', async () => {
  const s = await serve((_rq, rs) => {
    rs.writeHead(200, { 'content-type': 'application/json' });
    rs.end('x'.repeat(40 * 1024));
  });
  try {
    await assert.rejects(
      () => call(s.port, { maxResponseBytes: 16 * 1024 }),
      (e: unknown) => e instanceof CodedError && e.code === 'response_too_large',
    );
    // The same body is fine under the broker's 256 KB default — the extraction changed
    // nothing for the broker.
    const ok = await call(s.port);
    assert.equal(ok.status, 200);
  } finally {
    s.close();
  }
});

test('a hung app times out rather than hanging the conversation', async () => {
  const s = await serve(() => {
    /* never responds */
  });
  try {
    await assert.rejects(
      () => call(s.port, { timeoutMs: 300 }),
      (e: unknown) => e instanceof CodedError && e.code === 'timeout',
    );
  } finally {
    s.close();
  }
});

test('a closed port is unreachable, not a crash', async () => {
  await assert.rejects(
    () => call(1, { timeoutMs: 500 }),
    (e: unknown) => e instanceof CodedError && e.code === 'target_unreachable',
  );
});

// ── structural rules ─────────────────────────────────────────────────────────────

test('nothing in commands/ can message anyone but the sender', () => {
  // This is the property that keeps command replies the lowest-risk traffic the
  // number emits: a solicited answer to someone who just messaged us. It is one
  // careless commit from being false, and invisible in review.
  const exec = src('commands/execute.ts');

  // The bound reply closure is the ONLY send. Nothing may call the queue or the
  // immediate sender directly from here.
  assert.ok(!/\benqueue\s*\(/.test(exec), 'commands must not enqueue — replies are immediate or nothing');
  assert.ok(!/\bsendImmediate\s*\(/.test(exec), 'commands must not call sendImmediate directly');
  assert.ok(!/\bsendTestMessage\s*\(|\bsendTestToGroup\s*\(/.test(exec), 'commands must not use the test-send path');

  // replyTo is called exactly once, inside the closure that captures the sender.
  const replyCalls = exec.match(/replyTo\s*\(/g) ?? [];
  assert.equal(replyCalls.length, 1, 'exactly one replyTo call site');
  assert.match(exec, /await replyTo\(digits, cap\(text\)\)/, 'it must send to the captured sender');

  // And nothing in commands/ can construct a group send. Note this looks for
  // send-shaped CODE, not for the string "@g.us" — normalise.ts has to reason about
  // group JIDs precisely in order to reject them, and a rule that forbade mentioning
  // them would push that reasoning somewhere less visible.
  const dir = path.join(__dirname, '..', 'src', 'commands');
  for (const f of fs.readdirSync(dir)) {
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/kind:\s*'group'/.test(body), `${f}: builds a group target`);
    assert.ok(!/\bgroupId\s*[:,)]/.test(body), `${f}: passes a group id`);
    assert.ok(!/sendTestToGroup|isApprovedGroup/.test(body), `${f}: touches the group send path`);
  }
});

test('replyTo takes digits, so it cannot be handed a group id', () => {
  // A JID-shaped parameter would make "post to the parents group" one typo away.
  assert.match(src('notify/whatsapp.ts'), /export async function replyTo\(digits: string, text: string\)/);
  assert.match(src('notify/whatsapp.ts'), /sendImmediate\(\{ kind: 'person', digits \}/);
});

test('no OS command takes a phone number as an argument', () => {
  // `!send <number> <text>` is precisely the feature that turns an admin channel into
  // a spam gateway. It is out of scope, and this is what keeps it out.
  //
  // Asserted against the real declarations rather than by grepping for the word
  // "phone" — a text scan matches prose in comments and proves nothing.
  const { OS_COMMANDS } = req('../src/commands/os') as typeof import('../src/commands/os');
  assert.ok(OS_COMMANDS.length > 0);
  for (const c of OS_COMMANDS) {
    assert.ok(['none', 'app'].includes(c.argKind), `${c.id} has argKind ${c.argKind}`);
    // 'text' would be the door: free text an executor could read a number out of.
    assert.notEqual(c.argKind, 'text', `${c.id} must not take free text`);
  }
  // The refusals are documented in the file so nobody re-adds them casually.
  const osFile = src('commands/os.ts');
  for (const gone of ['reboot', 'logs', 'remove']) {
    assert.ok(osFile.includes(gone), `the reason "${gone}" is excluded must stay written down`);
    assert.ok(!new RegExp(`id: '${gone}'`).test(osFile), `${gone} must not be a command`);
  }
});

test('the platform-managed gateway cannot be stopped or updated by command', () => {
  // Doing so would recreate the container carrying this very conversation: the admin
  // sees "starting…" and then nothing, forever.
  const exec = src('commands/execute.ts');
  assert.match(exec, /isPlatformManaged\(target\.id\)/);
  assert.match(exec, /say\.managedApp/);
});

test('the executor never logs a message body', () => {
  const exec = src('commands/execute.ts');
  // The realistic leak is the error path: `log.error(msg, err)` prints whatever the
  // error closed over — which here is the message. So the rule is that no logger call
  // anywhere in commands/ takes a SECOND argument.
  //
  // Checked by scanning for the argument separator rather than by matching a whole
  // call: a naive /log\.error\([^)]*\)/ stops at the first ')' inside a template
  // literal and silently examines a fragment, which is a test that proves nothing.
  const dir = path.join(__dirname, '..', 'src', 'commands');
  for (const f of fs.readdirSync(dir)) {
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(
      !/log\.(error|warn|info|debug)\(`[^`]*`\s*,/.test(body),
      `${f}: a logger call passes a second argument — it will print what the error closed over`,
    );
    assert.ok(!/,\s*err\s*\)/.test(body), `${f}: an error object is passed to a logger`);
  }
  // The body reaches exactly one place: the parser.
  const bodyUses = exec.match(/msg\.body/g) ?? [];
  assert.equal(bodyUses.length, 1, 'the body is read once, to parse it');
  assert.match(exec, /parseCommand\(msg\.body,/);
});
