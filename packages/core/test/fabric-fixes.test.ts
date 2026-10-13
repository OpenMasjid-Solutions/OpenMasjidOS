// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Regression tests for a review of the Fabric, mail, alerts and their monitors — each
 * one pinned against the real code path rather than a description of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-fabric-fixes-'));
process.env.OPENMASJID_DATA_DIR = DATA;

const req = createRequire(__filename);
const Fastify = req('fastify') as typeof import('fastify').default;
const fabric = req('../src/api/fabric') as typeof import('../src/api/fabric');
const manager = req('../src/apps/manager') as typeof import('../src/apps/manager');
const email = req('../src/notify/email') as typeof import('../src/notify/email');
const emailStore = req('../src/store/email') as typeof import('../src/store/email');
const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');

const BUS = '172.17.0.1'; // what EVERY app presents, behind Docker's published port

/** Answer every `fetch` in `fn` with `handler`, then put the real one back. */
async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The context the dashboard's own requests carry: a genuine session and its key. */
function dashboardContext(): never {
  const { token, csrf } = sessions.createSession('admin', sessions.currentCredential());
  return {
    username: 'admin',
    sessionToken: token,
    csrf,
    isWebSocket: false,
    ip: '192.168.1.20',
    host: 'openmasjidos.local',
    viaTunnel: false,
    remoteIp: null,
    setSessionCookie: () => {},
    clearSessionCookie: () => {},
  } as never;
}

function installApp(id: string, secret: string, caps: Record<string, boolean>): void {
  const dir = path.join(DATA, 'apps', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, name: id, kind: 'catalog', ssoSecret: secret, ...caps }));
  manager.invalidateFabricIndex();
}

const POLLER = `poller-secret-${'p'.repeat(40)}`;
const SENDER = `sender-secret-${'s'.repeat(40)}`;
installApp('poller', POLLER, { whatsapp: true });
installApp('sender', SENDER, { notify: true });

async function fabricServer() {
  const app = Fastify();
  fabric.registerFabric(app);
  await app.ready();
  return app;
}

const notify = (app: Awaited<ReturnType<typeof fabricServer>>, secret: string | null) =>
  app.inject({
    method: 'POST',
    url: '/api/fabric/notify',
    remoteAddress: BUS,
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-openmasjid-app-secret': secret } : {}) },
    payload: { text: 'hello' },
  });

// ── the per-IP bucket every app shares ───────────────────────────────────────────

test("ONE APP'S ALLOWED TRAFFIC CANNOT REFUSE ANOTHER APP'S CALLS", async () => {
  // Every route charged identified apps to the per-IP bucket too, and every app arrives
  // from the same address: one app polling its message outcomes at its allowed rate
  // emptied it, and every other app's email, WhatsApp, alerts and Stripe calls got 429.
  fabric.__resetFabricRateForTests();
  const app = await fabricServer();
  try {
    let polled = 0;
    for (let i = 0; i < 605; i++) {
      const r = await app.inject({
        method: 'GET',
        url: '/api/fabric/whatsapp/status/no-such-message',
        remoteAddress: BUS,
        headers: { 'x-openmasjid-app-secret': POLLER },
      });
      if (r.statusCode === 404) polled++;
    }
    assert.ok(polled >= 600, `precondition: the poller used its whole read budget (${polled})`);
    const r = await notify(app, SENDER);
    assert.notEqual(r.statusCode, 429, "another app's polling refused this app's notification");
  } finally {
    await app.close();
  }
});

test('a caller with no valid secret is still bounded by the shared tier', async () => {
  fabric.__resetFabricRateForTests();
  const app = await fabricServer();
  try {
    let last = 0;
    for (let i = 0; i < 605; i++) last = (await notify(app, null)).statusCode;
    assert.equal(last, 429, 'an unidentified flood must still be refused');
    // ...and an identified app is not refused by that flood.
    assert.notEqual((await notify(app, SENDER)).statusCode, 429);
  } finally {
    await app.close();
  }
});

// ── Settings → Email: Save checks what sending will actually do ──────────────────

type EmailConfig = import('../src/store/email').EmailConfig;
const resendConfig = (apiKey: string): EmailConfig => ({
  ...emailStore.getEmailConfig(),
  provider: 'resend',
  fromEmail: 'alerts@masjid.test',
  resend: { apiKey },
});

test('SAVE ACCEPTS A SENDING-ONLY RESEND KEY AND REFUSES A BAD ONE', async () => {
  // It was the other way round: an invalid key answers 400 (or 403) and was stored, so
  // every alert email then failed with only a log line; the least-privilege key Resend
  // recommends answers 401 restricted_api_key and was refused.
  const cases: [number, unknown, boolean][] = [
    [200, { data: [] }, true],
    [401, { statusCode: 401, name: 'restricted_api_key', message: 'This API key is restricted to only send emails' }, true],
    [400, { statusCode: 400, name: 'validation_error', message: 'API key is invalid' }, false],
    [403, { statusCode: 403, name: 'invalid_api_key', message: 'API key is invalid' }, false],
    [403, { statusCode: 403, name: 'restricted_api_key', message: 'API key is not active' }, false],
    [401, { statusCode: 401, name: 'missing_api_key', message: 'Missing API key' }, false],
  ];
  for (const [status, body, ok] of cases) {
    const v = await withFetch(() => jsonResponse(status, body), () => email.verifyEmailConfig(resendConfig('re_test')));
    assert.equal(v.ok, ok, `HTTP ${status} ${JSON.stringify(body)}`);
  }
  // Load or an outage is "try again", not "your key is wrong".
  for (const status of [429, 503]) {
    const v = await withFetch(() => jsonResponse(status, {}), () => email.verifyEmailConfig(resendConfig('re_test')));
    assert.equal(v.ok, false);
    assert.match(v.error ?? '', /try again/, `HTTP ${status}`);
  }
});

/** A mail server that does not offer STARTTLS, recording every line it is sent. */
async function plainSmtpServer(): Promise<{ port: number; lines: string[]; close: () => Promise<void> }> {
  const lines: string[] = [];
  const server = net.createServer((sock) => {
    sock.on('error', () => undefined);
    sock.write('220 fake.test ESMTP\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (let i = buf.indexOf('\r\n'); i >= 0; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        lines.push(line);
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO') sock.write('250-fake.test\r\n250 AUTH PLAIN\r\n');
        else if (verb === 'STARTTLS') sock.write('502 5.5.1 Not supported\r\n');
        else if (verb === 'AUTH') sock.write('235 2.7.0 Accepted\r\n');
        else if (verb === 'QUIT') sock.end('221 Bye\r\n');
        else sock.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    lines,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('SAVE NEVER SENDS THE MAIL PASSWORD WHERE SENDING WOULD REFUSE TO', async () => {
  // Save's check logged in without requireTLS, so a server (or an attacker stripping the
  // STARTTLS offer) got the password in the clear on every Save — and a server with no
  // STARTTLS passed Save, then every send failed.
  const s = await plainSmtpServer();
  try {
    const cfg: EmailConfig = {
      ...emailStore.getEmailConfig(),
      provider: 'smtp',
      fromEmail: 'alerts@masjid.test',
      smtp: { host: '127.0.0.1', port: s.port, secure: false, user: 'masjid', pass: 'the-mail-password' },
    };
    const v = await email.verifyEmailConfig(cfg);
    assert.equal(v.ok, false, 'a server that cannot encrypt must not pass Save');
    assert.equal(s.lines.some((l) => /^AUTH/i.test(l)), false, 'the password was sent in the clear');
    // A relay with no login has no password to protect, and still passes.
    const relay = await email.verifyEmailConfig({ ...cfg, smtp: { ...cfg.smtp, user: '', pass: '' } });
    assert.equal(relay.ok, true, relay.error);
  } finally {
    await s.close();
  }
});

test('APP MAIL OVER THE SIZE LIMIT IS REFUSED, NOT CUT OFF AND CALLED SENT', async () => {
  emailStore.saveEmailConfig({ provider: 'resend', fromEmail: 'alerts@masjid.test', resend: { apiKey: 're_test' } });
  let sends = 0;
  try {
    await withFetch(
      () => {
        sends++;
        return jsonResponse(200, { id: 'sent' });
      },
      async () => {
        const html = `<p>${'x'.repeat(100_001)}</p>`;
        const r = await email.sendEmail({ to: 'donor@masjid.test', subject: 'Receipt', text: '', html }, 'donations');
        assert.deepEqual(r, { sent: false, reason: 'too_large' });
        assert.equal(sends, 0, 'nothing may go out');
        const ok = await email.sendEmail({ to: 'donor@masjid.test', subject: 'Receipt', text: 'x'.repeat(100_000) }, 'donations');
        assert.deepEqual(ok, { sent: true }, 'a body at the limit still sends');
      },
    );
  } finally {
    emailStore.saveEmailConfig({ provider: 'none' });
  }
});

test('a failed test email says why in words, never as an internal code', async () => {
  const { emailRouter } = req('../src/trpc/routers/email') as typeof import('../src/trpc/routers/email');
  emailStore.saveEmailConfig({ provider: 'none' });
  await assert.rejects(
    () => emailRouter.createCaller(dashboardContext()).test({ to: 'admin@masjid.test' }),
    (e: Error) => /isn't set up yet/.test(e.message) && !/not_configured|\(/.test(e.message),
  );
});

// ── admin alerts ────────────────────────────────────────────────────────────────

const alerts = req('../src/notify/alerts') as typeof import('../src/notify/alerts');

test("A BURST OF ONE APP'S ALERTS CANNOT SILENCE THE PLATFORM'S OWN", async () => {
  // App-raised alert emails were rate-limited as 'os', so thirty from one app (the Fabric
  // lets an app raise 120 a minute) spent the platform's budget, and the next chargeback
  // or app-offline email was dropped — and the chargeback monitor never retries.
  const auth = req('../src/auth/store') as typeof import('../src/auth/store');
  auth.createAdminIfUnset({ username: 'admin', passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb', email: 'admin@masjid.test' });
  emailStore.saveEmailConfig({ provider: 'resend', fromEmail: 'alerts@masjid.test', resend: { apiKey: 're_test' } });
  try {
    await withFetch(
      () => jsonResponse(200, { id: 'sent' }),
      async () => {
        let appEmails = 0;
        for (let i = 0; i < 35; i++) {
          const r = await alerts.deliverAlert({ source: 'reader-app', sourceName: 'Reader', alertId: 'reader-offline', text: 'The reader is offline.' });
          if (r.email) appEmails++;
        }
        assert.ok(appEmails < 35, `precondition: the app reached its own mail limit (${appEmails} sent)`);
        const own = await alerts.deliverAlert({ source: 'os', alertId: 'stripe-chargeback', title: 'A payment has been disputed', text: 'A card payment has been disputed.' });
        assert.equal(own.email, true, "an app's burst dropped the platform's own alert");
      },
    );
  } finally {
    emailStore.saveEmailConfig({ provider: 'none' });
  }
});

test('a subject made from an alert is shortened even when its text has no early space', () => {
  // `lastIndexOf` found no space, so the text was "shortened" by one character; a lone
  // space near the start left just "A…".
  const unbroken = alerts.firstSentence('x'.repeat(200));
  assert.ok(unbroken.length <= 78 && unbroken.endsWith('…'), `${unbroken.length} chars`);
  const early = alerts.firstSentence(`A ${'y'.repeat(200)}`);
  assert.notEqual(early, 'A…');
  assert.ok(early.length > 20 && early.length <= 78, early);
  // A word boundary is still preferred when there is one.
  assert.equal(alerts.firstSentence(`${'word '.repeat(30)}end`), `${'word '.repeat(15).trim()}…`);
});

// ── Settings → Payments ─────────────────────────────────────────────────────────

test("A STRIPE KEY JUST SAVED SHOWS ITS OWN STATUS, NOT THE OLD KEY'S", async () => {
  // The green/red dot was cached for a minute per account, and saving or removing one did
  // not clear it: a corrected key stayed red, a broken one green, for up to 60 s more.
  const { stripeRouter } = req('../src/trpc/routers/stripe') as typeof import('../src/trpc/routers/stripe');
  const caller = stripeRouter.createCaller(dashboardContext());
  const validKey = 'sk_test_the_right_one';
  await withFetch(
    (_url, init) => jsonResponse((init?.headers as Record<string, string>)?.authorization === `Bearer ${validKey}` ? 200 : 401, {}),
    async () => {
      const { id } = await caller.save({ label: 'Donations', publishableKey: 'pk_test_x', secretKey: 'sk_test_mistyped' });
      assert.deepEqual(await caller.status(), [{ id, online: false }]);
      await caller.save({ id, label: 'Donations', publishableKey: '', secretKey: validKey });
      assert.deepEqual(await caller.status(), [{ id, online: true }], 'the corrected key still shows the old answer');
      await caller.remove({ id });
      const again = await caller.save({ label: 'Donations', publishableKey: 'pk_test_x', secretKey: 'sk_test_another' });
      assert.equal(again.id, id, 'precondition: re-added under the same name, so the same id');
      assert.deepEqual(await caller.status(), [{ id, online: false }], 'a removed account\'s answer stood in for the new one');
      await caller.remove({ id });
    },
  );
});
