// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Sending an image over the Fabric WhatsApp API.
 *
 * The feature is one optional field, but the things that must not break are the ones the
 * whole WhatsApp design rests on: an image goes through the SAME paced queue as everything
 * else (an image is a more conspicuous event than a sentence, not less), and a failed
 * image is NEVER quietly downgraded to its caption — an app would report that a poster
 * went out when only a sentence did, and a masjid would believe the timetable had been
 * published.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-wa-media-'));

const req = createRequire(__filename);
const wa = req('../src/notify/whatsapp') as typeof import('../src/notify/whatsapp');
const store = req('../src/store/whatsapp') as typeof import('../src/store/whatsapp');

const GROUP = '120363012345678901@g.us';
/** A tiny but genuinely valid base64 payload. */
const PNG = Buffer.from('not a real png, but real bytes').toString('base64');
const img = (over: Partial<import('../src/notify/whatsapp').OutgoingMedia> = {}) => ({
  data: PNG,
  mimeType: 'image/png',
  ...over,
});

const codeOf = (rel: string) =>
  fs
    .readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

function configure(): void {
  store.saveWhatsAppConfig({ provider: 'openwa', apiKey: 'k', baseUrl: 'http://127.0.0.1:1' });
  store.approveGroup(GROUP, 'Parents');
}

// ── what may be sent ─────────────────────────────────────────────────────────────

test('only real images are accepted', () => {
  assert.equal(wa.mediaProblem(img()), null);
  assert.equal(wa.mediaProblem(img({ mimeType: 'image/jpeg' })), null);
  assert.equal(wa.mediaProblem(img({ mimeType: 'IMAGE/PNG' })), null, 'case must not matter');

  // A document or video is a different gateway route with different rules — it would fail
  // AT the gateway, after the app was told 202.
  assert.match(String(wa.mediaProblem(img({ mimeType: 'application/pdf' }))), /Only images/);
  assert.match(String(wa.mediaProblem(img({ mimeType: 'video/mp4' }))), /Only images/);
  assert.match(String(wa.mediaProblem(img({ mimeType: '' }))), /Only images/);
});

test('bad base64 is caught here, not by the gateway', () => {
  // The caller is still listening now; after 202 it is not.
  for (const bad of ['', 'not base64!!', 'abc', 'a'.repeat(5)]) {
    assert.ok(wa.mediaProblem(img({ data: bad })), `must reject ${JSON.stringify(bad)}`);
  }
  assert.equal(wa.base64Bytes('AAAA'), 3);
  assert.equal(wa.base64Bytes('AAA='), 2);
  assert.equal(wa.base64Bytes('AA=='), 1);
  assert.equal(wa.base64Bytes('bad!'), null);
});

test('an oversize image is refused, and the message says by how much', () => {
  // 4/3 of the cap, so it decodes to just over the limit.
  const tooBig = 'A'.repeat(Math.ceil(((wa.MAX_MEDIA_BYTES + 1024) * 4) / 3 / 4) * 4);
  const problem = wa.mediaProblem(img({ data: tooBig }));
  assert.match(String(problem), /the limit is 2 MB/, `unhelpful: ${problem}`);
  assert.match(String(problem), /KB/, 'and it should say how big the image actually was');
});

// ── enqueueing ───────────────────────────────────────────────────────────────────

test('an image goes through the same queue, and text-only is untouched', () => {
  configure();
  wa.__resetPacingForTests();

  // Text-only: byte-for-byte the shape shipped apps already use.
  assert.equal(wa.enqueue({ to: '+15550101234', text: 'hello', source: 'display' }).queued, true);
  // With an image.
  assert.equal(wa.enqueue({ groupId: GROUP, text: 'Iqāmah times change Monday.', media: img(), source: 'display' }).queued, true);
  // And an image with NO caption — a poster can speak for itself.
  assert.equal(wa.enqueue({ groupId: GROUP, media: img(), source: 'display' }).queued, true);

  wa.__resetPacingForTests();
});

test('a caption longer than the gateway allows fails at the door', () => {
  configure();
  wa.__resetPacingForTests();
  const r = wa.enqueue({ groupId: GROUP, text: 'x'.repeat(wa.MAX_CAPTION + 1), media: img(), source: 'display' });
  assert.equal(r.queued, false);
  assert.match(String(r.error), /caption is too long/i);
  // The plain-text limit is four times larger, and must not have changed.
  assert.equal(wa.enqueue({ to: '+15550101234', text: 'x'.repeat(wa.MAX_CAPTION + 1), source: 'display' }).queued, true);
  wa.__resetPacingForTests();
});

test('an empty message is still refused, but an image alone is not', () => {
  configure();
  wa.__resetPacingForTests();
  assert.equal(wa.enqueue({ to: '+15550101234', text: '   ', source: 'display' }).queued, false);
  assert.equal(wa.enqueue({ to: '+15550101234', media: img(), source: 'display' }).queued, true);
  wa.__resetPacingForTests();
});

test('queued images are capped, and the refusal says why', () => {
  // Queued bytes live in memory and quiet hours can hold them for hours. On a Pi, an
  // unbounded queue of posters is an out-of-memory kill that takes the dashboard with it.
  configure();
  wa.__resetPacingForTests();
  for (let i = 0; i < wa.MAX_QUEUED_MEDIA; i++) {
    assert.equal(wa.enqueue({ groupId: GROUP, media: img(), source: 'display' }).queued, true, `image ${i + 1}`);
  }
  const over = wa.enqueue({ groupId: GROUP, media: img(), source: 'display' });
  assert.equal(over.queued, false, 'the cap must hold');
  assert.match(String(over.error), /already waiting/i);
  // A TEXT message is still accepted — the cap is on images, not on messages.
  assert.equal(wa.enqueue({ groupId: GROUP, text: 'still fine', source: 'display' }).queued, true);
  wa.__resetPacingForTests();
});

test('an unapproved group is refused whether or not there is an image', () => {
  configure();
  wa.__resetPacingForTests();
  const other = '120363099999999999@g.us';
  assert.equal(wa.enqueue({ groupId: other, text: 'hi', source: 'display' }).queued, false);
  assert.equal(wa.enqueue({ groupId: other, media: img(), source: 'display' }).queued, false);
  wa.__resetPacingForTests();
});

// ── behaviour ────────────────────────────────────────────────────────────────────

test('an image is composed for longer than its caption would suggest', () => {
  // A half-megabyte upload appearing after a 2-second flicker reads as automated. Someone
  // sending a picture spends time picking and attaching it.
  const shortCaption = { text: 'Times change.', media: img() };
  assert.ok(
    wa.composingMs(shortCaption) > wa.typingMs(shortCaption.text),
    'an image needs a floor above the text-derived time',
  );
  assert.ok(wa.composingMs(shortCaption) >= 5000);
  // Text-only is unchanged.
  assert.equal(wa.composingMs({ text: 'hello' }), wa.typingMs('hello'));
});

test('a failed image is NEVER downgraded to its caption', () => {
  // The whole point. Delivering the caption alone lets an app report a poster went out
  // when only a sentence did.
  const code = codeOf('core/src/notify/whatsapp.ts');
  const fn = code.slice(code.indexOf('async function sendOne'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // Exactly one send is chosen — a ternary, not a fallback chain.
  assert.match(body, /item\.media\s*\?[\s\S]*send-image[\s\S]*:[\s\S]*send-text/, 'one branch or the other');
  // And no send-text call may appear AFTER a media failure is detected.
  const failAt = body.indexOf('if (!r.ok)');
  assert.ok(failAt > 0);
  assert.doesNotMatch(body.slice(failAt), /send-text/, 'no retry as text after an image fails');
});

test('the image goes to send-image with the field names the gateway uses', () => {
  // OpenWA spells it `mimetype`; our own API uses `mimeType`. Verified against its SDK
  // (SendMediaRequest). Getting this wrong fails only at runtime, on a real send.
  const code = codeOf('core/src/notify/whatsapp.ts');
  const at = code.indexOf('send-image');
  assert.ok(at > 0, 'the image route must be used');
  const call = code.slice(at, at + 400);
  assert.match(call, /base64: item\.media\.data/, 'base64 is what OpenWA accepts');
  assert.match(call, /mimetype: item\.media\.mimeType/, 'lowercase on the wire');
  assert.match(call, /caption: item\.text/, 'the text becomes the caption');
});

test('neither the caption nor the bytes are ever logged', () => {
  // A caption carries the masjid's words and the bytes are half a megabyte of poster.
  const code = codeOf('core/src/notify/whatsapp.ts');
  for (const line of code.split('\n')) {
    if (!/log\.(info|warn|error)/.test(line)) continue;
    assert.doesNotMatch(line, /item\.text|\.media\.data|item\.media\b(?!\s*\?)/, `logs content: ${line.trim()}`);
  }
});

// ── the route ────────────────────────────────────────────────────────────────────

test('the send route raises its own body limit, because the two servers disagree', () => {
  // registerFabric runs on BOTH the dashboard (25 MB) and the HTTP front door, which was
  // left on Fastify's 1 MB default — and the front door is exactly what an app reaches
  // over OPENMASJID_BASE_URL. Per route, so both are right without raising the ceiling
  // for every other front-door route.
  const code = codeOf('core/src/api/fabric.ts');
  const at = code.search(/server\.post\(\s*'\/api\/fabric\/whatsapp'/);
  assert.ok(at > 0, 'the route must take an options object');
  const opts = code.slice(at, at + 1500);
  assert.match(opts, /bodyLimit: FABRIC_WHATSAPP_BODY_LIMIT/);
  // And the oversize answer must name the limit rather than Fastify's bare message.
  assert.match(opts, /FST_ERR_CTP_BODY_TOO_LARGE/, 'the too-large case is handled explicitly');
  assert.match(opts, /code\(413\)/);
});

test('the capability read advertises media, and an old platform reads as false', () => {
  const code = codeOf('core/src/api/fabric.ts');
  const at = code.indexOf("server.get('/api/fabric/whatsapp'");
  const body = code.slice(at, code.indexOf('server.post(', at));
  assert.match(body, /media: reason === 'ready'/, 'media follows gateway readiness');
  assert.match(body, /maxMediaBytes: MAX_MEDIA_BYTES/, 'and the cap is discoverable');
  // Nothing about the gateway itself may cross this boundary (unchanged rule).
  for (const leak of ['apiKey', 'baseUrl', 'sessionId', 'phone']) {
    assert.doesNotMatch(body, new RegExp(`\\b${leak}\\b`), `${leak} must not be returned`);
  }
});
