// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Platform fixes whose modules had no test file of their own: a setting the disk
 * refused, and what the logo upload tells the admin when it cannot take an image.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';

const req = createRequire(__filename);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-fixes-'));
process.env.OPENMASJID_DATA_DIR = DATA_DIR;
const CONFIG_DIR = path.join(DATA_DIR, 'config');

// Loaded after DATA_DIR is set (config.ts reads it at import time).
const settings = req('../src/settings/store') as typeof import('../src/settings/store');
const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
const branding = req('../src/store/branding') as typeof import('../src/store/branding');
const { registerBranding } = req('../src/api/branding') as typeof import('../src/api/branding');

test('a setting the disk refused is not in effect, not even until the next restart', () => {
  // updateSettings changed its in-memory copy and THEN wrote. On a full disk the save
  // reported an error, yet the change was live: managing from outside, switched off,
  // read as closed — and quietly reopened at the next boot, when the file was read again.
  settings.updateCloudflare({ remoteAdmin: true });
  const tmp = path.join(CONFIG_DIR, 'settings.json.tmp');
  fs.mkdirSync(tmp); // writeJson cannot create its temp file, so every write fails
  try {
    assert.throws(() => settings.updateCloudflare({ remoteAdmin: false }));
    assert.equal(settings.getSettings().cloudflare.remoteAdmin, true, 'the refused change was believed');
    assert.throws(() => settings.updateSettings({ rootTerminal: true }));
    assert.equal(settings.getSettings().rootTerminal, false, 'the refused change was believed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  settings.reloadSettings();
  assert.equal(settings.getSettings().cloudflare.remoteAdmin, true, 'memory and disk agree');
});

let app: FastifyInstance;
let cookie = '';
let csrf = '';

before(async () => {
  app = Fastify();
  await app.register(fastifyMultipart);
  registerBranding(app);
  await app.ready();
  const s = sessions.createSession('admin', sessions.currentCredential());
  cookie = `${sessions.COOKIE_NAME}=${s.token}`;
  csrf = s.csrf;
});

after(() => app.close());

/** POST one image to the logo upload, signed in, as the Settings page does. */
function uploadLogo(bytes: Buffer) {
  const boundary = 'omos-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\n` +
        'Content-Type: image/png\r\n\r\n',
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: '/api/branding/logo',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie, [sessions.CSRF_HEADER]: csrf },
    payload,
  });
}

test('a logo over 1 MB is answered with the friendly "too large"', async () => {
  // @fastify/multipart throws once a file passes its limit, so the 413 below it never
  // ran: the admin was shown the library's "request file too large", as a 400.
  const res = await uploadLogo(Buffer.alloc(branding.MAX_LOGO_BYTES + 1024, 1));
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.json(), { error: 'That image is too large (max 1 MB).' });
});

test('a logo the disk refuses is reported plainly, without the data path', async () => {
  // The raw fs error — the data path in it — went straight to the toast.
  const blocker = path.join(CONFIG_DIR, 'branding', 'logo.png');
  fs.mkdirSync(blocker, { recursive: true }); // nothing can be written in its place
  try {
    const res = await uploadLogo(Buffer.from('a small image'));
    assert.equal(res.statusCode, 500);
    const { error } = res.json() as { error: string };
    assert.match(error, /couldn't be saved/);
    assert.ok(!error.includes(DATA_DIR), `the data path reached the screen: ${error}`);
  } finally {
    fs.rmSync(blocker, { recursive: true, force: true });
  }
  assert.equal((await uploadLogo(Buffer.from('a small image'))).statusCode, 200, 'and a later try works');
});
