/**
 * OpenMasjidOS Fabric — notifications. The admin configures ONE webhook
 * (Slack / Discord / generic) in Settings; apps relay messages through the
 * platform (POST /api/fabric/notify) and never see the URL. The platform formats
 * the payload for the chosen service and posts it server-side.
 *
 * Security: apps choose only the message, never the destination — so there is no
 * SSRF vector from an app (the admin alone picks the target). We still require
 * an http(s) URL, never follow redirects, time out fast, rate-limit per app so
 * one app can't flood Slack/Discord, and neutralize broadcast/mention tokens so
 * an app's message can't mass-ping the masjid's workspace.
 */
import { getSettings } from '../settings/store';
import { log } from '../logger';

export interface NotifyInput {
  title?: string;
  text: string;
  level?: 'info' | 'success' | 'warning' | 'error';
}

export type NotifyResult = { delivered: true } | { delivered: false; reason: string };

type NotificationType = 'slack' | 'discord' | 'generic';

const TITLE_MAX = 200;
const TEXT_MAX = 2000;
const TIMEOUT_MS = 5000;

// Fixed-window rate limiting: per-app and platform-wide.
const WINDOW_MS = 60_000;
const PER_APP_MAX = 20; // messages per app per minute
const GLOBAL_MAX = 60; // platform-wide per minute
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

function clamp(s: unknown, max: number): string {
  return String(s ?? '').slice(0, max);
}

/** Stop Slack from resolving any app-supplied entity token. Escaping the leading
 *  `<` of the broadcast (<!…>), user (<@U…>) and channel (<#C…>) forms makes Slack
 *  render them as literal text instead of pinging/linking the workspace. Real
 *  links (<https…>) start with `<h` and are untouched. */
function neutralizeSlack(s: string): string {
  return s.replace(/<([!@#])/g, '&lt;$1');
}

/** Shape the message for the configured service. App text is untrusted display
 *  text — never let it resolve as a mention/broadcast. `appName` is the
 *  server-resolved sending app (an app can't forge being another). */
function buildBody(type: NotificationType, n: NotifyInput, label: string, appName: string): unknown {
  const title = clamp(n.title, TITLE_MAX).trim();
  const text = clamp(n.text, TEXT_MAX);
  // Attribution the app cannot overwrite: [workspace label · AppName].
  const tag = [label, appName].map((s) => s.trim()).filter(Boolean).join(' · ');
  const prefix = tag ? `[${tag}] ` : '';
  if (type === 'slack') {
    return { text: neutralizeSlack(prefix + (title ? `*${title}*\n${text}` : text)) };
  }
  if (type === 'discord') {
    // allowed_mentions parse:[] → @everyone/@here/role/user mentions never resolve.
    return {
      content: (prefix + (title ? `**${title}**\n${text}` : text)).slice(0, 2000),
      allowed_mentions: { parse: [] },
    };
  }
  // generic: a small, predictable JSON envelope
  return {
    source: 'openmasjidos',
    app: appName || label || undefined,
    title: title || undefined,
    text,
    level: n.level ?? 'info',
  };
}

/**
 * Deliver a notification to the configured webhook. `appId` keys the rate limit;
 * `appName` is the server-resolved sending app, stamped into the message so one
 * app can't impersonate another in the masjid's workspace (security audit).
 * Fails soft (never throws).
 */
export async function sendNotification(n: NotifyInput, appId: string, appName = ''): Promise<NotifyResult> {
  const cfg = getSettings().notifications;
  if (!cfg?.enabled || !cfg.url) return { delivered: false, reason: 'disabled' };
  if (!/^https?:\/\//i.test(cfg.url)) return { delivered: false, reason: 'bad_url' };
  if (!clamp(n.text, TEXT_MAX).trim()) return { delivered: false, reason: 'empty' };
  // Per-app first so one app over its own cap never burns the shared global
  // budget on rejected attempts (which would starve well-behaved apps).
  if (!rateOk(`app:${appId}`, PER_APP_MAX) || !rateOk('__global__', GLOBAL_MAX)) {
    return { delivered: false, reason: 'rate_limited' };
  }

  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildBody(cfg.type, n, cfg.label?.trim() || '', appName)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error', // never follow a redirect to a different host
    });
    if (!res.ok) {
      log.warn(`Notification webhook returned HTTP ${res.status}.`);
      return { delivered: false, reason: `http_${res.status}` };
    }
    return { delivered: true };
  } catch (err) {
    log.warn(`Notification webhook failed: ${(err as Error).message}`);
    return { delivered: false, reason: 'error' };
  }
}
