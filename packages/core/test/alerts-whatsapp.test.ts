// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WhatsApp is an alert channel for the PLATFORM's own alerts only.
 *
 * The alerts matrix routes things to the admin, and the platform knows exactly one phone
 * number — the admin's. An app that wants to message people over WhatsApp is almost never
 * trying to reach that number: it is telling a parent their fees are due, or a donor that
 * a receipt is ready. A WhatsApp toggle on an app's alert therefore promised routing the
 * platform cannot do.
 *
 * What does NOT change: apps still send through the OS. `POST /api/fabric/whatsapp` uses
 * the same gateway, the same credentials the app never sees, and the same single paced
 * queue that keeps the number unbanned. Only the CHOICE — which events go out, and to
 * whom — moves into the app's own settings.
 *
 * Separate from `alerts.test.ts`, which is deliberately read-only; this one persists, so
 * it needs a data dir of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-alerts-wa-'));

const req = createRequire(__filename);
const alerts = req('../src/notify/alerts') as typeof import('../src/notify/alerts');

test('only the platform may route an alert to WhatsApp', () => {
  assert.equal(alerts.whatsappAllowed('os'), true);
  assert.equal(alerts.whatsappAllowed('students'), false);
  assert.equal(alerts.whatsappAllowed('donations'), false);
});

test("an app's alert can never end up on the admin's phone, even if the file says so", () => {
  // Enforced on READ, not just hidden in the UI — a config written while the column
  // existed for apps, or edited by hand, must not keep sending.
  alerts.setAlertChannel('students', 'reader-offline', 'whatsapp', true);
  assert.equal(alerts.getAlertChannels('students', 'reader-offline').whatsapp, false);
});

test('apps keep email and the webhook, which really are "tell the admin"', () => {
  alerts.setAlertChannel('students', 'reader-offline', 'email', false);
  assert.equal(alerts.getAlertChannels('students', 'reader-offline').email, false);
  assert.equal(alerts.getAlertChannels('students', 'reader-offline').webhook, true);
});

test('the platform keeps its own WhatsApp column', () => {
  alerts.setAlertChannel('os', 'app-offline', 'whatsapp', true);
  assert.equal(alerts.getAlertChannels('os', 'app-offline').whatsapp, true);
  alerts.setAlertChannel('os', 'app-offline', 'whatsapp', false);
  assert.equal(alerts.getAlertChannels('os', 'app-offline').whatsapp, false);
});

test('the matrix tells the UI which rows may offer the column', () => {
  // So the UI shows "set up in the app" rather than a toggle that would do nothing.
  const types = alerts.listAlertTypes();
  const osRow = types.find((x) => x.source === 'os');
  assert.ok(osRow, 'the OS rows must exist');
  assert.equal(osRow.whatsappAvailable, true);
  // Every non-OS row must be marked unavailable, whatever apps happen to be installed.
  for (const row of types.filter((x) => x.source !== 'os')) {
    assert.equal(row.whatsappAvailable, false, `${row.source} must not offer the column`);
  }
});

test('apps still send WhatsApp through the platform, not around it', () => {
  // The split only moves the CHOICE into the app. If an app ever gained the gateway URL
  // or key, the single paced queue — the whole anti-ban defence — would be bypassed.
  const src = fs
    .readFileSync(path.join(__dirname, '..', 'src', 'api', 'fabric.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Anchor on the POST specifically: a GET on the same path sits above it, and matching
  // the path alone found that instead and read past the end of the send handler.
  const at = src.indexOf("server.post('/api/fabric/whatsapp'");
  assert.ok(at > 0, 'the app-facing send route must still exist');
  assert.match(src.slice(at, at + 1200), /enqueueWhatsApp/, 'and must still go through the queue');
});

test('an app can ask whether WhatsApp is usable, without learning anything about it', () => {
  // Without this an app's "WhatsApp reminders" switch looks available on every install
  // and silently fails on the ones with no gateway — and only when a real reminder was
  // due. But the answer must stay a tiny vocabulary: an app renders one of four
  // sentences, it does not track OpenWA's lifecycle, and it never learns the gateway
  // address, the API key or the linked number.
  const src = fs
    .readFileSync(path.join(__dirname, '..', 'src', 'api', 'fabric.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const at = src.indexOf("server.get('/api/fabric/whatsapp'");
  assert.ok(at > 0, 'the availability read must exist');
  const body = src.slice(at, src.indexOf('server.post(', at));

  assert.match(body, /app\.whatsapp/, 'it must be capability-gated like the send');
  for (const word of ['ready', 'not-configured', 'not-linked', 'unreachable']) {
    assert.match(body, new RegExp(`'${word}'`), `${word} must be reportable`);
  }
  // Nothing about the gateway itself may cross this boundary. NOTE: the boundary must be
  // written `\\b` inside a template literal — a bare `\b` there is a BACKSPACE character,
  // which matches nothing and makes every one of these assertions pass vacuously.
  for (const leak of ['apiKey', 'baseUrl', 'sessionId', 'phone', 'detail']) {
    assert.doesNotMatch(body, new RegExp(`\\b${leak}\\b`), `${leak} must not be returned to an app`);
  }
});
