// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * One update at a time.
 *
 * Nothing stopped two updates of the same thing running at once: every WebSocket
 * connection to `/api/update` started a fresh core update, and every connection to
 * `/api/apps/update?id=…` a fresh app update. So closing the progress window and pressing
 * the button again ran a SECOND update over the first — two
 * `docker compose up -d --force-recreate` runs racing for one container, with two writers
 * rewriting the same compose file underneath them. A masjid reported the result: the box
 * stopped coming back at all.
 *
 * The dialog is locked while an update runs, but that is the second line of defence. A
 * browser can be closed, a laptop can sleep, a phone can lose wifi — a guarantee that
 * depends on the user not clicking is not a guarantee, so the lock lives on the server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const lock = req('../src/system/update-lock') as typeof import('../src/system/update-lock');

function codeOf(rel: string): string {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const never = () => new Promise<void>(() => {}); // a job that never settles

test('a second update of the same thing is refused, not run alongside', async () => {
  let released = () => {};
  const held = new Promise<void>((r) => (released = r));
  const first = lock.withUpdateLock('core', 'busy', () => held);

  assert.equal(lock.isUpdating('core'), true);
  await assert.rejects(() => lock.withUpdateLock('core', 'busy', never), /busy/);

  released();
  await first;
  assert.equal(lock.isUpdating('core'), false, 'the lock must be released when the work finishes');
});

test('the lock is per app, so two different apps still update in parallel', async () => {
  let releaseA = () => {};
  const a = lock.withUpdateLock('app:students', 'busy', () => new Promise<void>((r) => (releaseA = r)));
  // A different app must not be blocked by the first.
  await lock.withUpdateLock('app:donations', 'busy', async () => {});
  releaseA();
  await a;
});

test('a failed update releases the lock, so it can be retried', async () => {
  await assert.rejects(() =>
    lock.withUpdateLock('core', 'busy', async () => {
      throw new Error('pull failed');
    }),
  );
  assert.equal(lock.isUpdating('core'), false, 'a failure must not wedge the lock for ever');
  // Provable: the next attempt gets in.
  await lock.withUpdateLock('core', 'busy', async () => {});
});

test('both update entry points take the lock', () => {
  // If either one is left unlocked, the other's guard does not help — the two race paths
  // are the core updater and the per-app updater.
  assert.match(codeOf('core/src/docker/update.ts'), /withUpdateLock\('core'/, 'the core updater must lock');
  assert.match(codeOf('core/src/apps/manager.ts'), /withUpdateLock\(`app:\$\{id\}`/, 'the app updater must lock');
});

test('"already running" is reported as information, never as a failure', () => {
  // Calling it a failure pushes an admin into retrying, which is the exact action the
  // lock exists to prevent.
  for (const rel of ['core/src/api/update.ts', 'core/src/api/app-update.ts']) {
    const src = codeOf(rel);
    const at = src.indexOf("name === 'UpdateBusyError'");
    assert.ok(at > 0, `${rel} must handle the busy case`);
    const branch = src.slice(at, at + 200);
    assert.doesNotMatch(branch.split('} else')[0], /Update failed/, `${rel} must not call it a failure`);
  }
});

test('the update dialog and window cannot be dismissed while running', () => {
  const modal = codeOf('ui/src/components/Modal.tsx');
  // RE-PINNED against the Radix implementation (v0.51.2-dev.5). Same three
  // guarantees, different mechanism: the hand-rolled backdrop onClick and the
  // window keydown listener are gone, and Radix owns both dismissal routes.
  //
  // `onOpenChange` is the funnel every close passes through, so the `!locked`
  // guard there is the backstop. The two preventDefaults stop Radix deciding to
  // close in the first place: onInteractOutside covers pointer-down-outside and
  // focus-outside, onEscapeKeyDown covers the key.
  assert.match(
    modal,
    /if \(!next && !locked\) onClose\(\)/,
    'no close path may fire while locked',
  );
  assert.match(
    modal,
    /onEscapeKeyDown=\{locked \? refuse : undefined\}/,
    'Escape must not close a locked dialog',
  );
  assert.match(
    modal,
    /onInteractOutside=\{locked \? refuse : undefined\}/,
    'an outside click must not close a locked dialog',
  );
  assert.match(modal, /const refuse = \(e: Event\) => e\.preventDefault\(\)/, 'and refuse must preventDefault');
  assert.match(modal, /\{!locked && \(/, 'the X must be absent while locked');

  // `modal={false}` must never appear. It is the obvious-looking way to keep our
  // own backdrop when this component moves onto Radix Dialog, and it silently
  // removes the FOCUS TRAP as well — which is not a nicety here, it is the other
  // half of the lock. Nothing in this UI traps focus today (three autoFocus hits,
  // zero tabIndex, zero inert), so while a locked update dialog is up, Tab walks
  // out to the Dock's NavLink; Enter then changes route, unmounts the page, and
  // takes the locked dialog with it — mid core update, the exact thing `locked`
  // exists to prevent. Passing `modal={false}` also makes Radix render no overlay
  // at all. The lock must come from controlled `open` plus preventDefault on the
  // dismissal handlers, never from turning modality off.
  // The lookbehind matters: `\bmodal=` also matches inside `aria-modal="true"`,
  // because a hyphen counts as a word boundary. Same trap that turned
  // `slide-in-from-left-2` into a non-existent class earlier in this migration.
  assert.doesNotMatch(modal, /(?<![-\w])modal=/, 'Modal must never pass Radix a `modal` prop');

  // The core updater locks while it runs and while the core restarts — and only then: an
  // update that changed nothing ends at once ('unchanged'), with nothing to wait for.
  assert.match(
    codeOf('ui/src/components/UpdateModal.tsx'),
    /locked=\{phase === 'running' \|\| phase === 'restarting'\}/,
  );

  // App updates open in a window instead, and both launchers must lock it.
  for (const rel of ['ui/src/components/AppCard.tsx', 'ui/src/routes/Dashboard.tsx']) {
    assert.match(codeOf(rel), /locked: true/, `${rel} must open the update window locked`);
    assert.match(codeOf(rel), /setLocked\(winId, false\)/, `${rel} must release it when done`);
  }
  // And the manager itself refuses close() for a locked window, so the Escape handler and
  // any future caller are covered by one rule rather than one check per entry point.
  assert.match(codeOf('ui/src/components/Windows.tsx'), /\?\.locked \? list :/);
});

test('A CORE UPDATE, A RESTORE AND AN APP UPDATE NEVER OVERLAP — the first two each end by replacing the core', async () => {
  // Two locks, 'core' and 'restore', that never looked at each other: a review pressed
  // Update 300 ms into a restore and the update's helper replaced the core while the
  // restore was still refilling app data — cutting it off part-way, every app left
  // stopped, a database half put back. An app update during either is cut off with the
  // core, or recreates its container over data being replaced.
  const cases = [
    ['restore', 'core', /^A backup is being restored right now\. Please update OpenMasjidOS once it has finished\. Nothing was changed\.$/],
    ['core', 'restore', /^OpenMasjidOS is being updated right now\. Please restore your backup once it has finished\./],
    ['restore', 'app:students', /^A backup is being restored right now\. Please update this app once it has finished\./],
    ['app:students', 'restore', /^An app is being updated right now\. Please restore your backup once it has finished\./],
    ['core', 'app:students', /^OpenMasjidOS is being updated right now\. Please update this app once it has finished\./],
    ['app:students', 'core', /^An app is being updated right now\. Please update OpenMasjidOS once it has finished\./],
  ] as const;
  for (const [first, second, says] of cases) {
    let release = () => {};
    const held = lock.withUpdateLock(first, 'busy', () => new Promise<void>((r) => (release = r)));
    let ran = false;
    await assert.rejects(
      () =>
        lock.withUpdateLock(second, 'busy', async () => {
          ran = true;
        }),
      (e: Error & { clash?: boolean }) => e.name === 'UpdateBusyError' && e.clash === true && says.test(e.message),
      `${second} during ${first}`,
    );
    assert.equal(ran, false, `${second} ran while ${first} was under way`);
    release();
    await held;
    await lock.withUpdateLock(second, 'busy', async () => {}); // and once that finished, it may
  }
  // The same work asked for twice is not a clash: it will finish on its own.
  let release = () => {};
  const held = lock.withUpdateLock('core', 'already', () => new Promise<void>((r) => (release = r)));
  await assert.rejects(
    () => lock.withUpdateLock('core', 'already', never),
    (e: Error & { clash?: boolean }) => e.message === 'already' && e.clash === false,
  );
  release();
  await held;
  // A clash refuses the update window with "nothing changed"; the same work twice waits
  // for the restart the running one will bring.
  assert.match(codeOf('core/src/api/update.ts'), /outcome = \(err as UpdateBusyError\)\.clash \? 'unchanged' : 'restarting';/);
  // And the restore says what is in its way, rather than always "a restore is running".
  assert.match(codeOf('core/src/system/restore.ts'), /if \(err instanceof UpdateBusyError\) \{\s*onLine\(err\.message\);/);
});

test('A CORE UPDATE OR A RESTORE KEEPS ITS LOCK UNTIL THE CORE IS REPLACED — not just until it hands that job over', async () => {
  // Both end by handing the core's replacement to a helper, and the old core goes on
  // running for some seconds after. Letting go of the lock at the hand-off accepted work
  // in that gap — an app update, a second restore — which the replacement then killed
  // part-way.
  const restarts = (r: string) => (r === 'restarting' ? 60_000 : 0);
  assert.equal(await lock.withUpdateLock('core', 'busy', async () => 'restarting', { holdAfter: restarts }), 'restarting');
  assert.equal(lock.isUpdating('core'), true, 'let go at the hand-off');
  // Said as it is: the update is done and OpenMasjidOS is restarting, not "being updated".
  const finishingUpdate = /^OpenMasjidOS is restarting to finish an update\. Please try again in a minute or two\. Nothing was changed\.$/;
  await assert.rejects(
    () => lock.withUpdateLock('app:students', 'busy', async () => {}),
    (e: Error & { clash?: boolean }) => e.clash === true && finishingUpdate.test(e.message),
    'work was accepted while the core was about to be replaced',
  );
  await assert.rejects(
    () => lock.withUpdateLock('core', 'An update is already running.', async () => {}),
    (e: Error & { clash?: boolean }) => e.clash === false && finishingUpdate.test(e.message),
    'the same update again: not a clash (the restart it waits for is coming), but not "running" either',
  );
  assert.throws(() => lock.assertAppFree('students', 'install'), (e: Error) => finishingUpdate.test(e.message));
  lock.assertAppFree('students', 'start'); // a start is quick, as during the update itself
  lock.__releaseHeldLocksForTests();
  assert.equal(lock.isUpdating('core'), false);

  // A restore that has finished says so too.
  await lock.withUpdateLock('restore', 'busy', async () => 'restarting', { holdAfter: restarts });
  const finishingRestore = /^OpenMasjidOS is restarting to finish restoring your backup\. Please try again in a minute or two\. Nothing was changed\.$/;
  assert.throws(() => lock.assertAppFree('students', 'start'), (e: Error) => finishingRestore.test(e.message));
  await assert.rejects(() => lock.withUpdateLock('core', 'busy', async () => {}), (e: Error) => finishingRestore.test(e.message));
  lock.__releaseHeldLocksForTests();

  // Only for an ending that replaces the core: one that changed nothing lets go at once…
  await lock.withUpdateLock('core', 'busy', async () => 'unchanged', { holdAfter: restarts });
  assert.equal(lock.isUpdating('core'), false, 'held after an update that changed nothing');
  // …and so does one that failed.
  await assert.rejects(() =>
    lock.withUpdateLock('core', 'busy', async () => {
      throw new Error('pull failed');
    }, { holdAfter: () => 60_000 }),
  );
  assert.equal(lock.isUpdating('core'), false, 'held after a failure');

  // Released by a timer, so a helper that never replaces the core cannot wedge the box.
  await lock.withUpdateLock('restore', 'busy', async () => 'restarting', { holdAfter: () => 40 });
  assert.equal(lock.isUpdating('restore'), true);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(lock.isUpdating('restore'), false, 'a hold that nothing ends must end on its own');

  // Both callers hold for exactly their restarting endings, for the same time.
  const update = codeOf('core/src/docker/update.ts');
  assert.match(update, /holdAfter: \(outcome\) => \(outcome === 'restarting' \? HOLD_UNTIL_REPLACED_MS : 0\)/);
  const restore = codeOf('core/src/system/restore.ts');
  assert.match(
    restore,
    /holdAfter: \(outcome\) =>\s+outcome === 'restarting' \|\| outcome === 'restarting-with-problems' \? HOLD_UNTIL_REPLACED_MS : 0/,
  );
});

test('NO APP IS STARTED, INSTALLED OR REMOVED UNDER A RESTORE OR ITS OWN UPDATE — stopping never is', async () => {
  // A restore stops every app and refills its data: an app started meanwhile ran over a
  // database being replaced, from a compose that came in with the backup and had not been
  // checked yet. Start during the app's own update brought up the compose the update was
  // about to put back.
  const refused = (says: RegExp) => (e: Error & { clash?: boolean }) =>
    e.name === 'UpdateBusyError' && e.clash === true && says.test(e.message) && /Nothing was changed\.$/.test(e.message);
  for (const action of ['start', 'install', 'remove'] as const) lock.assertAppFree('students', action);

  let release = () => {};
  let held = lock.withUpdateLock('restore', 'busy', () => new Promise<void>((r) => (release = r)));
  assert.throws(() => lock.assertAppFree('students', 'start'), refused(/^A backup is being restored right now\. Your apps will start again on their own/));
  assert.throws(() => lock.assertAppFree('students', 'install'), refused(/Please install this app once it has finished/));
  assert.throws(() => lock.assertAppFree('students', 'remove'), refused(/Please remove this app once it has finished/));
  release();
  await held;

  held = lock.withUpdateLock('app:students', 'busy', () => new Promise<void>((r) => (release = r)));
  for (const action of ['start', 'install', 'remove'] as const) {
    assert.throws(() => lock.assertAppFree('students', action), refused(/^This app is being updated right now/), action);
    lock.assertAppFree('donations', action); // another app is not in the way
  }
  release();
  await held;

  // A core update cuts an install or a removal off; a start is quick, and is allowed.
  held = lock.withUpdateLock('core', 'busy', () => new Promise<void>((r) => (release = r)));
  lock.assertAppFree('students', 'start');
  assert.throws(() => lock.assertAppFree('students', 'install'), refused(/^OpenMasjidOS is being updated right now\. Please install this app/));
  assert.throws(() => lock.assertAppFree('students', 'remove'), refused(/Please remove this app/));
  release();
  await held;

  // Every way in asks, before anything else: Start, Restart (it starts a stopped app),
  // Remove, and both installs. Stop does not.
  const manager = codeOf('core/src/apps/manager.ts');
  const body = (name: RegExp) => {
    const at = manager.search(name);
    assert.ok(at >= 0, String(name));
    // From the body on: a parameter list may well say `composeText`.
    const opens = manager.indexOf('): Promise<', at);
    return manager.slice(opens, manager.indexOf('\n}\n', opens));
  };
  for (const [name, call] of [
    [/export async function startApp\(/, "assertAppFree(id, 'start')"],
    [/export async function restartApp\(/, "assertAppFree(id, 'start')"],
    [/export async function removeApp\(/, "assertAppFree(id, 'remove')"],
    [/export async function installCatalogApp\(/, "assertAppFree(app.id, 'install')"],
    [/async function installStack\(/, "assertAppFree(opts.id, 'install')"],
  ] as const) {
    const fn = body(name);
    const at = fn.indexOf(call);
    assert.ok(at > 0, `${name} does not ask`);
    for (const work of ['compose', 'writeFile', 'saveMeta', 'stopProxy', 'parseFabric']) {
      const w = fn.indexOf(work);
      assert.ok(w === -1 || w > at, `${name}: ${work} before the check`);
    }
  }
  assert.doesNotMatch(body(/export async function stopApp\(/), /assertAppFree/, 'stopping must never be refused');
  // An install refused this way is a refusal on every install route, not an internal fault.
  for (const r of ['store', 'custom', 'community', 'whatsapp']) {
    assert.match(codeOf(`core/src/trpc/routers/${r}.ts`), /err instanceof UpdateBusyError \? 'CONFLICT' : 'INTERNAL_SERVER_ERROR'/, r);
  }
});
