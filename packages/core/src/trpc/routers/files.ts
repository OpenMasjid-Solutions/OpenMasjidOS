// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * File explorer operations (JSON). Upload/download are HTTP routes (they stream
 * binary) — see api/files.ts. Everything is sandboxed to the data dir.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import {
  listDir,
  makeDir,
  renameEntry,
  removeEntry,
  readTextFile,
  writeTextFile,
  FileError,
} from '../../files/manager';

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof FileError) {
      // PROTECTED is a refusal, not a malformed request — say so, so the UI can
      // tell "you may not" apart from "that didn't work".
      const code =
        err.code === 'NOT_FOUND' ? 'NOT_FOUND' : err.code === 'PROTECTED' ? 'FORBIDDEN' : 'BAD_REQUEST';
      throw new TRPCError({ code, message: err.message });
    }
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err as Error).message });
  }
}

export const filesRouter = router({
  list: protectedProcedure
    .input(z.object({ path: z.string().default('/') }))
    .query(({ input }) => wrap(() => listDir(input.path))),

  mkdir: protectedProcedure
    .input(z.object({ path: z.string(), name: z.string().min(1) }))
    .mutation(({ input }) => wrap(() => {
      makeDir(input.path, input.name);
      return { ok: true };
    })),

  rename: protectedProcedure
    .input(z.object({ path: z.string(), name: z.string().min(1) }))
    .mutation(({ input }) => wrap(() => {
      renameEntry(input.path, input.name);
      return { ok: true };
    })),

  remove: protectedProcedure
    .input(z.object({ path: z.string().min(1) }))
    .mutation(({ input }) => wrap(() => {
      removeEntry(input.path);
      return { ok: true };
    })),

  read: protectedProcedure
    .input(z.object({ path: z.string().min(1) }))
    .query(({ input }) => wrap(() => readTextFile(input.path))),

  write: protectedProcedure
    .input(z.object({ path: z.string().min(1), content: z.string().max(2 * 1024 * 1024) }))
    .mutation(({ input }) => wrap(() => {
      writeTextFile(input.path, input.content);
      return { ok: true };
    })),
});
