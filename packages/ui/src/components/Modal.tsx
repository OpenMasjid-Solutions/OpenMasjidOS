import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { X, Minus, Maximize2 } from 'lucide-react';
import { springSoft } from '../lib/motion';
import { useWindows, newWindowId } from './Windows';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Wider modal (e.g. for terminals). */
  wide?: boolean;
  children: ReactNode;
}

/**
 * An in-dashboard window with macOS-style traffic lights:
 * red = close, yellow = minimize to the tray, green = fullscreen.
 */
export function Modal({ open, onClose, title, wide, children }: ModalProps) {
  const { t } = useTranslation();
  // Destructure the STABLE add/remove callbacks — depending on the whole context
  // value (which changes identity whenever the window list changes) made the
  // cleanup below fire on every add and instantly un-minimize the window.
  const { add, remove } = useWindows();
  const idRef = useRef(newWindowId());
  const [fullscreen, setFullscreen] = useState(false);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Reset window state and clear any dock entry when the modal closes.
  useEffect(() => {
    if (!open) {
      setMinimized(false);
      setFullscreen(false);
      remove(idRef.current);
    }
  }, [open, remove]);

  useEffect(() => {
    const id = idRef.current;
    return () => remove(id);
  }, [remove]);

  function minimize() {
    setMinimized(true);
    add({
      id: idRef.current,
      title: title ?? 'Window',
      restore: () => {
        setMinimized(false);
        remove(idRef.current);
      },
    });
  }

  const visible = open && !minimized;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="modal glass-raised"
            style={
              fullscreen
                ? { width: '96vw', height: '92vh', maxHeight: '92vh' }
                : wide
                  ? { width: 'min(60rem, 100%)' }
                  : undefined
            }
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: springSoft }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-head">
              <div className="traffic" role="group" aria-label="Window controls">
                <button className="tl tl-close" aria-label={t('common.close')} onClick={onClose}>
                  <X size={9} strokeWidth={3.5} />
                </button>
                <button className="tl tl-min" aria-label="Minimize" onClick={minimize}>
                  <Minus size={9} strokeWidth={3.5} />
                </button>
                <button className="tl tl-full" aria-label="Fullscreen" onClick={() => setFullscreen((f) => !f)}>
                  <Maximize2 size={8} strokeWidth={3.5} />
                </button>
              </div>
              {title && <h2 className="modal-title">{title}</h2>}
            </div>
            <div className="modal-body">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
