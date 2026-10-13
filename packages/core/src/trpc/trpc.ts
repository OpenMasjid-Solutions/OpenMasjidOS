// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * tRPC primitives. publicProcedure is open (auth/first-run only);
 * protectedProcedure requires a valid session — every feature router uses it,
 * so nothing is reachable unauthenticated (CLAUDE.md §9).
 */
import { initTRPC, TRPCError } from '@trpc/server';
import { ZodError } from 'zod';
import type { Context } from './context';
import { isRemoteSession, verifyCsrf } from '../auth/sessions';
import { remoteAdminEnabled } from '../system/remote-admin';
import { finishing, finishingMessage, isUpdating } from '../system/update-lock';

const t = initTRPC.context<Context>().create({
  // Input-validation (zod) failures otherwise reach the client as a raw JSON
  // blob of issues in `message` (the change-password screen showed
  // `[{"code":"too_small",…}]`). Surface the first issue's friendly, already-
  // localized message instead, so every form shows a clean error.
  errorFormatter({ shape, error }) {
    if (error.cause instanceof ZodError) {
      const first = error.cause.issues[0];
      if (first?.message) return { ...shape, message: first.message };
    }
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;

const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.username) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Please sign in to continue.' });
  }
  // CSRF / session-replay defence: require the dashboard key, which no app can read —
  // on the LAN it is in the dashboard origin's storage (an app is on another port);
  // from outside, where the apps share the dashboard's origin, it is only in the page's
  // memory (system/remote-admin.ts, the key rule).
  //
  // This applies to the WebSocket transport TOO, and used to not. The old
  // exemption rested on two beliefs that are both false: that WS carries only
  // subscriptions (tRPC's WS transport executes queries and mutations as well),
  // and that the origin guard covers it (util/origin.ts returns true when there is
  // no Origin header — and a non-browser client simply omits it). The result was
  // that the session cookie ALONE drove the whole admin API, including files.read
  // over the config directory and settings.update. A WS handshake can't set a
  // header, so the key arrives as `?k=` exactly like every other raw WS route in
  // api/* already requires (see api/ws-auth.ts requestCsrfOk).
  if (!verifyCsrf(ctx.sessionToken, ctx.csrf)) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Please sign in to continue.' });
  }
  // From the remote dashboard, the door and the session are checked again on EVERY
  // call. The context was built when the request — or, for a WebSocket, the whole
  // connection — began, and a review found a connection opened before remote
  // administration was turned off still able to call anything, including the switch
  // that turns it back on. HTTP requests are gated one by one at the front door; this
  // is what holds for the ones that are not (system/remote-sockets.ts closes them).
  if (ctx.handedOver && !(remoteAdminEnabled() && isRemoteSession(ctx.sessionToken))) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Please sign in to continue.' });
  }
  return next({ ctx: { ...ctx, username: ctx.username } });
});

/**
 * NOTHING CHANGES WHILE A RESTORE RUNS. A restore replaces config/ and apps/ whole: a
 * change made before the swap is silently overwritten by the backup's — an admin who
 * changed the password and shut the door on an unexpected restore got the old password
 * and an open door back — and the settings this process holds in memory are the
 * PRE-restore ones, so a change made after the swap wrote them back over the restored
 * file. So every signed-in change waits for the restore to finish (queries still answer,
 * and signing in and out are not protected procedures). The restore's own work is not a
 * tRPC call.
 *
 * Two mutations change nothing a restore replaces and go ahead: turning an app OFF
 * (stopping must always work, and is what a restore does to every app anyway) and minting
 * the one-use ticket that opens an app from outside (it writes nothing).
 */
const ALLOWED_DURING_RESTORE = new Set(['apps.stop', 'apps.openRemote']);
const noChangesDuringRestore = t.middleware(({ type, path, next }) => {
  if (type === 'mutation' && isUpdating('restore') && !ALLOWED_DURING_RESTORE.has(path)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: finishing('restore')
        ? finishingMessage('restore')
        : 'A backup is being restored right now. Please try this again once it has finished.',
    });
  }
  return next();
});

export const protectedProcedure = t.procedure.use(isAuthed).use(noChangesDuringRestore);
