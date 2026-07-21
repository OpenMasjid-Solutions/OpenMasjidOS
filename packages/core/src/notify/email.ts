// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Email sender. Dispatches to the admin-configured provider (SMTP via nodemailer,
 * or Resend via its HTTPS API). Used by OS admin alerts and, over the Fabric, by
 * apps (POST /api/fabric/email) — so an app never handles mail credentials or the
 * From address. Fails soft (never throws); the caller decides how to surface it.
 */
import nodemailer from 'nodemailer';
import { getEmailConfig, isEmailConfigured, type EmailConfig } from '../store/email';
import { log } from '../logger';

export interface EmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type EmailResult = { sent: true } | { sent: false; reason: string };

const SUBJECT_MAX = 300;
const BODY_MAX = 100_000; // 100 KB of text/html
const TIMEOUT_MS = 15_000;

// Basic, deliberately-strict single-address check (no display names / lists here —
// the platform sends one recipient per call).
const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

/** Is this a syntactically valid single email address? (Used for the From address
 *  and recipients.) */
export function isValidEmail(addr: string): boolean {
  return EMAIL_RE.test(String(addr ?? '').trim());
}

/**
 * Verify a provider config WITHOUT sending an email — so "Save" can reject a broken
 * config instead of silently storing it. SMTP: nodemailer verify() (connect + auth).
 * Resend: an authenticated GET; a 401 means the API key is wrong (a restricted-scope
 * key that authenticates but lacks that scope still passes — it's a valid key). Takes
 * the config explicitly so the router can check the would-be-saved (unsaved) values.
 */
export async function verifyEmailConfig(cfg: EmailConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    if (cfg.provider === 'resend') {
      if (!cfg.resend.apiKey) return { ok: false, error: 'No Resend API key.' };
      const res = await fetch('https://api.resend.com/domains', {
        headers: { authorization: `Bearer ${cfg.resend.apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401) return { ok: false, error: 'Resend rejected the API key.' };
      if (res.status >= 500) return { ok: false, error: `Resend is unavailable (HTTP ${res.status}) — try again.` };
      // 200 (valid) or 403 (valid but scope-restricted) → the key authenticated.
      return { ok: true };
    }
    if (cfg.provider === 'smtp') {
      if (!cfg.smtp.host) return { ok: false, error: 'No SMTP host.' };
      const transport = nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.secure,
        auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
      });
      await transport.verify(); // connects + authenticates, sends nothing
      return { ok: true };
    }
    return { ok: true }; // 'none' — nothing to verify
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  }
}

// Fixed-window rate limiting: per-app and platform-wide, so one app can't turn the
// masjid's mailbox into a spam cannon.
const WINDOW_MS = 60_000;
const PER_APP_MAX = 30;
const GLOBAL_MAX = 100;
const windows = new Map<string, { count: number; resetAt: number }>();

function rateOk(key: string, max: number): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (w.count >= max) return false;
  w.count += 1;
  return true;
}

function fromHeader(): string {
  const cfg = getEmailConfig();
  return cfg.fromName ? `${cfg.fromName} <${cfg.fromEmail}>` : cfg.fromEmail;
}

async function sendViaResend(to: string, subject: string, text: string, html: string | undefined): Promise<void> {
  const cfg = getEmailConfig();
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.resend.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: fromHeader(), // "Name <from@domain>" or bare address
      to: [to],
      subject,
      text,
      ...(html ? { html } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
}

async function sendViaSmtp(to: string, subject: string, text: string, html: string | undefined): Promise<void> {
  const cfg = getEmailConfig();
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure, // true for 465; false uses STARTTLS on 587
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  await transport.sendMail({ from: fromHeader(), to, subject, text, html });
}

/**
 * Send one email via the configured provider. `appId` keys the rate limit (use
 * 'os' for platform mail). Never throws.
 */
export async function sendEmail(input: EmailInput, appId = 'os'): Promise<EmailResult> {
  if (!isEmailConfigured()) return { sent: false, reason: 'not_configured' };
  const to = String(input.to ?? '').trim();
  if (!EMAIL_RE.test(to)) return { sent: false, reason: 'bad_recipient' };
  const subject = String(input.subject ?? '').slice(0, SUBJECT_MAX).trim();
  const text = String(input.text ?? '').slice(0, BODY_MAX);
  const html = input.html ? String(input.html).slice(0, BODY_MAX) : undefined;
  if (!subject || (!text && !html)) return { sent: false, reason: 'empty' };
  if (!rateOk(`app:${appId}`, PER_APP_MAX) || !rateOk('__global__', GLOBAL_MAX)) {
    return { sent: false, reason: 'rate_limited' };
  }

  const cfg = getEmailConfig();
  try {
    if (cfg.provider === 'resend') await sendViaResend(to, subject, text, html);
    else await sendViaSmtp(to, subject, text, html);
    return { sent: true };
  } catch (err) {
    // Never log the body; the provider error message is safe (no secrets).
    log.warn(`Email send failed (${cfg.provider}): ${(err as Error).message}`);
    return { sent: false, reason: 'error' };
  }
}
