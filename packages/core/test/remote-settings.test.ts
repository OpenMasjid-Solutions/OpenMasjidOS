// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Settings → Remote access, through the real router.
 *
 * Each of these was a way for ONE Save to shut the remote dashboard behind the admin
 * using it, after which only someone at the masjid could open it again:
 *  - a save that was refused had already written the apps' address — onto the
 *    dashboard's own, which switches remote administration off;
 *  - from outside, the dashboard's address could be moved or cleared, closing the door
 *    the request came through with nothing left to say where the dashboard went.
 * And a box managed from outside before addresses were separated loses remote
 * administration on updating; what "Recently turned away" says about it is the only
 * clue anyone at the masjid gets, so it must say what to fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-remote-settings-'));
process.env.OPENMASJID_DATA_DIR = DATA;

// A save that is ACCEPTED goes on to restart the tunnel. Docker here says yes to
// everything and runs nothing: these tests are about what is decided before that.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-fake-docker-'));
fs.writeFileSync(path.join(BIN, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
const POSIX = process.platform !== 'win32';

const req = createRequire(__filename);
const settings = req('../src/settings/store') as typeof import('../src/settings/store');
const store = req('../src/auth/store') as typeof import('../src/auth/store');
const tf = req('../src/auth/twofactor') as typeof import('../src/auth/twofactor');
const totpLib = req('../src/auth/totp') as typeof import('../src/auth/totp');
const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
const ra = req('../src/system/remote-admin') as typeof import('../src/system/remote-admin');
const cloudflared = req('../src/system/cloudflared') as typeof import('../src/system/cloudflared');
const { cloudflareRouter } = req('../src/trpc/routers/cloudflare') as typeof import('../src/trpc/routers/cloudflare');

const ADMIN = 'admin.example.org';
const APPS = 'omos.example.org';
const SETTINGS = path.join(DATA, 'config', 'settings.json');
const TOKEN_FILE = path.join(DATA, 'config', 'cloudflare', '.env');

store.setCredentials('admin', '$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb');
{
  const { secret } = tf.beginEnrolment('admin');
  tf.confirmEnrolment(totpLib.totp(secret, Date.now()));
}
cloudflared.setToken('TOKEN-NOW');

/** The box as it is when managed from outside. */
function managedFromOutside(): void {
  settings.updateCloudflare({ enabled: true, remoteAdmin: true, domain: APPS, adminHost: ADMIN });
  assert.equal(ra.remoteAdminEnabled(), true, 'precondition: the door is open');
}

/** A caller as the dashboard has one: at the masjid, or handed over from outside. */
function caller(where: 'masjid' | 'outside') {
  const outside = where === 'outside';
  const s = sessions.createSession(
    'admin',
    sessions.currentCredential(),
    outside ? { remote: true, tf: tf.secondFactorEpoch(), handedOver: true } : {},
  );
  return cloudflareRouter.createCaller({
    username: 'admin',
    sessionToken: s.token,
    csrf: s.csrf,
    isWebSocket: false,
    ip: '172.17.0.1',
    host: outside ? ADMIN : 'openmasjidos.local',
    viaTunnel: outside,
    handedOver: outside,
    remoteIp: outside ? '203.0.113.7' : null,
    setSessionCookie: () => {},
    clearSessionCookie: () => {},
  } as never);
}

const onDisk = () => fs.readFileSync(SETTINGS, 'utf8');
const code = (want: string) => (e: unknown) => (e as { code?: string }).code === want;

test('A REFUSED SAVE CHANGES NOTHING — not the addresses, not the token, not the door', async () => {
  for (const where of ['masjid', 'outside'] as const) {
    managedFromOutside();
    const before = onDisk();
    for (const input of [
      { domain: ADMIN, adminHost: ADMIN, token: 'TOKEN-PASTED' }, // both fields the same
      { domain: ADMIN }, // the apps' address alone, moved onto the dashboard's
      { domain: `https://${ADMIN.toUpperCase()}./` }, // in any spelling
      { domain: APPS, adminHost: APPS }, // the dashboard's address moved onto the apps'
    ]) {
      await assert.rejects(caller(where).save(input), code('BAD_REQUEST'), `${where}: ${JSON.stringify(input)}`);
      assert.equal(onDisk(), before, `${where}: a refused save still wrote settings.json (${JSON.stringify(input)})`);
      assert.equal(ra.remoteAdminEnabled(), true, `${where}: a refused save closed the door`);
      assert.match(fs.readFileSync(TOKEN_FILE, 'utf8'), /TOKEN-NOW/, `${where}: a refused save replaced the token`);
    }
  }
});

test('FROM OUTSIDE, THE DASHBOARD ADDRESS CANNOT BE MOVED OR CLEARED — it is the door the request came through', async () => {
  managedFromOutside();
  const before = onDisk();
  for (const adminHost of ['other.example.org', '', 'admn.example.org']) {
    await assert.rejects(caller('outside').save({ domain: APPS, adminHost }), code('FORBIDDEN'), JSON.stringify(adminHost));
    assert.equal(onDisk(), before, `moving it to ${JSON.stringify(adminHost)} was written anyway`);
    assert.equal(ra.adminHost(), ADMIN);
  }
});

test('…but sending it UNCHANGED from outside, or not at all, is not a move', { skip: !POSIX && 'needs a POSIX shell for the stand-in docker' }, async () => {
  managedFromOutside();
  await caller('outside').save({ domain: APPS, adminHost: ADMIN });
  await caller('outside').save({ domain: APPS });
  await caller('outside').save({ domain: APPS, adminHost: `${ADMIN.toUpperCase()}.` }); // the same host, spelt differently
  assert.equal(ra.adminHost(), ADMIN);
  assert.equal(ra.remoteAdminEnabled(), true);
});

test('AT THE MASJID it can be changed — and is stored as a bare hostname, whatever was typed', { skip: !POSIX && 'needs a POSIX shell for the stand-in docker' }, async () => {
  managedFromOutside();
  await caller('masjid').save({ adminHost: 'https://New-Admin.Example.org./settings' });
  assert.equal(settings.getSettings().cloudflare.adminHost, 'new-admin.example.org');
  await caller('masjid').save({ domain: 'HTTPS://Omos.Example.org/x' });
  assert.equal(settings.getSettings().cloudflare.domain, 'omos.example.org');
  // Moving BOTH at once is judged on where they end up, not field by field.
  await caller('masjid').save({ domain: 'apps.example.net', adminHost: 'omos.example.org' });
  assert.equal(settings.getSettings().cloudflare.domain, 'apps.example.net');
  assert.equal(settings.getSettings().cloudflare.adminHost, 'omos.example.org');
  assert.equal(ra.remoteAdminEnabled(), true);
  managedFromOutside();
});

// ── a box managed from outside before addresses were separated ──────────────

test('A BOX UPDATED FROM dev.13–15 SAYS WHAT TO FIX — not "Local network only"', () => {
  // Those builds served the dashboard on the apps' address and had no dashboard
  // address at all. Updating closes remote administration (correctly — an app page
  // must never share the dashboard's origin), and this is how it is reported.
  settings.updateCloudflare({ enabled: true, remoteAdmin: true, domain: APPS, adminHost: '' });
  assert.equal(ra.remoteAdminEnabled(), false);
  assert.equal(ra.remoteAdminBlockedReason(), 'no-admin-host');
  assert.equal(ra.doorClosedReason(), 'no-admin-host');
  const visit = { 'cf-ray': '7a1b-LHR', 'cf-visitor': '{"scheme":"https"}', host: APPS };
  for (const url of ['/', '/settings/remote', '/trpc/auth.me']) {
    assert.deepEqual(
      ra.frontDoorDecision(url, visit, {
        viaTunnel: true,
        remoteAdminEnabled: ra.remoteAdminEnabled(),
        adminHost: ra.adminHost(),
        closedReason: ra.doorClosedReason(),
      }),
      { kind: 'refuse', reason: 'no-admin-host' },
      url,
    );
  }
  // A door shut for any other reason is still "Local network only".
  settings.updateCloudflare({ remoteAdmin: false, adminHost: ADMIN });
  assert.equal(ra.doorClosedReason(), 'lan-only-route');
  settings.updateCloudflare({ remoteAdmin: true, enabled: false });
  assert.equal(ra.doorClosedReason(), 'lan-only-route', 'the tunnel being off is not a missing address');
  // And the front door asks it — not a copy of it.
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.match(index, /closedReason: doorClosedReason\(\)/);
  managedFromOutside();
});

test('the settings half of "is the door open" is ONE rule, for the live box and a restore alike', () => {
  const open = { enabled: true, remoteAdmin: true, domain: APPS, adminHost: ADMIN };
  assert.equal(ra.settingsOpenTheDoor(open), true);
  for (const [why, cf] of [
    ['tunnel off', { ...open, enabled: false }],
    ['switch off', { ...open, remoteAdmin: false }],
    ['no dashboard address', { ...open, adminHost: '' }],
    ['dashboard on the apps’ address', { ...open, adminHost: APPS }],
    ['…in another spelling', { ...open, domain: `https://${ADMIN.toUpperCase()}/` }],
    ['truthy is not true', { ...open, enabled: 'yes' }],
    ['…nor is 1', { ...open, remoteAdmin: 1 }],
  ] as const) {
    assert.equal(ra.settingsOpenTheDoor(cf), false, why);
  }
  // The restore reads it rather than keeping its own copy.
  const restore = fs.readFileSync(path.join(__dirname, '..', 'src', 'system', 'restore.ts'), 'utf8');
  assert.match(restore, /settingsOpenTheDoor\(cf\)/);
});

// ── the tunnel token ───────────────────────────────────────────────────────

/** A token shaped as Cloudflare issues one: base64 of {a: account, t: tunnel id, s: secret}. */
const tunnelToken = (secret: string) =>
  Buffer.from(JSON.stringify({ a: '0123456789abcdef0123456789abcdef', t: '4b0f2c1e-8d3a-4e6b-9c2d-1a2b3c4d5e6f', s: secret })).toString(
    'base64',
  );
const tokenOnDisk = () => fs.readFileSync(TOKEN_FILE, 'utf8');

test('normalizeTunnelToken: a whole token, or the token inside a pasted command — nothing else', () => {
  const good = tunnelToken('c2VjcmV0LW9uZQ==');
  for (const pasted of [
    good,
    `  ${good}\n`,
    `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${good}`,
    `cloudflared tunnel run --token=${good}`,
    `sudo cloudflared service install ${good}`,
  ]) {
    assert.equal(cloudflared.normalizeTunnelToken(pasted), good, JSON.stringify(pasted.slice(0, 40)));
  }
  const notJson = Buffer.from('not json at all, but long enough to pass the length test').toString('base64');
  const noUuid = Buffer.from(JSON.stringify({ a: 'acct', t: 'not-a-uuid', s: 'x' })).toString('base64');
  const noSecret = Buffer.from(JSON.stringify({ a: 'acct', t: '4b0f2c1e-8d3a-4e6b-9c2d-1a2b3c4d5e6f', s: '' })).toString('base64');
  for (const bad of [
    '',
    'eyJhIjoi', // half of one: the selection stopped short
    good.slice(0, Math.floor(good.length / 2)),
    good.slice(0, -6),
    `${good} and some words`,
    'docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token',
    notJson,
    noUuid,
    noSecret,
    `${good}\nCF_TUNNEL_TOKEN=evil`, // no line breaks reach the .env
  ]) {
    assert.throws(() => cloudflared.normalizeTunnelToken(bad), /whole tunnel token/, JSON.stringify(bad.slice(0, 40)));
  }
});

test('A TOKEN WHOSE "=" PADDING WAS LEFT BEHIND IS REPAIRED — cloudflared refuses it without', () => {
  // A double-click selects letters and digits only, so it takes all of a token but its "="
  // padding — and cloudflared reads tokens with Go's padded base64, which refuses that,
  // while Node's decoder does not care. Such a paste used to be saved as it was, the
  // tunnel restarted on it and never came back, and Settings said it was running.
  const padded = ['c2VjcmV0', 'c2VjcmV0LW9uZQ==', 'a-secret-of-another-length', 'x'.repeat(43), 'y'.repeat(44)]
    .map(tunnelToken)
    .filter((t) => t.endsWith('='));
  assert.ok(padded.some((t) => t.endsWith('==')) && padded.some((t) => !t.endsWith('==')), 'setup: one "=" and one "==" token');
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let twins = 0;
  for (const good of padded) {
    const bare = good.replace(/=+$/, '');
    assert.equal(cloudflared.normalizeTunnelToken(bare), good, `${good.slice(-6)}: the padding was not put back`);
    assert.equal(cloudflared.normalizeTunnelToken(`cloudflared tunnel run --token ${bare}`), good, 'inside a pasted command too');
    assert.equal(cloudflared.normalizeTunnelToken(`${good}=`), good, 'too much padding is the same token');
    // Only the canonical spelling gets through. The last character's lowest bit is
    // padding, which Node ignores; flipping it spells the same bytes in a form that is
    // not what Cloudflare issued.
    const twin = bare.slice(0, -1) + B64[B64.indexOf(bare.at(-1)!) ^ 1] + good.slice(bare.length);
    assert.ok(Buffer.from(twin, 'base64').equals(Buffer.from(good, 'base64')), 'setup: the same bytes');
    assert.throws(() => cloudflared.normalizeTunnelToken(twin), /whole tunnel token/, 'a non-canonical spelling was accepted');
    twins++;
  }
  assert.ok(twins >= 2);
  // One character into a block of four cannot be base64 at all.
  let short = tunnelToken('c2VjcmV0LW9uZQ==').replace(/=+$/, '');
  while (short.length % 4 !== 1) short = short.slice(0, -1);
  assert.throws(() => cloudflared.normalizeTunnelToken(short), /whole tunnel token/);
});

test('a tunnel stuck restarting on a refused token is not shown as running', () => {
  assert.equal(cloudflared.tunnelContainerUp({ Running: true, Restarting: false }), true);
  // How Docker reports a container in its restart loop: Running, AND Restarting.
  assert.equal(cloudflared.tunnelContainerUp({ Running: true, Restarting: true }), false);
  assert.equal(cloudflared.tunnelContainerUp({ Running: false }), false);
  assert.equal(cloudflared.tunnelContainerUp(undefined), false);
  // And Settings says so: a tunnel that is switched on and not up is not "turned off".
  const settingsUi = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'src', 'routes', 'Settings.tsx'), 'utf8');
  assert.match(settingsUi, /: cf\.enabled\s*\? t\('settings\.cfNotConnecting'\)\s*: t\('settings\.cfStopped'\)/);
});

test(
  'AT THE MASJID a paste that is not a whole token is refused before anything is written',
  { skip: !POSIX && 'needs a POSIX shell for the stand-in docker' },
  async () => {
    managedFromOutside();
    const before = tokenOnDisk();
    await assert.rejects(caller('masjid').save({ token: 'eyJhIjoi' }), code('BAD_REQUEST'));
    assert.equal(tokenOnDisk(), before, 'a refused token was written');
    // A pasted command is reduced to its token, which is what reaches cloudflared.
    const good = tunnelToken('c2VjcmV0LXR3bw==');
    await caller('masjid').save({ token: `sudo cloudflared service install ${good}` });
    assert.equal(tokenOnDisk(), `CF_TUNNEL_TOKEN=${good}\n`);
    cloudflared.setToken('TOKEN-NOW');
  },
);

test(
  'FROM OUTSIDE THE TUNNEL TOKEN CANNOT BE REPLACED — saving it recreates the connection the request came through',
  { skip: !POSIX && 'needs a POSIX shell for the stand-in docker' },
  async () => {
    managedFromOutside();
    const current = tunnelToken('Y3VycmVudA==');
    cloudflared.setToken(current);
    // Another tunnel's token, or a fresh one for this tunnel: refused, nothing written.
    for (const other of [tunnelToken('b3RoZXI='), tunnelToken('bmV3')]) {
      await assert.rejects(caller('outside').save({ domain: APPS, token: other }), code('FORBIDDEN'));
      assert.equal(tokenOnDisk(), `CF_TUNNEL_TOKEN=${current}\n`, 'a token was replaced from outside');
    }
    // Re-pasting the one in use — bare or inside the command — changes nothing and is fine.
    await caller('outside').save({ domain: APPS, token: current });
    await caller('outside').save({ domain: APPS, token: `cloudflared tunnel run --token ${current}` });
    assert.equal(tokenOnDisk(), `CF_TUNNEL_TOKEN=${current}\n`);
    assert.equal(ra.remoteAdminEnabled(), true);
    // At the masjid it can be replaced.
    const next = tunnelToken('bmV4dA==');
    await caller('masjid').save({ token: next });
    assert.equal(tokenOnDisk(), `CF_TUNNEL_TOKEN=${next}\n`);
    cloudflared.setToken('TOKEN-NOW');
  },
);

test('"from outside" means handed over by the front door — the routers ask the mark, not a header', () => {
  // A reverse proxy the masjid runs on its own network sends `X-Forwarded-Proto: https`
  // too, so `viaTunnel` is true behind it; its admin is at the masjid all the same.
  const save = fs.readFileSync(path.join(__dirname, '..', 'src', 'trpc', 'routers', 'cloudflare.ts'), 'utf8');
  assert.match(save, /if \(ctx\.handedOver && nextAdmin !== adminHost\(\)\)/);
  assert.match(save, /if \(ctx\.handedOver\) \{\s*throw new TRPCError\(\{\s*code: 'FORBIDDEN'/);
  assert.doesNotMatch(save, /ctx\.viaTunnel/, 'a Remote access decision keyed on the header again');
});

test('the panel sends an address only when it was edited, and keeps the masjid’s fields locked from outside', () => {
  // Sending what a field held since the page loaded put back an address another device
  // had changed. And from outside, the dashboard address and the tunnel token are the
  // masjid's to change: the server refuses, and the fields say so first.
  const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'src', 'routes', 'Settings.tsx'), 'utf8');
  const panel = ui.slice(ui.indexOf('function CloudflarePanel'), ui.indexOf('function StripeAccountForm'));
  assert.match(panel, /domain: domainEdited \? domain\.trim\(\) : undefined/);
  assert.match(panel, /adminHost: adminHostEdited \? adminHost\.trim\(\) : undefined/);
  assert.ok([...panel.matchAll(/disabled=\{remote\}/g)].length >= 2, 'the dashboard address and the token must both be locked from outside');
});
