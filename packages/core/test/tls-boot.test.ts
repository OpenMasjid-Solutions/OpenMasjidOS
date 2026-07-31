// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A damaged TLS certificate must never stop the daemon from booting
 * [OPENMASJIDOS-011].
 *
 * The brick: `ensureCert()` only checked that cert.pem and key.pem EXISTED, and
 * `loadCert()` was a bare `readFileSync` — so corrupt bytes flowed straight into
 * `Fastify({ https })`. Node builds the TLS context inside that constructor, which
 * sits OUTSIDE the try/catch that wraps reading the cert, so it threw, reached
 * `main().catch`, and called `process.exit(1)`. Under `restart: unless-stopped`
 * that is a permanent crash-loop: no dashboard to repair the cert from, and both
 * installer paths that a volunteer would reach for (Update and Repair) just re-read
 * the same bad file. On a wall-mounted display that means a masjid with no way back.
 *
 * Confirmed reachable, not theoretical: cert.pem lives under the data dir, so an
 * SD card losing power mid-write, a truncated write, a restore that brought over
 * one file of the pair, or the dashboard's own File Explorer can all produce it.
 *
 * The load-bearing test here is `the real boot sequence survives …`, which drives
 * the actual three steps in the order index.ts runs them. Every case in it threw
 * before this fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
type Tls = typeof import('../src/system/tls');

// openssl is how the platform makes a cert, so the suite needs it to build fixtures.
// It ships in the Alpine runtime image and on CI; fail loudly rather than skipping
// silently, because a quiet skip here would look like a green boot-path guarantee.
const haveOpenssl = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
assert.ok(haveOpenssl, 'these tests need openssl on PATH (present in the runtime image and on CI)');

/** Load system/tls.ts fresh against an empty data dir. */
function freshTls(): { tls: Tls; dir: string; certPath: string; keyPath: string; metaPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tls-'));
  process.env.OPENMASJID_DATA_DIR = dir;
  for (const m of ['../src/config', '../src/system/system', '../src/system/tls']) {
    delete req.cache[req.resolve(m)];
  }
  const tlsDir = path.join(dir, 'config', 'tls');
  return {
    tls: req('../src/system/tls') as Tls,
    dir,
    certPath: path.join(tlsDir, 'cert.pem'),
    keyPath: path.join(tlsDir, 'key.pem'),
    metaPath: path.join(tlsDir, 'cert.json'),
  };
}

/** A valid, unrelated cert+key pair — stands in for "a different box". */
function otherPair(): { cert: string; key: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-other-'));
  const cert = path.join(dir, 'c.pem');
  const key = path.join(dir, 'k.pem');
  const r = spawnSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=other'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `openssl fixture failed: ${r.stderr}`);
  return { cert: fs.readFileSync(cert, 'utf8'), key: fs.readFileSync(key, 'utf8') };
}

const other = otherPair();

/**
 * Every way the pair on disk can be present-but-unusable. Each returns the bytes to
 * write, given a known-good pair. `null` means "leave this file as the good one".
 */
const CORRUPTIONS: Array<{ name: string; cert?: (good: string) => string; key?: (good: string) => string }> = [
  { name: 'cert emptied', cert: () => '' },
  { name: 'key emptied', key: () => '' },
  { name: 'both emptied', cert: () => '', key: () => '' },
  { name: 'cert is whitespace', cert: () => '   \n\n' },
  { name: 'cert zeroed by a dying SD card', cert: () => '\0'.repeat(128) },
  { name: 'cert truncated mid-PEM', cert: (g) => g.slice(0, 200) },
  { name: 'key truncated mid-PEM', key: (g) => g.slice(0, 200) },
  { name: 'cert replaced by garbage', cert: () => 'not a certificate at all' },
  { name: 'cert lost its END line', cert: (g) => g.replace(/-----END CERTIFICATE-----\s*$/, '') },
  // The partial-restore case: both files are individually valid PEM, but they are
  // not a pair. Nothing short of checkPrivateKey catches this one.
  { name: 'key from a different box (partial restore)', key: () => other.key },
];

/** Stage a healthy install, then corrupt it per `c`. Returns the fresh module. */
function stageCorrupt(c: (typeof CORRUPTIONS)[number], type: 'self-signed' | 'custom' = 'self-signed') {
  const h = freshTls();
  h.tls.generateSelfSigned(); // a real, healthy starting point
  if (type === 'custom') {
    // Mark it as an admin-uploaded cert without changing the bytes, so the test
    // covers "we replaced YOUR cert" reporting.
    const meta = JSON.parse(fs.readFileSync(h.metaPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(h.metaPath, JSON.stringify({ ...meta, type: 'custom' }));
  }
  const goodCert = fs.readFileSync(h.certPath, 'utf8');
  const goodKey = fs.readFileSync(h.keyPath, 'utf8');
  if (c.cert) fs.writeFileSync(h.certPath, c.cert(goodCert));
  if (c.key) fs.writeFileSync(h.keyPath, c.key(goodKey));
  return h;
}

test('the real boot sequence survives every kind of damaged certificate', () => {
  // This is the regression test for the brick. It runs exactly what index.ts runs,
  // in order. Before the fix, the Fastify/createServer step threw for all of these.
  for (const c of CORRUPTIONS) {
    const h = stageCorrupt(c);
    h.tls.ensureCert(); // must repair rather than pass the damage along
    const pair = h.tls.loadCert(); // must not hand back unusable bytes
    // The step that actually crashed the daemon. https.createServer builds the same
    // secure context the Fastify constructor does.
    assert.doesNotThrow(() => https.createServer({ cert: pair.cert, key: pair.key }), `boot must survive: ${c.name}`);
    // And what it recovered to is genuinely usable, not merely non-throwing.
    assert.equal(h.tls.certPairProblem(pair.cert, pair.key), null, c.name);
  }
});

test('a healthy certificate is left byte-for-byte alone', () => {
  // Churning the cert on every boot would re-trigger the browser warning on every
  // device on the masjid's LAN — a self-heal that fires when nothing is wrong is
  // its own bug.
  const h = freshTls();
  h.tls.generateSelfSigned();
  const before = { cert: fs.readFileSync(h.certPath), key: fs.readFileSync(h.keyPath) };
  const fingerprint = h.tls.certInfo()?.fingerprint;
  for (let i = 0; i < 3; i++) h.tls.ensureCert();
  assert.deepEqual(fs.readFileSync(h.certPath), before.cert, 'cert.pem must not be rewritten');
  assert.deepEqual(fs.readFileSync(h.keyPath), before.key, 'key.pem must not be rewritten');
  assert.equal(h.tls.certInfo()?.fingerprint, fingerprint);
  assert.equal(h.tls.certInfo()?.recovered, undefined, 'nothing was wrong, so nothing was recovered');
});

test('a brand-new install still generates a certificate', () => {
  // The pre-existing behaviour this fix must not disturb.
  const h = freshTls();
  assert.equal(fs.existsSync(h.certPath), false);
  h.tls.ensureCert();
  assert.ok(fs.existsSync(h.certPath) && fs.existsSync(h.keyPath));
  assert.equal(h.tls.certPairProblem(fs.readFileSync(h.certPath), fs.readFileSync(h.keyPath)), null);
  assert.equal(h.tls.certInfo()?.type, 'self-signed');
});

test('one missing file regenerates the pair rather than mixing old with new', () => {
  for (const drop of ['cert', 'key'] as const) {
    const h = freshTls();
    h.tls.generateSelfSigned();
    const keptPath = drop === 'cert' ? h.keyPath : h.certPath;
    const kept = fs.readFileSync(keptPath);
    fs.rmSync(drop === 'cert' ? h.certPath : h.keyPath);
    h.tls.ensureCert();
    assert.notDeepEqual(fs.readFileSync(keptPath), kept, `${drop} missing must regenerate BOTH halves`);
    assert.equal(h.tls.certPairProblem(fs.readFileSync(h.certPath), fs.readFileSync(h.keyPath)), null);
  }
});

test('damaged files are quarantined, not deleted', () => {
  // They may be an admin's own cert, and what broke is worth being able to inspect.
  const h = stageCorrupt({ name: 'garbage', cert: () => 'garbage-cert-bytes' });
  h.tls.ensureCert();
  assert.equal(fs.readFileSync(`${h.certPath}.broken`, 'utf8'), 'garbage-cert-bytes');
  assert.ok(fs.existsSync(`${h.keyPath}.broken`), 'the key is moved aside with its cert');
});

test('replacing an uploaded certificate is recorded so the admin can be told', () => {
  const h = stageCorrupt({ name: 'truncated', cert: (g) => g.slice(0, 120) }, 'custom');
  h.tls.ensureCert();
  const info = h.tls.certInfo();
  assert.ok(info, 'a usable cert must be reported after recovery');
  assert.equal(info.type, 'self-signed', 'the box is now on a self-signed cert');
  assert.equal(info.recovered?.replaced, 'custom', 'so the UI can say "re-upload yours"');
  assert.match(info.recovered?.reason ?? '', /certificate/i);
  assert.ok(Date.parse(info.recovered?.at ?? ''), 'the recovery is timestamped');
  // The reason is shown to a volunteer and must stay free of key material.
  assert.doesNotMatch(info.recovered?.reason ?? '', /BEGIN|PRIVATE|-----/);
});

test('a self-heal is not re-run on the next boot', () => {
  const h = stageCorrupt({ name: 'garbage', cert: () => 'garbage' });
  h.tls.ensureCert();
  const healed = fs.readFileSync(h.certPath);
  // Assert it actually healed first — otherwise "unchanged" would also be true of a
  // no-op ensureCert that left the garbage in place, and this test would pass for
  // precisely the wrong reason.
  assert.equal(h.tls.certPairProblem(healed, fs.readFileSync(h.keyPath)), null, 'precondition: it healed');
  h.tls.ensureCert();
  assert.deepEqual(fs.readFileSync(h.certPath), healed, 'the healed cert is now the healthy case');
});

test('regenerating or uploading clears the recovery notice', () => {
  // Once the admin has acted, the banner must go away.
  const h = stageCorrupt({ name: 'garbage', cert: () => 'garbage' }, 'custom');
  h.tls.ensureCert();
  assert.ok(h.tls.certInfo()?.recovered, 'precondition: the notice is showing');

  h.tls.generateSelfSigned();
  assert.equal(h.tls.certInfo()?.recovered, undefined, 'Regenerate clears it');

  const h2 = stageCorrupt({ name: 'garbage', cert: () => 'garbage' }, 'custom');
  h2.tls.ensureCert();
  h2.tls.setCustomCert(other.cert, other.key);
  assert.equal(h2.tls.certInfo()?.recovered, undefined, 'uploading your own cert clears it');
  assert.equal(h2.tls.certInfo()?.type, 'custom');
});

test('loadCert refuses unusable bytes instead of returning them', () => {
  // Every caller treats a throw here as "skip TLS", which is a recoverable outcome.
  // Returning the bytes pushes the failure into createServer, which is not.
  for (const c of CORRUPTIONS) {
    const h = stageCorrupt(c);
    assert.throws(() => h.tls.loadCert(), /unusable/i, c.name);
  }
});

test('certPairProblem accepts a good pair and names each way a pair can be bad', () => {
  const h = freshTls();
  h.tls.generateSelfSigned();
  const cert = fs.readFileSync(h.certPath);
  const key = fs.readFileSync(h.keyPath);
  assert.equal(h.tls.certPairProblem(cert, key), null);
  assert.match(h.tls.certPairProblem('', key) ?? '', /certificate file/i);
  assert.match(h.tls.certPairProblem(cert, '') ?? '', /private key file/i);
  assert.match(h.tls.certPairProblem(cert, other.key) ?? '', /matching pair/i);
  // An EC key against an RSA cert makes checkPrivateKey throw rather than return
  // false — it must still be reported, not propagate.
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.match(
    h.tls.certPairProblem(cert, ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string) ?? '',
    /matching pair/i,
  );
});

test('a corrupt cert.json does not break reporting or recovery', () => {
  // The meta file sits on the same card as the cert, and it feeds the UI.
  for (const meta of ['{"type":', '', '[]', 'null', '{"type":"nonsense"}']) {
    const h = freshTls();
    h.tls.generateSelfSigned();
    fs.writeFileSync(h.metaPath, meta);
    assert.doesNotThrow(() => h.tls.certInfo(), `certInfo must survive meta=${JSON.stringify(meta)}`);
    assert.doesNotThrow(() => h.tls.ensureCert());
    assert.ok(h.tls.certInfo(), `a readable cert is still reported: meta=${JSON.stringify(meta)}`);
  }
});

test('generateSelfSigned refuses to record a cert openssl did not actually write', (t) => {
  // Exit code 0 and "the bytes are on disk" are two different facts — a full disk
  // gives you the first without the second, and recording that as a good cert is
  // exactly how the boot path gets handed something it dies on.
  if (process.platform === 'win32') {
    t.skip('needs a PATH shim, which Windows cannot exec without an extension');
    return;
  }
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-shim-'));
  fs.writeFileSync(path.join(shimDir, 'openssl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const h = freshTls();
  const realPath = process.env.PATH;
  process.env.PATH = shimDir; // openssl now "succeeds" and writes nothing
  try {
    assert.throws(() => h.tls.generateSelfSigned(), /unusable/i, 'a silent openssl failure must not be recorded');
    assert.equal(fs.existsSync(h.metaPath), false, 'no meta is written for a cert that does not exist');
  } finally {
    process.env.PATH = realPath;
  }
});

test('index.ts keeps a plain-HTTP fallback around the HTTPS listener', () => {
  // Structural backstop: the tests above prove system/tls.ts hands over a good
  // pair, but the thing that actually killed the process was the constructor call
  // in index.ts being unguarded. If someone inlines Fastify({https}) back into the
  // boot path with no fallback, the brick returns and nothing above would notice.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.match(src, /buildServer\(null\)/, 'the boot path must be able to rebuild the server without TLS');
  const guarded = /try\s*\{[^}]*buildServer\(tls\)[\s\S]{0,600}?catch/.test(src);
  assert.ok(guarded, 'constructing the HTTPS server must sit inside a try/catch that falls back');
});
