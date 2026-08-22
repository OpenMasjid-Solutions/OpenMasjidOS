// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WhatsApp gateway config (Settings → WhatsApp). Admin-only, and deliberately shaped
 * like the email router: the OpenWA API key is a secret (config/whatsapp.json, chmod
 * 600) and is never returned here — `get` is a sanitized view with an "is set" flag.
 *
 * `link` issues a pairing code so the admin links the phone by typing a code into
 * WhatsApp, rather than photographing a QR off a headless server.
 *
 * `test` sends one real message to the admin's own number and WAITS for the answer,
 * because a test the admin is watching needs a result on screen — so it bypasses the
 * paced queue (see notify/whatsapp.ts `sendTestMessage`). Every other send goes
 * through the queue.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import {
  getWhatsAppConfigPublic,
  saveWhatsAppConfig,
  deleteWhatsAppConfig,
  isWhatsAppConfigured,
  markLinked,
  approveGroup,
  unapproveGroup,
  renameGroup,
  DEFAULT_LIMITS,
} from '../../store/whatsapp';
import {
  gatewayStatus,
  requestPairingCode,
  sendTestMessage,
  sendTestToGroup,
  queueDepth,
  toDigits,
  listGatewayGroups,
  unlinkSession,
  deleteGatewaySession,
  clearWhatsAppRuntime,
} from '../../notify/whatsapp';
import { getAdminPhone } from '../../auth/store';
import { getInstalled, restartApp, startApp, verifyStayedUp, removeApp } from '../../apps/manager';
import { clearQueueStore } from '../../notify/whatsapp-queue-store';
import { clearWhatsAppChannels } from '../../notify/alerts';
import { setCommandsEnabled, clearCommandPeople } from '../../store/commands';
import { reconcileWhatsAppInbound } from '../../notify/whatsapp-inbound';
import { OPENWA_APP_ID } from '../../apps/managed';

/** Bounds mirror `clampLimits` in the store, which is the real enforcement — this is
 *  only so the UI gets a friendly error instead of a silent clamp. */
const limitsInput = z
  .object({
    minGapSeconds: z.number().int().min(3).max(600),
    jitterSeconds: z.number().int().min(1).max(600),
    perRecipientCooldownSeconds: z.number().int().min(0).max(86_400),
    warmupDays: z.number().int().min(0).max(90),
    groupPerHour: z.number().int().min(1).max(20),
    groupPerDay: z.number().int().min(1).max(50),
    perGroupCooldownSeconds: z.number().int().min(0).max(86_400),
  })
  .partial();

/**
 * The gateway app's own state, for the Settings panel.
 *
 * Returned from here so the UI never hardcodes the catalog id: `apps/managed.ts` decides
 * which app is the gateway, and that same decision is what hides it from the dashboard
 * and the store. `openPort`/`https` mirror an installed app's fields so the UI can build
 * its address with the helper it already uses for every other app.
 */
async function gatewayApp(): Promise<{
  id: string;
  installed: boolean;
  running: boolean;
  openPort: number | null;
  https: boolean;
}> {
  const app = await getInstalled(OPENWA_APP_ID);
  return {
    id: OPENWA_APP_ID,
    installed: Boolean(app),
    running: app?.running ?? false,
    openPort: app?.openPort ?? null,
    https: app?.https ?? false,
  };
}

export const whatsappRouter = router({
  get: protectedProcedure.query(async () => ({
    ...getWhatsAppConfigPublic(),
    /** The conservative starting point, so the UI can offer "restore defaults". */
    defaults: DEFAULT_LIMITS,
    queued: queueDepth(),
    /**
     * The gateway app itself, so Settings can offer "install it" or "open it" without
     * the UI hardcoding a catalog id — the platform decides which app is the gateway
     * (`apps/managed.ts`), and it is deliberately invisible everywhere else.
     */
    gateway: await gatewayApp(),
  })),

  /**
   * Start or restart the gateway app.
   *
   * It has to live here because the gateway is deliberately hidden from the dashboard
   * grid and the dock (`apps/managed.ts`) — which also removed the only Start button
   * in the product. A masjid whose gateway stopped therefore had no way to start it
   * again short of a root terminal, which is exactly when they can least afford one.
   *
   * Verifies rather than assuming: `compose up` exits 0 the moment a container is
   * created, so a gateway that boots and dies would otherwise report a cheerful
   * success. On failure the container's own last words come back with the result, so
   * the reason is on screen instead of behind the logs button.
   */
  restartGateway: protectedProcedure.mutation(async () => {
    const app = await getInstalled(OPENWA_APP_ID);
    if (!app) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'OpenWA is not installed.' });
    try {
      // `startApp` runs `compose up`, which RECREATES the container when its config
      // changed — that is what makes this the recovery path after a settings fix, not
      // just a bounce.
      if (app.running) await restartApp(OPENWA_APP_ID);
      else await startApp(OPENWA_APP_ID);
    } catch (err) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err as Error).message });
    }
    const output = await verifyStayedUp(OPENWA_APP_ID);
    return { ok: output === null, output: output ?? undefined };
  }),

  /**
   * Live status for the panel's dot. Deliberately reports reachable and connected
   * SEPARATELY: "the gateway is up but the phone isn't linked" is a completely
   * different problem from "the gateway is down", and collapsing them into one
   * boolean sends the admin looking in the wrong place.
   */
  status: protectedProcedure.query(async () => {
    const s = await gatewayStatus();
    return { ...s, configured: isWhatsAppConfigured(), queued: queueDepth() };
  }),

  save: protectedProcedure
    .input(
      z.object({
        provider: z.enum(['none', 'openwa']).optional(),
        /** Blank = discover an OpenWA installed from the App Store (the normal path). */
        baseUrl: z.string().trim().max(300).optional(),
        /** Blank = keep the stored key, so changing a limit never re-pastes a secret. */
        apiKey: z.string().max(300).optional(),
        /** Only the NAME. OpenWA mints the id and the platform records it. */
        sessionName: z.string().trim().max(60).optional(),
        limits: limitsInput.optional(),
      }),
    )
    .mutation(({ input }) => {
      try {
        return saveWhatsAppConfig(input);
      } catch (err) {
        // normaliseBaseUrl throws a human message for a malformed address.
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /**
   * Ask the gateway for a pairing code, and restart the warm-up ramp.
   *
   * The ramp restart is the important part: a freshly linked number is the one
   * WhatsApp watches hardest, so it must not inherit the allowance an older number
   * earned. Linking is exactly when that happens.
   */
  link: protectedProcedure
    .input(z.object({ phone: z.string().trim().min(6).max(24) }))
    .mutation(async ({ input }) => {
      const digits = toDigits(input.phone);
      if (!digits) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That phone number needs a country code, e.g. +1 555 010 1234.',
        });
      }
      // Creating the session, STARTING it and asking for the code are one action here.
      // Doing it in the sender (rather than making the admin press three buttons) is the
      // point of managing the session ourselves: OpenWA mints a UUID and takes only a
      // name, so there is no value a volunteer could sensibly type, and "create" without
      // "start" is the state in which every link attempt answers 400.
      const r = await requestPairingCode(digits);
      if (!r.ok) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: r.error ?? "Couldn't reach the WhatsApp gateway.",
        });
      }
      markLinked(new Date().toISOString());
      return { code: r.code ?? null };
    }),

  /**
   * Unlink the phone, keeping everything else.
   *
   * The way back when a masjid changes handsets, or links the wrong number. It logs out
   * at WhatsApp (the only operation that removes the entry from the phone's Linked
   * Devices) but keeps the gateway, the key and the approved groups, so relinking is one
   * pairing code away.
   *
   * `stillLinked` is reported honestly rather than folded into a generic failure: it is
   * the one outcome where the device may remain attached to the account, and an admin who
   * is told "unlinked" would never go and check their phone.
   */
  unlink: protectedProcedure.mutation(async () => {
    const r = await unlinkSession();
    if (!r.ok && !r.stillLinked) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: r.error ?? "Couldn't unlink the number." });
    }
    return { unlinked: r.ok, stillLinked: r.stillLinked ?? false };
  }),

  /**
   * Turn WhatsApp off — and, if asked, erase every trace of it.
   *
   * Two very different actions behind one input flag, because they are two answers to the
   * same question at the same switch:
   *
   *  - `deleteEverything: false` (the default) just sets `provider: 'none'`. Every setting
   *    stays on disk, so switching back on restores the masjid's key, session, linked
   *    number, approved groups and command list exactly as they were. Nothing to re-paste,
   *    nothing to re-approve.
   *  - `deleteEverything: true` removes the gateway app with its data and clears every
   *    piece of state listed below.
   *
   * THE ORDER IS LOAD-BEARING and each step is commented with why. In particular the
   * gateway is talked to FIRST, while it is still running: once the container is gone
   * there is no way left to tell WhatsApp to release the device, and the masjid is left
   * with a linked device on their phone that nothing in this dashboard can revoke.
   *
   * Deliberately NOT cleared: the admin's own phone number on their account (it is a
   * destination for email-era alerts and a login-adjacent detail, not WhatsApp state), and
   * other apps' manifest-derived `whatsapp` grants (they come back with the manifest, and
   * removing them would misreport what those apps are allowed to do).
   */
  disable: protectedProcedure
    .input(z.object({ deleteEverything: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      if (!input.deleteEverything) {
        saveWhatsAppConfig({ provider: 'none' });
        // The inbound socket checks `isWhatsAppConfigured()`; poke it so it drops now
        // rather than up to 30s later on the next supervisor tick.
        reconcileWhatsAppInbound();
        return { deleted: false, unlinked: false, stillLinked: false, gatewayRemoved: false };
      }

      // 1. Unlink at WhatsApp while the gateway still exists and is reachable. Best
      //    effort: a masjid deleting a BROKEN install must not be blocked by the very
      //    thing that is broken, so a failure here is reported, never fatal.
      let unlinked = false;
      let stillLinked = false;
      try {
        const r = await unlinkSession();
        unlinked = r.ok;
        stillLinked = r.stillLinked ?? false;
      } catch {
        /* reported to the admin below as "couldn't unlink automatically" */
      }
      // 2. Delete the session record + stored credentials at the gateway. Only meaningful
      //    after the logout above; on its own it would leave the device linked.
      try {
        await deleteGatewaySession();
      } catch {
        /* the container and its volumes go in step 8 regardless */
      }

      // 3. Stop accepting work BEFORE removing the app. `enqueue` refuses once
      //    unconfigured, and the pump drains-and-drops instead of spinning against a
      //    gateway that is about to disappear.
      saveWhatsAppConfig({ provider: 'none' });
      // 4. Erase the config file itself — the API key cannot be blanked through `save`.
      deleteWhatsAppConfig();
      // 5. The queued messages and their bodies, on disk and in memory.
      clearQueueStore();
      clearWhatsAppRuntime();
      // 6. The alerts matrix keeps its own copy of "route this to WhatsApp", and it would
      //    otherwise re-arm silently if WhatsApp were ever set up again.
      clearWhatsAppChannels();
      // 7. Admin commands: the authorised-sender list is an authorisation model in its
      //    own right and must not outlive the transport it rides on.
      setCommandsEnabled(false);
      clearCommandPeople();
      reconcileWhatsAppInbound();

      // 8. Finally the app. `deleteData: true` is REQUIRED, not a nicety: it is what
      //    removes the Docker volumes holding the linked-device credentials and
      //    `apps/openwa/.env`, which is a second copy of the gateway API key.
      let gatewayRemoved = false;
      try {
        if (await getInstalled(OPENWA_APP_ID)) {
          await removeApp(OPENWA_APP_ID, true);
        }
        gatewayRemoved = true;
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          // Everything else is already gone, so say so — otherwise an admin retries a
          // delete that has mostly happened and gets a confusing second failure.
          message: `Your WhatsApp settings were deleted, but the gateway app could not be removed: ${
            (err as Error).message
          }`,
        });
      }
      return { deleted: true, unlinked, stillLinked, gatewayRemoved };
    }),

  /**
   * The groups the linked phone is in, straight from the gateway — for the admin to pick
   * from. ADMIN-ONLY: this is the list an app must never see, because it names every
   * group that phone belongs to, personal ones included.
   */
  groups: protectedProcedure.query(async () => {
    const r = await listGatewayGroups();
    if (!r.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: r.error ?? "Couldn't read your WhatsApp groups." });
    return r.groups ?? [];
  }),

  /** Approve a group for apps to post into (or re-label one already approved). */
  approveGroup: protectedProcedure
    .input(
      z.object({
        id: z.string().max(120),
        label: z.string().trim().max(80),
        participants: z.number().optional(),
        name: z.string().trim().max(120).optional(),
      }),
    )
    .mutation(({ input }) => {
      try {
        return approveGroup(input.id, input.label, input.participants, input.name);
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /** Rename a group — the admin's own nickname, which is the name apps see. Never
   *  touches the group in WhatsApp. */
  renameGroup: protectedProcedure
    .input(z.object({ id: z.string().max(120), label: z.string().trim().min(1).max(80) }))
    .mutation(({ input }) => {
      try {
        return renameGroup(input.id, input.label);
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /** Withdraw approval. Apps lose the ability to post there immediately. */
  unapproveGroup: protectedProcedure
    .input(z.object({ id: z.string().max(120) }))
    .mutation(({ input }) => unapproveGroup(input.id)),

  /**
   * Post a test message into an approved group, so the admin can confirm it arrives
   * before an app ever posts something real.
   *
   * Says plainly in the message that it is a test, because everyone in the group sees it
   * and an unexplained message from the masjid's number invites replies.
   */
  testGroup: protectedProcedure
    .input(z.object({ id: z.string().max(120) }))
    .mutation(async ({ input }) => {
      const r = await sendTestToGroup(
        input.id,
        'This is a test message from OpenMasjidOS. Announcements for the masjid will arrive here — no reply needed.',
      );
      if (!r.ok) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: r.error ?? "The message couldn't be sent." });
      }
      return { sent: true };
    }),

  /** Send one real message to the admin's own number to prove the setup works. */
  test: protectedProcedure
    .input(z.object({ to: z.string().trim().max(24).optional() }))
    .mutation(async ({ input }) => {
      const to = input.to?.trim() || getAdminPhone();
      if (!to) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Add your WhatsApp number in Settings → Account first, so there is somewhere to send it.',
        });
      }
      const r = await sendTestMessage(
        to,
        'This is a test message from OpenMasjidOS. If you can read this, WhatsApp alerts are working.',
      );
      if (!r.ok) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: r.error ?? "The message couldn't be sent." });
      }
      return { sent: true };
    }),
});
