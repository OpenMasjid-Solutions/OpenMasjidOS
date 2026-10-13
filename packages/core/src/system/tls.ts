// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * TLS certificate lifecycle for the dashboard's forced-HTTPS listener.
 *
 * The platform is reached on a LAN at openmasjidos.local / a private IP, where a
 * public CA (Let's Encrypt) can't issue a cert — so we default to a self-signed
 * cert generated on first boot (browsers show a one-time "proceed" warning per
 * device, which is inherent to self-signed). Admins who own a real domain can
 * upload their own cert + key instead ("bring your own"). Cert + key live under
 * the data dir so they persist across upgrades.
 *
 * Cert generation shells to `openssl` (present in the Alpine runtime image). In
 * local dev (no openssl) this throws and the daemon falls back to plain HTTP.
 *
 * **The cert files are boot-critical, so nothing here trusts them on sight**
 * [OPENMASJIDOS-011]. Node builds the TLS context inside the Fastify constructor,
 * so handing it a damaged cert throws *before* the daemon has a server to catch it
 * with — the process exits, Docker restarts it under `restart: unless-stopped`, and
 * the box crash-loops with no dashboard to repair it from. `ensureCert` therefore
 * checks the *content* of what's on disk (not merely that the files exist),
 * quarantines anything unusable, and generates a fresh self-signed pair so the
 * dashboard comes back. A browser warning is a bad day; an unreachable masjid
 * display on a wall is a much worse one.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Server as HttpsServer } from 'node:https';
import { CONFIG_DIR } from '../config';
import { networkInfo } from './system';
import { desiredAddress } from './platform-address';
import { log } from '../logger';

const TLS_DIR = path.join(CONFIG_DIR, 'tls');
const CERT_PATH = path.join(TLS_DIR, 'cert.pem');
const KEY_PATH = path.join(TLS_DIR, 'key.pem');
const META_PATH = path.join(TLS_DIR, 'cert.json');
// A new pair is written here, checked, and only then renamed over the live one.
const NEW_CERT_PATH = `${CERT_PATH}.new`;
const NEW_KEY_PATH = `${KEY_PATH}.new`;

export type CertType = 'self-signed' | 'custom';

/** Recorded when a damaged cert had to be replaced automatically at boot, so the
 *  admin can be told why their certificate changed instead of just meeting a new
 *  browser warning. Cleared as soon as they regenerate or upload one themselves. */
export interface CertRecovery {
  at: string;
  /** What kind of cert was replaced — 'custom' means the admin needs to re-upload. */
  replaced: CertType;
  /** Plain-language reason, safe to show: never contains key material. */
  reason: string;
}

interface CertMeta {
  type: CertType;
  generatedAt: string;
  recovered?: CertRecovery;
}

function readMeta(): CertMeta {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    // The meta file is as corruptible as the cert beside it, and it feeds the UI.
    // Anything that isn't a plain object reads as "self-signed, unknown age".
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    return raw as CertMeta;
  } catch {
    return { type: 'self-signed', generatedAt: '' };
  }
}

function writeMeta(meta: CertMeta): void {
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/** The names/addresses the self-signed cert should be valid for. */
function subjectAltNames(): string {
  const info = networkInfo();
  const dns = new Set<string>(['openmasjidos.local', info.localDomain, 'localhost']);
  // In the container the interfaces are the bridge's; the LAN address everyone opens
  // comes from the installer (or the last address the dashboard was reached on).
  const lan = desiredAddress();
  const ips = new Set<string>(['127.0.0.1', '::1', ...info.addresses, ...(lan ? [lan] : [])]);
  return [
    ...[...dns].filter(Boolean).map((d) => `DNS:${d}`),
    // IP literals only: one bad `IP:` entry makes openssl fail, and the box drops to plain HTTP.
    ...[...ips].filter((ip) => net.isIP(ip) !== 0).map((ip) => `IP:${ip}`),
  ].join(',');
}

type PairProblem = 'cert' | 'key' | 'mismatch' | 'refused';

/**
 * What is wrong with a cert+key pair, or null if it's fine.
 *
 * The same checks Node makes when it builds a secure context — parse the cert, parse the
 * key, confirm they belong together — and then that context itself, which also refuses a
 * key or signature below OpenSSL's security level (a 512-bit RSA key, say). So "passes
 * this" means "the Fastify constructor won't throw". Verified against every realistic
 * corruption mode: an empty file, whitespace, zero bytes from a dying SD card, a write
 * truncated mid-PEM, outright garbage, and — the partial-restore case — a valid cert
 * paired with a valid key from a *different* box.
 */
function pairProblem(cert: Buffer | string, key: Buffer | string): PairProblem | null {
  let x509: crypto.X509Certificate;
  try {
    x509 = new crypto.X509Certificate(cert);
  } catch {
    return 'cert';
  }
  let priv: crypto.KeyObject;
  try {
    priv = crypto.createPrivateKey(key);
  } catch {
    return 'key';
  }
  try {
    if (!x509.checkPrivateKey(priv)) return 'mismatch';
  } catch {
    // Throws rather than returning false when the two are different key types.
    return 'mismatch';
  }
  try {
    tls.createSecureContext({ cert, key });
  } catch {
    return 'refused';
  }
  return null;
}

/** Each problem in plain language: logged, and shown to the admin after a recovery. */
const PROBLEM_REASON: Record<PairProblem, string> = {
  cert: "the certificate file isn't readable as a certificate",
  key: "the private key file isn't readable as a private key",
  mismatch: 'the certificate and private key are not a matching pair',
  refused: "the certificate's key or signature is too weak for a secure connection",
};

/** Why a cert+key pair can't be used, in plain language — or null if it's fine. */
export function certPairProblem(cert: Buffer | string, key: Buffer | string): string | null {
  const problem = pairProblem(cert, key);
  return problem ? PROBLEM_REASON[problem] : null;
}

/** Why the pair at these paths can't be used, or null. Unreadable counts as a problem. */
function storedCertProblem(certPath = CERT_PATH, keyPath = KEY_PATH): string | null {
  let cert: Buffer;
  let key: Buffer;
  try {
    cert = fs.readFileSync(certPath);
    key = fs.readFileSync(keyPath);
  } catch (err) {
    return `the certificate files could not be read (${(err as Error).message})`;
  }
  return certPairProblem(cert, key);
}

/**
 * Put the new pair (NEW_CERT_PATH / NEW_KEY_PATH) in place of the live one if it is
 * usable; otherwise discard it and say why. Writing straight over the live files meant
 * a failure part-way (a full disk) left a broken pair, and a box only on plain HTTP.
 */
function installNewPair(): string | null {
  const problem = storedCertProblem(NEW_CERT_PATH, NEW_KEY_PATH);
  if (problem) {
    discardNewPair();
    return problem;
  }
  try {
    fs.chmodSync(NEW_KEY_PATH, 0o600);
  } catch {
    /* best effort (e.g. non-POSIX dev) */
  }
  fs.renameSync(NEW_KEY_PATH, KEY_PATH);
  fs.renameSync(NEW_CERT_PATH, CERT_PATH);
  return null;
}

function discardNewPair(): void {
  for (const p of [NEW_CERT_PATH, NEW_KEY_PATH]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* best effort — the next attempt overwrites it */
    }
  }
}

/**
 * Move damaged cert files aside instead of deleting them. They may be an admin's
 * own certificate, and what broke is worth being able to look at afterwards. Purely
 * best-effort: the new pair is renamed over both paths anyway, so a failure here never
 * blocks recovery.
 */
function quarantineBroken(): void {
  for (const p of [CERT_PATH, KEY_PATH]) {
    try {
      fs.rmSync(`${p}.broken`, { force: true });
      fs.renameSync(p, `${p}.broken`);
    } catch {
      /* best effort — recovery proceeds regardless */
    }
  }
}

/** (Re)generate a self-signed cert covering the box's LAN names + addresses. */
export function generateSelfSigned(recovered?: CertRecovery): void {
  fs.mkdirSync(TLS_DIR, { recursive: true });
  const res = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', NEW_KEY_PATH, '-out', NEW_CERT_PATH,
      '-days', '3650', // long-lived: a LAN appliance shouldn't make admins re-accept yearly
      '-subj', '/CN=openmasjidos.local',
      '-addext', `subjectAltName=${subjectAltNames()}`,
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    discardNewPair();
    throw new Error(`openssl could not generate a certificate: ${res.stderr || res.error?.message || 'unknown error'}`);
  }
  // Don't trust exit code 0 on its own. A full disk can leave openssl "successful"
  // having written a truncated or empty file, and recording that as a good cert is
  // how we'd hand the boot path something it dies on. (Same lesson as the backup
  // writer: the tool's exit status and the bytes actually on disk are two facts.)
  const problem = installNewPair();
  if (problem) {
    throw new Error(`openssl reported success but the certificate it wrote is unusable: ${problem}`);
  }
  writeMeta({ type: 'self-signed', generatedAt: new Date().toISOString(), ...(recovered ? { recovered } : {}) });
  log.info('Generated a self-signed TLS certificate for the dashboard.');
}

/**
 * Ensure a cert+key exist AND are usable; otherwise generate a self-signed pair.
 *
 * Checking existence alone was the boot brick: `readFileSync` happily returns
 * corrupt bytes, so a damaged file sailed through to the Fastify constructor and
 * killed the process. A healthy cert is left byte-for-byte alone — this must not
 * churn the cert (and re-trigger every device's browser warning) on every boot.
 */
export function ensureCert(): void {
  if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
    generateSelfSigned();
    return;
  }
  const problem = storedCertProblem();
  if (!problem) return;

  const replaced = readMeta().type;
  log.error(
    `The stored TLS certificate is unusable: ${problem}. Replacing it with a fresh self-signed certificate so the dashboard stays reachable` +
      (replaced === 'custom' ? ' — your uploaded certificate will need to be re-added in Settings → Advanced.' : '.'),
  );
  quarantineBroken();
  generateSelfSigned({ at: new Date().toISOString(), replaced, reason: problem });
}

/**
 * The cert+key for a TLS listener. Throws if what's on disk is unusable, rather
 * than returning bytes that make `createServer` throw somewhere less recoverable —
 * every caller already treats a throw here as "skip TLS", which is a safe outcome.
 */
export function loadCert(): { cert: Buffer; key: Buffer } {
  const cert = fs.readFileSync(CERT_PATH);
  const key = fs.readFileSync(KEY_PATH);
  const problem = certPairProblem(cert, key);
  if (problem) throw new Error(`The stored TLS certificate is unusable: ${problem}`);
  return { cert, key };
}

/** What the admin is told when an uploaded pair is refused (shown as is). */
const UPLOAD_REFUSAL: Record<PairProblem, string> = {
  cert: "That certificate isn't valid PEM. Paste the full certificate, including the BEGIN/END lines.",
  key: "That private key isn't valid PEM. Paste the full key, including the BEGIN/END lines.",
  mismatch: 'The certificate and private key do not match.',
  refused:
    "That certificate can't be used to secure the dashboard — its key or signature is too weak. Please use one with at least a 2048-bit key.",
};

/** Validate + install an admin-supplied cert + key (bring-your-own). */
export function setCustomCert(certPem: string, keyPem: string): void {
  // The same checks the boot path makes, so a pair that would stop HTTPS is never stored.
  const problem = pairProblem(certPem, keyPem);
  if (problem) throw new Error(UPLOAD_REFUSAL[problem]);
  try {
    fs.mkdirSync(TLS_DIR, { recursive: true });
    fs.writeFileSync(NEW_CERT_PATH, certPem.endsWith('\n') ? certPem : certPem + '\n', 'utf8');
    fs.writeFileSync(NEW_KEY_PATH, keyPem.endsWith('\n') ? keyPem : keyPem + '\n', { encoding: 'utf8', mode: 0o600 });
    const written = installNewPair();
    if (written) throw new Error(written);
  } catch (err) {
    discardNewPair();
    // The detail (a full disk, with the data path in it) is for the log, not the screen.
    log.warn(`The uploaded TLS certificate could not be saved: ${(err as Error).message}`);
    throw new Error("The certificate couldn't be saved. Please try again in a moment.");
  }
  writeMeta({ type: 'custom', generatedAt: new Date().toISOString() });
}

export interface CertInfo {
  type: CertType;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** SHA-256 fingerprint (colon-separated hex) — handy for verifying the cert. */
  fingerprint: string;
  selfSigned: boolean;
  /** Set when the platform had to replace a damaged certificate to keep booting. */
  recovered?: CertRecovery;
}

export function certInfo(): CertInfo | null {
  try {
    const x509 = new crypto.X509Certificate(fs.readFileSync(CERT_PATH));
    const meta = readMeta();
    return {
      type: meta.type,
      ...(meta.recovered ? { recovered: meta.recovered } : {}),
      subject: x509.subject,
      issuer: x509.issuer,
      validFrom: x509.validFrom,
      validTo: x509.validTo,
      fingerprint: x509.fingerprint256,
      selfSigned: x509.subject === x509.issuer,
    };
  } catch {
    return null;
  }
}

// ── Live reload ──────────────────────────────────────────────────────────────
// A new cert can be applied to the running HTTPS server without a restart, so
// "Regenerate" / "Upload" take effect immediately for new connections.
let liveServer: FastifyInstance | null = null;

export function setLiveServer(server: FastifyInstance): void {
  liveServer = server;
}

function applyLiveCert(): void {
  if (!liveServer) return;
  const srv = liveServer.server as HttpsServer;
  if (typeof srv.setSecureContext === 'function') {
    const { cert, key } = loadCert();
    srv.setSecureContext({ cert, key });
  }
}

/** Regenerate the self-signed cert and apply it live. */
export function regenerateSelfSignedLive(): void {
  generateSelfSigned();
  applyLiveCert();
}

/** Install a custom cert and apply it live. */
export function setCustomCertLive(certPem: string, keyPem: string): void {
  setCustomCert(certPem, keyPem);
  applyLiveCert();
}
