// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Stripe account vault (Settings → Payments). Admin-only CRUD over named Stripe
 * accounts. `list` returns a sanitized view (no secret/webhook values); the full
 * keys are only ever handed to an installed app over the secret-gated Fabric
 * endpoint (api/fabric.ts → GET /api/fabric/stripe).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { listAccountsPublic, listAccountsInternal, upsertAccount, removeAccount } from '../../store/stripe';

// Cache the online/offline result briefly so opening Settings doesn't hammer
// Stripe (or block on the network) on every render.
const statusCache = new Map<string, { at: number; online: boolean }>();
const STATUS_TTL_MS = 60_000;

/** Is this secret key valid + Stripe reachable? GET /v1/balance → 200 means yes. */
async function pingStripe(secretKey: string): Promise<boolean> {
  if (!secretKey) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch('https://api.stripe.com/v1/balance', {
      headers: { authorization: `Bearer ${secretKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export const stripeRouter = router({
  list: protectedProcedure.query(() => listAccountsPublic()),

  /** Per-account online/offline (green/red dot): is the secret key valid and is
   *  Stripe reachable? Cached ~60s. */
  status: protectedProcedure.query(async () => {
    const out: { id: string; online: boolean }[] = [];
    for (const a of listAccountsInternal()) {
      const cached = statusCache.get(a.id);
      let online: boolean;
      if (cached && Date.now() - cached.at < STATUS_TTL_MS) {
        online = cached.online;
      } else {
        online = await pingStripe(a.secretKey);
        statusCache.set(a.id, { at: Date.now(), online });
      }
      out.push({ id: a.id, online });
    }
    return out;
  }),

  save: protectedProcedure
    .input(
      z.object({
        id: z.string().max(80).optional(),
        label: z.string().trim().min(1, 'Give this account a name.').max(60),
        // Publishable key may be left blank on update (keeps the existing one).
        publishableKey: z.string().trim().max(255),
        // Secret key: blank on update = keep existing; required on create.
        // Webhook secret: omitted = keep existing; '' = clear it (it is optional).
        secretKey: z.string().trim().max(255).optional(),
        webhookSecret: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(({ input }) => {
      try {
        const saved = upsertAccount(input);
        // The dot must show the new key's answer now, not the old key's for up to a minute.
        statusCache.delete(saved.id);
        return saved;
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => {
      removeAccount(input.id);
      statusCache.delete(input.id);
      return { ok: true };
    }),
});
