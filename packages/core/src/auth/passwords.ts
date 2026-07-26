// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Password hashing with argon2id. We use @node-rs/argon2 (prebuilt musl/glibc
 * binaries) rather than the native `argon2` package so the multi-arch Alpine
 * image builds with no compilation — see docs/ARCHITECTURE.md. Same algorithm.
 */
import { hash, verify, type Algorithm } from '@node-rs/argon2';

// `Algorithm` is an ambient `const enum`, so `isolatedModules` forbids reading
// `Algorithm.Argon2id` at a value position (TS2748) — the transpiler has no way
// to inline it. We write the literal instead but keep the TYPE via `satisfies`,
// so the compiler still proves it is a real Algorithm member and this fails the
// build if upstream ever renumbers. Argon2id === 2 (@node-rs/argon2 index.d.ts).
// Stated explicitly rather than left to the library default: which algorithm
// hashes our admin password is not something to inherit silently.
const ARGON2ID = 2 satisfies Algorithm;

const OPTIONS = {
  algorithm: ARGON2ID,
  // OWASP-ish defaults: 19 MiB memory, 2 iterations, single lane.
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain);
  } catch {
    // A malformed stored hash should fail closed, never throw to the caller.
    return false;
  }
}

/** Minimum admin password length enforced server-side (also enforced in the UI).
 *  Raised to 12: the admin account is effectively host-root (it can install apps
 *  and open a root shell), so a weak password on an exposed instance is the main
 *  brute-force risk. The UI shows a strength meter to encourage stronger still. */
export const MIN_PASSWORD_LENGTH = 12;
