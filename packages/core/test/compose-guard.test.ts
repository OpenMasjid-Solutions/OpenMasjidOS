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

// ── External NETWORKS: the same attachment trick, one level over ──────────────
// Joining another app's project network reaches its UNPUBLISHED ports directly,
// bypassing the Fabric broker's manifest-grant authorization entirely.

/** A minimal valid stack declaring a top-level `networks:` map. */
function netStack(topLevel: string): string {
  return ['services:', '  app:', '    image: example/app:1.0.0', 'networks:', topLevel].join('\n');
}

test("refuses joining another app's private network via external: true", () => {
  const { refusals, dangers } = checkCompose(
    netStack('  victim:\n    external: true\n    name: omos-students_default'),
  );
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /omos-students_default/);
  assert.deepEqual(dangers, []);
});

test("refuses joining the platform's OWN network", () => {
  // COMPOSE_PROJECT=openmasjid, so the core's network is `openmasjid_default` —
  // joining it puts an app on the same L2 as the core (root + docker.sock).
  const { refusals } = checkCompose(netStack('  x:\n    external: true\n    name: openmasjid_default'));
  assert.equal(refusals.length, 1);
});

test('refuses a reserved network named by the KEY (external, no explicit name)', () => {
  const { refusals } = checkCompose(netStack('  omos-donations_default:\n    external: true'));
  assert.equal(refusals.length, 1);
});

test('refuses a reserved network renamed via bare name: (no external)', () => {
  const { refusals } = checkCompose(netStack('  mine:\n    name: omos-kiosk_default'));
  assert.equal(refusals.length, 1);
});

test('a variable network name fails closed as a danger', () => {
  const { refusals, dangers } = checkCompose(netStack('  x:\n    external: true\n    name: ${TARGET}'));
  assert.deepEqual(refusals, []);
  assert.equal(dangers.length, 1);
});

test('ordinary and non-reserved networks stay clean (catalog apps must still install)', () => {
  for (const topLevel of [
    '  frontend:',
    '  frontend: {}',
    '  frontend:\n    driver: bridge',
    '  frontend:\n    external: false',
    // A non-reserved external network is deliberately NOT flagged: making it a
    // danger would hard-block the catalog path, which has no acknowledge route.
    '  homelab:\n    external: true',
  ]) {
    const { refusals, dangers } = checkCompose(netStack(topLevel));
    assert.deepEqual(refusals, [], topLevel);
    assert.deepEqual(dangers, [], topLevel);
  }
});

test('a reserved VOLUME target is still refused after the namespace widened', () => {
  // The regex grew from /^omos[-_]/ to /^(omos|openmasjid)[-_]/; both must refuse.
  for (const name of ['omos-students_data', 'openmasjid_data', 'OMOS-Students_data']) {
    const { refusals } = checkCompose(stack(name, `  ${name}:\n    external: true`));
    assert.equal(refusals.length, 1, name);
  }
});

// ── Host-path normalisation. Each case below was UNFLAGGED before this suite ──
// existed, and each was verified by hand against the real checkCompose.

/** A minimal valid stack whose single service bind-mounts `src`. */
function bindStack(src: string): string {
  return ['services:', '  app:', '    image: example/app:1.0.0', '    volumes:', `      - "${src}:/x"`].join('\n');
}

test('a duplicate slash cannot smuggle the Docker socket past the gate', () => {
  // `//run` is the same directory as `/run` to the kernel, but `startsWith('/run')`
  // is false for it — and /run holds docker.sock on every systemd distro, so this
  // was a silent path to host root.
  for (const src of ['//run', '//var/run', '//var//run/docker.sock', '//etc', '//root']) {
    const { dangers } = checkCompose(bindStack(src));
    assert.ok(dangers.length > 0, `${src} must be flagged`);
  }
});

test('a "." segment cannot smuggle a sensitive path past the gate', () => {
  for (const src of ['/var/./run/docker.sock', '/./etc', '/etc/./ssh']) {
    const { dangers } = checkCompose(bindStack(src));
    assert.ok(dangers.length > 0, `${src} must be flagged`);
  }
});

test('a leading ~ is treated as the host path compose expands it to', () => {
  // `docker compose config` rewrites `~/.ssh` to the invoking user's home before
  // the daemon sees it, and the core runs as root — so this reaches /root/.ssh,
  // which is what the /root entry exists to block. It previously failed the
  // startsWith('/') test and was accepted as a relative in-app path.
  for (const src of ['~/.ssh', '~root/.ssh', '~/.docker/config.json', '~']) {
    const { dangers } = checkCompose(bindStack(src));
    assert.ok(dangers.length > 0, `${src} must be flagged`);
  }
});

test("mounting a PARENT of the platform's data dir is flagged", () => {
  // SENSITIVE_ROOTS held the data dir itself, so descendants were caught but the
  // parent was not — and mounting /opt hands over every platform secret
  // (stripe.json, email.json, the tunnel token) plus every app's .env.
  const { dangers } = checkCompose(bindStack('/opt'));
  assert.ok(dangers.length > 0, '/opt must be flagged');
  assert.match(dangers[0], /contains sensitive data/);
});

test('ordinary app mounts are still accepted after normalisation', () => {
  // The gate must not become so strict that real apps stop installing: any danger
  // is hard-blocking on the catalog path.
  for (const src of ['./data', 'data', './config/app.yml', '/srv/media', '/mnt/usb']) {
    const { dangers, refusals } = checkCompose(bindStack(src));
    assert.deepEqual(dangers, [], `${src} must stay clean`);
    assert.deepEqual(refusals, [], src);
  }
});

test('".." is still refused rather than silently resolved', () => {
  // Normalisation runs AFTER this check on purpose — resolving `..` first would
  // turn an escape attempt into a clean-looking path.
  const { dangers } = checkCompose(bindStack('/var/run/../run/docker.sock'));
  assert.ok(dangers.length > 0);
  assert.match(dangers[0], /escapes the app folder/);
});

// ── interpolation must not decide whether a check RUNS (v0.51.1) ─────────────────
//
// The gate reads the RAW compose text, but `docker compose` interpolates BEFORE it
// validates the schema. That is fine for a field whose VALUE is dangerous — those are
// already failed closed by `hasInterpolation`. It was not fine for a field that decides
// whether any check happens at all, and there were three of them.

test('an interpolated volume `type` cannot skip the host-path check', () => {
  // THE CRITICAL ONE. `bindSource` used to early-return for any `type` that was not
  // literally 'bind', so this was classified as a named volume and `checkHostPath` never
  // ran: checkCompose returned NO dangers and NO refusals, and the app installed on the
  // ordinary one-click path with no risk dialog. Verified against real Docker at the time:
  // with an EMPTY .env the `:-bind` default renders `type: bind`, so the container came up
  // holding the host Docker socket — host root, from an app meant to run at arm's length.
  for (const source of ['/var/run/docker.sock', '/', '/etc', '/opt/openmasjid']) {
    const yml = `services:
  app:
    image: x
    volumes:
      - type: \${CACHE_MODE:-bind}
        source: ${source}
        target: /mnt`;
    const { dangers, refusals } = checkCompose(yml);
    assert.ok(dangers.length + refusals.length > 0, `${source} must not pass the gate`);
  }
});

test('an interpolated `type` is caught even when the source looks harmless', () => {
  // `bindSource` now treats an unverifiable type as possibly-bind, but that only helps when
  // the source is a path we recognise. A named/relative source with a variable type would
  // otherwise slip through unexamined, so the long form fails closed on its own fields too.
  const yml = `services:
  app:
    image: x
    volumes:
      - type: \${M:-bind}
        source: appdata
        target: /data`;
  const { dangers } = checkCompose(yml);
  assert.ok(dangers.some((d) => /variable in a volume mount/.test(d)));
});

test('a literal non-bind type stays clean, so real apps still install', () => {
  // The asymmetry that has to survive: any danger hard-blocks the catalog path, so treating
  // ordinary named volumes as suspicious would refuse to install shipped apps.
  const yml = `services:
  app:
    image: x
    volumes:
      - type: volume
        source: data
        target: /data
volumes:
  data:`;
  const { dangers, refusals } = checkCompose(yml);
  assert.deepEqual(dangers, []);
  assert.deepEqual(refusals, []);
});

test('an interpolated `external:` cannot evade the cross-app refusal', () => {
  // `isTruthyFlag` saw the literal text `${X:-true}` (not truthy) and no `name:` was
  // present, so `externalTarget` returned null and NOTHING was checked — while at runtime
  // compose resolved it to `true` and attached to another app's database. An unverifiable
  // flag now counts as SET, which lets the reserved-namespace refusal see the key.
  const yml = `services:
  app:
    image: x
    volumes:
      - omos-students_data:/steal
volumes:
  omos-students_data:
    external: \${X:-true}`;
  const { refusals } = checkCompose(yml);
  assert.ok(refusals.some((r) => /another OpenMasjid app's data/.test(r)), 'must be a hard refusal');
});

test('network_mode cannot join another app private network', () => {
  // The service-level way to join an existing network, which bypasses the top-level
  // `networks:` map entirely because it needs no entry there to inspect. Verified against
  // real Docker: the container joined the network AND resolved the other container by name,
  // so it reaches UNPUBLISHED ports with no host port, no proxy, and none of the Fabric
  // broker's manifest-grant authorization.
  for (const net of ['omos-students_default', 'openmasjid_default', 'OMOS-Students_default']) {
    const { refusals } = checkCompose(`services:\n  app:\n    image: x\n    network_mode: ${net}`);
    assert.ok(refusals.some((r) => /private network/.test(r)), `${net} must be refused`);
  }
});

test('ordinary network_mode values are unaffected', () => {
  // `bridge`/`default` are clean; `host` remains the danger it always was; a non-reserved
  // external network stays deliberately unflagged (see checkExternalNetworks for why).
  for (const mode of ['bridge', 'default', 'my-homelab-net']) {
    const { dangers, refusals } = checkCompose(`services:\n  app:\n    image: x\n    network_mode: ${mode}`);
    assert.deepEqual(refusals, [], mode);
    assert.deepEqual(dangers, [], mode);
  }
  const host = checkCompose('services:\n  app:\n    image: x\n    network_mode: host');
  assert.ok(host.dangers.some((d) => /host networking/.test(d)));
});
