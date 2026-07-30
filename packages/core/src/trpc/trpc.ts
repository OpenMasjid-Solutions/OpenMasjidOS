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
import { verifyCsrf } from '../auth/sessions';

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
  // CSRF / session-replay defence: require the dashboard key, which lives only in
  // the dashboard origin's storage and so can't be read by an app on another port
  // that captured the shared session cookie.
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
  return next({ ctx: { ...ctx, username: ctx.username } });
});

export const protectedProcedure = t.procedure.use(isAuthed);
