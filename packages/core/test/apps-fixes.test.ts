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
import Module, { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-apps-fixes-'));
process.env.OPENMASJID_DATA_DIR = DATA;

// A stand-in docker: runs nothing, and exits with FAKE_DOCKER_EXIT (0 unless a test says).
// With FAKE_DOCKER_REFUSE_FILE set, any call naming a compose file (-f) fails, as compose
// does on a file it cannot read.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-fake-docker-'));
fs.writeFileSync(
  path.join(BIN, 'docker'),
  '#!/bin/sh\n' +
    'if [ -n "$FAKE_DOCKER_REFUSE_FILE" ]; then case " $* " in *" -f "*) echo "yaml: invalid" >&2; exit 1;; esac; fi\n' +
    '[ "${FAKE_DOCKER_EXIT:-0}" = 0 ] || echo "Error response from daemon: refused" >&2\nexit "${FAKE_DOCKER_EXIT:-0}"\n',
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

test('AN APP WHOSE RECORD WILL NOT PARSE IS HELD, NOT RECOVERED OVER', async () => {
  // Recovering it as an orphan wrote a fresh record with no review over the broken one,
  // so a backup pairing a broken meta.json with a privileged compose — for an app whose
  // containers are already on the box — became an ordinary Start button.
  fs.mkdirSync(path.join(APPS, 'broken-app'), { recursive: true });
  fs.writeFileSync(path.join(APPS, 'broken-app', 'compose.yml'), 'services:\n  app:\n    image: x\n    privileged: true\n');
  fs.writeFileSync(path.join(APPS, 'broken-app', 'meta.json'), '{"id": "broken-app", "review": ');
  const original = client.docker.listContainers;
  client.docker.listContainers = () =>
    Promise.resolve([{ Labels: { 'com.docker.compose.project': 'omos-broken-app' }, State: 'exited', Ports: [] }]);
  try {
    // Held for what its compose asks for, ahead of "couldn't read its record": that one can be
    // agreed to on the dashboard, and a refusal in the compose must never become a tickbox.
    const row = (await manager.listInstalled()).find((a) => a.id === 'broken-app');
    assert.equal(row?.review?.kind, 'danger', 'the row must show the app held');
    assert.equal(fs.readFileSync(path.join(APPS, 'broken-app', 'meta.json'), 'utf8'), '{"id": "broken-app", "review": ');
    assert.equal(manager.startBlockedReason('broken-app')?.kind, 'danger');
    // With no finding in its compose, it is held as unreadable.
    fs.writeFileSync(path.join(APPS, 'broken-app', 'compose.yml'), 'services:\n  app:\n    image: x\n');
    assert.equal(manager.startBlockedReason('broken-app')?.kind, 'unreadable');
  } finally {
    client.docker.listContainers = original;
  }
});

const PRIVILEGED = 'services:\n  app:\n    image: x\n    privileged: true\n';
/** Lay down an app folder as a backup could bring it: this compose, and this meta.json text (none if null). */
function restored(id: string, metaText: string | null): void {
  fs.mkdirSync(path.join(APPS, id), { recursive: true });
  fs.writeFileSync(path.join(APPS, id, 'compose.yml'), PRIVILEGED);
  if (metaText !== null) fs.writeFileSync(path.join(APPS, id, 'meta.json'), metaText);
}
/** Docker reports these projects, stopped, for the length of `fn`. */
async function withProjects(ids: string[], fn: () => Promise<void>): Promise<void> {
  const original = client.docker.listContainers;
  client.docker.listContainers = () =>
    Promise.resolve(ids.map((id) => ({ Labels: { 'com.docker.compose.project': `omos-${id}` }, State: 'exited', Ports: [] })));
  try {
    await fn();
  } finally {
    client.docker.listContainers = original;
  }
}
const isHold = (err: unknown) => err instanceof manager.AppNeedsReviewError;

test('A COMPOSE THAT CAME WITH NO RECORD IS HELD — not recovered as an app free to start', async () => {
  // A backup carrying apps/X/compose.yml (privileged) and no meta.json, restored onto a box
  // whose Docker still has X's containers: the review only visited folders with a record, so
  // the listing recovered X with a fresh, unheld record, and Start ran the compose as root.
  restored('no-record', null);
  manager.reviewEveryApp();
  assert.equal(fs.existsSync(path.join(APPS, 'no-record', 'meta.json')), false, 'a review writes no record');
  assert.equal(manager.startBlockedReason('no-record')?.kind, 'danger', 'held before any listing');
  await assert.rejects(() => manager.startApp('no-record'), isHold);
  await withProjects(['no-record'], async () => {
    const row = (await manager.listInstalled()).find((a) => a.id === 'no-record');
    assert.equal(row?.review?.kind, 'danger', 'the recovered row shows the hold');
  });
  assert.equal(metaOf('no-record').review?.kind, 'danger', 'and the record it was given keeps it');
  assert.equal(manager.startBlockedReason('no-record')?.kind, 'danger');
  await assert.rejects(() => manager.startApp('no-record'), isHold);
  await assert.rejects(() => manager.restartApp('no-record'), isHold);
});

test('…and a record that cannot be read is never written over to move it off a reserved address', async () => {
  // `settings` is the dashboard's address now: recovering the app moved it off, by saving a
  // fresh record over the unreadable one — dropping the hold, the secret and the exposure.
  restored('settings', '{"id": "settings", "review": ');
  await withProjects(['settings'], async () => {
    const row = (await manager.listInstalled()).find((a) => a.id === 'settings');
    assert.equal(row?.review?.kind, 'danger', 'held for what its compose asks for');
  });
  assert.equal(fs.readFileSync(path.join(APPS, 'settings', 'meta.json'), 'utf8'), '{"id": "settings", "review": ');
  await assert.rejects(() => manager.startApp('settings'), isHold);
});

test("A RECORD NAMING ANOTHER APP IS NOT THIS APP'S RECORD — its verdict lands nowhere else", async () => {
  // Every write goes to the folder a record's `id` names. apps/X/meta.json saying "Y" had X's
  // verdict saved into apps/Y/ (over Y's own record), X stayed unheld, and a Remote access
  // save ended in startApp(X). With no `id` at all, the review threw and X stayed unheld too.
  seed('real-app', { name: 'Real' });
  fs.writeFileSync(path.join(APPS, 'real-app', 'compose.yml'), 'services:\n  app:\n    image: nginx:1.27\n'); // passes: its own review writes nothing
  const realBefore = fs.readFileSync(path.join(APPS, 'real-app', 'meta.json'), 'utf8');
  const claims = JSON.stringify({ id: 'real-app', name: 'Impostor', kind: 'catalog', createdAt: '2026-01-01T00:00:00.000Z' });
  restored('impostor', claims);
  restored('no-id', JSON.stringify({ name: 'No id', kind: 'catalog', createdAt: '2026-01-01T00:00:00.000Z' }));
  restored('not-a-record', '42');
  manager.reviewEveryApp();
  assert.equal(fs.readFileSync(path.join(APPS, 'real-app', 'meta.json'), 'utf8'), realBefore, "another app's record was written");
  assert.equal(fs.readFileSync(path.join(APPS, 'impostor', 'meta.json'), 'utf8'), claims, 'nothing is written over it');
  for (const id of ['impostor', 'no-id', 'not-a-record']) {
    assert.equal(manager.startBlockedReason(id)?.kind, 'danger', id);
    await assert.rejects(() => manager.startApp(id), isHold, id);
  }
  assert.equal(manager.reconcilePublicUrls().includes('impostor'), false);
  await withProjects(['impostor'], async () => {
    const rows = (await manager.listInstalled()).filter((a) => a.id === 'impostor' || a.name === 'Impostor');
    assert.deepEqual(rows.map((a) => [a.id, a.review?.kind]), [['impostor', 'danger']]);
  });
  assert.equal(fs.readFileSync(path.join(APPS, 'impostor', 'meta.json'), 'utf8'), claims);
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

test('A REMOVAL DOCKER REFUSED LEAVES THE APP AS IT WAS — and a damaged compose file never blocks one', needsShell, async () => {
  // Its files went while its containers still ran, so it came back as a recovered orphan
  // with the data the admin had asked to delete.
  seed('refused-removal');
  process.env.FAKE_DOCKER_EXIT = '1';
  try {
    await assert.rejects(() => manager.removeApp('refused-removal', true), /couldn't be removed/);
    await assert.rejects(() => manager.removeApp('refused-removal'), /couldn't be removed/);
  } finally {
    delete process.env.FAKE_DOCKER_EXIT;
  }
  assert.equal(metaOf('refused-removal').id, 'refused-removal', 'its record was removed');
  assert.ok(fs.existsSync(path.join(APPS, 'refused-removal', 'compose.yml')), 'its files were removed');

  // A compose file compose cannot read: the app goes all the same, found by its project.
  seed('damaged-compose');
  process.env.FAKE_DOCKER_REFUSE_FILE = '1';
  try {
    await manager.removeApp('damaged-compose', true);
  } finally {
    delete process.env.FAKE_DOCKER_REFUSE_FILE;
  }
  assert.equal(fs.existsSync(path.join(APPS, 'damaged-compose')), false);
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

test('…but not while a restore runs: a read writes nothing into the tree being put in place', async () => {
  const lock = req('../src/system/update-lock') as typeof import('../src/system/update-lock');
  seed('kiosk', { path: 'settings' });
  const before = fs.readFileSync(path.join(APPS, 'kiosk', 'meta.json'), 'utf8');
  let release = () => {};
  const restoring = lock.withUpdateLock('restore', 'busy', () => new Promise<void>((r) => (release = r)));
  try {
    assert.equal(manager.getAppPath('kiosk'), 'kiosk', 'it answers at the new address');
    assert.equal(fs.readFileSync(path.join(APPS, 'kiosk', 'meta.json'), 'utf8'), before, 'and writes nothing');
  } finally {
    release();
    await restoring;
  }
  assert.equal(manager.getAppPath('kiosk'), 'kiosk');
  assert.equal(metaOf('kiosk').path, undefined, 'the first read after the restore records it');
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

// ── "It stayed up" is said only of an app that did ────────────────────────────

/** A second copy of the manager, seeing these in place of its `docker compose` calls
 *  and its HTTPS proxies. */
function managerWith(stubs: {
  compose?: Partial<typeof import('../src/docker/compose')>;
  proxy?: Partial<typeof import('../src/system/app-proxy')>;
}): typeof import('../src/apps/manager') {
  const files = { compose: '../src/docker/compose', proxy: '../src/system/app-proxy' } as const;
  const managerPath = req.resolve('../src/apps/manager');
  const saved = new Map([[managerPath, req.cache[managerPath]]]);
  for (const [name, overrides] of Object.entries(stubs) as [keyof typeof files, object][]) {
    const file = req.resolve(files[name]);
    const stub = new Module(file);
    stub.filename = file;
    stub.loaded = true;
    stub.exports = { ...req(file), ...overrides };
    saved.set(file, req.cache[file]);
    req.cache[file] = stub;
  }
  delete req.cache[managerPath];
  try {
    return req('../src/apps/manager');
  } finally {
    for (const [file, real] of saved) req.cache[file] = real;
  }
}

test('AN APP THAT IS DOWN IS NEVER "STAYED UP" — not even when it left no logs to read', async () => {
  // Every caller reads null as "it stayed up": an update said Done, `!os start` said it
  // was running, and the WhatsApp gateway's restart said it had started.
  seed('silent-app');
  const original = client.docker.listContainers;
  client.docker.listContainers = () => Promise.resolve([]); // nothing is running
  try {
    const said = await Promise.all([
      managerWith({ compose: { composeLogs: async () => '  \n' } }).verifyStayedUp('silent-app'),
      managerWith({ compose: { composeLogs: () => Promise.reject(new Error('docker went away')) } }).verifyStayedUp('silent-app'),
    ]);
    for (const stayed of said) {
      assert.equal(stayed.result, 'down');
      if (stayed.result === 'down') assert.match(stayed.logs, /isn't running/);
    }
  } finally {
    client.docker.listContainers = original;
  }
});

test('DOCKER NOT ANSWERING IS "COULDN\'T TELL" — never "it stopped", never "it stayed up"', async () => {
  // A Docker hiccup during the settle checks read as "not running": an update closed as
  // "updated, but it isn't staying running", and WhatsApp said it started and then stopped.
  seed('steady-app');
  const original = client.docker.listContainers;
  let asked = 0;
  client.docker.listContainers = () =>
    ++asked === 2
      ? Promise.reject(new Error('docker is busy'))
      : Promise.resolve([{ Labels: { 'com.docker.compose.project': 'omos-steady-app' }, State: 'running', Ports: [] }]);
  try {
    assert.deepEqual(await manager.verifyStayedUp('steady-app'), { result: 'unknown' });
    asked = 2; // every later sample answers, and the app is up on each
    assert.deepEqual(await manager.verifyStayedUp('steady-app'), { result: 'up' });
  } finally {
    client.docker.listContainers = original;
  }
});

// ── A boot that could not read Docker comes back for the HTTPS proxies ────────

test("AN APP'S HTTPS ADDRESS IS RESTORED ONCE DOCKER ANSWERS — not given up at the first try", async () => {
  // At boot, "could not ask Docker" came back as every app with no port, so no proxy was
  // restored and nothing tried again: the app's HTTPS address stayed dead after a reboot.
  seed('card-reader', { https: true, httpsPort: 8449 });
  const restored: string[] = [];
  const mgr = managerWith({ proxy: { ensureProxy: (id, httpsPort, port) => void restored.push(`${id} ${httpsPort}→${port}`) } });
  let asked = 0;
  const original = client.docker.listContainers;
  client.docker.listContainers = () =>
    ++asked === 1
      ? Promise.reject(new Error('docker is still starting'))
      : Promise.resolve([{ Labels: { 'com.docker.compose.project': 'omos-card-reader' }, State: 'running', Ports: [{ PublicPort: 8095 }] }]);
  try {
    await mgr.restoreAppProxies();
    assert.deepEqual(restored, [], 'nothing is decided while Docker cannot be read');
    for (const until = Date.now() + 10_000; restored.length === 0 && Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(restored, ['card-reader 8449→8095'], 'restored once Docker answered');
  } finally {
    client.docker.listContainers = original;
  }
});
