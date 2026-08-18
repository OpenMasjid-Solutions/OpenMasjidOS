// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The manifest `commands:` contract — the declaration half of admin commands over
 * WhatsApp.
 *
 * This validator is mirrored by OpenMasjidAPPS's build-catalog.mjs, and the whole
 * value of that mirroring is that "passes the catalog build" means "installs
 * cleanly". Where the two disagree, a masjid finds out at install time.
 *
 * Two of the assertions here are security properties rather than validation:
 * `commands` must be refused as a Fabric capability, and PLATFORM_CALLER_ID must be
 * incapable of ever being an app id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { needsFabricSecret, parseCommands, parseFabric, isReservedAppId } from '../src/apps/manager';
import { PLATFORM_CALLER_ID } from '../src/fabric/proxy';

const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

test('parseCommands: accepts a valid list and normalises it', () => {
  assert.deepEqual(
    parseCommands(
      [
        { id: 'whats-on', label: "What's on the screen now" },
        {
          id: 'post-notice',
          label: 'Put a message on the screen',
          description: 'Replaces whatever is showing.',
          argument: { label: 'message' },
          confirm: true,
        },
      ],
      'display',
    ),
    [
      { id: 'whats-on', label: "What's on the screen now", description: undefined, argument: undefined, confirm: undefined },
      {
        id: 'post-notice',
        label: 'Put a message on the screen',
        description: 'Replaces whatever is showing.',
        argument: { label: 'message' },
        confirm: true,
      },
    ],
  );
  assert.deepEqual(parseCommands(undefined, 'x'), []);
  assert.deepEqual(parseCommands(null, 'x'), []);
});

test('parseCommands: clamps long text the way parseAlerts does', () => {
  const [c] = parseCommands([{ id: 'a', label: 'L'.repeat(200), description: 'D'.repeat(400) }], 'x');
  assert.equal(c!.label.length, 80);
  assert.equal(c!.description!.length, 200);
});

test('parseCommands: an all-digit id is refused', () => {
  // `!display 2` must mean "the second option" and nothing else. If a command could
  // be called `2`, the parser's grammar would be ambiguous at its most-used point.
  assert.throws(() => parseCommands([{ id: '2', label: 'Two' }], 'x'), /cannot be all digits/);
});

test('parseCommands: ids that collide with the platform are refused', () => {
  for (const id of ['help', 'yes', 'no', 'cancel', 'stop']) {
    assert.throws(() => parseCommands([{ id, label: 'x' }], 'x'), /reserved/, `"${id}" must be refused`);
  }
});

test('parseCommands: a malformed argument FAILS rather than being dropped', () => {
  // The `=== true ? true : undefined` idiom would quietly accept these and lose the
  // argument — so a volunteer types a notice, is told "done", and nothing was sent.
  assert.throws(() => parseCommands([{ id: 'a', label: 'A', argument: true }], 'x'), /must be an object/);
  assert.throws(() => parseCommands([{ id: 'a', label: 'A', argument: 'message' }], 'x'), /must be an object/);
  assert.throws(() => parseCommands([{ id: 'a', label: 'A', argument: [] }], 'x'), /must be an object/);
  assert.throws(() => parseCommands([{ id: 'a', label: 'A', argument: {} }], 'x'), /needs a "label"/);
  assert.throws(
    () => parseCommands([{ id: 'a', label: 'A', argument: { label: 'm', required: 'yes' } }], 'x'),
    /must be true or false/,
  );
  assert.throws(() => parseCommands([{ id: 'a', label: 'A', confirm: 'yes' }], 'x'), /not true or false/);
});

test('parseCommands: required:false survives, required:true is the default', () => {
  const [opt] = parseCommands([{ id: 'a', label: 'A', argument: { label: 'm', required: false } }], 'x');
  assert.deepEqual(opt!.argument, { label: 'm', required: false });
  const [req] = parseCommands([{ id: 'b', label: 'B', argument: { label: 'm', required: true } }], 'x');
  assert.deepEqual(req!.argument, { label: 'm' }, 'the default is not stored');
});

test('parseCommands: rejects the rest of the malformed shapes', () => {
  assert.throws(() => parseCommands('nope', 'x'), /must be a list/);
  assert.throws(() => parseCommands([{ id: 'Bad_Id', label: 'x' }], 'x'), /kebab-case "id"/);
  assert.throws(() => parseCommands([{ id: 'ok' }], 'x'), /needs a "label"/);
  assert.throws(() => parseCommands(['just-a-string'], 'x'), /must be an object/);
  assert.throws(
    () => parseCommands([{ id: 'dup', label: 'a' }, { id: 'dup', label: 'b' }], 'x'),
    /duplicate command id/,
  );
});

test('parseCommands: caps the list at 12', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, label: `C${i}` }));
  assert.equal(parseCommands(twelve, 'x').length, 12);
  assert.throws(() => parseCommands([...twelve, { id: 'c12', label: 'C12' }], 'x'), /at most 12/);
});

test('a commands-only app is issued a Fabric secret', () => {
  // Not cosmetic: the platform proves a command call is genuine by presenting the
  // app's OWN secret, so without one the app could never be called at all.
  assert.equal(needsFabricSecret({ commands: [{}] as unknown[] }), true);
  assert.equal(needsFabricSecret({ commands: [] }), false);
  assert.equal(needsFabricSecret({}), false);
});

test('"commands" is refused as a Fabric broker capability', () => {
  // Otherwise another app reaches the very same /fabric/commands/run handler with
  // consumes:["display/commands"], turning an admin-only surface into an app-to-app
  // one. Same path prefix, different trust boundary.
  assert.throws(() => parseFabric({ provides: [{ capability: 'commands' }] }, 'display'), /reserved for admin commands/);
  // Neighbouring names are ordinary capabilities and must still work.
  assert.deepEqual(parseFabric({ provides: [{ capability: 'command' }] }, 'x').provides, ['command']);
  assert.deepEqual(parseFabric({ consumes: ['display/commands'] }, 'x').consumes, ['display/commands']);
});

test('platform-reserved words cannot be app ids', () => {
  for (const id of ['os', 'omos', 'openmasjid', 'openmasjidos', 'platform', 'help']) {
    assert.equal(isReservedAppId(id), true, `"${id}" must be reserved`);
  }
  assert.equal(isReservedAppId('OS'), true, 'case-insensitive');
  assert.equal(isReservedAppId('osman'), false);
  assert.equal(isReservedAppId('display'), false);
});

test('reserving a word must NOT put it in RESERVED_APP_IDS', () => {
  // RESERVED_APP_IDS means "stray platform infrastructure", and listInstalled
  // rmSync's the directory of anything in it. Reserving a word there would destroy a
  // masjid's data the moment someone shipped an app under that id.
  const s = src('apps/manager.ts');
  const set = /const RESERVED_APP_IDS = new Set\(\[([^\]]*)\]\)/.exec(s);
  assert.ok(set, 'RESERVED_APP_IDS must still be a literal Set');
  for (const word of ['os', 'omos', 'platform', 'help']) {
    assert.ok(!set[1]!.includes(`'${word}'`), `"${word}" must not be in RESERVED_APP_IDS — it deletes directories`);
  }
});

test('PLATFORM_CALLER_ID can never be an app id', () => {
  // This is what makes `X-OpenMasjid-Caller-App: omos:platform` trustworthy to an
  // app: not an allow-list somebody maintains, but a value outside the charset every
  // app id is validated against. The broker only ever emits an authenticated app's
  // real id, so it cannot produce this one.
  const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
  assert.equal(APP_ID_RE.test(PLATFORM_CALLER_ID), false);

  // ...and pin that the regex above is really the one the broker enforces, so
  // widening the charset there fails here rather than silently forging the header.
  assert.match(src('fabric/appLink.ts'), /const APP_ID_RE = \/\^\[a-z0-9\]\[a-z0-9-\]\{0,79\}\$\//);
});

test('there is exactly one HTTP client to apps', () => {
  // A second one drifts: the caps, the no-redirect rule and the built-from-scratch
  // header set are the safety, and they only hold where they are written once.
  assert.ok(!/\bhttp\.request\(/.test(src('fabric/appLink.ts')), 'appLink.ts must proxy via fabric/proxy.ts');
  assert.match(src('fabric/appLink.ts'), /from '\.\/proxy'/);

  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && /['"]x-openmasjid-app-secret['"]\s*:/.test(fs.readFileSync(p, 'utf8'))) {
        offenders.push(path.relative(path.join(__dirname, '..', 'src'), p).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  assert.deepEqual(offenders, ['fabric/proxy.ts'], 'only fabric/proxy.ts may SET the app-secret request header');
});

test('the broker still caps responses at 256 KB', () => {
  // The extraction added a maxResponseBytes option for the command path. It must
  // have changed nothing for the broker.
  assert.match(src('fabric/proxy.ts'), /FABRIC_MAX_BODY = 256 \* 1024/);
  assert.match(src('fabric/proxy.ts'), /opts\.maxResponseBytes \?\? FABRIC_MAX_BODY/);
  assert.match(src('fabric/appLink.ts'), /MAX_BODY = FABRIC_MAX_BODY/);
});
