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
import { hasLogo } from '../store/branding';
import { getSettings } from '../settings/store';
import { desiredBaseUrl } from '../system/platform-address';
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

async function sendViaResend(
  to: string,
  subject: string,
  text: string,
  html: string | undefined,
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
      // No attachments. The masjid logo used to ride along here as a `content_id`
      // inline image; it is now a remote <img> (or the wordmark), because a client
      // lists ANY part with a filename in its attachment row and Resend exposes no
      // content_disposition field to say otherwise. See brandedEmail.
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
    // No attachments — see the note in sendViaResend and in brandedEmail.
  });
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

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

/**
 * The masjid logo as an internet-reachable URL, or undefined.
 *
 * WHY NOT A CID ATTACHMENT ANY MORE: it used to be, and that is exactly what the
 * "the logo comes as an attachment" report was. The MIME was never wrong —
 * nodemailer emits a canonical `multipart/related` with `Content-Disposition:
 * inline` and a `Content-ID`, and Resend's `content_id` is its documented (and
 * only) inline lever, with no disposition field to set. Mail clients simply list
 * ANY part that carries a filename in their attachment row, inline or not, and no
 * sender-side option changes that reliably: dropping the filename is the only
 * thing that alters the MIME, and it breaks inline rendering in Outlook and
 * Thunderbird while making other clients label the part "noname". So the only
 * provider-independent fix is to send no attachment at all.
 *
 * Same predicate as the webhook avatar in notify.ts, for the same reason: the
 * recipient's mail provider fetches the image from ITS network, so a LAN address
 * is useless. Only a configured Cloudflare tunnel gives a URL that resolves.
 * Without one the wordmark carries the branding instead.
 */
function remoteLogoUrl(): string | undefined {
  if (!hasLogo()) return undefined;
  const cf = getSettings().cloudflare;
  if (!cf?.enabled || !cf.domain) return undefined;
  const domain = String(cf.domain)
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  return domain ? `https://${domain}/api/public/logo` : undefined;
}

/** The masjid's name, as the admin already set it for outgoing mail. */
function masjidName(): string {
  return (getEmailConfig().fromName || 'OpenMasjidOS').trim();
}

export interface BrandedEmailOpts {
  /** The H1. Keep it short — it is the subject too. */
  title: string;
  /** Lead line. Also the FIRST line of the plain-text body, i.e. the snippet. */
  summary: string;
  detail?: string;
  facts?: { label: string; value: string }[];
  action?: { label: string; note: string; path: string };
}

/** Escaped label/value rows. Table-based: a real client, not a browser. */
function factRows(facts: { label: string; value: string }[]): string {
  return facts
    .map(
      (f) =>
        `<tr>` +
        `<td style="padding:6px 12px 6px 0;font-size:13px;color:#7c8a86;white-space:nowrap">${escapeHtml(f.label)}</td>` +
        `<td style="padding:6px 0;font-size:13px;color:#22302c;font-weight:600">${escapeHtml(f.value)}</td>` +
        `</tr>`,
    )
    .join('');
}

/**
 * Build the HTML and plain-text bodies for one OS email.
 *
 * Returns BOTH parts on purpose. The plain-text half is not a throwaway: it is
 * what mail clients show as the inbox snippet, and getting it wrong is half of
 * what "the text looks weird" meant. So `summary` leads, the footer sits below a
 * `--` separator where no snippet can reach it, and nothing repeats the subject.
 *
 * HTML is deliberately old-fashioned — nested tables, inline styles, no flex or
 * grid — because Outlook renders with Word's engine. Nothing here is an
 * attachment, so no client can show a paperclip.
 */
export function brandedEmail(opts: BrandedEmailOpts): { html: string; text: string } {
  const name = masjidName();
  const logoUrl = remoteLogoUrl();
  const base = desiredBaseUrl();
  const actionUrl = opts.action ? `${base}${opts.action.path === '/' ? '' : opts.action.path}` : '';
  const isLanUrl = /^https?:\/\/\d{1,3}(\.\d{1,3}){3}/.test(base);

  // ── HTML ────────────────────────────────────────────────────────────────────
  // A preheader: clients show this after the subject in the list, so give it the
  // summary rather than letting them scrape the header markup.
  const preheader =
    `<div style="display:none;font-size:1px;color:#f4f6f5;max-height:0;overflow:hidden">${escapeHtml(opts.summary)}</div>`;
  const logoImg = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(name)}" width="140" style="max-height:52px;max-width:140px;display:block;margin:0 auto 10px;border:0">`
    : '';
  // The wordmark is ALWAYS rendered, never conditional on the image: a client that
  // blocks remote images (Outlook, and Gmail's ask-first mode) would otherwise
  // leave the email headerless.
  const wordmark =
    `<div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#7c8a86;font-weight:600">${escapeHtml(name)}</div>`;
  const facts = opts.facts?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 0"><tbody>${factRows(opts.facts)}</tbody></table>`
    : '';
  const button =
    opts.action && actionUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0"><tr>` +
        `<td style="background:#1fa37a;border-radius:8px">` +
        `<a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">${escapeHtml(opts.action.label)}</a>` +
        `</td></tr></table>` +
        `<div style="margin:10px 0 0;font-size:13px;color:#7c8a86">${escapeHtml(opts.action.note)}</div>` +
        (isLanUrl
          ? `<div style="margin:6px 0 0;font-size:12px;color:#98a2a0">That link only works on the masjid's own network.</div>`
          : '')
      : '';
  const detail = opts.detail
    ? `<p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#5c6b66">${escapeHtml(opts.detail)}</p>`
    : '';

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>${escapeHtml(opts.title)}</title></head>` +
    `<body style="margin:0;background:#f4f6f5;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">` +
    preheader +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">` +
    `<tr><td style="padding:26px 32px 0;text-align:center">${logoImg}${wordmark}</td></tr>` +
    `<tr><td style="padding:20px 32px 30px">` +
    `<h1 style="margin:0;font-size:19px;line-height:1.35;color:#0e1814;font-weight:600">${escapeHtml(opts.title)}</h1>` +
    `<p style="margin:10px 0 0;font-size:15px;line-height:1.6;color:#33403c">${escapeHtml(opts.summary)}</p>` +
    detail +
    facts +
    button +
    `</td></tr>` +
    `<tr><td style="padding:16px 32px 22px;border-top:1px solid #e5e9e7">` +
    `<div style="font-size:12px;line-height:1.55;color:#98a2a0">` +
    `Sent by OpenMasjidOS, your masjid's server. ` +
    `To choose which alerts you get, open Settings and find Alerts.` +
    `</div></td></tr>` +
    `</table></td></tr></table></body></html>`;

  // ── Plain text ──────────────────────────────────────────────────────────────
  const lines: string[] = [opts.summary];
  if (opts.detail) lines.push('', opts.detail);
  if (opts.facts?.length) {
    lines.push('');
    for (const f of opts.facts) lines.push(`${f.label}: ${f.value}`);
  }
  if (opts.action && actionUrl) {
    lines.push('', `${opts.action.note.replace(/^Then /, 'Open OpenMasjidOS, then ')}`, actionUrl);
    if (isLanUrl) lines.push("(That link only works on the masjid's own network.)");
  }
  // `--` keeps the footer out of any client's snippet window.
  lines.push('', '--', "Sent by OpenMasjidOS, your masjid's server.", 'To choose which alerts you get, open Settings and find Alerts.');
  return { html, text: lines.join('\n') };
}

/**
 * Send a branded OS email — admin alerts and the "send test email" button.
 *
 * App mail (POST /api/fabric/email) does NOT come through here: it calls sendEmail
 * directly, so an app's own HTML goes out verbatim and never picks up the
 * platform's branding. That boundary is deliberate (§3 — apps stay at arm's
 * length) and is pinned by a test.
 */
export async function sendBrandedEmail(
  input: { to: string; subject?: string } & BrandedEmailOpts,
  appId = 'os',
): Promise<EmailResult> {
  const { html, text } = brandedEmail(input);
  return sendEmail({ to: input.to, subject: input.subject ?? input.title, text, html }, appId);
}
