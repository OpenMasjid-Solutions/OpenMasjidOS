// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * One-click live updater: opening this modal starts the update and streams it.
 * When the core restarts (the WS drops), it waits for the new version to come
 * back online, then offers a reload — so an admin never touches a terminal.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';
import { LogStream } from './LogStream';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How the server says the update ended — its close code. Keep in step with core
 * `api/update.ts` `UPDATE_CLOSE` (a core test reads this file to check). 1000, or a
 * stream that just dropped, means the core is restarting. Any 4xxx means nothing was
 * changed: up to date, a download that failed, a refusal, or not signed in.
 */
const nothingChanged = (code: number) => code >= 4000 && code <= 4999;

/** Polls before saying the restart has not been seen (~30 s), and before giving up (~3 min). */
const POLLS_BEFORE_UNSURE = 15;
const POLLS_MAX = 90;

type Phase = 'running' | 'restarting' | 'unsure' | 'done' | 'same' | 'unchanged' | 'unreachable';

export function UpdateModal({
  open,
  onClose,
  currentVersion,
}: {
  open: boolean;
  onClose: () => void;
  currentVersion: string;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('running');
  const [newVersion, setNewVersion] = useState('');
  // A wait left over from an earlier run must not write into this one.
  const run = useRef(0);

  useEffect(() => {
    if (open) {
      run.current += 1;
      setPhase('running');
      setNewVersion('');
    }
  }, [open]);

  async function onClosed(code: number, opened: boolean) {
    // THE SERVER SAYS HOW IT ENDED. Every ending used to be treated as a restart, so an
    // update that changed nothing — already up to date, a download that failed, one
    // refused from outside — held this dialog shut on "restarting" for three minutes
    // and then said "Update applied." A stream that never even connected began nothing.
    if (!opened) return setPhase('unreachable');
    if (nothingChanged(code)) return setPhase('unchanged');
    const mine = run.current;
    const set = (p: Phase) => {
      if (run.current === mine) setPhase(p);
    };
    set('restarting');
    // Down only after TWO failed checks in a row: one blip — a 502, the Wi-Fi — read as a
    // restart kept the dialog locked for three minutes and then claimed a restart that
    // never happened.
    let failures = 0;
    let wentDown = false;
    let cameBackSame = false;
    let sameSince = 0;
    for (let i = 0; i < POLLS_MAX; i++) {
      await sleep(2000);
      if (run.current !== mine) return;
      // No sign of a restart yet: say so rather than look certain. The wait goes on
      // underneath, so a restart that is merely slow still ends on "updated".
      if (!wentDown && i === POLLS_BEFORE_UNSURE) set('unsure');
      // Back on the same version for a while: the restart has happened and did not take
      // the update. Say so then, rather than hold the dialog for the rest of the wait.
      if (cameBackSame && i - sameSince >= POLLS_BEFORE_UNSURE) break;
      try {
        // The dashboard's own sign-in check, not /api/health: health is refused over
        // the tunnel (it would tell the internet which build this is), so from
        // outside this dialog never saw the core come back and sat on "restarting".
        // `auth.me` reports the version to a signed-in session, inside tRPC's
        // envelope — reading it off the top level found nothing, so the new version
        // was never shown and a missed restart left this dialog waiting minutes.
        const res = await fetch('/trpc/auth.me', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        failures = 0;
        const body = (await res.json()) as { result?: { data?: { version?: string | null } } };
        const version = body.result?.data?.version ?? '';
        // "Updated" only on EVIDENCE: a new version answering, or the core seen to go
        // down and come back. Without either this ended on "Update applied." after
        // three minutes — over an update still downloading, or one that had failed.
        if (version && version !== currentVersion) {
          setNewVersion(version);
          set('done');
          return;
        }
        if (wentDown) {
          if (!version) {
            set('done'); // restarted, and this page can no longer see which version
            return;
          }
          // Back on the SAME version: the restart has happened and did not take the
          // update — unless another restart is still to come. Watch a little longer.
          if (!cameBackSame) sameSince = i;
          cameBackSame = true;
        }
      } catch {
        failures += 1;
        if (failures >= 2) wentDown = true;
      }
    }
    if (cameBackSame) setNewVersion(currentVersion);
    set(cameBackSame ? 'same' : 'unsure');
  }

  const finished = (text: string, primary: boolean) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
      <span>{text}</span>
      {primary ? (
        <button className="btn btn--primary" onClick={() => window.location.reload()}>
          {t('update.reload')}
        </button>
      ) : (
        <button className="btn" onClick={onClose}>
          {t('common.close')}
        </button>
      )}
    </div>
  );

  return (
    // Locked until the update has finished. Leaving mid-update and pressing Update again
    // started a SECOND one over the first — two helpers recreating the same container,
    // which is how a masjid's box stopped coming back at all. The server refuses a second
    // run regardless (system/update-lock.ts); this stops the admin reaching for it.
    <Modal
      open={open}
      onClose={onClose}
      wide
      locked={phase === 'running' || phase === 'restarting'}
      title={t('update.title')}
    >
      {open && <LogStream wsPath="/api/update" onClosed={onClosed} />}
      {(phase === 'running' || phase === 'restarting') && (
        <p className="hint" style={{ marginTop: '0.6rem' }}>
          {t('update.dontClose')}
        </p>
      )}
      <div style={{ marginTop: '0.85rem', minHeight: '2rem' }}>
        {phase === 'restarting' && (
          <p style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span className="status-dot" /> {t('update.restarting')}
          </p>
        )}
        {phase === 'unchanged' && finished(t('update.unchanged'), false)}
        {phase === 'unreachable' && finished(t('update.unreachable'), false)}
        {phase === 'unsure' && finished(t('update.unsure'), true)}
        {phase === 'same' && finished(t('update.same', { version: newVersion }), true)}
        {phase === 'done' &&
          finished(newVersion ? t('update.done', { version: newVersion }) : t('update.doneGeneric'), true)}
      </div>
    </Modal>
  );
}
