// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Email provider vault. The admin configures ONE email sender here — either SMTP
 * (any mailbox) or Resend (API key) — and the platform sends on behalf of the OS
 * (admin alerts) and, over the Fabric, on behalf of apps (donation receipts, parent
 * notices, …) so no app ever handles mail credentials.
 *
 * Secrets (the SMTP password / Resend API key) live ONLY in this file under the
 * data dir (chmod 600) — never in settings.json and never in the admin-facing API
 * (which returns a sanitized view: provider + from + host/port/user + "is set"
 * flags). The full config leaves this module only to the sender (notify/email.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { readJson, writeJson } from '../util/json-store';

export type EmailProvider = 'none' | 'smtp' | 'resend';

export interface EmailConfig {
  provider: EmailProvider;
  /** The From address all mail is sent as (e.g. alerts@masjid.org). */
  fromEmail: string;
  /** Optional display name for the From header (e.g. "An-Noor Institute"). */
  fromName: string;
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
  resend: { apiKey: string };
}

interface EmailFile {
  email: EmailConfig;
}

const EMAIL_PATH = path.join(CONFIG_DIR, 'email.json');

const DEFAULT_CONFIG: EmailConfig = {
  provider: 'none',
  fromEmail: '',
  fromName: 'OpenMasjidOS',
  smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
  resend: { apiKey: '' },
};

function withDefaults(e: Partial<EmailConfig> | undefined): EmailConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(e ?? {}),
    smtp: { ...DEFAULT_CONFIG.smtp, ...(e?.smtp ?? {}) },
    resend: { ...DEFAULT_CONFIG.resend, ...(e?.resend ?? {}) },
  };
}

let cache: EmailConfig = withDefaults(readJson<EmailFile>(EMAIL_PATH, { email: DEFAULT_CONFIG }).email);

function persist(): void {
  writeJson(EMAIL_PATH, { email: cache });
  try {
    fs.chmodSync(EMAIL_PATH, 0o600);
  } catch {
    /* best effort (non-POSIX dev) */
  }
}

/** Full config incl. secrets — ONLY for the sender (notify/email.ts). */
export function getEmailConfig(): EmailConfig {
  return cache;
}

/** True when a usable provider is configured (has the creds it needs + a from). */
export function isEmailConfigured(): boolean {
  if (!cache.fromEmail) return false;
  if (cache.provider === 'smtp') return Boolean(cache.smtp.host && cache.smtp.port);
  if (cache.provider === 'resend') return Boolean(cache.resend.apiKey);
  return false;
}

/** Non-secret view for the admin UI — the SMTP password / Resend key are shown
 *  only as "is set" flags, never their values. */
export interface EmailConfigPublic {
  provider: EmailProvider;
  fromEmail: string;
  fromName: string;
  smtp: { host: string; port: number; secure: boolean; user: string };
  hasSmtpPass: boolean;
  hasResendKey: boolean;
  configured: boolean;
}

export function getEmailConfigPublic(): EmailConfigPublic {
  return {
    provider: cache.provider,
    fromEmail: cache.fromEmail,
    fromName: cache.fromName,
    smtp: { host: cache.smtp.host, port: cache.smtp.port, secure: cache.smtp.secure, user: cache.smtp.user },
    hasSmtpPass: Boolean(cache.smtp.pass),
    hasResendKey: Boolean(cache.resend.apiKey),
    configured: isEmailConfigured(),
  };
}

export interface EmailUpsert {
  provider?: EmailProvider;
  fromEmail?: string;
  fromName?: string;
  smtp?: Partial<EmailConfig['smtp']>;
  /** Blank/omitted apiKey = keep the existing Resend key (so the admin needn't re-type). */
  resend?: Partial<EmailConfig['resend']>;
}

/** Save the email config. A blank secret (smtp.pass / resend.apiKey) means "keep
 *  the existing one" so the admin never re-pastes a secret just to change a setting. */
export function saveEmailConfig(input: EmailUpsert): EmailConfigPublic {
  const next: EmailConfig = withDefaults(cache);
  if (input.provider) next.provider = input.provider;
  if (input.fromEmail !== undefined) next.fromEmail = input.fromEmail.trim();
  if (input.fromName !== undefined) next.fromName = input.fromName.trim();
  if (input.smtp) {
    if (input.smtp.host !== undefined) next.smtp.host = input.smtp.host.trim();
    if (input.smtp.port !== undefined) next.smtp.port = input.smtp.port;
    if (input.smtp.secure !== undefined) next.smtp.secure = input.smtp.secure;
    if (input.smtp.user !== undefined) next.smtp.user = input.smtp.user.trim();
    if (input.smtp.pass !== undefined && input.smtp.pass.trim()) next.smtp.pass = input.smtp.pass;
  }
  if (input.resend) {
    if (input.resend.apiKey !== undefined && input.resend.apiKey.trim()) {
      next.resend.apiKey = input.resend.apiKey.trim();
    }
  }
  cache = next;
  persist();
  return getEmailConfigPublic();
}
