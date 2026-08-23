// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Admin commands over WhatsApp (Settings → WhatsApp → Commands): the master switch,
 * who may send them, and a per-scope × per-person grid. Admin-only, like every other
 * router here.
 *
 * The one rule worth stating: `setScope` refuses a grant for a scope that cannot
 * currently be granted, rather than storing one the reader would ignore — the same
 * discipline setAlertChannel follows. Availability is ALSO enforced on read in
 * commands/registry.ts, so a stale grant left in the file by a hand edit still
 * confers nothing.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { TRPCError } from '@trpc/server';
import {
  addCommandPerson,
  areCommandsEnabled,
  listCommandPeople,
  removeCommandPerson,
  renameCommandPerson,
  setCommandScope,
  setCommandsEnabled,
} from '../../store/commands';
import { isGrantable, listGrants, listNamespaces } from '../../commands/registry';
import { inboundStatus, observedEventShapes } from '../../notify/whatsapp-inbound';
import { gatewayTraffic } from '../../notify/whatsapp';
import { menuText } from '../../commands/reply';
import { getAdminName, getAdminPhone } from '../../auth/store';

const phone = z.string().trim().min(6).max(24);
const label = z.string().trim().min(1).max(60);
const scopeKey = z.string().min(1).max(80);

/** Turn a store error ("that needs a country code") into a friendly 400. */
function bad(err: unknown): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
}

export const commandsRouter = router({
  get: protectedProcedure.query(() => ({
    enabled: areCommandsEnabled(),
    people: listCommandPeople(),
    grants: listGrants(),
    /** Offered as a one-click "add my number" — never granted automatically. That
     *  number was collected as an alert destination, not as an authenticator. */
    adminPhone: getAdminPhone(),
    adminName: getAdminName(),
  })),

  status: protectedProcedure.query(() => inboundStatus()),

  /**
   * Ask the GATEWAY what it has received from WhatsApp, and pair it with what WE
   * received from the gateway.
   *
   * The two numbers together are the whole diagnosis, and neither is enough alone:
   *   gateway heard nothing        → the engine is deaf; nothing on our side matters
   *   gateway heard it, we did not → the emit or our socket
   *   both heard it, none ran      → our gate dropped it, and `dropped` says why
   *
   * Read-only, and it reads counts and timestamps — never a message body.
   */
  probe: protectedProcedure.mutation(async () => ({
    gateway: await gatewayTraffic(),
    inbound: inboundStatus(),
    // The shapes of frames the filter discarded — key names only, never values. Purely
    // diagnostic: it is how we find out whether WhatsApp delivery receipts reach this
    // socket, since OpenWA documents neither its event names nor their payloads.
    shapes: observedEventShapes(),
  })),

  setEnabled: protectedProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      setCommandsEnabled(input.enabled);
      return { ok: true };
    }),

  addPerson: protectedProcedure
    .input(z.object({ phone, label, scopes: z.array(scopeKey).max(64).optional() }))
    .mutation(({ input }) => {
      try {
        return { people: addCommandPerson(input.phone, input.label, input.scopes ?? []) };
      } catch (err) {
        bad(err);
      }
    }),

  renamePerson: protectedProcedure
    .input(z.object({ phone, label }))
    .mutation(({ input }) => {
      try {
        return { people: renameCommandPerson(input.phone, input.label) };
      } catch (err) {
        bad(err);
      }
    }),

  removePerson: protectedProcedure
    .input(z.object({ phone }))
    .mutation(({ input }) => ({ people: removeCommandPerson(input.phone) })),

  setScope: protectedProcedure
    .input(z.object({ phone, scope: scopeKey, allowed: z.boolean() }))
    .mutation(({ input }) => {
      if (input.allowed && !isGrantable(input.scope)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That app does not offer any WhatsApp commands.',
        });
      }
      try {
        return { people: setCommandScope(input.phone, input.scope, input.allowed) };
      } catch (err) {
        bad(err);
      }
    }),

  /** The literal text a volunteer would receive, so an admin can see what they are
   *  granting before they grant it. Read-only — this sends nothing. */
  preview: protectedProcedure
    .input(z.object({ word: z.string().min(1).max(80) }))
    .query(({ input }) => {
      const ns = listNamespaces().find((n) => n.word === input.word);
      return { text: ns ? menuText(ns) : '' };
    }),
});
