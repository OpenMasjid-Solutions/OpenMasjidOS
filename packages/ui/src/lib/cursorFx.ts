/**
 * Apple-style pointer reactivity: a soft light that follows the cursor across
 * glass surfaces. We set --mx/--my (the cursor position within the hovered
 * pane) and the glass background's radial-gradient renders the highlight there.
 *
 * One delegated pointermove listener, rAF-throttled, so it's cheap regardless
 * of how many cards are on screen. Resets the previous pane when the cursor
 * leaves it. Disabled for users who prefer reduced motion.
 */
export function installCursorFx(): void {
  if (typeof window === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  let last: HTMLElement | null = null;
  let target: HTMLElement | null = null;
  let x = 0;
  let y = 0;
  let scheduled = false;

  function flush() {
    scheduled = false;
    if (!target) return;
    const r = target.getBoundingClientRect();
    target.style.setProperty('--mx', `${x - r.left}px`);
    target.style.setProperty('--my', `${y - r.top}px`);
  }

  window.addEventListener(
    'pointermove',
    (e) => {
      // Only small interactive cards opt in (via .fx-glint), so big panels and
      // list containers don't show a stray halo.
      const el = (e.target as Element | null)?.closest?.('.fx-glint') as HTMLElement | null;
      if (el !== last) {
        if (last) {
          last.style.removeProperty('--mx');
          last.style.removeProperty('--my');
        }
        last = el;
      }
      if (!el) return;
      target = el;
      x = e.clientX;
      y = e.clientY;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    },
    { passive: true },
  );
}
