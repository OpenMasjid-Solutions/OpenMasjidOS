// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Sign-in and account fixes, driven through the real auth router: a damaged admin
 * record says so at sign-in, and a WhatsApp number that is not a whole number is
 * refused instead of quietly clearing the one on file.
 *
 * Boots on a damaged auth.json, because the store reports damage only for a file it
 * could not read at start-up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-auth-fixes-'));
process.env.OPENMASJID_DATA_DIR = DATA;
const AUTH_JSON = path.join(DATA, 'config', 'auth.json');
fs.mkdirSync(path.dirname(AUTH_JSON), { recursive: true });
fs.writeFileSync(AUTH_JSON, '{"username": "admin", "passwordHa');

const req = createRequire(__filename);
const store = req('../src/auth/store') as typeof import('../src/auth/store');
const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
const pw = req('../src/auth/passwords') as typeof import('../src/auth/passwords');
const { writeJson } = req('../src/util/json-store') as typeof import('../src/util/json-store');
const { authRouter } = req('../src/trpc/routers/auth') as typeof import('../src/trpc/routers/auth');

const PASSWORD = 'a-long-enough-admin-password';

/** A caller on the masjid's network, signed in when given a session. */
function caller(session?: { token: string; csrf: string }) {
  return authRouter.createCaller({
    username: session ? sessions.getSessionUser(session.token) : null,
    sessionToken: session?.token ?? null,
    csrf: session?.csrf ?? null,
    isWebSocket: false,
    ip: '172.17.0.1',
    host: '192.168.1.50',
    viaTunnel: false,
    handedOver: false,
    remoteIp: null,
    setSessionCookie: () => {},
    clearSessionCookie: () => {},
  } as never);
}

test('A DAMAGED ADMIN RECORD SAYS SO AT SIGN-IN — not "incorrect" to someone typing the right password', async () => {
  assert.equal(store.isAuthStoreDamaged(), true, 'precondition: damaged at start-up');
  await assert.rejects(
    caller().login({ username: 'admin', password: PASSWORD }),
    (e: { code?: string; message?: string }) =>
      e.code === 'CONFLICT' && /can't be read/.test(e.message ?? '') && /password reset/.test(e.message ?? ''),
  );
});

test('once the reset tool has repaired the record, signing in works again', async () => {
  writeJson(AUTH_JSON, { username: 'admin', passwordHash: await pw.hashPassword(PASSWORD), email: 'admin@masjid.test', name: 'admin' });
  store.getPasswordHash({ fresh: true });
  assert.equal(store.isAuthStoreDamaged(), false);
  assert.equal((await caller().login({ username: 'admin', password: PASSWORD })).authenticated, true);
});

const NOT_A_NUMBER = (e: { code?: string; message?: string }) => e.code === 'BAD_REQUEST' && /country code/.test(e.message ?? '');

test('A WHATSAPP NUMBER THAT IS NOT A WHOLE NUMBER IS REFUSED — it used to clear the one on file', async () => {
  const me = caller(sessions.createSession('admin', sessions.currentCredential()));
  // The answer is what is now stored, so the screen can show it.
  assert.deepEqual(await me.updateProfile({ phone: '+1 555 010 1234' }), {
    name: 'admin',
    email: 'admin@masjid.test',
    phone: '15550101234',
  });
  for (const typed of ['+1 555 010', '1234567', '+1 555 010 1234 5678 9']) {
    await assert.rejects(me.updateProfile({ phone: typed }), NOT_A_NUMBER, typed);
    assert.equal(store.getAdminPhone(), '15550101234', `${typed} changed the number on file`);
  }
  // A field left out is left alone, and the answer says what is still stored.
  assert.equal((await me.updateProfile({ name: 'admin' })).email, 'admin@masjid.test');
});

test('an empty phone field, or one holding only its dial code, clears the number', async () => {
  const me = caller(sessions.createSession('admin', sessions.currentCredential()));
  for (const cleared of ['', '1', '+44', '971']) {
    await me.updateProfile({ phone: '+1 555 010 1234' });
    assert.equal((await me.updateProfile({ phone: cleared })).phone, '', JSON.stringify(cleared));
    assert.equal(store.getAdminPhone(), '', JSON.stringify(cleared));
  }
});
