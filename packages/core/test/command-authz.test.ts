// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Who may run a command over WhatsApp.
 *
 * This is the security boundary for a channel that can stop and update a masjid's
 * apps with no password step, so every test here is a fail-closed one. The most
 * important is the least obvious: an unknown sender gets NOTHING back. A refusal
 * message would confirm to a stranger that this number runs a masjid's server, spend
 * the sending budget that fee reminders need, and — sent to enough scanned numbers —
 * is the strongest ban signal the account can emit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-cmd-'));
process.env.OPENMASJID_DATA_DIR = dataDir;

const req = createRequire(__filename);
const store = req('../src/store/commands') as typeof import('../src/store/commands');

const ALICE = '15550101234';
const BOB = '447700900123';

function reset(): void {
  fs.rmSync(path.join(dataDir, 'config', 'commands.json'), { force: true });
  store.__reloadCommandConfigForTests();
}

test('off by default, and nobody is on the list', () => {
  reset();
  assert.equal(store.areCommandsEnabled(), false);
  assert.deepEqual(store.listCommandPeople(), []);
  assert.equal(store.authoriseSender(ALICE), null);
});

test('the master switch gates everything, even a fully granted person', () => {
  reset();
  store.addCommandPerson(ALICE, 'Alice', [store.OS_READ, store.OS_CONTROL]);
  assert.equal(store.authoriseSender(ALICE), null, 'still off');
  store.setCommandsEnabled(true);
  assert.ok(store.authoriseSender(ALICE));
  store.setCommandsEnabled(false);
  assert.equal(store.authoriseSender(ALICE), null, 'off again');
});

test('an unknown number is never authorised', () => {
  reset();
  store.setCommandsEnabled(true);
  store.addCommandPerson(ALICE, 'Alice', [store.OS_READ]);
  assert.equal(store.authoriseSender(BOB), null);
  assert.equal(store.authoriseSender(''), null);
  assert.equal(store.authoriseSender(null), null);
  assert.equal(store.authoriseSender(undefined), null);
  // A LID cannot be mapped to a phone, so util/phone.jidDigits hands us null.
  assert.equal(store.authoriseSender('12345'), null, 'too short to be a real number');
});

test('scope is checked separately from membership', () => {
  reset();
  store.setCommandsEnabled(true);
  store.addCommandPerson(ALICE, 'Alice', [store.OS_READ]);
  assert.ok(store.authoriseCommand(ALICE, store.OS_READ));
  assert.equal(store.authoriseCommand(ALICE, store.OS_CONTROL), null, 'read does not imply control');
  assert.equal(store.authoriseCommand(ALICE, 'display'), null);
  assert.equal(store.authoriseCommand(BOB, store.OS_READ), null, 'not a member at all');
});

test('one number has one representation', () => {
  reset();
  store.setCommandsEnabled(true);
  store.addCommandPerson('+1 555 010 1234', 'Alice', [store.OS_READ]);
  assert.ok(store.authoriseSender('15550101234'));
  assert.ok(store.authoriseSender('+1 (555) 010-1234'));
  assert.equal(store.authoriseSender('15550101235'), null, 'a different number is a different person');
  // Re-adding the same human updates rather than duplicating them.
  store.addCommandPerson('15550101234', 'Alice B', [store.OS_CONTROL]);
  assert.equal(store.listCommandPeople().length, 1);
  assert.deepEqual(store.listCommandPeople()[0]!.scopes, [store.OS_CONTROL]);
});

test('a number with no country code is refused, not guessed at', () => {
  reset();
  assert.throws(() => store.addCommandPerson('5550123', 'Alice', [store.OS_READ]), /needs a country code/);
});

test('removing someone takes their grants with them', () => {
  reset();
  store.setCommandsEnabled(true);
  store.addCommandPerson(ALICE, 'Alice', [store.OS_READ, store.OS_CONTROL]);
  store.removeCommandPerson('+1 555 010 1234');
  assert.deepEqual(store.listCommandPeople(), []);
  assert.equal(store.authoriseSender(ALICE), null);
});

test('setCommandScope grants and revokes exactly one scope', () => {
  reset();
  store.setCommandsEnabled(true);
  store.addCommandPerson(ALICE, 'Alice', [store.OS_READ]);
  store.setCommandScope(ALICE, 'display', true);
  assert.ok(store.authoriseCommand(ALICE, 'display'));
  assert.ok(store.authoriseCommand(ALICE, store.OS_READ), 'the other grant is untouched');
  store.setCommandScope(ALICE, 'display', false);
  assert.equal(store.authoriseCommand(ALICE, 'display'), null);
  // Granting twice must not produce a duplicate entry.
  store.setCommandScope(ALICE, 'display', true);
  store.setCommandScope(ALICE, 'display', true);
  assert.equal(store.listCommandPeople()[0]!.scopes.filter((s) => s === 'display').length, 1);
});

test('a hand-edited config file is sanitised, not trusted', () => {
  reset();
  const file = path.join(dataDir, 'config', 'commands.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      commands: {
        // Not the boolean `true`, so it must read as OFF.
        enabled: 'yes',
        people: [
          // Written the way a human would, which must still match the digits the gate
          // compares against — otherwise the entry silently never works.
          { phone: '+44 7700 900123', label: 'Bob', scopes: ['os:read'] },
          { phone: '447700900123', label: 'Duplicate', scopes: ['os:control'] },
          { phone: 'nonsense', label: 'Bad', scopes: ['os:read'] },
          { phone: '15550101234', label: 'No scopes', scopes: [] },
          { phone: '15550109999', label: 'Bad scope', scopes: ['../etc', 'os:read'] },
        ],
      },
    }),
  );
  store.__reloadCommandConfigForTests();

  assert.equal(store.areCommandsEnabled(), false, '"yes" is not true');
  const people = store.listCommandPeople();
  assert.deepEqual(
    people.map((p) => p.phone),
    ['447700900123', '15550109999'],
    'malformed, duplicate and scope-less entries are dropped',
  );
  assert.equal(people[0]!.phone, '447700900123', 're-canonicalised from the human spelling');
  assert.deepEqual(people[1]!.scopes, ['os:read'], 'the bogus scope is dropped, the good one kept');
});

test('scope keys are validated', () => {
  assert.equal(store.isScopeKey('os:read'), true);
  assert.equal(store.isScopeKey('os:control'), true);
  assert.equal(store.isScopeKey('notice-board'), true);
  assert.equal(store.isScopeKey('os:everything'), false);
  assert.equal(store.isScopeKey('../etc/passwd'), false);
  assert.equal(store.isScopeKey('Display'), false);
  assert.equal(store.isScopeKey(''), false);
  assert.equal(store.isScopeKey(42), false);
});

test('the people list is capped', () => {
  reset();
  for (let i = 0; i < 10; i++) store.addCommandPerson(`1555010${1000 + i}`, `P${i}`, [store.OS_READ]);
  assert.equal(store.listCommandPeople().length, 10);
  assert.throws(() => store.addCommandPerson('15550109999', 'One too many', [store.OS_READ]), /at most 10/);
});

test('the config file is written 0600', { skip: process.platform === 'win32' }, () => {
  reset();
  store.addCommandPerson(ALICE, 'Alice', [store.OS_READ]);
  const mode = fs.statSync(path.join(dataDir, 'config', 'commands.json')).mode & 0o777;
  assert.equal(mode, 0o600, 'a list of trustees and their phone numbers');
});
