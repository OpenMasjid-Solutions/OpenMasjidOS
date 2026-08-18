// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * An update must not report success for a container that is crash-looping.
 *
 * `docker compose up -d` exits 0 the moment a container is created and started — it
 * says nothing about whether the process inside then died. So an app that boots,
 * throws and is restarted forever by `restart: unless-stopped` used to look like a
 * clean update: "Done — X is now on v1.2.3", with the real reason buried in container
 * logs the admin had to know to go and find.
 *
 * This reached a masjid. A WhatsApp gateway update added a guard that rejected a
 * setting the existing install did not satisfy; the update said Done, the dashboard
 * said "not running", and nothing connected the two.
 *
 * Structural rather than behavioural: exercising the real thing needs Docker, and the
 * property worth defending is that the claim is made only AFTER the check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

test('the update path verifies before it says Done', () => {
  const code = src('apps/manager.ts');
  const fn = code.slice(code.indexOf('async function updateCatalogAppInner'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  const check = body.indexOf('verifyStayedUp(');
  const done = body.indexOf('Done — ');
  assert.ok(check > 0, 'the update must check the container stayed up');
  assert.ok(done > 0, 'the update still reports success somewhere');
  assert.ok(check < done, 'the check must come BEFORE the success line, or it proves nothing');

  // And the failure path must return rather than falling through to "Done".
  const failure = body.slice(check, done);
  assert.match(failure, /return;/, 'a crash-looping app must not also get the success line');
  assert.match(failure, /not staying running/, 'it must say what actually happened');
});

test('a crash-loop is reported with the container output, not just a status', () => {
  // "It is not running" sends the admin hunting. The reason is already in the logs we
  // just fetched, so it goes in the message.
  const code = src('apps/manager.ts');
  assert.match(code, /composeLogs\(projectOf\(id\), 40\)/, 'the last lines are collected');
  assert.match(code, /The last thing it printed before stopping/);
});

test('verifyStayedUp samples more than once', () => {
  // A crash-loop spends part of its cycle genuinely `running`, so a single check can
  // land in that window and report a healthy app.
  const code = src('apps/manager.ts');
  const fn = code.slice(code.indexOf('export async function verifyStayedUp'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /SETTLE_SAMPLES/, 'it must sample repeatedly');
  assert.match(body, /if \(!up\) break;/, 'one bad sample is enough to fail');
  assert.ok(!/return null;\s*\}\s*$/.test(body.split('if (up) return null;')[0] ?? ''), 'sanity');
});

test('the WhatsApp reply does not claim an app is running until it is', () => {
  // The admin running `!os start` cannot see the dashboard — that is the whole point
  // of the feature — so a false "it's running again" is worse here than anywhere else.
  const exec = src('commands/execute.ts');
  const check = exec.indexOf('verifyStayedUp(');
  const done = exec.indexOf('doneWords(command.id');
  assert.ok(check > 0 && done > 0 && check < done, 'verify before the success reply');
  assert.match(exec, /started and then stopped again/);
  // `stop` is exempt: "did it stay up" is the wrong question for it.
  assert.match(exec, /command\.id !== 'stop'/);
});
