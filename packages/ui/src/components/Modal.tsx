// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { springSoft } from '../lib/motion';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Wider dialog. */
  wide?: boolean;
  /**
   * Refuse every way out — backdrop, Escape and the corner X all stop working.
   *
   * For an operation that must not be interrupted or restarted, and ONLY that: an update
   * in progress. Use it nowhere else. A dialog a user cannot leave is a trap, and it is
   * justified here only because leaving this one and pressing the button again used to
   * run a second update over the first.
   */
  locked?: boolean;
  children: ReactNode;
}

/**
 * A simple centered dialog for confirmations and short forms. Click the
 * backdrop or the corner X (or press Escape) to dismiss. Long-lived,
 * minimizable windows (terminals, logs, file viewers) are NOT modals — they
 * live in the window manager (see WindowManager.tsx).
 *
 * RENDERED THROUGH A PORTAL TO `document.body`, and it must stay that way. The
 * backdrop is `position: fixed; inset: 0`, which sounds like "cover the viewport"
 * but is not: a transform, filter or `will-change` on ANY ancestor makes that
 * ancestor the containing block instead, and every route is wrapped in a
 * `motion.div` that animates `y` (Page.tsx `fadeRise`). So dialogs opened from a
 * page were sized and clipped to the page's content box — the backdrop covered
 * part of the screen and the dialog sat off-centre, half behind the panels
 * around it. A portal is the only fix that does not depend on knowing every
 * animated ancestor, and it fixes every dialog at once because they all build on
 * this component.
 */
/**
 * How many modals are currently on screen.
 *
 * WindowManager also listens for Escape, on `window` — so one keypress used to be
 * handled twice: the dialog closed AND the log window behind it closed with it.
 * Neither listener can see the other through the DOM (the modal is portalled and
 * the window is a sibling), so they agree through this counter instead.
 *
 * Counts LOCKED modals too. A locked dialog ignores its own Escape deliberately
 * (an update is running), and that must not silently hand the keypress to the
 * window manager — the one thing Escape must never do mid-update is close the
 * window showing the progress.
 */
let openModals = 0;
export function anyModalOpen(): boolean {
  return openModals > 0;
}

export function Modal({ open, onClose, title, wide, locked, children }: ModalProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    openModals += 1;
    return () => {
      openModals -= 1;
    };
  }, [open]);

  useEffect(() => {
    if (!open || locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, locked]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={locked ? undefined : onClose}
        >
          <motion.div
            className="modal glass-raised"
            style={wide ? { width: 'min(60rem, 100%)' } : undefined}
            initial={{ opacity: 0, scale: 0.94, y: 12, filter: 'blur(8px)' }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)', transition: springSoft }}
            exit={{ opacity: 0, scale: 0.96, y: 8, filter: 'blur(6px)' }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-head">
              {title && <h2 className="modal-title">{title}</h2>}
              {/* No X at all while locked — a disabled one still invites the click that
                  the whole lock exists to prevent. */}
              {!locked && (
                <button className="icon-btn modal-x" aria-label={t('common.close')} onClick={onClose}>
                  <X size={18} />
                </button>
              )}
            </div>
            <div className="modal-body">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
