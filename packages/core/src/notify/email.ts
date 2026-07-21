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
import { getLogo } from '../store/branding';
import { log } from '../logger';

export interface EmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** An inline/attached file. `cid` makes it an inline image referenced as
 *  `cid:<cid>` in the HTML (how the masjid logo is embedded). */
export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  cid?: string;
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

async function sendViaResend(
  to: string,
  subject: string,
  text: string,
  html: string | undefined,
  attachments: EmailAttachment[],
): Promise<void> {
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
      ...(attachments.length
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: a.content.toString('base64'),
              ...(a.contentType ? { content_type: a.contentType } : {}),
              // content_id makes it inline, referenced as cid:<content_id> in html.
              ...(a.cid ? { content_id: a.cid } : {}),
            })),
          }
        : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
}

async function sendViaSmtp(
  to: string,
  subject: string,
  text: string,
  html: string | undefined,
  attachments: EmailAttachment[],
): Promise<void> {
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
  await transport.sendMail({
    from: fromHeader(),
    to,
    subject,
    text,
    html,
    attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, cid: a.cid })),
  });
}

/**
 * Send one email via the configured provider. `appId` keys the rate limit (use
 * 'os' for platform mail); `attachments` carry inline images (the masjid logo).
 * Never throws.
 */
export async function sendEmail(input: EmailInput, appId = 'os', attachments: EmailAttachment[] = []): Promise<EmailResult> {
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
    if (cfg.provider === 'resend') await sendViaResend(to, subject, text, html, attachments);
    else await sendViaSmtp(to, subject, text, html, attachments);
    return { sent: true };
  } catch (err) {
    // Never log the body; the provider error message is safe (no secrets).
    log.warn(`Email send failed (${cfg.provider}): ${(err as Error).message}`);
    return { sent: false, reason: 'error' };
  }
}

const LOGO_CID = 'omos-logo';

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

/**
 * Wrap a plain-text message in a tidy, email-client-safe HTML layout branded with
 * the masjid logo. The logo rides along as a CID inline attachment (renders more
 * reliably than a remote <img>, and works with no public URL). Returns the html +
 * the attachment to pass to sendEmail. When no logo is set, it's just clean text.
 */
export function brandedEmail(opts: { heading?: string; text: string }): { html: string; attachments: EmailAttachment[] } {
  const logo = getLogo();
  const attachments: EmailAttachment[] = [];
  let logoBlock = '';
  if (logo) {
    attachments.push({ filename: `logo.${logo.ext}`, content: logo.buf, contentType: logo.mime, cid: LOGO_CID });
    logoBlock = `<img src="cid:${LOGO_CID}" alt="" style="max-height:56px;max-width:220px;margin:0 auto 16px;display:block">`;
  }
  const heading = opts.heading
    ? `<h1 style="font-size:18px;margin:0 0 12px;color:#0e1814;font-weight:600">${escapeHtml(opts.heading)}</h1>`
    : '';
  const body = escapeHtml(opts.text).replace(/\n/g, '<br>');
  const html =
    `<!doctype html><html><body style="margin:0;background:#f4f6f5;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;padding:32px;text-align:center">` +
    `<tr><td>${logoBlock}${heading}<div style="font-size:15px;line-height:1.6;color:#33403c;text-align:left">${body}</div>` +
    `<hr style="border:none;border-top:1px solid #e5e9e7;margin:24px 0 12px">` +
    `<div style="font-size:12px;color:#98a2a0">Sent by OpenMasjidOS</div></td></tr></table>` +
    `</td></tr></table></body></html>`;
  return { html, attachments };
}

/**
 * Send a branded OS email (logo header + tidy layout) — used for admin alerts and
 * the "send test email" button. App mail (POST /api/fabric/email) keeps its OWN
 * design; the platform never rewrites an app's HTML.
 */
export async function sendBrandedEmail(input: EmailInput & { heading?: string }, appId = 'os'): Promise<EmailResult> {
  const { html, attachments } = brandedEmail({ heading: input.heading ?? input.subject, text: input.text });
  return sendEmail({ to: input.to, subject: input.subject, text: input.text, html: input.html ?? html }, appId, attachments);
}
