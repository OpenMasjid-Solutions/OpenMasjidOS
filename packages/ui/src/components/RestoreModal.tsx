// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Streams a restore (extract → restart apps → recreate core) over a WebSocket,
 * then waits for the core to come back and offers a reload — so an admin can
 * restore a backup without touching a terminal. Mirrors UpdateModal.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';
import { LogStream } from './LogStream';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function RestoreModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'running' | 'restarting' | 'done'>('running');

  useEffect(() => {
    if (open) setPhase('running');
  }, [open]);

  async function onClosed() {
    setPhase('restarting');
    let wentDown = false;
    for (let i = 0; i < 120; i++) {
      await sleep(2000);
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          if (wentDown) {
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
        {phase === 'done' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span>{t('restore.done')}</span>
            <button className="btn btn--primary" onClick={() => window.location.reload()}>
              {t('update.reload')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
