// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * OS alert emails: what actually goes on the wire (notify/email.ts + alert-copy.ts).
 *
 * This path had NO tests, which is how it drifted into the two things a maintainer
 * reported from their inbox: the masjid logo arriving as a downloadable
 * `logo.png`, and the body reading badly. Both are now pinned here, because
 * neither can be checked by sending real mail in CI.
 *
 * The load-bearing assertion is the FIRST one: zero attachment parts. The MIME was
 * never malformed — nodemailer emits canonical multipart/related + inline, and
 * Resend's `content_id` is its only (documented) inline lever — but clients list
 * any part carrying a filename regardless, so the only provider-independent fix is
 * to send no part at all.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import nodemailer from 'nodemailer';

const req = createRequire(__filename);

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-mail-'));
process.env.OPENMASJID_PORT = '80';
process.env.OPENMASJID_HOST_IP = '192.168.1.24';
delete process.env.OPENMASJID_BASE_URL;

type EmailModule = typeof import('../src/notify/email');
type CopyModule = typeof import('../src/notify/alert-copy');

let email: EmailModule;
let copy: CopyModule;

before(() => {
  email = req('../src/notify/email') as EmailModule;
  copy = req('../src/notify/alert-copy') as CopyModule;
});

/** Render through nodemailer so we assert the real MIME, not our own string. */
async function toMime(subject: string, text: string, html: string): Promise<string> {
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await t.sendMail({ from: 'Masjid <a@b.c>', to: 'd@e.f', subject, text, html });
  return (info.message as Buffer).toString('utf8');
}

test('an OS email carries ZERO attachment parts — the reported bug', async () => {
  const { html, text } = email.brandedEmail(copy.appUpdate('OpenMasjid Students', '0.43.0', '0.43.1'));
  const raw = await toMime('OpenMasjid Students can be updated', text, html);
  assert.equal((raw.match(/Content-Disposition:/gi) ?? []).length, 0, 'no part may have a disposition');
  assert.equal((raw.match(/Content-ID:/gi) ?? []).length, 0, 'no CID part');
  assert.equal(/multipart\/related/i.test(raw), false, 'related implies an embedded part');
  assert.equal(/filename=/i.test(raw), false, 'a filename is what clients draw a paperclip for');
  // The shape we DO want: text + html alternatives, nothing else.
  assert.ok(/multipart\/alternative/i.test(raw));
  assert.ok(/Content-Type: text\/plain/i.test(raw));
  assert.ok(/Content-Type: text\/html/i.test(raw));
});

test('the HTML never references a cid: image', () => {
  for (const c of [
    copy.appUpdate('Students', '1.0.0', '1.1.0'),
    copy.coreUpdate('0.46.0', '0.47.0'),
    copy.appOffline('Parking Attendant', 'parking-attendant'),
  ]) {
    const { html } = email.brandedEmail(c);
    assert.equal(/cid:/i.test(html), false, c.alertId);
  }
});

test('the wordmark always renders, so a blocked remote image is not a blank header', () => {
  // No logo + no tunnel here, so there is no <img> at all — the masjid's name has
  // to carry the branding on its own.
  const { html } = email.brandedEmail(copy.coreUpdate('0.46.0', '0.47.0'));
  assert.equal(/<img/i.test(html), false, 'no logo configured → no remote image');
  assert.match(html, /OpenMasjidOS<\/div>/, 'wordmark present');
});

test('the plain-text body leads with the summary — it IS the inbox snippet', () => {
  for (const c of [
    copy.appUpdate('OpenMasjid Students', '0.43.0', '0.43.1'),
    copy.coreUpdate('0.46.0', '0.47.0'),
    copy.appOffline('Parking Attendant', 'parking-attendant'),
  ]) {
    const { text } = email.brandedEmail(c);
    assert.ok(text.startsWith(c.summary), `${c.alertId} must open with its summary`);
    // The whole summary has to survive a ~90-char snippet window unclipped.
    assert.ok(c.summary.length <= 90, `${c.alertId} summary is ${c.summary.length} chars`);
    // The footer must sit below a `--` so it can never bleed into the snippet.
    const sep = text.indexOf('\n--\n');
    assert.ok(sep > 90, `${c.alertId}: footer separator at ${sep}, inside the snippet window`);
  }
});

test('no alert text contains UI-chrome glyphs that render as tofu', () => {
  // U+22EF (⋯) was in the old app-update copy and arrived as a box: most email
  // font stacks do not carry it. Arrows and menu paths are out for the same reason.
  for (const c of [
    copy.appUpdate('Students', '1.0.0', '1.1.0'),
    copy.coreUpdate('0.46.0', '0.47.0'),
    copy.appOffline('Kiosk', 'kiosk'),
  ]) {
    const all = [c.title, c.summary, c.detail ?? '', c.action?.note ?? ''].join(' ');
    assert.equal(/[⋯…→⇒]/.test(all), false, `${c.alertId}: ${all}`);
  }
});

test('attribution appears exactly once, not three times', () => {
  const { html, text } = email.brandedEmail(copy.appUpdate('Students', '1.0.0', '1.1.0'));
  // The old body carried "— OpenMasjidOS · OpenMasjidOS alert" ABOVE a "Sent by
  // OpenMasjidOS" footer, under a "[OpenMasjidOS]" subject.
  assert.equal(/·\s*OpenMasjidOS alert/.test(text), false);
  assert.equal((text.match(/Sent by OpenMasjidOS/g) ?? []).length, 1);
  assert.equal((html.match(/Sent by OpenMasjidOS/g) ?? []).length, 1);
});

test('the title is short enough to survive a subject line, and repeats nothing', () => {
  for (const c of [
    copy.appUpdate('OpenMasjid Students', '0.43.0', '0.43.1'),
    copy.coreUpdate('0.46.0', '0.47.0'),
    copy.appOffline('Parking Attendant', 'parking-attendant'),
  ]) {
    assert.ok(c.title.length <= 78, `${c.alertId} title is ${c.title.length} chars`);
    assert.equal(c.title.startsWith('['), false, 'no bracket prefix');
    // The summary must not be a verbatim copy of the title — that wastes the snippet.
    assert.notEqual(c.summary, c.title);
  }
});

test('the action button points at the dashboard, and warns when that is LAN-only', () => {
  const { html, text } = email.brandedEmail(copy.appOffline('Parking Attendant', 'parking-attendant'));
  assert.match(html, /href="http:\/\/192\.168\.1\.24\/apps\/parking-attendant"/);
  assert.match(text, /http:\/\/192\.168\.1\.24\/apps\/parking-attendant/);
  // A bare LAN IP is useless on mobile data — say so rather than look broken.
  assert.match(text, /only works on the masjid's own network/);
});

test('the core-update button goes to Settings, where the update control lives', () => {
  const { html } = email.brandedEmail(copy.coreUpdate('0.46.0', '0.47.0'));
  assert.match(html, /href="http:\/\/192\.168\.1\.24\/settings"/);
});

test('HTML is escaped, so a masjid or app name cannot inject markup', () => {
  const { html } = email.brandedEmail(copy.appOffline('<script>alert(1)</script>', 'x'));
  assert.equal(/<script>/.test(html), false);
  assert.match(html, /&lt;script&gt;/);
});

test('the layout uses table markup, not flex/grid (Outlook renders with Word)', () => {
  const { html } = email.brandedEmail(copy.coreUpdate('0.46.0', '0.47.0'));
  assert.match(html, /role="presentation"/);
  assert.equal(/display:\s*(flex|grid)/i.test(html), false);
  assert.match(html, /<!doctype html>/i);
});

test('the logo becomes a REMOTE image once remote access is configured', () => {
  // The one case where a logo can appear in mail: the recipient's mail provider
  // fetches images from its own network, so only a public tunnel URL resolves.
  // Same predicate the webhook avatar already uses.
  const branding = req('../src/store/branding') as typeof import('../src/store/branding');
  const settings = req('../src/settings/store') as typeof import('../src/settings/store');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  branding.saveLogo(png, 'image/png');

  // A logo alone is NOT enough — without a tunnel there is no reachable URL.
  settings.updateCloudflare({ enabled: false, domain: '' });
  assert.equal(/<img/i.test(email.brandedEmail(copy.coreUpdate('1', '2')).html), false);

  settings.updateCloudflare({ enabled: true, domain: 'masjid.example.org' });
  const { html } = email.brandedEmail(copy.coreUpdate('1', '2'));
  assert.match(html, /<img src="https:\/\/masjid\.example\.org\/api\/public\/logo"/);
  // Non-empty alt, so a client that blocks images still shows the masjid's name.
  assert.match(html, /alt="OpenMasjidOS"/);
  // Still not an attachment.
  assert.equal(/cid:/i.test(html), false);

  branding.removeLogo();
  settings.updateCloudflare({ enabled: false, domain: '' });
});

test("app mail never goes through the platform's branded template", () => {
  // §3: apps stay at arm's length — the platform must not rewrite an app's HTML,
  // and app mail must not pick up the masjid wordmark or logo. Asserted
  // structurally because the alternative (booting the Fabric route) passes
  // vacuously if the app index is not primed.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'fabric.ts'), 'utf8');
  assert.equal(/sendBrandedEmail/.test(src), false, 'app mail must call sendEmail, not the branded path');
  assert.equal(/brandedEmail/.test(src), false);
  assert.match(src, /sendEmail\(\{ to, subject, text, html \}, app\.id\)/, "the app's own html is passed through");
});

test('the logo is never distorted, whatever shape it is', () => {
  // THE REPORTED BUG: the old markup set width="140" AND max-height:52px with no
  // height:auto, constraining both axes independently. A 512x512 logo came out
  // 140x52 — ratio 2.69 against a source ratio of 1.0, i.e. stretched sideways.
  const branding = req('../src/store/branding') as typeof import('../src/store/branding');
  const settings = req('../src/settings/store') as typeof import('../src/settings/store');
  settings.updateCloudflare({ enabled: true, domain: 'masjid.example.org' });

  const png = (w: number, h: number): Buffer => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4, 'latin1');
    ihdr.writeUInt32BE(w, 8);
    ihdr.writeUInt32BE(h, 12);
    return Buffer.concat([sig, ihdr]);
  };

  for (const [w, h] of [
    [512, 512], // square — the real dashboard mark, and the reported case
    [400, 100], // wide
    [1200, 150], // banner
    [150, 1200], // tall
    [60, 60], // small: must NOT be upscaled
  ] as [number, number][]) {
    branding.saveLogo(png(w, h), 'image/png');
    const { html } = email.brandedEmail(copy.coreUpdate('1', '2'));
    const tag = html.match(/<img[^>]+>/)?.[0] ?? '';
    const rw = Number(tag.match(/width="(\d+)"/)?.[1]);
    const rh = Number(tag.match(/height="(\d+)"/)?.[1]);
    assert.ok(rw > 0 && rh > 0, `${w}x${h}: no dimensions emitted`);
    // Aspect ratio preserved (allowing a pixel of rounding).
    const drift = Math.abs(rw / rh - w / h) / (w / h);
    assert.ok(drift < 0.02, `${w}x${h} rendered ${rw}x${rh} — ratio drifted ${(drift * 100).toFixed(1)}%`);
    // Fits the box, and never upscaled beyond its natural size.
    assert.ok(rw <= 200 && rh <= 48, `${w}x${h} rendered ${rw}x${rh}, outside the box`);
    assert.ok(rw <= w && rh <= h, `${w}x${h} was upscaled to ${rw}x${rh}`);
    // Both attributes AND matching inline styles, because Outlook ignores max-*.
    assert.match(tag, new RegExp(`width:${rw}px`), `${w}x${h}: style width missing`);
    assert.match(tag, new RegExp(`height:${rh}px`), `${w}x${h}: style height missing`);
  }
  branding.removeLogo();
  settings.updateCloudflare({ enabled: false, domain: '' });
});

test('an unreadable logo header still cannot produce a stretched image', () => {
  // Fallback path: dimensions unknown, so constrain ONE axis and let the other
  // follow. Constraining both is what caused the bug.
  const branding = req('../src/store/branding') as typeof import('../src/store/branding');
  const settings = req('../src/settings/store') as typeof import('../src/settings/store');
  settings.updateCloudflare({ enabled: true, domain: 'masjid.example.org' });
  // Valid MIME so it is stored, but a body whose header cannot be parsed.
  branding.saveLogo(Buffer.from('not really a png at all'), 'image/png');
  assert.equal(branding.getLogoSize(), null, 'precondition: size must be unreadable');

  const tag = email.brandedEmail(copy.coreUpdate('1', '2')).html.match(/<img[^>]+>/)?.[0] ?? '';
  assert.match(tag, /height="48"/);
  assert.match(tag, /width:auto/, 'width must be free to follow the height');
  assert.equal(/width="\d+"/.test(tag), false, 'must not pin a width it cannot know');
  branding.removeLogo();
  settings.updateCloudflare({ enabled: false, domain: '' });
});
