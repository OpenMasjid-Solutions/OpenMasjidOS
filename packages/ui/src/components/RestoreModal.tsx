// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Streams a restore (extract → restart apps → recreate core) over a WebSocket,
 * then waits for the core to come back and offers a reload — so an admin can
 * restore a backup without touching a terminal. Mirrors UpdateModal.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';
import { LogStream } from './LogStream';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How the server says the restore ended — its close code. Keep in step with core
 * `api/restore.ts` `RESTORE_CLOSE` (a core test reads this file to check). A normal
 * close (1000) means the core is being replaced. Every other 4xxx is a refusal made
 * before anything was touched (signed out, wrong origin, nothing changed). Anything
 * else means the stream dropped and the outcome is unknown.
 */
const CLOSED_NOT_RESTARTED = 4002;
/** Restarting, but some app data could not be put back or some app did not start. */
const CLOSED_WITH_PROBLEMS = 4003;
/** Everything was put back, but the core could not restart itself to finish. */
const CLOSED_RESTORED_NOT_RESTARTED = 4004;
const refusedBeforeStarting = (code: number) =>
  code >= 4000 &&
  code <= 4999 &&
  code !== CLOSED_NOT_RESTARTED &&
  code !== CLOSED_WITH_PROBLEMS &&
  code !== CLOSED_RESTORED_NOT_RESTARTED;

/** Polls before saying the restart has not been seen (~30 s), and before giving up (~4 min). */
const POLLS_BEFORE_UNSURE = 15;
const POLLS_MAX = 120;

type Phase =
  | 'running'
  | 'restarting'
  | 'unsure'
  | 'done'
  | 'lost'
  | 'unchanged'
  | 'stopped'
  | 'restoredNoRestart'
  | 'unreachable';

export function RestoreModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('running');
  // The restore restarted the core but said some app data did not come back.
  const [problems, setProblems] = useState(false);
  // A wait left over from an earlier run must not write into this one.
  const run = useRef(0);

  useEffect(() => {
    if (open) {
      run.current += 1;
      setPhase('running');
      setProblems(false);
    }
  }, [open]);

  async function onClosed(code: number, opened: boolean) {
    // THE SERVER SAYS HOW IT ENDED. This used to assume every ending was a restart:
    // a restore refused before it changed anything — the usual result from outside,
    // and every "busy", "too large" or "nothing in it" — sat on "reconnecting" for
    // four minutes and then announced "Restore complete." A stream that never even
    // connected began nothing at all.
    if (!opened) return setPhase('unreachable');
    if (code === CLOSED_NOT_RESTARTED) return setPhase('stopped');
    if (code === CLOSED_RESTORED_NOT_RESTARTED) return setPhase('restoredNoRestart');
    if (refusedBeforeStarting(code)) return setPhase('unchanged');
    if (code === CLOSED_WITH_PROBLEMS) setProblems(true);
    // The server closes with how the restore ended (1000 or a 4xxx) before the core is
    // replaced. Anything else means the stream DROPPED — a sleeping laptop, the Wi-Fi —
    // and this window does not know how it ended, so a restart seen afterwards is not
    // proof it went well: say that, rather than "Restore complete.".
    const heard = code === 1000 || code === CLOSED_WITH_PROBLEMS;

    const mine = run.current;
    const set = (p: Phase) => {
      if (run.current === mine) setPhase(p);
    };
    set('restarting');
    // Down only after TWO failed checks in a row: one blip read as a restart said
    // "Restore complete." while the old core was still about to be replaced.
    let failures = 0;
    let wentDown = false;
    for (let i = 0; i < POLLS_MAX; i++) {
      await sleep(2000);
      if (run.current !== mine) return;
      // No sign of a restart yet: say so rather than look certain. The wait goes on
      // underneath, so a restart that is merely slow still ends on "complete".
      if (!wentDown && i === POLLS_BEFORE_UNSURE) set('unsure');
      try {
        // The dashboard's own sign-in check, not /api/health: health is refused over
        // the tunnel (it would tell the internet which build this is), so from
        // outside this dialog never saw the core come back and sat on "restarting".
        const res = await fetch('/trpc/auth.me', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        failures = 0;
        if (wentDown) {
          set(heard ? 'done' : 'lost');
          return;
        }
      } catch {
        failures += 1;
        if (failures >= 2) wentDown = true;
      }
    }
    set('unsure');
  }

  const reload = (
    <button className="btn btn--primary" onClick={() => window.location.reload()}>
      {t('update.reload')}
    </button>
  );

  return (
    // Locked while the restore is streaming, like UpdateModal. Closing it and picking a
    // file again used to start a second restore over the first; the server refuses
    // that now (system/restore.ts), and this stops the admin reaching for it. Only
    // while 'running': once the stream ends the restore has finished on the server,
    // and a restore that FAILED never restarts the core, so waiting for one would
    // hold the dialog shut for minutes over nothing.
    <Modal open={open} onClose={onClose} wide locked={phase === 'running'} title={t('restore.title')}>
      {open && <LogStream wsPath="/api/restore/run" onClosed={onClosed} />}
      {phase === 'running' && (
        <p className="hint" style={{ marginTop: '0.6rem' }}>
          {t('update.dontClose')}
        </p>
      )}
      <div style={{ marginTop: '0.85rem', minHeight: '2rem' }}>
        {phase === 'restarting' && (
          <p style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span className="status-dot" /> {t('restore.restarting')}
          </p>
        )}
        {(phase === 'unchanged' || phase === 'unreachable') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span>{phase === 'unreachable' ? t('restore.unreachable') : t('restore.unchanged')}</span>
            <button className="btn" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        )}
        {(phase === 'stopped' || phase === 'restoredNoRestart' || phase === 'unsure' || phase === 'lost' || phase === 'done') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span>
              {phase === 'stopped'
                ? t('restore.stopped')
                : phase === 'restoredNoRestart'
                  ? t('restore.restoredNoRestart')
                  : phase === 'unsure'
                    ? t('restore.unsure')
                    : phase === 'lost'
                      ? t('restore.lost')
                    : problems
                      ? t('restore.doneWithProblems')
                      : t('restore.done')}
            </span>
            {reload}
          </div>
        )}
      </div>
    </Modal>
  );
}
