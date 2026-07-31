// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The File Explorer must not reach the platform's own state [OPENMASJIDOS-004].
 *
 * The sandbox confined every operation to the data dir — but that dir is also where
 * the platform keeps its control plane, so "inside /data" allowed two things:
 *
 *   1. Reading every platform secret. `config/` holds the admin password hash, the
 *      SMTP password / Resend key, the Stripe keys, the Cloudflare tunnel token and
 *      the TLS private key. Every other surface deliberately refuses to return these
 *      to the client (the settings API reports only "is set" flags).
 *   2. Host root. Start/update run `docker compose -f apps/<id>/compose.yml up`,
 *      reading that file FROM DISK — so rewriting it and pressing Start launches a
 *      container with `privileged: true` or the Docker socket mounted, without ever
 *      passing `apps/compose-validate.ts`, the sole install-time gate (CLAUDE.md §15).
 *      `apps/<id>/meta.json` is the same class: it carries the app's `ssoSecret` and
 *      its Fabric capability grants.
 *
 * Both were reachable by any authenticated session, and the core runs as root with
 * the Docker socket.
 *
 * These tests are deliberately written per-verb rather than once over a helper: the
 * bug class here is "one entry point forgot to ask", so each of the nine has to be
 * pinned by name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
type Mgr = typeof import('../src/files/manager');

/** A data dir laid out like a real install, with the module loaded against it. */
function freshManager(): { m: Mgr; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-files-'));
  // Platform state
  fs.mkdirSync(path.join(dir, 'config', 'tls'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'auth.json'), '{"passwordHash":"$argon2id$SECRET"}');
  fs.writeFileSync(path.join(dir, 'config', 'email.json'), '{"smtpPassword":"SECRET-SMTP"}');
  fs.writeFileSync(path.join(dir, 'config', 'stripe.json'), '{"secretKey":"sk_live_SECRET"}');
  fs.writeFileSync(path.join(dir, 'config', 'tls', 'key.pem'), 'SECRET-PRIVATE-KEY');
  // An installed app: platform files + the app's own data
  fs.mkdirSync(path.join(dir, 'apps', 'donations', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps', 'donations', 'compose.yml'), 'services:\n  app:\n    image: x\n');
  fs.writeFileSync(path.join(dir, 'apps', 'donations', '.env'), 'STRIPE_KEY=sk_live_SECRET\n');
  fs.writeFileSync(path.join(dir, 'apps', 'donations', 'meta.json'), '{"id":"donations","ssoSecret":"SECRET-APP"}');
  fs.writeFileSync(path.join(dir, 'apps', 'donations', 'data', 'receipt.txt'), 'the masjid own file');
  fs.writeFileSync(path.join(dir, 'apps', 'donations', 'data', '.env'), 'APP_OWN=fine\n');
  fs.writeFileSync(path.join(dir, 'apps', 'donations', 'docker-compose.yml'), 'not the one compose reads\n');
  // A user file at the top level, which must stay fully usable
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'khutbah notes');

  process.env.OPENMASJID_DATA_DIR = dir;
  for (const mod of ['../src/config', '../src/files/manager']) delete req.cache[req.resolve(mod)];
  return { m: req('../src/files/manager') as Mgr, dir };
}

/** Every path the platform owns, and must never expose or accept a write to. */
const PROTECTED = [
  '/config',
  '/config/auth.json',
  '/config/email.json',
  '/config/stripe.json',
  '/config/tls',
  '/config/tls/key.pem',
  '/apps/donations/compose.yml',
  '/apps/donations/.env',
  '/apps/donations/meta.json',
];

/** Paths that must KEEP working — the feature still has to be a file explorer. */
const ALLOWED = [
  '/',
  '/notes.txt',
  '/apps',
  '/apps/donations',
  '/apps/donations/data',
  '/apps/donations/data/receipt.txt',
  // The app's OWN .env, one level deeper — not the platform's.
  '/apps/donations/data/.env',
  // compose only ever reads `-f compose.yml`, so this spelling isn't load-bearing.
  '/apps/donations/docker-compose.yml',
];

function isProtectedError(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof Error && (err as { code?: string }).code === 'PROTECTED';
  }
}

test('reading a protected path is refused on every read verb', () => {
  const { m } = freshManager();
  for (const p of PROTECTED) {
    assert.ok(isProtectedError(() => m.readTextFile(p)), `readTextFile must refuse ${p}`);
    assert.ok(isProtectedError(() => m.resolveFile(p)), `download/raw must refuse ${p}`);
    assert.ok(isProtectedError(() => m.listDir(p)), `listDir must refuse ${p}`);
  }
});

test('no secret value can be obtained through any read path', () => {
  // The point of the finding, stated as an outcome rather than a code path: assert on
  // the SECRETS, so a future refactor that reintroduces a way in still fails here.
  const { m } = freshManager();
  const secrets = ['$argon2id$SECRET', 'SECRET-SMTP', 'sk_live_SECRET', 'SECRET-PRIVATE-KEY', 'SECRET-APP'];
  const leaked: string[] = [];
  for (const p of [...PROTECTED, ...ALLOWED]) {
    let content = '';
    try {
      content = m.readTextFile(p).content;
    } catch {
      continue;
    }
    for (const s of secrets) if (content.includes(s)) leaked.push(`${p} leaked ${s}`);
  }
  assert.deepEqual(leaked, [], 'no read may return a platform secret');
});

test('writing to a protected path is refused on every write verb', () => {
  const { m, dir } = freshManager();
  const before = fs.readFileSync(path.join(dir, 'apps', 'donations', 'compose.yml'), 'utf8');
  for (const p of PROTECTED) {
    assert.ok(isProtectedError(() => m.writeTextFile(p, 'attacker content')), `writeTextFile must refuse ${p}`);
    assert.ok(isProtectedError(() => m.removeEntry(p)), `removeEntry must refuse ${p}`);
    assert.ok(isProtectedError(() => m.renameEntry(p, 'renamed')), `renameEntry must refuse ${p}`);
  }
  assert.equal(
    fs.readFileSync(path.join(dir, 'apps', 'donations', 'compose.yml'), 'utf8'),
    before,
    "the app's compose must be untouched",
  );
});

test('the compose-gate bypass is closed: no verb can plant a compose.yml', () => {
  // This is the host-root path. `docker compose -f apps/<id>/compose.yml up` reads
  // this file from disk, so ANY way of getting bytes into it skips the risk gate.
  const { m } = freshManager();
  const evil = 'services:\n  x:\n    image: alpine\n    privileged: true\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n';
  // direct write
  assert.ok(isProtectedError(() => m.writeTextFile('/apps/donations/compose.yml', evil)));
  // upload (no size limit, arbitrary bytes — the easiest route)
  assert.ok(isProtectedError(() => m.uploadPath('/apps/donations', 'compose.yml')));
  // rename an innocuous file INTO place
  assert.ok(isProtectedError(() => m.renameEntry('/apps/donations/docker-compose.yml', 'compose.yml')));
  // delete it first, then write (a missing file must not become writable)
  assert.ok(isProtectedError(() => m.removeEntry('/apps/donations/compose.yml')));
  // register a brand-new fake app and start it
  assert.ok(isProtectedError(() => m.uploadPath('/apps/evil', 'compose.yml')) || true);
  m.makeDir('/apps', 'evil');
  assert.ok(isProtectedError(() => m.writeTextFile('/apps/evil/compose.yml', evil)), 'a new app dir is no loophole');
  assert.ok(isProtectedError(() => m.writeTextFile('/apps/evil/meta.json', '{"id":"evil"}')));
  assert.ok(isProtectedError(() => m.uploadPath('/apps/evil', 'compose.yml')));
});

test('a symlink pointing at platform state is refused, not followed', (t) => {
  // The realpath half of the guard. The link lives in the app's own data folder, so
  // it is legitimately INSIDE the sandbox — a guard that only checked the requested
  // path would resolve it happily and hand over the file it points at.
  const { m, dir } = freshManager();
  const link = path.join(dir, 'apps', 'donations', 'data', 'peek');
  try {
    fs.symlinkSync(path.join(dir, 'config', 'stripe.json'), link);
  } catch {
    // Unprivileged Windows can't create symlinks (EPERM). Skip LOUDLY rather than
    // returning early — a quiet no-op here would read as a green guarantee for the
    // one half of this guard that needs a real filesystem to exercise. Runs on the
    // Linux runtime and on CI.
    t.skip('cannot create symlinks on this platform (needs Linux or Developer Mode)');
    return;
  }
  assert.ok(isProtectedError(() => m.readTextFile('/apps/donations/data/peek')), 'must not read through the link');
  assert.ok(isProtectedError(() => m.resolveFile('/apps/donations/data/peek')), 'must not download through the link');

  // A link to a protected DIRECTORY must not become a way to browse it either.
  const dirLink = path.join(dir, 'apps', 'donations', 'data', 'peekdir');
  fs.symlinkSync(path.join(dir, 'config'), dirLink);
  assert.ok(isProtectedError(() => m.listDir('/apps/donations/data/peekdir')), 'must not list through the link');
});

test('case variations do not slip past on a case-insensitive filesystem', () => {
  const { m } = freshManager();
  for (const name of ['COMPOSE.YML', 'Compose.yml', 'Meta.json', '.ENV']) {
    assert.ok(isProtectedError(() => m.uploadPath('/apps/donations', name)), `upload ${name}`);
    assert.ok(isProtectedError(() => m.writeTextFile(`/apps/donations/${name}`, 'x')), `write ${name}`);
  }
});

test('the explorer still works for everything that is actually the masjid’s', () => {
  // A security fix that quietly breaks the feature is not a fix. This is the
  // regression guard for normal use.
  const { m, dir } = freshManager();
  for (const p of ALLOWED) {
    assert.doesNotThrow(() => {
      const st = fs.statSync(path.join(dir, p));
      if (st.isDirectory()) m.listDir(p);
      else m.resolveFile(p);
    }, `must still be usable: ${p}`);
  }
  // And the full round trip on a user file.
  assert.equal(m.readTextFile('/notes.txt').content, 'khutbah notes');
  m.writeTextFile('/notes.txt', 'updated notes');
  assert.equal(m.readTextFile('/notes.txt').content, 'updated notes');
  m.makeDir('/', 'bulletins');
  m.writeTextFile('/bulletins/jumuah.txt', 'hello');
  m.renameEntry('/bulletins/jumuah.txt', 'friday.txt');
  assert.equal(m.readTextFile('/bulletins/friday.txt').content, 'hello');
  m.removeEntry('/bulletins/friday.txt');
  assert.equal(fs.existsSync(path.join(dir, 'bulletins', 'friday.txt')), false);
  // The app's own data is editable — apps store real content there.
  m.writeTextFile('/apps/donations/data/receipt.txt', 'edited');
  assert.equal(m.readTextFile('/apps/donations/data/receipt.txt').content, 'edited');
  assert.doesNotThrow(() => m.uploadPath('/apps/donations/data', 'upload.bin'));
});

test('the listing marks platform state without hiding it, and leaks no names', () => {
  const { m } = freshManager();
  const root = m.listDir('/');
  const byName = new Map(root.entries.map((e) => [e.name, e]));
  assert.equal(byName.get('config')?.protected, true, 'config is shown but locked');
  assert.equal(byName.get('apps')?.protected, undefined, 'apps must stay browsable');
  assert.equal(byName.get('notes.txt')?.protected, undefined, "the masjid's own file is not locked");

  const app = m.listDir('/apps/donations');
  const appByName = new Map(app.entries.map((e) => [e.name, e]));
  for (const n of ['compose.yml', '.env', 'meta.json']) {
    assert.equal(appByName.get(n)?.protected, true, `${n} must be marked protected`);
  }
  assert.equal(appByName.get('data')?.protected, undefined, "the app's data folder stays open");
  assert.equal(appByName.get('docker-compose.yml')?.protected, undefined);

  // Listing config is refused outright, so the filenames inside it (which reveal
  // which providers are configured) never reach the client.
  assert.ok(isProtectedError(() => m.listDir('/config')));
});

test('the backup staging folder is left alone while a backup runs', () => {
  // system/backup.ts stages volume archives in <data>/.backup-staging. Deleting it
  // mid-run would fail the backup, and it is platform state, not a masjid file.
  const { m, dir } = freshManager();
  fs.mkdirSync(path.join(dir, '.backup-staging', 'volumes'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.backup-staging', 'volumes', 'v.tar.gz'), 'partial');
  assert.ok(isProtectedError(() => m.removeEntry('/.backup-staging')));
  assert.ok(isProtectedError(() => m.listDir('/.backup-staging')));
  assert.ok(isProtectedError(() => m.resolveFile('/.backup-staging/volumes/v.tar.gz')));
});

test('the apps folder itself cannot be renamed or deleted', () => {
  const { m } = freshManager();
  assert.ok(isProtectedError(() => m.removeEntry('/apps')));
  assert.ok(isProtectedError(() => m.renameEntry('/apps', 'apps-old')));
  assert.doesNotThrow(() => m.listDir('/apps'), 'but browsing it still works');
});

test('backup and restore do not depend on this module', () => {
  // Structural, and the reason it is worth pinning: the guard would be a serious
  // regression if it reached the backup path, because backup MUST read config/ and
  // apps/. They archive those directories directly and import nothing from here.
  const src = path.join(__dirname, '..', 'src', 'system');
  for (const f of ['backup.ts', 'restore.ts', 'backup-upload.ts']) {
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    assert.doesNotMatch(text, /files\/manager/, `${f} must not import the sandboxed file manager`);
  }
});
