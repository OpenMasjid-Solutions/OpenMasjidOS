// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The ONE HTTP client the platform uses to call an installed app.
 *
 * Two callers today: the app-to-app broker (fabric/appLink.ts, relaying one app's
 * call to another) and admin commands (fabric/appCommands.ts, the platform calling
 * an app on its own behalf). They differ only in who the call is FROM; everything
 * that makes the call safe is here, once:
 *
 *   - Raw http.request, so redirects are NEVER followed. An app that answers 302
 *     must not be able to point the platform at another host.
 *   - The header set is built from scratch. Nothing caller-supplied survives, and
 *     the target's own secret is what proves to it that the platform sent this.
 *   - Both directions are size-capped and the response is aborted mid-stream once
 *     it goes over, so a runaway app cannot exhaust a Pi's memory.
 *   - Bodies are never logged. They routinely carry minors' PII and payment data.
 *
 * If you need a third way to reach an app, add an option here rather than a second
 * client — test/fabric-proxy-shared.test.ts fails the build if one appears.
 */
import http from 'node:http';

/** 256 KB, each direction — the broker's long-standing cap. */
export const FABRIC_MAX_BODY = 256 * 1024;
export const FABRIC_DEFAULT_TIMEOUT_MS = 10_000;

export type BrokerCode =
  | 'unauthorized'
  | 'not_granted'
  | 'bad_request'
  | 'target_not_installed'
  | 'target_unreachable'
  | 'timeout'
  | 'payload_too_large'
  | 'response_too_large'
  | 'rate_limited';

export class CodedError extends Error {
  constructor(public code: BrokerCode) {
    super(code);
  }
}

export interface ProxyResult {
  status: number;
  contentType?: string;
  body: Buffer;
}

/**
 * Who the platform says it is when it calls an app on its own behalf, rather than
 * relaying for another app.
 *
 * The colon is load-bearing. Every app id is validated against `^[a-z0-9][a-z0-9-]*$`
 * at the store router, the catalog build and the apps directory, and that charset has
 * no colon — so this value can never BE an app id, and the broker (which only ever
 * emits an authenticated caller's real id) can never produce it. An app can therefore
 * trust `X-OpenMasjid-Caller-App: omos:platform` as firmly as it trusts the secret.
 * That is a guarantee by construction, not by an allow-list somebody has to maintain.
 */
export const PLATFORM_CALLER_ID = 'omos:platform';

/**
 * POST a JSON body to an app's published host port and return its response,
 * size-capped. Rejects with a CodedError on connect failure, timeout or oversize.
 */
export function proxyToTarget(opts: {
  host: string;
  port: number;
  path: string;
  body: Buffer;
  /** The TARGET's own secret — how it knows the call really came from the platform. */
  targetSecret: string;
  /** The calling app's id, or PLATFORM_CALLER_ID when the platform itself is asking. */
  callerId: string;
  timeoutMs: number;
  /** Response cap. Defaults to the broker's 256 KB; the command path passes 16 KB,
   *  because a command's answer has to fit in a chat message either way. */
  maxResponseBytes?: number;
}): Promise<ProxyResult> {
  const maxResponse = opts.maxResponseBytes ?? FABRIC_MAX_BODY;
  return new Promise((resolve, reject) => {
    const upstream = http.request(
      {
        host: opts.host,
        port: opts.port,
        method: 'POST',
        path: opts.path,
        headers: {
          'content-type': 'application/json',
          'content-length': String(opts.body.length),
          accept: 'application/json',
          // Trusted identity, set by the platform — the ONLY way the target learns
          // the call is genuine + who the caller is. Caller-supplied copies were
          // never forwarded (we build this header set from scratch).
          'x-openmasjid-app-secret': opts.targetSecret,
          'x-openmasjid-caller-app': opts.callerId,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooBig = false;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxResponse) {
            tooBig = true;
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (tooBig) return reject(new CodedError('response_too_large'));
          resolve({
            status: res.statusCode ?? 502,
            contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', () => reject(new CodedError('target_unreachable')));
      },
    );
    upstream.on('error', () => reject(new CodedError('target_unreachable')));
    upstream.setTimeout(opts.timeoutMs, () => {
      upstream.destroy();
      reject(new CodedError('timeout'));
    });
    upstream.end(opts.body);
  });
}
