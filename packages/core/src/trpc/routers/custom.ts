// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Third-party / custom apps (advanced, opt-in — CLAUDE.md §11). Gated server-
 * side on the allowCustomApps setting. The pasted compose is always parsed and
 * risk-checked before anything runs; dangerous stacks need an explicit ack.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { getSettings } from '../../settings/store';
import { checkCompose } from '../../apps/compose-validate';
import { findPortConflicts, remapPorts } from '../../apps/ports';
import { installCustomApp, listInstalled } from '../../apps/manager';
import { slugify } from '../../util/slug';

const portRemapInput = z.record(z.string(), z.number().int().min(1).max(65535)).optional();

function ensureEnabled() {
  if (!getSettings().allowCustomApps) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Custom apps are turned off. Enable them in Settings → Advanced first.',
    });
  }
}

function safeCheck(text: string) {
  try {
    return checkCompose(text);
  } catch (err) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
  }
}

/** Some findings are never acknowledgeable — a stack that reaches into another
 *  app's data is refused outright, however emphatically the admin agrees. */
function refuseIfBlocked(refusals: string[]): void {
  if (refusals.length === 0) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: `This app tries to open another app’s data, so it can’t be installed. ${refusals[0]}`,
  });
}

export const customRouter = router({
  /** Pre-flight: parse + risk-check a pasted compose, and flag port conflicts. */
  check: protectedProcedure
    .input(z.object({ compose: z.string().min(1) }))
    .mutation(async ({ input }) => {
      ensureEnabled();
      const { services, dangers, refusals } = safeCheck(input.compose);
      const { conflicts } = await findPortConflicts(input.compose);
      return { services, dangers, refusals, conflicts, ok: dangers.length === 0 && refusals.length === 0 };
    }),

  install: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(60),
        compose: z.string().min(1),
        env: z.record(z.string(), z.string()).default({}),
        icon: z.string().url().optional(),
        acknowledgeRisk: z.boolean().optional(),
        portRemap: portRemapInput,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      ensureEnabled();
      const compose = input.portRemap ? remapPorts(input.compose, input.portRemap) : input.compose;
      const { dangers, refusals } = safeCheck(compose);
      refuseIfBlocked(refusals);
      if (dangers.length > 0 && !input.acknowledgeRisk) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This app needs powerful permissions. Please confirm you understand the risk.',
        });
      }
      // Re-check ports on the final compose so we never start into a taken port.
      const { conflicts } = await findPortConflicts(compose);
      if (conflicts.length > 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Some ports are already in use: ${conflicts.map((c) => c.hostPort).join(', ')}. Please choose different ones.`,
        });
      }

      // Build a unique id: custom-<slug>, adding a numeric suffix if taken.
      const installed = await listInstalled();
      const taken = new Set(installed.map((a) => a.id));
      const base = `custom-${slugify(input.name)}`;
      let id = base;
      let n = 2;
      while (taken.has(id)) id = `${base}-${n++}`;

      try {
        return await installCustomApp({
          id,
          name: input.name,
          composeText: compose,
          env: input.env,
          icon: input.icon,
          baseUrl: ctx.host,
        });
      } catch (err) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err as Error).message });
      }
    }),
});
