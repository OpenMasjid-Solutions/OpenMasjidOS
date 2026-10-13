// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Fixes to the apps manager (apps/manager.ts). Each test says what it holds the manager
 * to; the ones that reach `docker` use a stand-in that runs nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-apps-fixes-'));
process.env.OPENMASJID_DATA_DIR = DATA;

// A stand-in docker: runs nothing, and exits with FAKE_DOCKER_EXIT (0 unless a test says).
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-fake-docker-'));
fs.writeFileSync(
  path.join(BIN, 'docker'),
  '#!/bin/sh\n[ "${FAKE_DOCKER_EXIT:-0}" = 0 ] || echo "Error response from daemon: refused" >&2\nexit "${FAKE_DOCKER_EXIT:-0}"\n',
  { mode: 0o755 },
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
const needsShell = { skip: process.platform === 'win32' && 'needs a POSIX shell for the stand-in docker' };

const req = createRequire(__filename);
const manager = req('../src/apps/manager') as typeof import('../src/apps/manager');
const settings = req('../src/settings/store') as typeof import('../src/settings/store');
const { log } = req('../src/logger') as typeof import('../src/logger');
const { isOfflineSuppressed } = req('../src/system/offline-suppress') as typeof import('../src/system/offline-suppress');
const client = req('../src/docker/client') as { docker: { listContainers: unknown } };

const APPS = path.join(DATA, 'apps');
const envOf = (id: string) => fs.readFileSync(path.join(APPS, id, '.env'), 'utf8');
const metaOf = (id: string) => JSON.parse(fs.readFileSync(path.join(APPS, id, 'meta.json'), 'utf8'));

/** Lay down an installed app's files. */
function seed(id: string, meta: Record<string, unknown> = {}, env?: string): void {
  fs.mkdirSync(path.join(APPS, id), { recursive: true });
  fs.writeFileSync(path.join(APPS, id, 'compose.yml'), 'services: {}\n');
  fs.writeFileSync(
    path.join(APPS, id, 'meta.json'),
    JSON.stringify({ id, name: id, kind: 'catalog', createdAt: '2026-01-01T00:00:00.000Z', ...meta }),
  );
  if (env !== undefined) fs.writeFileSync(path.join(APPS, id, '.env'), env);
}

// ── Reading one app costs one app ─────────────────────────────────────────────

test("ONE APP'S ROW IS THE ROW THE FULL LISTING GIVES — without reading every app", async () => {
  seed('running-app', { icon: 'https://example.org/i.png', category: 'displays', sso: true });
  seed('stopped-app', { kind: 'custom' });
  seed('https-app', { https: true, httpsPort: 9443, exposed: false });
  seed('held-app', { review: { kind: 'danger', reasons: ['It asks for privileged mode.'], at: '2026-01-01T00:00:00.000Z' } });
  seed('pathed-app', { path: 'give' });
  seed('cloudflared');
  const containers = [
    { Labels: { 'com.docker.compose.project': 'omos-running-app' }, State: 'running', Ports: [{ PublicPort: 8443 }, { PublicPort: 8081 }] },
    { Labels: { 'com.docker.compose.project': 'omos-stopped-app' }, State: 'exited', Ports: [] },
    { Labels: { 'com.docker.compose.project': 'omos-https-app' }, State: 'running', Ports: [{ PublicPort: 8090 }] },
    { Labels: { 'com.docker.compose.project': 'omos-orphan-app' }, State: 'running', Ports: [{ PublicPort: 8070 }] },
    { Labels: { 'com.docker.compose.project': 'omos-cloudflared' }, State: 'running', Ports: [] },
  ];
  const original = client.docker.listContainers;
  client.docker.listContainers = () => Promise.resolve(containers);
  try {
    await manager.listInstalled(); // recovers the orphan, as the dashboard's first listing would
    const all = await manager.listInstalled();
    for (const id of ['running-app', 'stopped-app', 'https-app', 'held-app', 'pathed-app', 'orphan-app', 'cloudflared', 'nothing']) {
      assert.deepEqual(await manager.getInstalled(id), all.find((a) => a.id === id) ?? null, id);
    }
    assert.equal(await manager.getInstalled('cloudflared'), null, "the platform's own tunnel is never an app");
    assert.deepEqual((await manager.getInstalled('running-app'))?.ports, [8081, 8443]);
  } finally {
    client.docker.listContainers = original;
  }
});

test('the alert check follows the Fabric index, which follows every change to an app', () => {
  seed('alerting', { ssoSecret: 'a'.repeat(43), appAlerts: [{ id: 'reader-offline', label: 'Reader offline' }] });
  seed('secretless', { appAlerts: [{ id: 'reader-offline', label: 'Reader offline' }] });
  manager.invalidateFabricIndex();
  assert.equal(manager.appDeclaresAlert('alerting', 'reader-offline'), true);
  assert.equal(manager.appDeclaresAlert('alerting', 'something-else'), false);
  assert.equal(manager.appDeclaresAlert('secretless', 'reader-offline'), false, 'it cannot call the route at all');
  assert.equal(manager.appDeclaresAlert('nothing', 'reader-offline'), false);

  // An update that withdraws the alert saves the record, and that drops the index.
  seed('alerting', { ssoSecret: 'a'.repeat(43), appAlerts: [] });
  manager.setExposed('alerting', false);
  assert.equal(manager.appDeclaresAlert('alerting', 'reader-offline'), false);

  // One unreadable entry must not take every app's Fabric lookups down with it.
  seed('mangled', { ssoSecret: 'm'.repeat(43), appAlerts: [null, { id: 'ok-alert' }] });
  manager.invalidateFabricIndex();
  assert.equal(manager.appDeclaresAlert('mangled', 'ok-alert'), true);
  assert.ok(manager.findFabricApp('a'.repeat(43)));
});

// ── What Docker refused is reported ───────────────────────────────────────────

test('A REFUSED START, STOP OR RESTART IS REPORTED, NEVER CALLED A SUCCESS', needsShell, async () => {
  seed('stubborn');
  const plainWords = (verb: string) => (err: Error) => {
    assert.match(err.message, new RegExp(`couldn't be ${verb}`));
    assert.doesNotMatch(err.message, /daemon/, "Docker's own words stay in the log");
    return true;
  };
  process.env.FAKE_DOCKER_EXIT = '1';
  try {
    await assert.rejects(() => manager.stopApp('stubborn'), plainWords('stopped'));
    await assert.rejects(() => manager.startApp('stubborn'), plainWords('started'));
    await assert.rejects(() => manager.restartApp('stubborn'), plainWords('restarted'));
    // An app with no compose file of ours is started with `compose start` instead.
    fs.rmSync(path.join(APPS, 'stubborn', 'compose.yml'));
    await assert.rejects(() => manager.startApp('stubborn'), plainWords('started'));
  } finally {
    delete process.env.FAKE_DOCKER_EXIT;
  }
  // And when Docker does what was asked, nothing is said.
  await manager.startApp('stubborn');
  await manager.stopApp('stubborn');
  await manager.restartApp('stubborn');
});

test('REMOVING AN APP IS NOT AN OUTAGE — no "has stopped" alert while it goes', needsShell, async () => {
  seed('leaving');
  assert.equal(isOfflineSuppressed('leaving'), false);
  await manager.removeApp('leaving');
  assert.equal(isOfflineSuppressed('leaving'), true);
  // Held from before `compose down` starts, which is when it stops.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'apps', 'manager.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function removeApp('));
  assert.ok(body.indexOf('suppressOfflineAlert(id)') < body.indexOf('composeDown('));
});

// ── A setting reaches the app as it was typed ─────────────────────────────────

/** The raw text after `KEY=` on the line that sets it. */
function rawValue(env: string, key: string): string {
  const line = env.split('\n').find((l) => l.startsWith(`${key}=`));
  assert.ok(line !== undefined, `no ${key} line`);
  return line.slice(key.length + 1);
}

/**
 * What `docker compose --env-file` gives an app for one .env value, following compose-go's
 * dotenv parser (dotenv/parser.go) and its `$$` escape (template/template.go). A `$` it
 * would interpolate fails the test: the value would reach the app changed.
 */
function composeReads(raw: string): string {
  let value: string;
  if (raw.startsWith('"')) {
    let out = '';
    let escaped = false;
    let end = -1;
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i];
      if (c === '"' && !escaped) {
        end = i;
        break;
      }
      if (c === '"') {
        escaped = false;
        out += c; // an escaped quote loses its backslash
      } else if (!escaped && c === '\\') {
        escaped = true;
      } else {
        if (escaped) out += '\\';
        escaped = false;
        out += c;
      }
    }
    assert.ok(end > 0, `unterminated quoted value: ${raw}`);
    assert.equal(raw.slice(end + 1), '', `something follows the closing quote: ${raw}`);
    const ESC: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', '\\': '\\', $: '$$' };
    value = out.replace(/\\([abfnrtv$"\\])/g, (_m, c: string) => ESC[c]);
  } else {
    value = raw.trimStart().split(' #')[0].trimEnd();
  }
  return value.replace(/\$(\$|[_a-z][_a-z0-9]*|\{)/gi, (m, next: string) => {
    assert.equal(next, '$', `compose would interpolate "${m}" in ${raw}`);
    return '$';
  });
}

const TYPED: Record<string, string> = {
  PLAIN: 'plain-value_1.2:3/x=y',
  EMPTY: '',
  PASSWORD: 'pa$$w0rd',
  HOME_REF: 'a$HOME and ${HOME}',
  RATE: 'rate # 2',
  HASH: '#1',
  QUOTES: `say "hi", it's fine`,
  LEADING_QUOTE: `'single`,
  BACKSLASH: 'C:\\path\\to\\',
  ESCAPES: '\\n \\t \\$ \\" \\\\',
  SPACES: '  padded  ',
  ARABIC: 'مسجد النور',
};

test('A SETTING REACHES THE APP EXACTLY AS IT WAS TYPED', needsShell, async () => {
  await manager.installCatalogApp(
    { id: 'typed', name: 'Typed', version: '1.0.0', compose: 'services: {}\n' } as never,
    TYPED,
    null,
    false,
  );
  const env = envOf('typed');
  for (const [key, typed] of Object.entries(TYPED)) {
    const raw = rawValue(env, key);
    assert.equal(composeReads(raw), typed, `compose reads ${key} differently from what was typed`);
    assert.equal(manager.decodeEnvValue(raw), typed, `the platform reads ${key} back differently`);
  }
  // A value compose would read as written stays byte for byte what it was.
  assert.match(env, /^PLAIN=plain-value_1\.2:3\/x=y$/m);
  assert.match(env, /^EMPTY=$/m);
  assert.match(env, /^ARABIC=مسجد النور$/m);
  assert.match(env, /^OPENMASJID_APP_ID=typed$/m);
  assert.match(env, /^PASSWORD="pa\$\$\$\$w0rd"$/m, 'every $ doubled, inside double quotes');
});

test('the .env codec round-trips anything a form can send', () => {
  const samples = [...Object.values(TYPED), '$', '$$', '"', '\\', '\\"', '"\\', ' ', '\t', 'a\u0085', '${A:-b}', 'x\\$y'];
  for (const v of samples) {
    const raw = manager.encodeEnvValue(v);
    assert.equal(manager.decodeEnvValue(raw), v, JSON.stringify(v));
    assert.equal(composeReads(raw), v, `compose: ${JSON.stringify(v)}`);
  }
  // One value is one line, as before.
  assert.equal(manager.encodeEnvValue('a\r\nb'), 'a b');
});

test('A PLATFORM REWRITE OF THE .ENV CHANGES ONLY ITS OWN LINE', () => {
  // Written before values were quoted, or pasted for a custom app: compose has always
  // read these lines one way, and a rewrite must not start reading them another.
  const legacy = [
    'OPENMASJID_APP_ID=legacy',
    'PASSWORD=pa$$w0rd',
    'TZ=UTC # the masjid is on UTC',
    'GREETING="two words"',
    "SINGLE='as is'",
    '# a comment',
    'OPENMASJID_PUBLIC_URL=',
  ].join('\n');
  seed('legacy', { kind: 'custom', ssoSecret: 's'.repeat(43) }, `${legacy}\n`);
  settings.updateCloudflare({ enabled: true, domain: 'omos.example.org' });
  manager.setExposed('legacy', true);
  manager.rotateAllFabricSecrets();

  const after = envOf('legacy').split('\n');
  for (const line of legacy.split('\n')) {
    if (line.startsWith('OPENMASJID_PUBLIC_URL=')) continue;
    assert.ok(after.includes(line), `a line the platform did not mean to touch changed: ${line}`);
  }
  assert.ok(after.includes('OPENMASJID_PUBLIC_URL=https://omos.example.org/legacy'));
  assert.equal(after.filter((l) => l.startsWith('OPENMASJID_PUBLIC_URL=')).length, 1);
  assert.equal(after.filter((l) => l.startsWith('OPENMASJID_APP_SECRET=')).length, 1, 'the new secret, once');
  settings.updateCloudflare({ enabled: false, domain: '' });
});

test("a custom app's pasted .env is written as the admin pasted it", needsShell, async () => {
  // It is .env text already: quoting it again would hand the app the quotes.
  await manager.installCustomApp({
    id: 'pasted',
    name: 'Pasted',
    composeText: 'services: {}\n',
    env: { GREETING: '"two words"', TZ: 'UTC # zone', OPENMASJID_APP_ID: 'spoofed' },
  });
  const env = envOf('pasted');
  assert.match(env, /^GREETING="two words"$/m);
  assert.match(env, /^TZ=UTC # zone$/m);
  assert.match(env, /^OPENMASJID_APP_ID=pasted$/m, 'the platform still sets its own keys');
  assert.doesNotMatch(env, /spoofed/);
});

// ── No app keeps an address the platform has since taken ──────────────────────

test('AN APP LEFT ON AN ADDRESS OPENMASJIDOS NOW USES IS MOVED, ONCE AND FOR GOOD', () => {
  // dev.17 reserved the dashboard's pages. An app given /store before that had no public
  // page any more, while its links and QR codes, still saying /store, opened the dashboard.
  settings.updateCloudflare({ enabled: true, domain: 'omos.example.org' });
  seed('shop', { path: 'store', exposed: true }, 'SHOP_NAME=Masjid shop\nOPENMASJID_PUBLIC_URL=https://omos.example.org/store\n');
  seed('blocker', { path: 'shop' }); // the id the shop would move to is another app's address
  seed('files'); // an app whose own id is now the dashboard's
  const warned: string[] = [];
  const warn = log.warn;
  log.warn = (msg: string) => void warned.push(msg);
  try {
    assert.equal(manager.getAppPath('shop'), 'shop-2', 'the address a new app would get');
    assert.equal(metaOf('shop').path, 'shop-2', 'and it is kept');
    const env = envOf('shop');
    assert.match(env, /^OPENMASJID_PUBLIC_URL=https:\/\/omos\.example\.org\/shop-2$/m, 'the app is told where it is now');
    assert.match(env, /^SHOP_NAME=Masjid shop$/m);
    assert.equal(manager.getAppPath('files'), 'files-2');

    // Every way in agrees, and it is said once, not on every read.
    assert.equal(manager.getAppPath('shop'), 'shop-2');
    assert.equal(manager.reconcilePublicUrls().includes('shop'), false, 'already told, by the move itself');
    assert.equal(warned.filter((m) => m.includes('"shop" was at /store')).length, 1);
  } finally {
    log.warn = warn;
    settings.updateCloudflare({ enabled: false, domain: '' });
  }
});

test('a reinstall keeps its address — unless OpenMasjidOS has since taken it', needsShell, async () => {
  seed('kept', { kind: 'custom', path: 'kept-here' });
  await manager.installCustomApp({ id: 'kept', name: 'Kept', composeText: 'services: {}\n', env: {} });
  assert.equal(manager.getAppPath('kept'), 'kept-here');
  seed('kiosk', { kind: 'custom', path: 'apps' });
  await manager.installCustomApp({ id: 'kiosk', name: 'Kiosk', composeText: 'services: {}\n', env: {} });
  assert.equal(manager.getAppPath('kiosk'), 'kiosk');
  assert.equal(metaOf('kiosk').path, undefined, 'it follows its id again');
});
