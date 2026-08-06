// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The core must actually RUN the channel's image, not merely pull it.
 *
 * The bug this pins, reported as "I'm on the latest and have dev mode on":
 * `recreateCore` recreates the core with
 *   docker compose -f /data/docker-compose.yml up -d --force-recreate
 * and the installer writes that file with a hardcoded
 *   image: ghcr.io/openmasjid-solutions/openmasjid-core:latest
 * (`IMAGE=` in install.sh). Switching to Development therefore pulled `:dev` and
 * then started `:latest` again — the pull was wasted, the box stayed on Stable, and
 * the dashboard said Development. Every Development fix was unreachable as a result,
 * including the one that made app updates work.
 *
 * The file is a real masjid's boot configuration, so the rewrite has to be surgical:
 * only the core's image tag, nothing else in the file, and never a deliberate pin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);

/** A compose file shaped like the one install.sh writes. */
const COMPOSE = `# OpenMasjidOS — managed by the installer.
services:
  core:
    image: ghcr.io/openmasjid-solutions/openmasjid-core:latest
    container_name: openmasjid-core
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /opt/openmasjid:/data
      - /proc:/host/proc:ro
    environment:
      OPENMASJID_PORT: "80"
`;

function load(compose: string | null): {
  mod: typeof import('../src/docker/update');
  file: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-ci-'));
  const file = path.join(dir, 'docker-compose.yml');
  if (compose !== null) fs.writeFileSync(file, compose);
  process.env.OPENMASJID_DATA_DIR = dir;
  for (const m of ['../src/config', '../src/settings/store', '../src/docker/update']) {
    delete req.cache[req.resolve(m)];
  }
  return { mod: req('../src/docker/update') as typeof import('../src/docker/update'), file };
}

test('switching to Development repoints the core compose at :dev', () => {
  // THE REGRESSION. Without this the box pulls :dev and starts :latest forever.
  const { mod, file } = load(COMPOSE);
  assert.equal(mod.alignComposeImage('dev'), true);
  const out = fs.readFileSync(file, 'utf8');
  assert.match(out, /image: ghcr\.io\/openmasjid-solutions\/openmasjid-core:dev$/m);
  assert.doesNotMatch(out, /openmasjid-core:latest/, 'the old tag must be gone');
});

test('returning to Stable repoints it back at :latest', () => {
  const { mod, file } = load(COMPOSE.replace(':latest', ':dev'));
  assert.equal(mod.alignComposeImage('main'), true);
  assert.match(fs.readFileSync(file, 'utf8'), /openmasjid-core:latest$/m);
});

test('everything else in the file is left byte-identical', () => {
  // This file is a masjid's boot configuration: its ports, its mounts, its data
  // path. Losing a line here is a box that does not come back.
  const { mod, file } = load(COMPOSE);
  mod.alignComposeImage('dev');
  const before = COMPOSE.split('\n');
  const after = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(after.length, before.length, 'no lines added or removed');
  const changed = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
  assert.equal(changed.length, 1, `exactly one line may change, got ${changed.length}`);
  assert.match(after[changed[0] as number]!, /image:/, 'and it must be the image line');
  // Indentation matters in YAML — a lost space breaks the file.
  assert.match(after[changed[0] as number]!, /^ {4}image: /, 'indentation preserved');
});

test('a deliberately digest-pinned core is left alone', () => {
  // An operator who pinned a digest meant it; silently converting that to a moving
  // tag would undo the pin — the same rule retarget() follows.
  const pinned = COMPOSE.replace(
    ':latest',
    '@sha256:1111111111111111111111111111111111111111111111111111111111111111',
  );
  const { mod, file } = load(pinned);
  assert.equal(mod.alignComposeImage('dev'), true, 'reports satisfied');
  assert.equal(fs.readFileSync(file, 'utf8'), pinned, 'and changes nothing');
});

test('an already-correct file is not rewritten', () => {
  const { mod, file } = load(COMPOSE.replace(':latest', ':dev'));
  const before = fs.statSync(file).mtimeMs;
  assert.equal(mod.alignComposeImage('dev'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), COMPOSE.replace(':latest', ':dev'));
  assert.equal(fs.statSync(file).mtimeMs, before, 'no needless write');
});

test('a missing or unrecognisable compose file fails soft, never throws', () => {
  // Local dev has no such file. Throwing here would break the update path for a
  // reason that has nothing to do with the update.
  assert.doesNotThrow(() => load(null).mod.alignComposeImage('dev'));
  assert.equal(load(null).mod.alignComposeImage('dev'), false);
  // A file with no core image line: leave it, report false, do not guess.
  const odd = load('services:\n  core:\n    build: .\n');
  assert.equal(odd.mod.alignComposeImage('dev'), false);
  assert.equal(fs.readFileSync(odd.file, 'utf8'), 'services:\n  core:\n    build: .\n');
});

test('only the core image is touched, never an app image in the same file', () => {
  // Defence in depth: the core's compose should not contain app services, but the
  // regex must be anchored to our repo regardless.
  const withApp = COMPOSE + `  other:\n    image: ghcr.io/someone/otherapp:latest\n`;
  const { mod, file } = load(withApp);
  mod.alignComposeImage('dev');
  const out = fs.readFileSync(file, 'utf8');
  assert.match(out, /openmasjid-core:dev/);
  assert.match(out, /someone\/otherapp:latest/, "another service's image must be untouched");
});

test('recreateCore aligns the compose before composing up', () => {
  // Order is the whole point: aligning after the `up` would recreate from the old
  // tag and the fix would silently do nothing.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'docker', 'update.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export async function recreateCore'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const alignAt = body.indexOf('alignComposeImage(');
  const upAt = body.indexOf('docker compose -p');
  assert.ok(alignAt > 0, 'recreateCore must align the compose image');
  assert.ok(upAt > 0);
  assert.ok(alignAt < upAt, 'and must do it BEFORE the compose up');
});
