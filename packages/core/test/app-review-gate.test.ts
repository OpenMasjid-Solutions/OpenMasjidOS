// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A restored app must not start until a human has agreed to what it asks for.
 *
 * THE HOLE THIS CLOSES. `CLAUDE.md` §15 said the ungated `startApp` was
 * acceptable "because every *write* vector into that file is closed:
 * install/update/restore all pass the gate." Restore did not. `system/restore.ts`
 * `rmSync`s `apps/` and `renameSync`s the archive's tree straight into place with
 * NO gate on the write. The gate ran only afterwards, in `reupAllApps`, which
 * correctly declined to auto-start a dangerous stack, printed
 * `(not started — needs review: …)` into the restore stream — and then threw the
 * verdict away. `AppMeta` had nowhere to put it.
 *
 * So once the restore window closed, an app carrying `privileged: true` smuggled
 * in via a handed-over backup was an ordinary Stopped card with a Start button.
 * The core runs as root with the Docker socket, so pressing it was host root,
 * with no warning at the moment of the click. The same ungated entry was reachable
 * from `!os start` over WhatsApp and from the exposure toggle.
 *
 * That is this codebase's own documented failure mode twice over: a guard that
 * computed the right answer and acted on it nowhere, and a containment argument
 * in the docs that was false — which is what stopped anyone re-examining it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-review-'));

const req = createRequire(__filename);
const manager = req('../src/apps/manager') as typeof import('../src/apps/manager');
const config = req('../src/config') as typeof import('../src/config');

const SRC = path.join(__dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/**
 * Strip comments before matching source. A structural test that reads prose is
 * satisfied by writing the right words in a comment, which is precisely the kind
 * of guard-that-does-nothing this file exists to prevent.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The body of a top-level function, up to the next top-level declaration. */
function fnBody(text: string, signature: string): string {
  const src = code(text);
  const at = src.indexOf(signature);
  assert.notEqual(at, -1, `could not find ${signature}`);
  const rest = src.slice(at + signature.length);
  const end = rest.search(/\nexport (async )?function |\nexport class |\nexport const /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Lay down an app on disk with the given compose text. */
function seed(id: string, compose: string): void {
  const dir = path.join(config.APPS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yml'), compose, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id, name: id, kind: 'catalog', createdAt: new Date().toISOString() }),
    'utf8',
  );
}

const readMeta = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(config.APPS_DIR, id, 'meta.json'), 'utf8'));

const SAFE = 'services:\n  app:\n    image: nginx:1.27\n    ports: ["8080:80"]\n';
const DANGEROUS = 'services:\n  app:\n    image: nginx:1.27\n    privileged: true\n';
/** Reaches into another app's data — a refusal, never acknowledgeable. */
const REFUSING =
  'services:\n  app:\n    image: nginx:1.27\n    volumes: ["other:/data"]\nvolumes:\n  other:\n    external: true\n    name: omos-donations_data\n';

// ── The verdict is PERSISTED, not printed and forgotten ────────────────────

test('a dangerous restored compose is recorded on the app, not just logged', () => {
  seed('danger-app', DANGEROUS);
  const review = manager.reviewCompose('danger-app');

  assert.ok(review, 'the gate must object to privileged: true');
  assert.equal(review.kind, 'danger', 'privileged is a danger, not a refusal');
  assert.match(review.reasons[0], /privileged/i);

  // The whole bug: this survives the restore stream closing.
  assert.ok(readMeta('danger-app').review, 'the verdict must reach meta.json');
  assert.deepEqual(manager.startBlockedReason('danger-app')?.reasons, review.reasons);
});

test('EVERY finding is recorded, not just the first', () => {
  // The tickbox says "I understand the risk". Showing one of several findings
  // collects consent for a fraction of what the app actually asked for.
  seed(
    'many-app',
    'services:\n  app:\n    image: nginx:1.27\n    privileged: true\n    network_mode: host\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n',
  );
  const review = manager.reviewCompose('many-app');
  assert.ok(review);
  assert.ok(review.reasons.length >= 2, `expected several findings, got ${review.reasons.length}`);
  assert.deepEqual(readMeta('many-app').review.reasons, review.reasons, 'all of them persisted');
});

test('a safe compose records nothing, and CLEARS a stale hold', () => {
  seed('safe-app', DANGEROUS);
  manager.reviewCompose('safe-app');
  assert.ok(manager.startBlockedReason('safe-app'), 'held first');

  // An admin who fixes the compose (or updates the app) must not stay locked out.
  fs.writeFileSync(path.join(config.APPS_DIR, 'safe-app', 'compose.yml'), SAFE, 'utf8');
  assert.equal(manager.reviewCompose('safe-app'), null);
  assert.equal(manager.startBlockedReason('safe-app'), null);
  assert.equal(readMeta('safe-app').review, undefined);
});

test('a compose we cannot even read is held, never waved through', () => {
  // "Couldn't ask" is not "there is nothing there" (§15). An unparseable file
  // must not be the one input that skips the gate.
  seed('broken-app', 'services: [this: is not: valid yaml\n  - {{{\n');
  const review = manager.reviewCompose('broken-app');
  assert.ok(review, 'an unreadable compose must block');
  assert.equal(review.kind, 'unreadable', 'and is reported as unchecked, not as a known danger');
});

// ── meta.json must NEVER be able to switch the gate off ────────────────────

test('an unparseable meta.json HOLDS the app — it does not disable the check', () => {
  // THE REGRESSION THIS PINS. The first cut of `reviewCompose` opened with
  // `const meta = loadMeta(id); if (!meta) return null;` — so a single bad byte
  // in meta.json, which arrives in the SAME attacker-supplied backup as the
  // compose, produced "no finding" and `reupAllApps` then went on to START the
  // privileged stack. That is strictly worse than the hole being closed here.
  seed('badmeta-app', DANGEROUS);
  fs.writeFileSync(path.join(config.APPS_DIR, 'badmeta-app', 'meta.json'), '{', 'utf8');

  const review = manager.reviewCompose('badmeta-app');
  assert.ok(review, 'the compose must still be checked');
  assert.match(review.reasons.join(' '), /privileged/i, 'and the real finding reported');

  // The manual Start path has to fail closed on the same input.
  const held = manager.startBlockedReason('badmeta-app');
  assert.ok(held, 'startBlockedReason must not read a corrupt record as "nothing wrong"');
});

test('a pre-seeded verdict cannot downgrade a refusal into a tickbox', () => {
  // meta.json comes out of the backup, so an attacker can write the review
  // record too. Comparing only the reason TEXT meant a crafted
  // `kind: 'danger'` with a matching string survived a genuine refusal — and a
  // refusal that presents as a danger is one the admin is offered a way to
  // agree to. The computed verdict must always win.
  seed('downgrade-app', REFUSING);
  const real = manager.reviewCompose('downgrade-app');
  assert.equal(real?.kind, 'refusal');

  const meta = readMeta('downgrade-app');
  meta.review = { kind: 'danger', reasons: real.reasons, at: real.at };
  fs.writeFileSync(path.join(config.APPS_DIR, 'downgrade-app', 'meta.json'), JSON.stringify(meta), 'utf8');

  manager.reviewCompose('downgrade-app');
  assert.equal(readMeta('downgrade-app').review.kind, 'refusal', 'the real kind is restored');
  assert.equal(manager.startBlockedReason('downgrade-app')?.kind, 'refusal');
});

test('an app with no gate objection is left alone (the grandfathered default)', () => {
  seed('plain-app', SAFE);
  assert.equal(manager.reviewCompose('plain-app'), null);
  assert.equal(manager.startBlockedReason('plain-app'), null);
});

// ── Start refuses until someone agrees ─────────────────────────────────────

test('startApp refuses a held app, and the error carries the reason', async () => {
  seed('held-app', DANGEROUS);
  manager.reviewCompose('held-app');

  await assert.rejects(
    () => manager.startApp('held-app'),
    (err: Error) => {
      assert.ok(err instanceof manager.AppNeedsReviewError, 'must be the typed error');
      assert.match(err.message, /privileged/i, 'the admin is told what it asked for');
      return true;
    },
  );
  // Still held — a refused start must not quietly consume the hold.
  assert.ok(manager.startBlockedReason('held-app'));
});

test('an explicit acknowledgement frees the app, and is recorded once', () => {
  seed('ack-app', DANGEROUS);
  manager.reviewCompose('ack-app');
  assert.ok(manager.startBlockedReason('ack-app'));

  manager.acknowledgeReview('ack-app');
  assert.equal(manager.startBlockedReason('ack-app'), null, 'consent clears the hold');
  assert.equal(readMeta('ack-app').review, undefined, 'and it is persisted');
});

// ── Refusals are NEVER acknowledgeable ─────────────────────────────────────

test('a refusal cannot be agreed away, however emphatically', async () => {
  // Attaching to another app's omos-* volume can never have passed install
  // legitimately, so unlike a `danger` there is no "I understand" path.
  seed('refusal-app', REFUSING);
  const review = manager.reviewCompose('refusal-app');
  assert.ok(review, 'the gate must refuse another app’s volume');
  assert.equal(review.kind, 'refusal', 'this must be classified as a refusal');

  assert.throws(() => manager.acknowledgeReview('refusal-app'), manager.AppNeedsReviewError);
  // Even WITH the acknowledgement, start is refused.
  await assert.rejects(() => manager.startApp('refusal-app', true), manager.AppNeedsReviewError);
  assert.ok(manager.startBlockedReason('refusal-app'), 'and the hold survives');
});

// ── "Restart" is a start path too ──────────────────────────────────────────

test('restartApp refuses a held app — `!os restart` is not a way round `!os start`', async () => {
  // `docker compose restart` starts a STOPPED container, so guarding only
  // startApp left the neighbouring verb able to run a held app — from the very
  // phone that is deliberately not allowed to consent to one.
  seed('restart-app', DANGEROUS);
  manager.reviewCompose('restart-app');
  await assert.rejects(() => manager.restartApp('restart-app'), manager.AppNeedsReviewError);
  assert.ok(manager.startBlockedReason('restart-app'), 'and the hold survives');
});

test('stopApp is deliberately NOT guarded', () => {
  // Stopping a held app is exactly what an admin should be able to do, and a
  // guard here would strand containers left running from before a restore.
  const body = fnBody(read('apps', 'manager.ts'), 'export async function stopApp(');
  assert.doesNotMatch(body, /startBlockedReason/, 'stop must stay available');
});

// ── Structural: the guard lives at the choke point, not at the call sites ──

test('startApp itself consults the guard, BEFORE it composes anything', () => {
  const body = fnBody(read('apps', 'manager.ts'), 'export async function startApp(');
  const guard = body.indexOf('startBlockedReason');
  const up = body.indexOf('composeUp');
  const start = body.indexOf('composeStart');

  assert.notEqual(guard, -1, 'startApp must ask startBlockedReason');
  assert.ok(guard < up && guard < start, 'the check must precede BOTH compose paths');
  assert.match(body, /AppNeedsReviewError/, 'and refuse by throwing the typed error');
});

test('reupAllApps PERSISTS the verdict AND acts on it', () => {
  const body = fnBody(read('apps', 'manager.ts'), 'export async function reupAllApps(');
  assert.match(body, /reviewCompose\(/, 'restore must record the verdict');
  assert.doesNotMatch(
    body,
    /checkCompose\(/,
    'an inline checkCompose here is the original bug: the result went nowhere',
  );
  // Recording it is only half of it. The original bug was a verdict that was
  // computed and then not acted on, so assert the skip as well — otherwise the
  // exact bug can be reintroduced with this test still green.
  const at = body.indexOf('reviewCompose(');
  const rest = body.slice(at);
  assert.match(rest, /if \(review\)[\s\S]{0,200}continue;/, 'a held app must be skipped');
  assert.ok(rest.indexOf('continue;') < rest.indexOf('composeUp'), 'and skipped BEFORE composeUp');
  // One bad app must not disarm the gate for every app after it: an unexpected
  // throw here used to abort the loop, leaving every later app unreviewed.
  assert.match(
    body,
    /try \{\s*review = reviewCompose\(id\);\s*\} catch/,
    'each app’s review needs its own try/catch',
  );
});

test('reviewCompose reads the compose BEFORE it touches meta.json', () => {
  // meta.json arrives in the same backup as the compose, so letting it decide
  // whether the gate runs is an attacker-controlled off switch.
  const body = fnBody(read('apps', 'manager.ts'), 'export function reviewCompose(');
  assert.ok(
    body.indexOf('checkCompose(') < body.indexOf('loadMeta('),
    'the verdict must not depend on a file the attacker supplies',
  );
});

test('startBlockedReason fails closed on a corrupt record', () => {
  const body = fnBody(read('apps', 'manager.ts'), 'export function startBlockedReason(');
  assert.match(body, /existsSync\(metaPath\(id\)\)/, 'present-but-unparseable is distinguished');
  assert.match(body, /unreadableMeta\(/, 'and held rather than waved through');
});

test('WhatsApp can never acknowledge a held app', () => {
  // Possession of a phone already authorises a lot (§13.2b-iii). Agreeing to a
  // privileged compose on a root daemon holding the Docker socket is not on that
  // list — `!os start` must pass no acknowledgement and point at the dashboard.
  const src = code(read('commands', 'execute.ts'));
  // `restartApp(target.id)` CONTAINS the substring `startApp(target.id)`, so a
  // plain match here passes even once a consent flag is added — which is what
  // the first cut of this test did, making it a guard that could never fire on
  // the one file where consent must never appear. Anchor on the call itself.
  const calls = [...src.matchAll(/(?<![A-Za-z])startApp\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(calls, ['target.id'], 'startApp is called once here, with no consent flag');
  assert.doesNotMatch(src, /acknowledgeRisk/, 'and must never grow one');
  assert.doesNotMatch(src, /acknowledgeReview/, 'nor reach past startApp to clear the hold');
  assert.match(src, /AppNeedsReviewError/, 'it reports the hold rather than a generic failure');
});

test('the dashboard route maps a hold to a question, not a server error', () => {
  const src = code(read('trpc', 'routers', 'apps.ts'));
  assert.match(src, /AppNeedsReviewError/);
  assert.match(src, /PRECONDITION_FAILED/, 'an acknowledgeable danger asks the admin');
  assert.match(src, /FORBIDDEN/, 'a refusal is simply refused');
  assert.match(src, /acknowledgeRisk/, 'and the consent reaches startApp');
});

test('a successful update clears the hold', () => {
  // The update path rewrites compose.yml from fresh catalogue data and re-runs
  // the gate, so a hold against the file it replaced no longer describes
  // anything on disk. Leaving it would make "update the app" the one fix an
  // admin cannot apply.
  const body = fnBody(read('apps', 'manager.ts'), 'async function updateCatalogAppInner(');
  assert.match(body, /review: undefined/, 'updateCatalogApp must clear the hold');
});

test('the UI never offers consent for a refusal', () => {
  // A dialog whose only enabled action is guaranteed to fail leaves the admin
  // in a loop with nothing saying the app can never start.
  const dlg = code(fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'src', 'components', 'AppReviewDialog.tsx'), 'utf8'));
  assert.match(dlg, /kind === 'refusal'/, 'the dialog must branch on the refusal');
  const at = dlg.indexOf('refused ?');
  assert.notEqual(at, -1, 'and render a refused branch');
  // The tickbox and the danger confirm must sit in the NON-refused arm.
  const refusedArm = dlg.slice(at, dlg.indexOf(') : ('));
  assert.doesNotMatch(refusedArm, /type="checkbox"/, 'no tickbox for a refusal');
  assert.doesNotMatch(refusedArm, /onConfirm/, 'and no way to confirm it');
});

test('the hold is on the row the dashboard already renders', () => {
  // If it were not in the DTO, the card could not warn before the click.
  const src = code(read('apps', 'manager.ts'));
  assert.match(src, /review: meta\.review \?\? null/, 'installed apps carry their hold');
  assert.match(src, /review: null/, 'recovered orphans are explicitly un-held');
});
