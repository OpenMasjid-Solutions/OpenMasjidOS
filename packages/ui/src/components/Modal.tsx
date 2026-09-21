// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useEffect, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { springSoft } from '../lib/motion';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from './ui/dialog';

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
 * BUILT ON RADIX DIALOG since v0.51.2-dev.5, with the prop surface and the
 * visuals unchanged — all 25 rendered instances (15 `<Modal>` literals, of
 * which four are wrapper components covering the rest) migrated without a
 * single call-site edit. What changed is underneath:
 *
 * - FOCUS IS NOW TRAPPED, and that is not a nicety here, it is the other half
 *   of `locked`. Nothing in this UI trapped focus before — three `autoFocus`
 *   hits and no `tabIndex` or `inert` anywhere — so while a locked update
 *   dialog was up, Tab walked out to the Dock's NavLink and Enter changed
 *   route, unmounting the page and the locked dialog with it, mid core update.
 *   The mouse was blocked by the backdrop; the keyboard was not.
 * - Focus is restored to whatever was focused when the dialog opened (below).
 * - Escape and outside-pointer dismissal are Radix's now, which is why this
 *   file no longer registers a `window` keydown listener of its own.
 *
 * `modal` is NEVER passed to Radix. `modal={false}` looks like the way to keep
 * our own backdrop and silently removes the focus trap AND the overlay with it;
 * `update-lock.test.ts` refuses the prop outright. The lock is expressed as
 * controlled `open` plus preventDefault on the dismissal handlers.
 *
 * STILL RENDERED THROUGH A PORTAL TO `document.body` (Radix's, rather than a
 * hand-rolled `createPortal`), and it must stay that way. The backdrop is
 * `position: fixed; inset: 0`, which sounds like "cover the viewport" but is
 * not: a transform, filter or `will-change` on ANY ancestor makes that ancestor
 * the containing block instead, and every route is wrapped in a `motion.div`
 * that animates `y` (Page.tsx `fadeRise`). So dialogs opened from a page were
 * sized and clipped to the page's content box — the backdrop covered part of
 * the screen and the dialog sat off-centre, half behind the panels around it.
 *
 * The panel is a CHILD of the backdrop, not a sibling: `.modal-backdrop` is
 * `display: grid; place-items: center`, so nesting is what centres it. That is
 * why shadcn's `top-[50%] left-[50%] translate-x/y-[-50%]` was deleted rather
 * than converted — there is no logical `translate-x`, and the centring was
 * already free and direction-neutral.
 *
 * Motion still drives the entrance and exit, so the spring and the blur are
 * byte-for-byte what they were. shadcn's `animate-in`/`zoom-in-95` classes were
 * dropped: the plugin that defines them is not installed, so they compile to
 * nothing and would have turned a tuned spring into a hard cut.
 */
/**
 * How many modals are currently on screen.
 *
 * WindowManager also listens for Escape, on `window` — so one keypress used to be
 * handled twice: the dialog closed AND the log window behind it closed with it.
 * Radix does not stop propagation when it handles Escape, so the two still cannot
 * see each other (the modal is portalled and the window is a sibling) and they
 * agree through this counter exactly as before.
 *
 * Counts LOCKED modals too. A locked dialog ignores its own Escape deliberately
 * (an update is running), and that must not silently hand the keypress to the
 * window manager. The concrete loss is not the progress window — `close()` is
 * already a no-op for a locked window — it is that the keypress falls through
 * and kills whatever unlocked window is front-most, which may be a live
 * terminal with no scrollback to recover.
 *
 * Over-counting is the worse and quieter failure: `anyModalOpen()` stays true
 * for the life of the page and Escape stops closing windows at all, with no
 * console output, on a dashboard that may be wall-mounted for weeks. Both
 * directions are pinned by `audit-hardening.test.ts`.
 */
let openModals = 0;
export function anyModalOpen(): boolean {
  return openModals > 0;
}

export function Modal({ open, onClose, title, wide, locked, children }: ModalProps) {
  const { t } = useTranslation();

  // MUST STAY THE FIRST `  useEffect` IN THIS FILE, keyed on `[open]` alone and
  // ending `}, [open]);` — `audit-hardening.test.ts` locates it by that shape.
  // It lives on the wrapper, never inside the Presence-mounted subtree, so the
  // count follows the `open` PROP rather than Radix's mount lifecycle.
  useEffect(() => {
    if (!open) return;
    openModals += 1;
    return () => {
      openModals -= 1;
    };
  }, [open]);

  // Radix restores focus to its Trigger on close. None of our dialogs use one —
  // they are all controlled by an `open` prop — so its default would focus
  // nothing and leave the keyboard at the top of the document. Capture what was
  // focused when the dialog opened and put it back ourselves.
  const returnFocusTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) returnFocusTo.current = document.activeElement as HTMLElement | null;
  }, [open]);

  const refuse = (e: Event) => e.preventDefault();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The only routes here are Radix's dismissal paths and DialogClose, and
        // a locked dialog renders no close button — so this guard plus the two
        // preventDefaults below close every way out.
        if (!next && !locked) onClose();
      }}
    >
      <AnimatePresence>
        {open && (
          // `forceMount` hands presence to AnimatePresence so the exit animation
          // can play. The `open &&` gate is what keeps that safe: Radix's
          // `hideOthers` runs in an effect with empty deps, so a permanently
          // force-mounted Content would aria-hide #root for the component's
          // whole life with no visual symptom at all.
          <DialogPortal forceMount>
            <DialogOverlay asChild forceMount>
              <motion.div
                className="modal-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <DialogContent
                  asChild
                  forceMount
                  onEscapeKeyDown={locked ? refuse : undefined}
                  onInteractOutside={locked ? refuse : undefined}
                  onCloseAutoFocus={(e) => {
                    e.preventDefault();
                    returnFocusTo.current?.focus?.();
                  }}
                >
                  <motion.div
                    className="modal glass-raised"
                    style={wide ? { width: 'min(60rem, 100%)' } : undefined}
                    initial={{ opacity: 0, scale: 0.94, y: 12, filter: 'blur(8px)' }}
                    animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)', transition: springSoft }}
                    exit={{ opacity: 0, scale: 0.96, y: 8, filter: 'blur(6px)' }}
                  >
                    <div className="modal-head">
                      {/* Radix has no dev warning for a missing Title in this
                          version (its WarningProvider is a noop), so a titleless
                          dialog would ship unlabelled with no feedback at all.
                          Every current call site passes one; the fallback is for
                          the next one that does not. */}
                      <DialogTitle className={title ? 'modal-title' : 'visually-hidden'}>
                        {title ?? t('common.dialog')}
                      </DialogTitle>
                      {/* No X at all while locked — a disabled one still invites the click that
                          the whole lock exists to prevent. */}
                      {!locked && (
                        <DialogClose asChild>
                          <button className="icon-btn modal-x" aria-label={t('common.close')}>
                            <X size={18} />
                          </button>
                        </DialogClose>
                      )}
                    </div>
                    <div className="modal-body">{children}</div>
                  </motion.div>
                </DialogContent>
              </motion.div>
            </DialogOverlay>
          </DialogPortal>
        )}
      </AnimatePresence>
    </Dialog>
  );
}
