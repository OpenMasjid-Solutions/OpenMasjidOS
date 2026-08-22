// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Turning WhatsApp off, and deleting it.
 *
 * There are two different "off"s and the difference matters to a masjid:
 *
 *  - **Off, keep everything** — the default. The gateway key, the session, the linked
 *    number, the approved groups and the trustee phone list all stay, so switching back
 *    on restores the setup exactly. Nothing to re-paste, nothing to re-approve.
 *  - **Off, delete everything** — every one of those is erased and the gateway app is
 *    removed with its data.
 *
 * What is pinned here is mostly the SECOND kind of failure: a delete that reports success
 * while leaving something behind. Each of these left a real trace in an earlier design —
 * the API key that no admin edit can blank, the alerts matrix that re-arms itself on
 * re-enable, the trustee list that is an authorisation model in its own right, and the
 * Docker volume holding the linked-device credentials.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-wa-delete-'));

const req = createRequire(__filename);
const store = req('../src/store/whatsapp') as typeof import('../src/store/whatsapp');
const alerts = req('../src/notify/alerts') as typeof import('../src/notify/alerts');
const commands = req('../src/store/commands') as typeof import('../src/store/commands');

const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const GROUP = '120363012345678901@g.us';

function configure() {
  store.saveWhatsAppConfig({ provider: 'openwa', apiKey: 'secret-key-123', sessionName: 'openmasjid' });
  store.recordSessionId('11111111-2222-3333-4444-555555555555');
  store.recordLinkedPhone('15550101234');
  store.markLinked(new Date().toISOString());
  store.approveGroup(GROUP, 'Parents');
}

// ── turning it off must NOT lose anything ────────────────────────────────────────

test('TURNING IT OFF KEEPS EVERYTHING, so turning it back on needs no setup again', () => {
  configure();
  store.saveWhatsAppConfig({ provider: 'none' });

  // The whole promise of the plain "off": nothing to re-paste, nothing to re-approve.
  const off = store.getWhatsAppConfig();
  assert.equal(off.provider, 'none');
  assert.equal(off.apiKey, 'secret-key-123', 'the key must survive a plain switch-off');
  assert.equal(off.sessionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(off.linkedPhone, '15550101234');
  assert.equal(off.groups.length, 1);
  assert.equal(store.isWhatsAppConfigured(), false, 'but nothing may send while it is off');

  // And switching back on restores it, which is the behaviour a masjid is promised.
  store.saveWhatsAppConfig({ provider: 'openwa' });
  assert.equal(store.isWhatsAppConfigured(), true);
  assert.equal(store.getWhatsAppConfig().groups[0]?.label, 'Parents');
});

// ── deleting must leave nothing behind ───────────────────────────────────────────

test('DELETE ERASES THE API KEY — which no ordinary save can do', () => {
  configure();
  // The carve-out that makes this necessary: a blank apiKey is IGNORED by `save`, on
  // purpose, so that editing one setting never makes an admin re-paste their secret.
  store.saveWhatsAppConfig({ apiKey: '' });
  assert.equal(store.getWhatsAppConfig().apiKey, 'secret-key-123', 'save cannot blank the key by design');

  store.deleteWhatsAppConfig();
  assert.equal(store.getWhatsAppConfig().apiKey, '', 'delete must blank it');
});

test('delete clears the session, the linked number and every approved group', () => {
  configure();
  store.deleteWhatsAppConfig();
  const c = store.getWhatsAppConfig();
  assert.equal(c.provider, 'none');
  assert.equal(c.sessionId, '');
  assert.equal(c.linkedPhone, '');
  assert.equal(c.linkedAt, null);
  assert.equal(c.baseUrl, '', 'the gateway override points sending at another machine');
  assert.deepEqual(c.groups, []);
  assert.equal(store.isApprovedGroup(GROUP), false, 'apps must lose the right to post immediately');
});

test('delete removes the file, not just the in-memory copy', () => {
  configure();
  const file = path.join(process.env.OPENMASJID_DATA_DIR!, 'config', 'whatsapp.json');
  assert.ok(fs.existsSync(file), 'precondition: the config was written');
  store.deleteWhatsAppConfig();
  assert.equal(fs.existsSync(file), false, 'a masjid deleting everything keeps no file naming their session');
});

// ── the alerts matrix must not re-arm itself ─────────────────────────────────────

test("ALERTS: clearing the WhatsApp column stops a re-enable silently messaging the phone", () => {
  alerts.setAlertChannel('os', 'app-offline', 'whatsapp', true);
  alerts.setAlertChannel('os', 'core-update', 'whatsapp', true);
  assert.equal(alerts.getAlertChannels('os', 'app-offline').whatsapp, true, 'precondition');

  alerts.clearWhatsAppChannels();

  // The reason this matters: the column defaults to OFF precisely so that an upgrade can
  // never silently start messaging a phone. A delete-then-reinstall owes the same
  // promise, and without this the old ON rows are still on disk waiting.
  assert.equal(alerts.getAlertChannels('os', 'app-offline').whatsapp, false);
  assert.equal(alerts.getAlertChannels('os', 'core-update').whatsapp, false);
});

test('clearing the WhatsApp column leaves email and the webhook alone', () => {
  alerts.setAlertChannel('os', 'app-offline', 'email', false);
  alerts.setAlertChannel('os', 'app-offline', 'whatsapp', true);
  alerts.clearWhatsAppChannels();
  const c = alerts.getAlertChannels('os', 'app-offline');
  assert.equal(c.whatsapp, false);
  assert.equal(c.email, false, 'an unrelated choice must not be reset by a WhatsApp delete');
  assert.equal(c.webhook, true);
});

test('clearing the WhatsApp column persists — it must survive a restart', () => {
  alerts.setAlertChannel('os', 'app-update', 'whatsapp', true);
  alerts.clearWhatsAppChannels();
  const file = path.join(process.env.OPENMASJID_DATA_DIR!, 'config', 'alerts.json');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
  assert.doesNotMatch(raw, /"whatsapp"\s*:\s*true/, 'no row may still say whatsapp:true on disk');
});

// ── the trustee list is an authorisation model, not a convenience ────────────────

test('COMMANDS: delete empties the authorised-sender list', () => {
  commands.addCommandPerson('15550101234', 'Imam', []);
  commands.addCommandPerson('15550109999', 'Treasurer', []);
  assert.equal(commands.listCommandPeople().length, 2, 'precondition');

  commands.clearCommandPeople();

  // A phone on this list can start, stop and update a masjid's apps with no password
  // step. Leaving it behind means re-enabling WhatsApp months later silently re-arms
  // whichever numbers were trusted then — including a phone that has changed hands.
  assert.deepEqual(commands.listCommandPeople(), []);
  assert.equal(commands.authoriseSender('15550101234'), null);
});

// ── ordering and completeness, pinned structurally ───────────────────────────────

test('THE GATEWAY IS UNLINKED VIA /logout — the only route that frees the phone', () => {
  const src = read('notify', 'whatsapp.ts');
  assert.match(src, /\/logout/, 'unlinkSession must call the logout route');
  // stop and delete only release things LOCALLY: the device stays listed under Linked
  // Devices on the handset, and once the container is gone nothing here can revoke it.
  // So a delete that skipped logout would strand a device entry for ever.
  assert.match(src, /export async function unlinkSession/);
  assert.match(src, /export async function deleteGatewaySession/);
});

test('the delete talks to the gateway BEFORE removing the app that is the gateway', () => {
  const src = read('trpc', 'routers', 'whatsapp.ts');
  const unlinkAt = src.indexOf('unlinkSession()');
  const removeAt = src.indexOf('removeApp(OPENWA_APP_ID');
  assert.ok(unlinkAt > 0 && removeAt > 0, 'both steps must exist');
  assert.ok(
    unlinkAt < removeAt,
    'once the container is removed there is no way left to tell WhatsApp to release the device',
  );
});

test('the gateway app is removed WITH its data, or the credentials and key survive', () => {
  const src = read('trpc', 'routers', 'whatsapp.ts');
  // `deleteData: true` is what removes the Docker volumes holding the linked-device
  // credentials, and apps/openwa/.env — a SECOND copy of the gateway API key, written
  // without a 0600 mode. Removing the app without it deletes almost nothing that matters.
  assert.match(src, /removeApp\(OPENWA_APP_ID,\s*true\)/);
});

test('the delete clears every store that holds WhatsApp state', () => {
  const src = read('trpc', 'routers', 'whatsapp.ts');
  for (const fn of [
    'deleteWhatsAppConfig', // the key, session, linked number, groups
    'clearQueueStore', // queued message bodies on disk
    'clearWhatsAppRuntime', // the same in memory, plus the lid->phone cache
    'clearWhatsAppChannels', // the alerts matrix
    'clearCommandPeople', // the trustee phone list
    'setCommandsEnabled', // and the switch itself
  ]) {
    assert.match(src, new RegExp(`${fn}\\(`), `a full delete must call ${fn}()`);
  }
});

test('the runtime clear is SEPARATE from the test-only pacing reset', () => {
  const src = read('notify', 'whatsapp.ts');
  // They look mergeable and are not: __resetPacingForTests deliberately leaves `outcomes`
  // and `lidPhones` alone, and both are personal data (per-app message history, and a
  // cache mapping WhatsApp privacy ids to real phone numbers) belonging to a masjid that
  // has just asked for all of it to go. Merging would silently widen one or narrow the
  // other.
  assert.match(src, /export function clearWhatsAppRuntime/);
  assert.match(src, /export function __resetPacingForTests/);
  const clear = src.slice(src.indexOf('export function clearWhatsAppRuntime'));
  assert.match(clear, /outcomes\.length = 0/, 'the delete path must clear outcomes');
  assert.match(clear, /lidPhones\.clear\(\)/, 'and the privacy-id cache');
});

test('the inbound socket is reconciled, never hard-stopped', () => {
  const src = read('trpc', 'routers', 'whatsapp.ts');
  assert.match(src, /reconcileWhatsAppInbound\(\)/);
  // stopWhatsAppInbound() latches the supervisor off for the whole process lifetime, so
  // a later re-enable would never reconnect until the container restarted.
  assert.doesNotMatch(src, /stopWhatsAppInbound\(/, 'must not hard-stop the inbound supervisor');
});

test("the admin's own phone number is NOT deleted with the gateway", () => {
  const src = read('trpc', 'routers', 'whatsapp.ts');
  // It lives on the admin record beside their email, as a destination for alerts — it is
  // account data, not WhatsApp state, and silently clearing it would be a surprise.
  assert.doesNotMatch(src, /setAdminPhone|clearAdminPhone/);
});
