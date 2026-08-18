// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * OpenMasjidOS Fabric app-to-app broker.
 *
 *   POST /api/fabric/app/:targetAppId/:capability/:method
 *     X-OpenMasjid-App-Secret: <the CALLER app's secret>
 *     Content-Type: application/json   <JSON body, passed through>
 *
 * The platform is the trusted middle-man for app↔app calls (e.g. Donations asking
 * the Students app for a family's balance). Apps never learn each other's
 * addresses or secrets — the broker resolves the target from the app registry and
 * presents the TARGET's own secret so the target knows the call truly came from
 * the platform. Invariants (do NOT regress):
 *   - LAN-only: the route is under /api/fabric, so the front-door viaTunnel guard
 *     (registerFabricTunnelGuard) 404s tunnel-origin requests before it runs.
 *   - Authorize by STATIC manifest grants: caller.consumes must contain
 *     "<target>/<capability>" AND target.provides must contain the capability.
 *   - Target URL is built ONLY from the registry (the app's published host port, reached
 *     via system/app-host.ts) and validated path segments — never from
 *     request-controlled data. No SSRF.
 *   - Strip every caller-supplied identity/forwarding/hop-by-hop header; inject
 *     only the trusted X-OpenMasjid-App-Secret (target's) + X-OpenMasjid-Caller-App.
 *   - JSON only, bodies ≤256 KB each way, 10 s timeout, no redirects, per-caller
 *     rate limit. Broker-generated failures use the { fabric_error } envelope so a
 *     consumer can tell "platform couldn't route this" from "the target said no".
 *   - Never log request/response bodies (they can carry minors' PII + payment data).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { findFabricApp, getFabricApp, getFabricSecret, getInstalled, type FabricApp } from '../apps/manager';
import { appHost } from '../system/app-host';
import { log } from '../logger';
import {
  CodedError,
  FABRIC_DEFAULT_TIMEOUT_MS,
  FABRIC_MAX_BODY,
  proxyToTarget,
  type BrokerCode,
} from './proxy';

const MAX_BODY = FABRIC_MAX_BODY; // 256 KB, each direction
const DEFAULT_TIMEOUT_MS = FABRIC_DEFAULT_TIMEOUT_MS;
const DEFAULT_RATE_MAX = Number.parseInt(process.env.OPENMASJID_FABRIC_BROKER_RATE ?? '', 10) || 60;
const RATE_WINDOW_MS = 60_000;
const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CAPABILITY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const METHOD_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A fixed-window rate limiter. State is per-registration (created in
 *  registerAppLink) so tests are isolated and the limiter can't leak across apps. */
function makeRateLimiter() {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string, now: number, max: number): boolean => {
    if (hits.size > 5000) for (const [k, w] of hits) if (w.resetAt <= now) hits.delete(k);
    const w = hits.get(key);
    if (!w || w.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
      return true;
    }
    if (w.count >= max) return false;
    w.count += 1;
    return true;
  };
}

function fabricError(reply: FastifyReply, status: number, code: BrokerCode, message: string) {
  return reply.code(status).send({ fabric_error: { code, message } });
}

/** Injectable dependencies so the broker is testable without Docker. */
export interface AppLinkDeps {
  resolveCaller: (secret: string | null) => FabricApp | null;
  getTargetApp: (id: string) => FabricApp | null;
  getTargetSecret: (id: string) => string | null;
  getTarget: (id: string) => Promise<{ running: boolean; port: number | null } | null>;
  targetHost: string;
  timeoutMs: number;
  rateMax: number;
  now: () => number;
}

function defaultDeps(): AppLinkDeps {
  return {
    resolveCaller: (s) => findFabricApp(s),
    getTargetApp: (id) => getFabricApp(id),
    getTargetSecret: (id) => getFabricSecret(id),
    getTarget: async (id) => {
      const a = await getInstalled(id);
      return a ? { running: a.running, port: a.ports[0] ?? null } : null;
    },
    // How the core reaches an app's published host port — one definition, shared with
    // the reverse proxies and the WhatsApp gateway client (system/app-host.ts).
    targetHost: appHost(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    rateMax: DEFAULT_RATE_MAX,
    now: () => Date.now(),
  };
}

export function registerAppLink(server: FastifyInstance, overrides?: Partial<AppLinkDeps>): void {
  const deps: AppLinkDeps = { ...defaultDeps(), ...overrides };
  const callerRateOk = makeRateLimiter();

  server.post('/api/fabric/app/:targetAppId/:capability/:method', async (req, reply) => {
    const started = deps.now();
    const { targetAppId, capability, method } = req.params as {
      targetAppId: string;
      capability: string;
      method: string;
    };

    // 1. Authenticate the CALLER (constant-time inside findFabricApp). Never reveal
    //    whether the target exists on an auth failure.
    const presented = req.headers['x-openmasjid-app-secret'];
    const caller = deps.resolveCaller(typeof presented === 'string' ? presented : null);
    if (!caller) return fabricError(reply, 401, 'unauthorized', 'Unknown or missing app secret.');

    // 2. Per-caller rate limit.
    if (!callerRateOk(caller.id, started, deps.rateMax)) {
      return fabricError(reply, 429, 'rate_limited', 'Too many requests — slow down.');
    }

    // 3. Validate the path shape (also guards the outbound URL we build below).
    if (!APP_ID_RE.test(targetAppId) || !CAPABILITY_RE.test(capability) || !METHOD_RE.test(method)) {
      return fabricError(reply, 400, 'bad_request', 'Invalid target app, capability, or method.');
    }

    // 4. Authorize by STATIC manifest grants (both sides must agree).
    const grant = `${targetAppId}/${capability}`;
    const target = deps.getTargetApp(targetAppId);
    if (!caller.consumes.includes(grant) || !target || !target.provides.includes(capability)) {
      return fabricError(reply, 403, 'not_granted', 'This app is not allowed to call that capability.');
    }

    // 5. Resolve the target: installed + running + a published port + a secret.
    const resolved = await deps.getTarget(targetAppId);
    if (!resolved) return fabricError(reply, 503, 'target_not_installed', 'The target app is not installed.');
    if (!resolved.running || resolved.port == null) {
      return fabricError(reply, 503, 'target_unreachable', 'The target app is not running right now.');
    }
    const targetSecret = deps.getTargetSecret(targetAppId);
    if (!targetSecret) return fabricError(reply, 503, 'target_unreachable', 'The target app is not reachable right now.');

    // 6. JSON body, size-limited (Fastify already parsed it; re-serialize to forward).
    let body: Buffer;
    try {
      body = Buffer.from(JSON.stringify(req.body ?? {}));
    } catch {
      return fabricError(reply, 400, 'bad_request', 'The request body must be JSON.');
    }
    if (body.length > MAX_BODY) {
      return fabricError(reply, 413, 'payload_too_large', 'The request body is too large (max 256 KB).');
    }

    // 7. Proxy. capability/method are validated to a safe charset, so the path is safe.
    try {
      const out = await proxyToTarget({
        host: deps.targetHost,
        port: resolved.port,
        path: `/fabric/${capability}/${method}`,
        body,
        targetSecret,
        callerId: caller.id,
        timeoutMs: deps.timeoutMs,
      });
      // Log metadata ONLY — never bodies.
      log.info(
        `Fabric broker: ${caller.id} → ${targetAppId}/${capability}/${method} → ${out.status} (${deps.now() - started}ms)`,
      );
      reply.code(out.status);
      if (out.contentType) reply.header('content-type', out.contentType);
      return reply.send(out.body);
    } catch (err) {
      const code = err instanceof CodedError ? err.code : 'target_unreachable';
      log.warn(`Fabric broker: ${caller.id} → ${targetAppId}/${capability}/${method} failed (${code}).`);
      const status = code === 'timeout' ? 504 : code === 'response_too_large' ? 502 : 503;
      return fabricError(reply, status, code, brokerMessage(code));
    }
  });
}

function brokerMessage(code: BrokerCode): string {
  switch (code) {
    case 'timeout':
      return 'The target app took too long to respond.';
    case 'response_too_large':
      return 'The target app’s response was too large.';
    default:
      return 'The target app is not reachable right now.';
  }
}
