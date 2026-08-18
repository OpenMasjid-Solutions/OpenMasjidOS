// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * One-click live updater: opening this modal starts the update and streams it.
 * When the core restarts (the WS drops), it waits for the new version to come
 * back online, then offers a reload — so an admin never touches a terminal.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';
import { LogStream } from './LogStream';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const [phase, setPhase] = useState<'running' | 'restarting' | 'done'>('running');
  const [newVersion, setNewVersion] = useState('');

  useEffect(() => {
    if (open) {
      setPhase('running');
      setNewVersion('');
    }
  }, [open]);

  async function onClosed() {
    setPhase('restarting');
    let wentDown = false;
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          const data = (await res.json()) as { version?: string };
          if (wentDown || (data.version && data.version !== currentVersion)) {
            setNewVersion(data.version ?? '');
            setPhase('done');
            return;
          }
        } else {
          wentDown = true;
        }
      } catch {
        wentDown = true;
      }
    }
    setPhase('done');
  }

  return (
    // Locked until the update has finished. Leaving mid-update and pressing Update again
    // started a SECOND one over the first — two helpers recreating the same container,
    // which is how a masjid's box stopped coming back at all. The server refuses a second
    // run regardless (system/update-lock.ts); this stops the admin reaching for it.
    <Modal open={open} onClose={onClose} wide locked={phase !== 'done'} title={t('update.title')}>
      {open && <LogStream wsPath="/api/update" onClosed={onClosed} />}
      {phase !== 'done' && (
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
        {phase === 'done' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span>{newVersion ? t('update.done', { version: newVersion }) : t('update.doneGeneric')}</span>
            <button className="btn btn--primary" onClick={() => window.location.reload()}>
              {t('update.reload')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
