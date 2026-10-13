// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Nothing done FROM OUTSIDE may move the box to a version that cannot be managed from
 * outside.
 *
 * Going back to Stable while Stable has no remote dashboard — or updating to anything
 * older than the first build that serves one — brought the core back without it, and
 * every window from outside was cut off until someone at the masjid moved the box on
 * again (system/remote-admin.ts `managesFromOutside`). From outside the update and the
 * channel switch now refuse; at the masjid both go ahead as before. And the update's
 * window is told whether anything changed, instead of waiting minutes for a restart
 * that is not coming.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-remote-update-'));
process.env.OPENMASJID_DATA_DIR = DATA;
// No Docker Engine API, whatever the machine running this has: nothing here may reach a
// real daemon. The CLI is a stand-in below.
process.env.DOCKER_SOCKET = path.join(DATA, 'no-docker.sock');

const req = createRequire(__filename);
const settings = req('../src/settings/store') as typeof import('../src/settings/store');
const store = req('../src/auth/store') as typeof import('../src/auth/store');
const tf = req('../src/auth/twofactor') as typeof import('../src/auth/twofactor');
const totpLib = req('../src/auth/totp') as typeof import('../src/auth/totp');
const sessions = req('../src/auth/sessions') as typeof import('../src/auth/sessions');
const ra = req('../src/system/remote-admin') as typeof import('../src/system/remote-admin');
const { runUpdate, recreateCore } = req('../src/docker/update') as typeof import('../src/docker/update');
const { UPDATE_CLOSE } = req('../src/api/update') as typeof import('../src/api/update');
const { systemRouter } = req('../src/trpc/routers/system') as typeof import('../src/trpc/routers/system');
const { VERSION } = req('../src/version') as typeof import('../src/version');

// The box: managed from outside, at omos.example.org, with two-step sign-in set up.
store.setCredentials('admin', '$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb');
settings.updateCloudflare({ enabled: true, remoteAdmin: true, domain: 'omos.example.org' });
{
  const { secret } = tf.beginEnrolment('admin');
  tf.confirmEnrolment(totpLib.totp(secret, Date.now()));
}
assert.equal(ra.remoteAdminEnabled(), true, 'setup: the door is open');

/**
 * What GitHub answers: each OpenMasjidOS branch's VERSION file (null: unreachable), and
 * a one-app catalogue for either channel.
 */
function publishes(versions: { master?: string | null; dev?: string | null }): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes('OpenMasjidAPPS')) {
      return new Response(JSON.stringify({ apps: [{ id: 'hello', name: 'Hello', version: '1.0.0', compose: 'services: {}' }] }));
    }
    const v = url.includes('/master/') ? versions.master : url.includes('/dev/') ? versions.dev : null;
    if (v == null) throw new TypeError('fetch failed');
    return new Response(`${v}\n`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/**
 * A stand-in `docker` that records every call and fails the ones matching `fail` (a shell
 * `case` pattern over its arguments) — by default every download.
 */
function fakeDocker(fail = 'pull*'): { log: () => string; restore: () => void } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-fake-docker-'));
  const logFile = path.join(bin, 'calls.log');
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/sh\necho "$*" >> "$FAKE_DOCKER_LOG"\ncase "$*" in ${fail}) exit 1 ;; esac\nexit 0\n`,
    { mode: 0o755 },
  );
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  process.env.FAKE_DOCKER_LOG = logFile;
  return {
    log: () => fs.readFileSync(logFile, 'utf8'),
    restore: () => {
      process.env.PATH = PATH;
      delete process.env.FAKE_DOCKER_LOG;
    },
  };
}

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'needs a POSIX shell for the stand-in docker — run the suite in WSL' : false } as const;

test('managesFromOutside: the first build that can be managed from outside, and everything after it', () => {
  for (const v of ['0.51.1', '0.50.9', '0.51.2-dev.13', '0.51.2-dev.15']) {
    assert.equal(ra.managesFromOutside(v), false, v);
  }
  for (const v of ['0.51.2-dev.16', '0.51.2-dev.17', '0.51.2', '0.52.0-dev.1', '1.0.0']) {
    assert.equal(ra.managesFromOutside(v), true, v);
  }
  // And this build is one, or every update from outside would be refused.
  assert.equal(ra.managesFromOutside(VERSION), true, VERSION);
});

test('FROM OUTSIDE, AN UPDATE TO A VERSION THAT CANNOT BE MANAGED FROM OUTSIDE IS REFUSED — before anything is downloaded', POSIX_ONLY, async () => {
  const docker = fakeDocker();
  const unpublish = publishes({ master: '0.51.1', dev: '0.51.2-dev.99' });
  try {
    // Just switched back to Stable, whose newest build has no remote dashboard.
    settings.updateSettings({ updateChannel: 'main' });
    const lines: string[] = [];
    assert.equal(await runUpdate((l) => lines.push(l), { remote: true }), 'unchanged');
    assert.ok(lines.some((l) => /0\.51\.1 can't be managed from outside the masjid/.test(l)), lines.join(' | '));
    assert.ok(lines.some((l) => /Nothing was changed/.test(l)));
    assert.equal(docker.log(), '', 'docker was asked to do something for a refused update');

    // A version that could not be read is refused from outside as well.
    unpublish();
    const unread = publishes({});
    const more: string[] = [];
    assert.equal(await runUpdate((l) => more.push(l), { remote: true }), 'unchanged');
    assert.ok(more.some((l) => /Couldn't check which version/.test(l)), more.join(' | '));
    assert.equal(docker.log(), '');
    unread();

    // At the masjid the same update goes ahead (and fails here only because the
    // stand-in refuses every download).
    const again = publishes({ master: '0.51.1' });
    const lan: string[] = [];
    assert.equal(await runUpdate((l) => lan.push(l), {}), 'unchanged');
    assert.match(docker.log(), /^pull .*:0\.51\.1$/m, 'at the masjid the update was not attempted');
    assert.ok(!lan.some((l) => /from outside/.test(l)), lan.join(' | '));
    again();

    // And from outside, to a version that has it, the guard stands aside.
    settings.updateSettings({ updateChannel: 'dev' });
    const forward = publishes({ dev: '0.51.2-dev.99' });
    const fwd: string[] = [];
    await runUpdate((l) => fwd.push(l), { remote: true });
    assert.match(docker.log(), /^pull .*:0\.51\.2-dev\.99$/m, 'a newer Development build was refused from outside');
    forward();
  } finally {
    unpublish();
    docker.restore();
    settings.updateSettings({ updateChannel: 'dev' });
  }
});

test('the update window is told whether anything changed — and waits only for a restart', () => {
  assert.deepEqual(UPDATE_CLOSE.restarting[0], 1000);
  assert.deepEqual(UPDATE_CLOSE.unchanged[0], 4001);
  // The dialog reads the code the same way (it cannot import from the core).
  const modal = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'src', 'components', 'UpdateModal.tsx'), 'utf8');
  assert.match(modal, /nothingChanged = \(code: number\) => code >= 4000 && code <= 4999/);
  assert.match(modal, /if \(nothingChanged\(code\)\) return setPhase\('unchanged'\)/);
  // A stream that never connected began nothing — it is not "dropped while restarting".
  assert.match(modal, /if \(!opened\) return setPhase\('unreachable'\)/);
  // "Updated" only on evidence: the wait that saw no restart ends unsure, never done.
  assert.match(modal, /set\(cameBackSame \? 'same' : 'unsure'\);\s*\}/);
  assert.doesNotMatch(modal, /\n {4}setPhase\('done'\);\n {2}\}/, 'the old fall-through to "Update applied."');
  const restoreModal = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'src', 'components', 'RestoreModal.tsx'), 'utf8');
  assert.match(restoreModal, /if \(!opened\) return setPhase\('unreachable'\)/);
  // Down only after TWO failed checks in a row, in both windows: one blip — a 502, the
  // Wi-Fi — was read as the restart, and the window then called it done.
  for (const [name, m] of [['UpdateModal', modal], ['RestoreModal', restoreModal]] as const) {
    assert.match(m, /failures \+= 1;\s*if \(failures >= 2\) wentDown = true;/, name);
    assert.match(m, /if \(!res\.ok\) throw new Error\(String\(res\.status\)\);\s*failures = 0;/, `${name}: a good answer starts the count again`);
    assert.doesNotMatch(m, /catch \{\s*wentDown = true;/, `${name}: one failure is a restart again`);
    assert.doesNotMatch(m, /\} else \{\s*wentDown = true;/, `${name}: one failure is a restart again`);
  }
  // A restore whose stream DROPPED before it said how it went is not "complete": the
  // restart afterwards proves only that the core restarted.
  assert.match(restoreModal, /const heard = code === 1000 \|\| code === CLOSED_WITH_PROBLEMS;/);
  assert.match(restoreModal, /set\(heard \? 'done' : 'lost'\);/);
  assert.match(restoreModal, /phase === 'lost'\s*\? t\('restore\.lost'\)/);
  // And the route passes "from outside" from the front door's hand-over, not a header.
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'update.ts'), 'utf8');
  assert.match(route, /runUpdate\(send, \{ remote: wasHandedOver\(req\.raw\) \}\)/);
  assert.match(route, /socket\.close\(\.\.\.UPDATE_CLOSE\[outcome\]\)/);
  // A refusal before it starts closes with a 4xxx too, so it must say why as a line first —
  // the window reads every 4xxx as "nothing was changed, the messages above say why".
  for (const code of ['4401', '4403']) assert.match(route, new RegExp(`return refuse\\(${code}, '`), code);
  assert.doesNotMatch(route, /return socket\.close\(44/, 'a refusal that closes without saying why');
});

/** The remote dashboard's own caller: handed over, with a session that passed the second factor. */
function fromOutside() {
  const { token, csrf } = sessions.createSession('admin', sessions.currentCredential(), {
    remote: true,
    tf: tf.secondFactorEpoch(),
    handedOver: true,
  });
  return systemRouter.createCaller({
    username: 'admin',
    sessionToken: token,
    csrf,
    isWebSocket: false,
    ip: '172.17.0.1',
    host: 'omos.example.org',
    viaTunnel: true,
    handedOver: true,
    remoteIp: '203.0.113.9',
  } as never);
}
function atTheMasjid() {
  const { token, csrf } = sessions.createSession('admin', sessions.currentCredential());
  return systemRouter.createCaller({
    username: 'admin',
    sessionToken: token,
    csrf,
    isWebSocket: false,
    ip: '172.17.0.1',
    host: '192.168.1.50',
    viaTunnel: false,
    handedOver: false,
    remoteIp: null,
  } as never);
}

test('FROM OUTSIDE, THE CHANNEL SWITCH TO A VERSION THAT CANNOT BE MANAGED FROM OUTSIDE IS REFUSED', async () => {
  settings.updateSettings({ updateChannel: 'dev' });
  const unpublish = publishes({ master: '0.51.1', dev: '0.51.2-dev.99' });
  try {
    await assert.rejects(
      fromOutside().setUpdateChannel({ channel: 'main' }),
      (e: { code?: string; message?: string }) =>
        e.code === 'FORBIDDEN' && /can't be managed from outside the masjid/.test(e.message ?? '') && /Nothing was changed/.test(e.message ?? ''),
    );
    assert.equal(settings.getSettings().updateChannel, 'dev', 'the channel moved anyway');
    // At the masjid it goes ahead.
    const res = await atTheMasjid().setUpdateChannel({ channel: 'main' });
    assert.equal(res.changed, true);
    // From outside, to a channel whose version has it: allowed.
    unpublish();
    const both = publishes({ master: '0.51.2', dev: '0.51.2-dev.99' });
    const back = await fromOutside().setUpdateChannel({ channel: 'dev' });
    assert.equal(back.changed, true);
    const toStable = await fromOutside().setUpdateChannel({ channel: 'main' });
    assert.equal(toStable.changed, true, 'once Stable has remote administration, switching to it from outside is fine');
    both();
    // A version that cannot be read is refused from outside too.
    settings.updateSettings({ updateChannel: 'dev' });
    const none = publishes({ dev: '0.51.2-dev.99' });
    await assert.rejects(
      fromOutside().setUpdateChannel({ channel: 'main' }),
      (e: { code?: string; message?: string }) => /Couldn't check which version/.test(e.message ?? ''),
    );
    assert.equal(settings.getSettings().updateChannel, 'dev');
    none();
  } finally {
    unpublish();
    settings.updateSettings({ updateChannel: 'dev' });
  }
});

test('a version that cannot be read is never "already up to date" — on the same channel, nothing is pulled and it says it could not check', POSIX_ONLY, async () => {
  // An admin pressed "Update now" for a version found a moment earlier; the next check
  // failed, and the window said "already up to date" over a newer build it knew about.
  settings.updateSettings({ updateChannel: 'dev' }); // the box runs a Development build
  const docker = fakeDocker();
  const unread = publishes({});
  try {
    for (const remote of [false, true]) {
      const lines: string[] = [];
      assert.equal(await runUpdate((l) => lines.push(l), { remote }), 'unchanged');
      assert.ok(lines.some((l) => /Couldn't check for the latest version just now/.test(l)), lines.join(' | '));
      assert.ok(!lines.some((l) => /already up to date/.test(l)), `remote=${remote}: called up to date`);
    }
    assert.equal(docker.log(), '', 'something was pulled for a version nobody could read');
  } finally {
    unread();
    docker.restore();
  }
});

test("an app's update window reads the server's close codes as the server means them", () => {
  // The window said "<app> is up to date now." for every ending; it reads the code now,
  // through a React-free copy the server's codes are held to here.
  const { APP_UPDATE_CLOSE } = req('../src/api/app-update') as typeof import('../src/api/app-update');
  const endings = req(path.join(__dirname, '..', '..', 'ui', 'src', 'lib', 'update-endings.ts')) as typeof import('../../ui/src/lib/update-endings');
  assert.equal(endings.appUpdateEnding(APP_UPDATE_CLOSE.updated[0], true), 'updated');
  assert.equal(endings.appUpdateEnding(APP_UPDATE_CLOSE.unchanged[0], true), 'unchanged');
  assert.equal(endings.appUpdateEnding(APP_UPDATE_CLOSE['not-running'][0], true), 'notRunning');
  assert.equal(endings.appUpdateEnding(APP_UPDATE_CLOSE.failed[0], true), 'stopped');
  for (const refusal of [4400, 4401, 4403]) assert.equal(endings.appUpdateEnding(refusal, true), 'unchanged', String(refusal));
  assert.equal(endings.appUpdateEnding(1006, true), 'lost', 'a stream that dropped part-way may still be finishing');
  assert.equal(endings.appUpdateEnding(1006, false), 'unreachable', 'a stream that never connected began nothing');
  const codes = Object.values(APP_UPDATE_CLOSE).map(([c]) => c);
  assert.equal(new Set(codes).size, codes.length, 'two endings share a code');
  // And the route closes with them, saying why on a refusal.
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'app-update.ts'), 'utf8');
  assert.match(route, /socket\.close\(\.\.\.APP_UPDATE_CLOSE\[outcome\]\)/);
  for (const code of ['4400', '4401', '4403']) assert.match(route, new RegExp(`return refuse\\(${code}, '`), code);
});

/** A stand-in Docker Engine API on the socket the core is pointed at, answering inspect. */
async function stubEngine(container: unknown): Promise<() => Promise<void>> {
  const sock = process.env.DOCKER_SOCKET!;
  fs.rmSync(sock, { force: true });
  const server = http.createServer((r, res) => {
    if (/\/containers\/[^/]+\/json$/.test((r.url ?? '').split('?')[0]!)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(container));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"message":"not in this stand-in"}');
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(sock, { force: true });
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('A RESTORE COMES BACK ON THE BUILD THAT IS RUNNING — whatever the compose file says', POSIX_ONLY, async () => {
  // The compose file is not a record of what runs. An update whose helper could not start
  // left it naming the version it was going to, and the installer's Update wrote it before
  // downloading; a restore that trusted it came back on another build — from outside,
  // possibly one with no remote dashboard.
  const compose = path.join(DATA, 'docker-compose.yml');
  const id = `sha256:${'ab'.repeat(32)}`;
  const stopEngine = await stubEngine({
    Image: id,
    Config: { Image: 'ghcr.io/openmasjid-solutions/openmasjid-core:0.51.2-dev.16' },
    Mounts: [{ Destination: '/data', Source: '/opt/openmasjid' }],
  });
  const docker = fakeDocker();
  try {
    fs.writeFileSync(compose, 'services:\n  core:\n    image: ghcr.io/openmasjid-solutions/openmasjid-core:0.51.1\n');
    assert.equal(await recreateCore(() => undefined), true);
    const want = `ghcr.io/openmasjid-solutions/openmasjid-core:${VERSION}`;
    assert.match(docker.log(), new RegExp(`^tag ${id} ${escapeRe(want)}$`, 'm'), 'the running image was not tagged with its version');
    assert.match(fs.readFileSync(compose, 'utf8'), new RegExp(`image: ${escapeRe(want)}\\n`), 'the compose file still names another build');
    assert.match(docker.log(), new RegExp(`^run -d --rm .*-v /opt/openmasjid:/data .*${id} -c sleep 2; docker compose`, 'm'));

    // A line pinned to a digest is the operator's, and is left alone.
    const pinned = `services:\n  core:\n    image: ghcr.io/openmasjid-solutions/openmasjid-core@sha256:${'cd'.repeat(32)}\n`;
    fs.writeFileSync(compose, pinned);
    const before = docker.log();
    assert.equal(await recreateCore(() => undefined), true);
    assert.equal(fs.readFileSync(compose, 'utf8'), pinned);
    assert.doesNotMatch(docker.log().slice(before.length), /^tag /m);
  } finally {
    docker.restore();
    await stopEngine();
    fs.rmSync(compose, { force: true });
  }
});

test('an update whose helper could not start puts the compose file back — "nothing was changed" stays true', POSIX_ONLY, async () => {
  const compose = path.join(DATA, 'docker-compose.yml');
  const original = 'services:\n  core:\n    image: ghcr.io/openmasjid-solutions/openmasjid-core:0.51.2-dev.16\n';
  fs.writeFileSync(compose, original);
  const docker = fakeDocker('"run -d"*');
  try {
    assert.equal(await recreateCore(() => undefined, '0.51.2-dev.99'), false);
    assert.equal(fs.readFileSync(compose, 'utf8'), original, 'the compose file names a build the core never ran');
  } finally {
    docker.restore();
    fs.rmSync(compose, { force: true });
  }
});

test("the installer's Update downloads BEFORE it writes the new image into the compose file", () => {
  // With `set -e` a failed download ends the script, and a compose file already naming the
  // new image would be what the next restart of the core comes back on.
  const sh = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'install.sh'), 'utf8');
  const start = sh.indexOf('do_update() {');
  const body = sh.slice(start, sh.indexOf('\n}\n', start));
  const pull = body.indexOf('docker pull "${IMAGE}"');
  const write = body.indexOf('write_compose_file');
  assert.ok(pull > 0 && write > 0, 'setup');
  assert.ok(pull < write, 'the compose file is written before the image is downloaded');
  assert.ok(body.indexOf('resolve_image') < pull, 'the image must be decided before it is pulled');
});

test('A CORE PINNED TO ONE EXACT BUILD IS NOT "UPDATED" ONTO THAT SAME BUILD, AGAIN AND AGAIN', POSIX_ONLY, async () => {
  // A digest on the compose line is the operator's choice and is left alone, so an update
  // pulled the same build and restarted the dashboard onto it, for nothing, every time it
  // was pressed, while the banner went on offering it.
  const compose = path.join(DATA, 'docker-compose.yml');
  fs.writeFileSync(compose, `services:\n  core:\n    image: ghcr.io/openmasjid-solutions/openmasjid-core@sha256:${'cd'.repeat(32)}\n`);
  settings.updateSettings({ updateChannel: 'dev' });
  const docker = fakeDocker();
  const unpublish = publishes({ dev: '0.51.2-dev.99' });
  try {
    const lines: string[] = [];
    assert.equal(await runUpdate((l) => lines.push(l), {}), 'unchanged');
    assert.ok(lines.some((l) => /pinned to one exact build/.test(l)), lines.join(' | '));
    assert.ok(lines.some((l) => /Nothing was changed\./.test(l)));
    assert.equal(docker.log(), '', 'something was downloaded or restarted for a pinned core');
  } finally {
    unpublish();
    docker.restore();
    fs.rmSync(compose, { force: true });
  }
});
