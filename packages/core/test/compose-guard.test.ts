// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Install-time risk gate: cross-app Docker VOLUME access (apps/compose-validate.ts).
 *
 * A compose file can attach to another app's data without ever naming a host
 * path — `external: true` uses the volume name verbatim, and `name:` overrides
 * the project-scoped name — so the host-path checks never see it. Every
 * OpenMasjid app's data lives in an `omos-*` volume, so hitting that namespace
 * is a REFUSAL (no "I understand the risk" path); anything else pre-existing is
 * merely unverifiable and stays an acknowledgeable danger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCompose } from '../src/apps/compose-validate';

/** A minimal valid stack that mounts `vol` — checkCompose needs a service. */
function stack(vol: string, topLevel: string): string {
  return [
    'services:',
    '  app:',
    '    image: example/app:1.0.0',
    '    volumes:',
    `      - "${vol}:/data"`,
    'volumes:',
    topLevel,
  ].join('\n');
}

test('refuses a service that attaches to another app\'s volume via external: true', () => {
  const { refusals, dangers } = checkCompose(
    stack('omos-students_data', '  omos-students_data:\n    external: true'),
  );
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /omos-students_data/);
  assert.deepEqual(dangers, []);
});

test('refuses the truthy spellings of external, not just `true`', () => {
  for (const spelling of ['yes', 'on', '1', '"true"']) {
    const { refusals } = checkCompose(
      stack('steal', `  steal:\n    external: ${spelling}`),
    );
    assert.equal(refusals.length, 0, `"${spelling}" targets a non-omos name, so it is a danger not a refusal`);
  }
  for (const spelling of ['yes', 'on', '1', '"true"']) {
    const { refusals } = checkCompose(
      stack('omos-kiosk_data', `  omos-kiosk_data:\n    external: ${spelling}`),
    );
    assert.equal(refusals.length, 1, `external: ${spelling} must still be caught`);
  }
});

test('refuses an explicit `name:` that points at another app\'s volume (no external needed)', () => {
  const { refusals } = checkCompose(stack('steal', '  steal:\n    name: omos-students_data'));
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /omos-students_data/);
});

test('refuses the long form `external: { name: … }`', () => {
  const { refusals } = checkCompose(
    stack('steal', '  steal:\n    external:\n      name: omos-donations_data'),
  );
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /omos-donations_data/);
});

test('refuses reaching into the platform\'s own infra volumes', () => {
  const { refusals } = checkCompose(
    stack('omos-cloudflared_data', '  omos-cloudflared_data:\n    external: true'),
  );
  assert.equal(refusals.length, 1);
});

test('an unrelated pre-existing volume is an acknowledgeable danger, not a refusal', () => {
  const { refusals, dangers } = checkCompose(
    stack('nextcloud_data', '  nextcloud_data:\n    external: true'),
  );
  assert.deepEqual(refusals, []);
  assert.equal(dangers.length, 1);
  assert.match(dangers[0], /nextcloud_data/);
});

test('a variable volume name fails closed as a danger (we can\'t see the target)', () => {
  const { refusals, dangers } = checkCompose(
    stack('steal', '  steal:\n    external: true\n    name: ${TARGET}'),
  );
  assert.deepEqual(refusals, []);
  assert.equal(dangers.length, 1);
  assert.match(dangers[0], /variable/i);
});

test('ordinary project-scoped volumes stay completely clean', () => {
  // Both the `data:` shorthand and an empty mapping are how every real catalog
  // app declares its storage — neither may start warning.
  for (const topLevel of ['  data:', '  data: {}', '  data:\n    driver: local']) {
    const { refusals, dangers } = checkCompose(stack('data', topLevel));
    assert.deepEqual(refusals, [], `unexpected refusal for:\n${topLevel}`);
    assert.deepEqual(dangers, [], `unexpected danger for:\n${topLevel}`);
  }
});

test('a real catalog app compose still passes the whole gate', () => {
  // Shaped like OpenMasjid Students / Donations: pinned image, published port,
  // one named volume, cap_drop + no-new-privileges. Must be danger-free or every
  // catalog install breaks (store.ts blocks on ANY danger).
  const { refusals, dangers, services } = checkCompose(
    [
      'services:',
      '  app:',
      '    image: ghcr.io/openmasjid-solutions/openmasjidstudents:0.36.0',
      '    restart: unless-stopped',
      '    environment:',
      '      OPENMASJID_PUBLIC_URL: ${OPENMASJID_PUBLIC_URL:-}',
      '    ports:',
      '      - "8360:8080"',
      '    volumes:',
      '      - data:/data',
      '    cap_drop:',
      '      - ALL',
      '    security_opt:',
      '      - no-new-privileges:true',
      '    tmpfs:',
      '      - /tmp',
      'volumes:',
      '  data:',
    ].join('\n'),
  );
  assert.deepEqual(refusals, []);
  assert.deepEqual(dangers, []);
  assert.deepEqual(services, ['app']);
});
