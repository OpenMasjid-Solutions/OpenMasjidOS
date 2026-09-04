// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Regressions from the 2026-08-30 full audit.
 *
 * Each test here pins one confirmed finding. They are grouped by the thing that
 * would break rather than by file, because the common shape of these bugs is "a
 * guard that reads correctly and does nothing" — an unreachable `catch`, a counter
 * that can never reset, a comment describing a check that was never written. Those
 * survive review precisely because the code LOOKS right, so the assertions below
 * aim at the observable consequence instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const UI = path.join(__dirname, '..', '..', 'ui', 'src');
const readUi = (...p: string[]) => fs.readFileSync(path.join(UI, ...p), 'utf8');

// ── the File Explorer sandbox ───────────────────────────────────────────────

type Mgr = typeof import('../src/files/manager');

function freshManager(): { m: Mgr; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-audit-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'auth.json'), '{"passwordHash":"SECRET"}');
  // The CORE's own compose — the file the installer rewrites and docker runs as root.
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n  core:\n    image: openmasjid/core\n');
  fs.mkdirSync(path.join(dir, 'apps', 'donations', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps', 'donations', 'compose.yml'), 'services:\n  app:\n    image: x\n');
  fs.writeFileSync(path.join(dir, 'apps', 'donations', 'meta.json'), '{"id":"donations"}');
  fs.writeFileSync(path.join(dir, 'apps', 'donations', 'data', 'receipt.txt'), 'a masjid file');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'khutbah notes');

  process.env.OPENMASJID_DATA_DIR = dir;
  for (const mod of ['../src/config', '../src/files/manager']) delete req.cache[req.resolve(mod)];
  return { m: req('../src/files/manager') as Mgr, dir };
}

test("THE CORE'S OWN COMPOSE IS PROTECTED — it sits at the sandbox root, not under apps/", () => {
  // OPENMASJIDOS-004 protected `apps/<id>/compose.yml` and left this one open. It
  // defines the container running as root with the Docker socket and the whole data
  // directory mounted, the installer's Repair rewrites it, and Update recreates from
  // it — so an edit here is executed with full host privilege and never passes
  // apps/compose-validate.ts, which only ever sees app composes.
  const { m } = freshManager();
  for (const verb of [
    () => m.readTextFile('/docker-compose.yml'),
    () => m.writeTextFile('/docker-compose.yml', 'services:\n  evil:\n    privileged: true\n'),
    () => m.removeEntry('/docker-compose.yml'),
    () => m.renameEntry('/docker-compose.yml', 'moved.yml'),
  ]) {
    assert.throws(verb, /PROTECTED|private/i, 'the core compose must be refused');
  }
  // And renaming something else ONTO it must not work either.
  assert.throws(() => m.renameEntry('/notes.txt', 'docker-compose.yml'), /PROTECTED|private/i);
});

test("AN APP'S FOLDER CANNOT BE DELETED OR RENAMED, but stays browsable", () => {
  // Refusing compose.yml, .env and meta.json one at a time while allowing their
  // parent to be removed wholesale is not a sandbox.
  const { m } = freshManager();
  assert.throws(() => m.removeEntry('/apps/donations'), /removed or renamed/i);
  assert.throws(() => m.renameEntry('/apps/donations', 'elsewhere'), /removed or renamed/i);

  // Still a file explorer: listing the folder and using the app's own data works.
  assert.doesNotThrow(() => m.listDir('/apps/donations'));
  assert.doesNotThrow(() => m.listDir('/apps/donations/data'));
  assert.equal(m.readTextFile('/apps/donations/data/receipt.txt').content, 'a masjid file');
  assert.doesNotThrow(() => m.removeEntry('/apps/donations/data/receipt.txt'));
});

// ── the reverse proxies ─────────────────────────────────────────────────────

test('A WEBSOCKET UPGRADE TO A NON-APP PATH IS CLOSED, never abandoned', () => {
  // `return` left the socket with no response and no close, held open until the peer
  // gave up — and the peer chooses. On the tunnel-facing front door that is an
  // unauthenticated file-descriptor exhaustion lever against a root daemon.
  const src = read('system', 'ingress.ts');
  const handler = src.slice(src.indexOf("front.server.on('upgrade'"));
  // Scoped to the NOT-AN-APP branch alone. A slice reaching as far as the fabric
  // refusal below it would pass on that branch's own (legitimate) socket.destroy()
  // and never notice this one had gone back to a bare return.
  const notAnApp = handler.slice(
    handler.indexOf('if (port == null)'),
    handler.indexOf('isFabricSubpath'),
  );
  assert.ok(notAnApp.length > 0, 'located the non-app branch');
  assert.match(notAnApp, /socket\.destroy\(\)/, 'the non-app branch must destroy the socket');
  assert.doesNotMatch(
    notAnApp,
    /if \(port == null\) return;/,
    'a bare return here leaks the connection',
  );
});

test('spoofable client-IP headers are stripped on EVERY proxy path', () => {
  // Four separate lists, and a header missed in one of them is relayed verbatim to
  // an app that then logs and rate-limits by the caller's own choice.
  for (const [label, src] of [
    ['ingress', read('system', 'ingress.ts')],
    ['app-proxy', read('system', 'app-proxy.ts')],
  ] as const) {
    for (const header of ['x-real-ip', 'true-client-ip', 'cf-connecting-ip']) {
      const count = [...src.matchAll(new RegExp(`'${header}'`, 'g'))].length;
      assert.ok(count >= 2, `${label}: '${header}' must appear in BOTH the HTTP and WebSocket lists`);
    }
  }
});

// ── trust must not be self-asserted ─────────────────────────────────────────

test("AN ORPHANED APP CANNOT PROMOTE ITSELF with its own Docker label", () => {
  // `com.openmasjid.kind` is only ever READ — nothing in the platform writes one — so
  // a label being present means the app's own compose set it, and compose-validate
  // never inspects `labels:`. Honouring it made an unvetted stack "Official" and
  // flipped its default tunnel exposure to public.
  const src = read('apps', 'manager.ts');
  const recovery = src.slice(src.indexOf('2. Running/known projects without metadata'));
  const block = recovery
    .slice(0, recovery.indexOf('saveMeta(recovered)'))
    // Drop comment lines before matching. The explanation of WHY the label is not
    // trusted has to name it, so a prose match would fail on the fix itself.
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(block, /disc\.kind/, 'recovery must not read the app-supplied kind label');
  assert.match(block, /kind: 'custom'/, 'an unvetted app is Custom');
  assert.match(block, /exposed: false/, 'and must not be published to the internet unreviewed');
});

test('a reserved id that gets its directory deleted is also refused at install', () => {
  // `cloudflared` is in RESERVED_APP_IDS, whose members have their app directory
  // rmSync'd on every listInstalled(). Without a matching refusal at install, a
  // catalog entry with that id installs fine and then has its compose, its .env (with
  // its Fabric secret) and its meta.json deleted under a running container.
  const src = read('apps', 'manager.ts');
  const words = src.slice(src.indexOf('const RESERVED_ID_WORDS'), src.indexOf('export function isReservedAppId'));
  assert.match(words, /'cloudflared'/, 'cloudflared must be refused at install');
});

test('the app-to-app broker bounds UNAUTHENTICATED work', () => {
  // The per-caller limiter keys on caller.id, which only exists after a secret is
  // accepted — so it bounded a misbehaving app and nothing else. Every wrong secret
  // still costs a constant-time compare against every registered app.
  const src = read('fabric', 'appLink.ts');
  const ipGate = src.indexOf('ipRateOk(');
  const auth = src.indexOf('deps.resolveCaller(');
  assert.ok(ipGate > 0, 'a per-source limiter must exist');
  assert.ok(ipGate < auth, 'and must run BEFORE authentication, or it bounds nothing');
});

// ── "could not ask" is never an answer ──────────────────────────────────────

test('A FAILED UPDATE CHECK DOES NOT CLEAR THE ALERT DEDUPE', () => {
  // checkForUpdate() swallows a failed fetch and returns latest:null rather than
  // throwing, so the catch could never see an offline check and the else-branch read
  // "the internet was down" as "there is no update" — re-emailing the admin about the
  // same version on every recovery.
  const src = read('system', 'update-monitor.ts');
  const core = src.slice(src.indexOf('async function checkCore'), src.indexOf('async function checkApps'));
  assert.match(core, /else if \(u\.latest != null\)/, 'only a successful check may clear the dedupe');
});

test('stale auth failures cannot veto WhatsApp recovery for ever', () => {
  // authFailures resets only on a successful send, and a confirmed incident PAUSES
  // the queue — so once it tripped, assess() could never return alive again and the
  // admin's release was undone on the next tick.
  const src = read('system', 'whatsapp-monitor.ts');
  assert.match(src, /AUTH_FAILS_WINDOW_MS/, 'the counter must be time-bounded');
  const assess = src.slice(src.indexOf('async function assess'));
  assert.match(
    assess.slice(0, 900),
    /authFailsAreCurrent/,
    'the evidence check must consider how recent the failures are',
  );
});

test('a negative contacts/check answer expires, and the cache is bounded', () => {
  // A permanent negative meant a family who joined WhatsApp later was refused for the
  // life of the process, and the map grew one entry per distinct recipient for ever.
  const src = read('notify', 'whatsapp.ts');
  assert.match(src, /CONTACT_NEGATIVE_TTL_MS/, 'negative answers must expire');
  assert.match(src, /CONTACT_CACHE_MAX/, 'and the cache must be bounded');
  const remember = src.slice(src.indexOf('function rememberRegistration'));
  assert.match(remember.slice(0, 400), /onWhatsApp\.delete/, 'the bound must actually evict');
});

test('a command attempt from an unlisted number is logged — silently, but logged', () => {
  // noteStrangerAttempt existed, was documented as "called by the executor", and had
  // no callers at all — so someone probing a masjid's server with `!os` left no trace
  // anywhere. Still no reply, ever; only a rate-limited line in the masjid's own log.
  const inbound = read('notify', 'whatsapp-inbound.ts');
  const unknown = inbound.slice(inbound.indexOf("case 'unknown-sender'"));
  assert.match(unknown.slice(0, 700), /noteStrangerAttempt\(/, 'the log must actually be reached');
  const gate = read('commands', 'gate.ts');
  assert.match(gate, /prefixed: body\.startsWith\(COMMAND_PREFIX\)/, 'the gate must surface it');
  // And it must stay a silent drop: an unlisted sender never gets a reply.
  assert.doesNotMatch(unknown.slice(0, 700), /handler\(/, 'a stranger must never be answered');
});

// ── the dashboard ───────────────────────────────────────────────────────────

test('MODALS PAINT ABOVE WINDOWS, not behind them', () => {
  // Windows render at 110 + index and the modal backdrop sat at 100, so a
  // confirmation or install dialog opened over a log or terminal window rendered
  // behind it: the backdrop dimmed, nothing appeared, and the app looked frozen.
  const css = readUi('styles', 'app.css');
  const backdrop = css.slice(css.indexOf('.modal-backdrop {'));
  const z = /z-index:\s*(\d+)/.exec(backdrop.slice(0, 200));
  assert.ok(z, '.modal-backdrop must set a z-index');
  const modalZ = Number(z![1]);
  const wm = readUi('components', 'WindowManager.tsx');
  const band = /zIndex=\{(\d+) \+ i\}/.exec(wm);
  assert.ok(band, 'the window band must be a numeric base + index');
  assert.ok(
    modalZ > Number(band![1]) + 100,
    `modal z-index ${modalZ} must clear the window band starting at ${band![1]}`,
  );
});

test('one Escape closes one thing', () => {
  // Two independent window-level keydown listeners both acted on the same Escape, so
  // dismissing a dialog also closed the log window behind it.
  const wm = readUi('components', 'WindowManager.tsx');
  assert.match(wm, /anyModalOpen\(\)/, 'the window manager must defer to an open dialog');
  const modal = readUi('components', 'Modal.tsx');
  assert.match(modal, /export function anyModalOpen/, 'and the modal must publish that state');
  // Locked modals must COUNT. A locked dialog ignores its own Escape deliberately
  // (an update is running), and that keypress must not fall through to the window
  // manager — the one thing Escape must never do mid-update is close the window
  // showing the progress. So the counting effect keys on `open` alone.
  const start = modal.indexOf('  useEffect(() => {');
  const counter = modal.slice(start, modal.indexOf('}, [open]);', start));
  assert.ok(counter.includes('openModals += 1'), 'located the counting effect');
  assert.doesNotMatch(counter, /locked/, 'the counter must not skip locked modals');
});

test('the file rename editor is not nested inside a button', () => {
  // An <input> and two <button>s inside a <button> is invalid HTML, and browsers do
  // not reliably focus interactive content inside a button — the confirm and cancel
  // controls were unreachable by keyboard.
  const src = readUi('routes', 'Files.tsx');
  const row = src.slice(src.indexOf('className="file-list"'), src.indexOf('className="file-size"'));
  const openButton = row.slice(row.indexOf('<button\n                    className="file-main"'));
  assert.doesNotMatch(openButton, /<input/, 'no input inside the open-button');
  assert.match(row, /<div className="file-main"/, 'the editor is a sibling div');
});

test('no user-facing aria-label is hardcoded English', () => {
  // CLAUDE.md §15: every user-facing string goes through i18next. A missing key then
  // fails i18n-keys.test.ts instead of shipping raw text.
  for (const f of [
    ['components', 'WindowManager.tsx'],
    ['components', 'Clock.tsx'],
    ['routes', 'Files.tsx'],
  ] as const) {
    const src = readUi(...f);
    const hard = [...src.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hard, [], `${f.join('/')}: aria-labels must go through t()`);
  }
});
