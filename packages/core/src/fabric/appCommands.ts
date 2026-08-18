// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The platform calling an app to RUN one of its declared commands.
 *
 *   POST http://<appHost()>:<published port>/fabric/commands/run
 *     X-OpenMasjid-App-Secret: <the app's OWN secret>
 *     X-OpenMasjid-Caller-App: omos:platform
 *     { command, text?, requestId, locale }
 *
 * This is the app-to-app broker's sibling, and it deliberately shares the broker's
 * HTTP client (fabric/proxy.ts) rather than growing a second one — the no-redirect
 * rule, the size caps and the built-from-scratch header set only hold where they are
 * written once.
 *
 * What is DIFFERENT from the broker:
 *   - there is no caller app to authenticate; the platform is asking on its own
 *     behalf, and says so with PLATFORM_CALLER_ID, a value no app id can ever be.
 *   - authorisation is the manifest declaration (`getAppCommand`), re-checked here,
 *     immediately before the call — the menu the sender is answering may predate an
 *     update that withdrew the command.
 *   - the response cap is 16 KB, not 256 KB. The answer has to fit in a chat message
 *     either way, and reading a quarter-megabyte into a Pi's memory to throw nearly
 *     all of it away is the wrong trade.
 *
 * The app's response body is NEVER echoed to the admin verbatim and NEVER logged: app
 * bodies routinely carry minors' PII and payment details.
 */
import { getAppCommand, getFabricSecret, getInstalled } from '../apps/manager';
import { appHost } from '../system/app-host';
import { log } from '../logger';
import { CodedError, FABRIC_DEFAULT_TIMEOUT_MS, PLATFORM_CALLER_ID, proxyToTarget, type BrokerCode } from './proxy';

/** A command's answer is a chat message, so it does not need the broker's 256 KB. */
const MAX_RESPONSE_BYTES = 16 * 1024;
/** The parser already caps the argument at 300 chars; this can only trip on a bug. */
const MAX_REQUEST_BYTES = 4 * 1024;
/** What an app may say back, before we trim it to the reply cap. */
const MAX_APP_TEXT = 1000;

export type AppCommandCode =
  | BrokerCode
  | 'unknown_command'
  | 'not_ready'
  /** The app worked and said no, in its own words. Show ITS message, not ours. */
  | 'app_error'
  /** The app is not honouring the contract — non-JSON, no `ok`, an HTML error page. */
  | 'bad_response'
  | 'no_secret';

export type AppCommandOutcome =
  | {
      ok: true;
      text: string;
      /**
       * The app is mid-question and wants the sender's next message.
       *
       * Opaque to us — it is the app's own handle on the conversation it is running,
       * so the platform holds no flow state of its own beyond who it belongs to.
       * While set, the platform relaxes the `!` prefix for that sender and posts
       * their next message straight back with this token.
       */
      followUpToken?: string;
    }
  | { ok: false; code: AppCommandCode; text?: string };

export interface AppCommandRequest {
  appId: string;
  commandId: string;
  /** The free text the sender typed after the command. Never the command word or `!`. */
  text?: string;
  requestId: string;
  /** Set when this message is an ANSWER to a question the app asked — the token it
   *  handed back last turn. Absent on the first call of an exchange. */
  followUpToken?: string;
}

/**
 * Strip control characters, collapse runs of blank lines, and clamp.
 *
 * An app must not be able to make its answer look like three separate messages, nor
 * blast a 4000-character wall at a volunteer's phone.
 */
function tidy(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return (
    raw
      // C0 except tab/newline, plus DEL and C1. Written as escapes on purpose:
      // literal control characters in source are invisible and get reformatted away.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_APP_TEXT)
  );
}

export async function runAppCommand(reqInput: AppCommandRequest): Promise<AppCommandOutcome> {
  const { appId, commandId, text, requestId, followUpToken } = reqInput;

  // Re-check the declaration NOW. A menu snapshot can name a command the app withdrew
  // in an update since it was shown.
  if (!getAppCommand(appId, commandId)) return { ok: false, code: 'unknown_command' };

  const installed = await getInstalled(appId);
  if (!installed) return { ok: false, code: 'target_not_installed' };
  const port = installed.ports[0];
  if (!installed.running || port == null) return { ok: false, code: 'target_unreachable' };

  const secret = getFabricSecret(appId);
  if (!secret) return { ok: false, code: 'no_secret' };

  const body = Buffer.from(
    JSON.stringify({ command: commandId, text, requestId, locale: 'en', followUpToken }),
  );
  if (body.length > MAX_REQUEST_BYTES) return { ok: false, code: 'payload_too_large' };

  const started = Date.now();
  try {
    const res = await proxyToTarget({
      host: appHost(),
      port,
      path: '/fabric/commands/run',
      body,
      targetSecret: secret,
      callerId: PLATFORM_CALLER_ID,
      timeoutMs: FABRIC_DEFAULT_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });

    // Metadata only — never the body, never the sender's number.
    log.info(`Commands: ${appId}/${commandId} → ${res.status} (${Date.now() - started}ms)`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body.toString('utf8'));
    } catch {
      // An HTML error page, an empty body, a proxy's own response — all the same to us.
      return { ok: false, code: res.status === 404 ? 'unknown_command' : 'bad_response' };
    }
    const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    if (!obj) return { ok: false, code: 'bad_response' };

    const declared = typeof obj.code === 'string' ? obj.code : '';
    if (res.status === 404 || declared === 'unknown_command') return { ok: false, code: 'unknown_command' };
    if (res.status === 503 || declared === 'not_ready') {
      return { ok: false, code: 'not_ready', text: tidy(obj.error) || undefined };
    }

    if (obj.ok === true) {
      const said = tidy(obj.text);
      // Bounded and charset-checked before it is ever echoed back: it becomes part of
      // a later request body, and an app should not be able to smuggle anything
      // through it.
      const raw = (obj.followUp as { token?: unknown } | undefined)?.token;
      const followUpToken =
        typeof raw === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(raw) ? raw : undefined;
      return { ok: true, text: said || 'Done.', followUpToken };
    }
    if (obj.ok === false) {
      // The app worked and refused, or hit a problem it can describe. Its own words
      // are far more useful to a volunteer than anything we could substitute.
      const said = tidy(obj.error);
      return said ? { ok: false, code: 'app_error', text: said } : { ok: false, code: 'bad_response' };
    }
    // `ok` missing entirely — the app is not honouring the contract.
    return { ok: false, code: 'bad_response' };
  } catch (err) {
    const code: AppCommandCode = err instanceof CodedError ? err.code : 'target_unreachable';
    log.warn(`Commands: ${appId}/${commandId} failed (${code}).`);
    return { ok: false, code };
  }
}
