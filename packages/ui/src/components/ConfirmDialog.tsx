// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * One confirmation dialog for destructive actions, so a misclick can't take
 * something away that the masjid can't easily get back.
 *
 * Reserved DELIBERATELY for actions that are instant AND hard to undo. It is not
 * on Start/Stop/Restart, the sharing toggles, the alert matrix or the Advanced
 * switches: those are reversible with the control right next to them, they are the
 * most-used things in the product, and a dialog on every one of them trains people
 * to click straight through — which makes the genuinely dangerous ones LESS safe.
 *
 * Built on the existing Modal (backdrop click, corner X and Escape all cancel), so
 * it inherits reduced-motion handling, both themes, and logical CSS for RTL.
 * Cancel is the leftmost, plainest button and the default place the eye lands;
 * the destructive action carries `btn--danger`.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** Dialog heading — name the specific thing, e.g. 'Remove "Donations"?'. */
  title: string;
  /** What will happen, in plain words. */
  body: ReactNode;
  /** What it costs to undo, when that's the real point. Rendered as a warning. */
  cost?: ReactNode;
  /** Destructive button label. Defaults to "Remove". */
  confirmLabel?: string;
  /** True while the mutation is in flight. */
  pending?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  cost,
  confirmLabel,
  pending,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p style={{ margin: 0 }}>{body}</p>
      {cost && (
        <p
          className="setting-row__hint"
          style={{ marginBlockStart: '0.7rem', color: 'var(--color-gold, #F59E0B)' }}
        >
          {cost}
        </p>
      )}
      {pending ? (
        <p style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBlockStart: '1.2rem' }}>
          <span className="spinner" /> {t('common.working')}
        </p>
      ) : (
        <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginBlockStart: '1.4rem' }}>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn--danger" onClick={onConfirm}>
            {confirmLabel ?? t('actions.remove')}
          </button>
        </div>
      )}
    </Modal>
  );
}
