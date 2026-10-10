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
 * held it is gone. A core update or a restore ends by handing the core's replacement to a
 * helper container, and the old core goes on running for some seconds after that (the
 * helper waits, then compose waits for this process to stop) — so those two keep their
 * lock past the hand-off (`holdAfter`) rather than let go of it while the core is still
 * about to be replaced: work started in that gap was accepted, and then killed part-way.
 */
import { log } from '../logger';

/**
 * Thrown when work is asked for while it — or something it must not overlap — is already
 * running. `clash` says which: false for the same work asked for twice (which will finish
 * on its own), true for OTHER work in the way (this request simply did not happen).
 */
export class UpdateBusyError extends Error {
  constructor(
    message: string,
    readonly clash = false,
  ) {
    super(message);
    this.name = 'UpdateBusyError';
  }
}

const inFlight = new Set<string>();
/** The release timers of locks kept past their work (`holdAfter`). */
const held = new Map<string, ReturnType<typeof setTimeout>>();

/** Is an update running for this key? `core` for the platform, `restore`, or `app:<id>`. */
export function isUpdating(key: string): boolean {
  return inFlight.has(key);
}

/**
 * Work that may overlap NOTHING else here. A core update and a restore each end by
 * replacing the core, and a restore stops every app and refills its data: run together,
 * the one replacing the core cut the other off part-way — a restore's data half put back
 * and every app left stopped — and an app update during either was cut off with the core,
 * or recreated its container over data being replaced. Two different apps' updates touch
 * nothing in common and may run together.
 */
const EXCLUSIVE = new Set(['core', 'restore']);

function inTheWay(key: string): string | undefined {
  for (const running of inFlight) {
    if (running !== key && (EXCLUSIVE.has(key) || EXCLUSIVE.has(running))) return running;
  }
  return undefined;
}

/**
 * Is this work done, and only waiting for the core to be replaced (`holdAfter`)? Then a
 * refusal says so: "being restored right now" over a restore that had finished sent the
 * admin to wait for something that was not happening.
 */
export function finishing(key: string): boolean {
  return held.has(key);
}

/** What to tell someone refused while `key` is done and the core is about to be replaced. */
export function finishingMessage(key: string): string {
  const what = key === 'restore' ? 'restoring your backup' : 'an update';
  return `OpenMasjidOS is restarting to finish ${what}. Please try again in a minute or two. Nothing was changed.`;
}

/** What to tell someone whose `key` was refused because `running` is under way. */
function clashMessage(key: string, running: string): string {
  if (held.has(running)) return finishingMessage(running);
  const what =
    running === 'core'
      ? 'OpenMasjidOS is being updated'
      : running === 'restore'
        ? 'A backup is being restored'
        : 'An app is being updated';
  const then = key === 'core' ? 'update OpenMasjidOS' : key === 'restore' ? 'restore your backup' : 'update this app';
  return `${what} right now. Please ${then} once it has finished. Nothing was changed.`;
}

/** What `key` would be refused with right now because OTHER work is in the way, or null. */
export function clashFor(key: string): string | null {
  const running = inTheWay(key);
  return running === undefined ? null : clashMessage(key, running);
}

/**
 * Run `fn` under the lock for `key`, refusing rather than queueing.
 *
 * Refusing is deliberate: queueing a second identical update would just repeat the whole
 * thing for no reason, and the honest answer to "update this twice at once" is that the
 * first one is already doing it. Work that must not overlap other work (`EXCLUSIVE`) is
 * refused the same way, before anything has started.
 *
 * `holdAfter(result)`: how long to keep the lock once `fn` has finished — for work whose
 * real end comes later, the core being replaced by the helper it handed that job to.
 * Released by a timer, so a helper that never replaces the core cannot wedge the box.
 */
export async function withUpdateLock<T>(
  key: string,
  busyMessage: string,
  fn: () => Promise<T>,
  opts: { holdAfter?: (result: T) => number } = {},
): Promise<T> {
  if (inFlight.has(key)) {
    log.warn(`Refused a second update for "${key}" — one is already running.`);
    throw new UpdateBusyError(held.has(key) ? finishingMessage(key) : busyMessage);
  }
  const running = inTheWay(key);
  if (running !== undefined) {
    log.warn(`Refused "${key}" — "${running}" is running and the two must not overlap.`);
    throw new UpdateBusyError(clashMessage(key, running), true);
  }
  inFlight.add(key);
  let holdMs = 0;
  try {
    const result = await fn();
    holdMs = opts.holdAfter?.(result) ?? 0;
    return result;
  } finally {
    if (holdMs > 0) {
      const timer = setTimeout(() => {
        held.delete(key);
        inFlight.delete(key);
      }, holdMs);
      timer.unref?.();
      held.set(key, timer);
    } else {
      inFlight.delete(key);
    }
  }
}

/**
 * How long a core update or a restore keeps its lock after handing the core's
 * replacement to a helper: comfortably longer than the hand-off takes, short enough that a
 * helper which never replaces the core does not keep updates and restores refused for long.
 */
export const HOLD_UNTIL_REPLACED_MS = 5 * 60_000;

/** Tests only: let go of every lock still kept past its work, as the core being replaced would. */
export function __releaseHeldLocksForTests(): void {
  for (const [key, timer] of held) {
    clearTimeout(timer);
    inFlight.delete(key);
  }
  held.clear();
}

/**
 * Refuse to start, restart, install or remove app `id` while work that must not overlap it
 * runs: a restore (it stops every app and refills its data — an app started meanwhile runs
 * over a database being replaced, and a compose that came in with the backup has not been
 * checked yet), that app's own update (Start would bring up the compose the update is about
 * to put back), or — for an install or a removal — a core update, which would cut it off.
 * Stopping is never refused.
 */
export function assertAppFree(id: string, action: 'start' | 'install' | 'remove'): void {
  if (held.has('restore') || (action !== 'start' && held.has('core'))) {
    throw new UpdateBusyError(finishingMessage(held.has('restore') ? 'restore' : 'core'), true);
  }
  if (inFlight.has('restore')) {
    throw new UpdateBusyError(
      action === 'start'
        ? 'A backup is being restored right now. Your apps will start again on their own when it has finished. Nothing was changed.'
        : `A backup is being restored right now. Please ${action} this app once it has finished. Nothing was changed.`,
      true,
    );
  }
  if (inFlight.has(`app:${id}`)) {
    throw new UpdateBusyError('This app is being updated right now. Please try again once it has finished. Nothing was changed.', true);
  }
  if (action !== 'start' && inFlight.has('core')) {
    throw new UpdateBusyError(
      `OpenMasjidOS is being updated right now. Please ${action} this app once it has finished. Nothing was changed.`,
      true,
    );
  }
}
