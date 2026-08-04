// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The chargeback pipeline end to end: poll → parse → route through the alert matrix →
 * out of the webhook channel, plus the state file that stops it re-sending.
 *
 * Only Stripe itself is stubbed (by intercepting `fetch` for api.stripe.com and
 * letting every other request through to a real local server). Everything downstream
 * runs for real: the monitor, `selectNewDisputes`, the persisted state, the per-alert
 * channel matrix, and the actual webhook POST. That is deliberately the opposite of
 * mocking my own code — the unit tests cover the parsing, and this covers the wiring
 * between the pieces, which is where an integration bug would actually live.
 *
 * A deliberately UNstubbed detail: the real `fetch` is used for the webhook, so a
 * bug in the request the platform sends shows up here as a malformed body rather than
 * being asserted against a mock's expectations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const req = createRequire(__filename);

interface Received {
  body: string;
  contentType: string | undefined;
}

/** A local server standing in for the masjid's Slack/Discord webhook. */
async function webhookServer(sink: Received[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((r, res) => {
    let body = '';
    r.on('data', (c) => (body += c));
    r.on('end', () => {
      sink.push({ body, contentType: r.headers['content-type'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const DISPUTE = {
  id: 'dp_e2e_001',
  object: 'dispute',
  amount: 4500,
  currency: 'gbp',
  reason: 'fraudulent',
  status: 'needs_response',
  created: 1_754_000_000,
  evidence_details: { due_by: 1_755_000_000 },
};

/** Stub api.stripe.com only; anything else (the webhook) uses the real fetch. */
function stubStripe(payload: unknown, opts: { status?: number } = {}): () => void {
  const real = globalThis.fetch;
  let sawAuthHeader: string | null = null;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string })?.url ?? input);
    if (url.includes('api.stripe.com')) {
      sawAuthHeader = String((init?.headers as Record<string, string>)?.authorization ?? '');
      // The platform must ask with the account's secret key as a bearer token.
      assert.match(sawAuthHeader, /^Bearer sk_test_/, 'the secret key must be sent as a bearer token');
      assert.match(url, /\/v1\/disputes\?/, 'must call the disputes endpoint');
      return new Response(JSON.stringify(payload), {
        status: opts.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** A data dir with one Stripe account and the webhook channel pointed at `hookUrl`. */
function stage(hookUrl: string): { dir: string; statePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-cb-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config', 'stripe.json'),
    JSON.stringify({
      accounts: [
        {
          id: 'donations',
          label: 'Masjid Donations',
          publishableKey: 'pk_test_x',
          secretKey: 'sk_test_e2e_not_a_real_key',
          webhookSecret: '',
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'config', 'settings.json'),
    JSON.stringify({ notifications: { enabled: true, type: 'slack', url: hookUrl, label: 'Masjid' } }),
  );
  // No admin email configured, so the email channel is a no-op and the webhook is the
  // observable channel. That keeps the test off the network and out of a mail server.
  process.env.OPENMASJID_DATA_DIR = dir;
  for (const m of [
    '../src/config',
    '../src/settings/store',
    '../src/store/stripe',
    '../src/auth/store',
    '../src/notify/notify',
    '../src/notify/alerts',
    '../src/system/stripe-monitor',
  ]) {
    delete req.cache[req.resolve(m)];
  }
  return { dir, statePath: path.join(dir, 'config', 'stripe-disputes.json') };
}

test('a new chargeback reaches the webhook, and is never sent twice', async () => {
  const sink: Received[] = [];
  const hook = await webhookServer(sink);
  const restore = stubStripe({ data: [DISPUTE] });
  try {
    const { statePath } = stage(hook.url);
    const mon = req('../src/system/stripe-monitor') as typeof import('../src/system/stripe-monitor');

    await mon.checkStripeDisputesNow();

    assert.equal(sink.length, 1, 'exactly one alert should have been delivered');
    const payload = JSON.parse(sink[0]!.body) as Record<string, unknown>;
    const flat = JSON.stringify(payload);
    // The things a treasurer needs: the money, the deadline, and which account.
    assert.match(flat, /45\.00/, 'the amount must be in the notification');
    assert.match(flat, /disputed/i);
    assert.match(flat, /Masjid Donations/, 'which Stripe account it was');
    // And the things that must never be in it.
    assert.doesNotMatch(flat, /sk_test/, 'the secret key must never leave in a notification');
    assert.doesNotMatch(flat, /undefined|NaN/, 'no placeholder text reaches the admin');

    // State recorded under config/, so it is covered by the data-dir guard and by
    // writeJson's 0600. Contents are dispute ids, not secrets.
    assert.ok(fs.existsSync(statePath), 'the seen-state must be persisted');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      accounts: Record<string, { seen: string[]; initialised: boolean }>;
    };
    assert.deepEqual(state.accounts.donations?.seen, ['dp_e2e_001']);
    assert.equal(state.accounts.donations?.initialised, true);

    // Polling again must be silent — this is the whole reason state is persisted.
    await mon.checkStripeDisputesNow();
    await mon.checkStripeDisputesNow();
    assert.equal(sink.length, 1, 'the same dispute must not alert again');
  } finally {
    restore();
    await hook.close();
  }
});

test('an unreachable Stripe records nothing, so the dispute is not lost', async () => {
  // The dangerous failure: treating "could not ask" as "there are none" would mark
  // unseen chargebacks as seen and the masjid would never hear about them.
  const sink: Received[] = [];
  const hook = await webhookServer(sink);
  const restore = stubStripe({ error: { message: 'Invalid API Key provided: sk_test_***' } }, { status: 401 });
  try {
    const { statePath } = stage(hook.url);
    const mon = req('../src/system/stripe-monitor') as typeof import('../src/system/stripe-monitor');
    await mon.checkStripeDisputesNow();
    assert.equal(sink.length, 0, 'an API failure must not alert the admin');
    assert.equal(fs.existsSync(statePath), false, 'and must not record any state');
  } finally {
    restore();
    await hook.close();
  }

  // Now Stripe comes back: the dispute that was there all along must still alert.
  const sink2: Received[] = [];
  const hook2 = await webhookServer(sink2);
  const restore2 = stubStripe({ data: [DISPUTE] });
  try {
    stage(hook2.url);
    const mon = req('../src/system/stripe-monitor') as typeof import('../src/system/stripe-monitor');
    await mon.checkStripeDisputesNow();
    assert.equal(sink2.length, 1, 'the dispute survives an earlier outage');
  } finally {
    restore2();
    await hook2.close();
  }
});

test('the admin can switch the alert off and nothing is sent', async () => {
  const sink: Received[] = [];
  const hook = await webhookServer(sink);
  const restore = stubStripe({ data: [DISPUTE] });
  try {
    const { dir } = stage(hook.url);
    // Both channels off for this alert type — the matrix must be honoured.
    fs.writeFileSync(
      path.join(dir, 'config', 'alerts.json'),
      JSON.stringify({ channels: { 'os:stripe-chargeback': { email: false, webhook: false } } }),
    );
    for (const m of ['../src/notify/alerts', '../src/system/stripe-monitor']) delete req.cache[req.resolve(m)];
    const mon = req('../src/system/stripe-monitor') as typeof import('../src/system/stripe-monitor');
    await mon.checkStripeDisputesNow();
    assert.equal(sink.length, 0, 'a disabled alert must not be delivered');
  } finally {
    restore();
    await hook.close();
  }
});

test('a burst of disputes sends one grouped notification', async () => {
  const sink: Received[] = [];
  const hook = await webhookServer(sink);
  const many = Array.from({ length: 9 }, (_, i) => ({ ...DISPUTE, id: `dp_burst_${i}` }));
  const restore = stubStripe({ data: many });
  try {
    stage(hook.url);
    const mon = req('../src/system/stripe-monitor') as typeof import('../src/system/stripe-monitor');
    await mon.checkStripeDisputesNow();
    assert.equal(sink.length, 1, 'nine disputes must not become nine notifications');
    const flat = JSON.stringify(JSON.parse(sink[0]!.body));
    assert.match(flat, /9 card payments/);
    assert.match(flat, /405\.00/, 'the grouped total is 9 × £45.00');
  } finally {
    restore();
    await hook.close();
  }
});

test('no Stripe account configured is a silent no-op', async () => {
  const sink: Received[] = [];
  const hook = await webhookServer(sink);
  const restore = stubStripe({ data: [DISPUTE] });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-cb-none-'));
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config', 'settings.json'),
      JSON.stringify({ notifications: { enabled: true, type: 'slack', url: hook.url } }),
    );
    process.env.OPENMASJID_DATA_DIR = dir;
    for (const m of ['../src/config', '../src/settings/store', '../src/store/stripe', '../src/notify/alerts', '../src/system/stripe-monitor']) {
      delete req.cache[req.resolve(m)];
    }
    const mon = req('../src/system/stripe-monitor') as typeof import('../src/system/stripe-monitor');
    await mon.checkStripeDisputesNow();
    assert.equal(sink.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'config', 'stripe-disputes.json')), false);
  } finally {
    restore();
    await hook.close();
  }
});
