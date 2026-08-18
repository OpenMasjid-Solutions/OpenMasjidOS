// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * One update at a time, per thing being updated.
 *
 * WHY THIS EXISTS: nothing stopped two updates of the same thing running at once. Every
 * WebSocket connection to `/api/update` started a fresh core update, and every connection
 * to `/api/apps/update?id=…` a fresh app update — so closing the progress dialog and
 * pressing the button again ran a SECOND one on top of the first. Two
 * `docker compose up -d --force-recreate` racing for the same container, with two writers
 * rewriting the same `compose.yml` underneath them, is how a masjid ends up with a box
 * that does not come back at all. That was reported from a real install.
 *
 * Locking on the SERVER is the load-bearing half. The dialog is also locked while an
 * update runs, but a browser can be closed, a laptop can sleep and a phone can lose wifi —
 * a guarantee that depends on the user not clicking is not a guarantee. Equally, a client
 * going away must never abort an update in flight: the work continues and the progress
 * lines are simply dropped, which is why the lock has to outlive the socket.
 *
 * Deliberately in-memory. The core is one process, and it is the only thing that starts
 * these; a restart clears the lock, which is correct, because a restart means whatever
 * held it is gone. (A core update ends in the core being replaced, so its lock dying with
 * the process is the intended end state, not a leak.)
 */
import { log } from '../logger';

/** Thrown when a second update is asked for while one is already running. */
export class UpdateBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateBusyError';
  }
}

const inFlight = new Set<string>();

/** Is an update running for this key? `core` for the platform, an app id otherwise. */
export function isUpdating(key: string): boolean {
  return inFlight.has(key);
}

/**
 * Run `fn` under the lock for `key`, refusing rather than queueing.
 *
 * Refusing is deliberate: queueing a second identical update would just repeat the whole
 * thing for no reason, and the honest answer to "update this twice at once" is that the
 * first one is already doing it.
 */
export async function withUpdateLock<T>(key: string, busyMessage: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) {
    log.warn(`Refused a second update for "${key}" — one is already running.`);
    throw new UpdateBusyError(busyMessage);
  }
  inFlight.add(key);
  try {
    return await fn();
  } finally {
    inFlight.delete(key);
  }
}
