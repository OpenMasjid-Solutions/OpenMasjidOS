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
    <Modal open={open} onClose={onClose} wide title={t('restore.title')}>
      {open && <LogStream wsPath="/api/restore/run" onClosed={onClosed} />}
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
