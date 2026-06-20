import { useEffect, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { springSoft } from '../lib/motion';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Wider modal (e.g. for terminals). */
  wide?: boolean;
  children: ReactNode;
}

export function Modal({ open, onClose, title, wide, children }: ModalProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="modal glass-raised"
            style={wide ? { width: 'min(60rem, 100%)' } : undefined}
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: springSoft }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: '1rem' }}>
              {title && <h2 className="modal-title">{title}</h2>}
              <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
