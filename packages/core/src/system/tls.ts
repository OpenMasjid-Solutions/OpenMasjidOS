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
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Server as HttpsServer } from 'node:https';
import { CONFIG_DIR } from '../config';
import { networkInfo } from './system';
import { log } from '../logger';

const TLS_DIR = path.join(CONFIG_DIR, 'tls');
const CERT_PATH = path.join(TLS_DIR, 'cert.pem');
const KEY_PATH = path.join(TLS_DIR, 'key.pem');
const META_PATH = path.join(TLS_DIR, 'cert.json');

export type CertType = 'self-signed' | 'custom';
interface CertMeta {
  type: CertType;
  generatedAt: string;
}

function readMeta(): CertMeta {
  try {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf8')) as CertMeta;
  } catch {
    return { type: 'self-signed', generatedAt: '' };
  }
}

function writeMeta(meta: CertMeta): void {
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/** The names/addresses the self-signed cert should be valid for. */
function subjectAltNames(): string {
  const net = networkInfo();
  const dns = new Set<string>(['openmasjidos.local', net.localDomain, 'localhost']);
  const ips = new Set<string>(['127.0.0.1', '::1', ...net.addresses]);
  return [
    ...[...dns].filter(Boolean).map((d) => `DNS:${d}`),
    ...[...ips].filter(Boolean).map((ip) => `IP:${ip}`),
  ].join(',');
}

/** (Re)generate a self-signed cert covering the box's LAN names + addresses. */
export function generateSelfSigned(): void {
  fs.mkdirSync(TLS_DIR, { recursive: true });
  const res = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', KEY_PATH, '-out', CERT_PATH,
      '-days', '3650', // long-lived: a LAN appliance shouldn't make admins re-accept yearly
      '-subj', '/CN=openmasjidos.local',
      '-addext', `subjectAltName=${subjectAltNames()}`,
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(`openssl could not generate a certificate: ${res.stderr || res.error?.message || 'unknown error'}`);
  }
  try {
    fs.chmodSync(KEY_PATH, 0o600);
  } catch {
    /* best effort (e.g. non-POSIX dev) */
  }
  writeMeta({ type: 'self-signed', generatedAt: new Date().toISOString() });
  log.info('Generated a self-signed TLS certificate for the dashboard.');
}

/** Ensure a cert+key exist; generate a self-signed pair if not. */
export function ensureCert(): void {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) return;
  generateSelfSigned();
}

export function loadCert(): { cert: Buffer; key: Buffer } {
  return { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) };
}

/** Validate + install an admin-supplied cert + key (bring-your-own). */
export function setCustomCert(certPem: string, keyPem: string): void {
  let x509: crypto.X509Certificate;
  try {
    x509 = new crypto.X509Certificate(certPem);
  } catch {
    throw new Error("That certificate isn't valid PEM. Paste the full certificate, including the BEGIN/END lines.");
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(keyPem);
  } catch {
    throw new Error("That private key isn't valid PEM. Paste the full key, including the BEGIN/END lines.");
  }
  if (!x509.checkPrivateKey(key)) {
    throw new Error('The certificate and private key do not match.');
  }
  fs.mkdirSync(TLS_DIR, { recursive: true });
  fs.writeFileSync(CERT_PATH, certPem.endsWith('\n') ? certPem : certPem + '\n', 'utf8');
  fs.writeFileSync(KEY_PATH, keyPem.endsWith('\n') ? keyPem : keyPem + '\n', 'utf8');
  try {
    fs.chmodSync(KEY_PATH, 0o600);
  } catch {
    /* best effort */
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
}

export function certInfo(): CertInfo | null {
  try {
    const x509 = new crypto.X509Certificate(fs.readFileSync(CERT_PATH));
    return {
      type: readMeta().type,
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
