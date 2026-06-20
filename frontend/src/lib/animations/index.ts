/*
 * Shared animation presets for OpenMasjidOS — the "Sakīna" motion vocabulary.
 *
 * Design decision (see docs/ARCHITECTURE.md): every motion here is driven by
 * CSS transitions/keyframes + native browser APIs (IntersectionObserver,
 * ResizeObserver, geometry). We deliberately do NOT use the Motion One library
 * even though it is a dependency — a CSS linear() spring (--ease-settle) gives
 * the identical buttery feel with zero JS animation runtime and zero risk of a
 * library-API mismatch breaking the build. The spring "tempo" lives in the
 * CSS tokens --ease-settle / --dur-settle / --dur-micro.
 *
 * Accessibility (non-negotiable, CLAUDE.md §12): rm() is read LIVE on every
 * call (never cached at module load, which would ignore a runtime preference
 * change). Under reduced motion every transition collapses to instant and every
 * interaction action attaches no listeners, leaving the static glass material
 * (top-edge highlight, hairline, steady glow) fully intact.
 */

import { cubicOut } from 'svelte/easing';
import type { TransitionConfig } from 'svelte/transition';

// ── Gates ───────────────────────────────────────────────────────────────────

/** Live reduced-motion check — the single source of truth. */
export const rm = (): boolean =>
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

/** RTL sign: -1 when the document is right-to-left, else +1. Read live so a
 *  runtime dir change is respected. Flips horizontal travel directions. */
export const dirSign = (): number =>
  typeof document !== 'undefined' && document.documentElement.dir === 'rtl' ? -1 : 1;

// ── Svelte transitions ────────────────────────────────────────────────────────

/** Gentle rise + fade for headers / hero text. */
export function riseIn(_node: Element, { delay = 0, duration = 300 } = {}): TransitionConfig {
  if (rm()) return { duration: 0, css: () => '' };
  return {
    delay,
    duration,
    easing: cubicOut,
    css: (t: number) => `opacity:${t}; transform:translateY(${(1 - t) * 12}px);`,
  };
}

/** Route in-transition: gentle crossfade + slight rise. Pair inside a
 *  {#key page.url.pathname} block. */
export function routeRise(_node: Element, { duration = 420, delay = 0 } = {}): TransitionConfig {
  if (rm()) return { duration: 0, css: () => '' };
  return {
    delay,
    duration,
    easing: cubicOut,
    // Gentle rise + a touch of scale + a fading blur — a soft "glassy" settle.
    css: (t: number) => {
      const e = 1 - t;
      return `opacity:${t}; transform:translateY(${e * 12}px) scale(${0.985 + t * 0.015}); filter:blur(${e * 3}px);`;
    },
  };
}

/** Staggered delay (ms) for grids. Kept signature-compatible with existing
 *  callers. Returns 0 under reduced motion. */
export function stagger(index: number, base = 60): number {
  return rm() ? 0 : index * base;
}

// ── Svelte actions (use:directive) ───────────────────────────────────────────

/** Pointer-tracked 3D tilt + lift for interactive glass cards.
 *  Transform/box-shadow only (GPU-friendly). RTL flips rotateY via dirSign(). */
export function tiltCard(
  node: HTMLElement,
  opts: { max?: number; lift?: number } = {}
): { destroy(): void } {
  if (rm()) return { destroy() {} }; // flat card; CSS :hover supplies shadow-only elevation

  const max = opts.max ?? 7;
  const lift = opts.lift ?? -6;
  node.style.transformStyle = 'preserve-3d';

  const apply = (rx: number, ry: number, y: number, glow: boolean, settle: boolean) => {
    node.style.transition = settle
      ? `transform var(--dur-settle) var(--ease-settle), box-shadow var(--dur-settle) ease`
      : `transform 120ms ease-out, box-shadow 220ms ease`;
    node.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(${y}px)`;
    node.style.boxShadow = glow ? 'var(--glow-primary)' : '';
  };

  const move = (e: PointerEvent) => {
    const r = node.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    apply(-py * max, px * max * dirSign(), lift, true, false);
  };
  const leave = () => apply(0, 0, 0, false, true);

  node.addEventListener('pointermove', move);
  node.addEventListener('pointerleave', leave);
  return {
    destroy() {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerleave', leave);
    },
  };
}

/** Spring press feedback for buttons / pills. CSS :active covers the
 *  reduced-motion case. */
export function pressable(
  node: HTMLElement,
  opts: { scale?: number } = {}
): { destroy(): void } {
  if (rm()) return { destroy() {} };

  const s = opts.scale ?? 0.955;
  node.style.transition = `transform var(--dur-micro) var(--ease-settle)`;
  const down = () => { node.style.transform = `scale(${s})`; };
  const up = () => { node.style.transform = 'scale(1)'; };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointerleave', up);
  return {
    destroy() {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointerleave', up);
    },
  };
}

/**
 * Liquid sliding active-indicator — the signature moment. Injects one
 * absolutely-positioned pill behind the container's items and glides + stretches
 * it to the active child. The spring glide is the CSS transition on
 * .liquid-indicator (instant under reduced motion via the media clamp).
 *
 * Container must be position:relative; items should be position:relative;z-index:1.
 * RTL-safe: measurement is purely geometric (no left/right literals).
 *
 * Returns { update, destroy }. Call update() whenever the active item changes.
 */
export function liquidIndicator(
  container: HTMLElement,
  opts: { activeSelector: string }
): { update(): void; destroy(): void } {
  const ind = document.createElement('span');
  ind.className = 'liquid-indicator';
  ind.setAttribute('aria-hidden', 'true');
  container.prepend(ind);

  const update = () => {
    const active = container.querySelector<HTMLElement>(opts.activeSelector);
    if (!active) {
      ind.style.opacity = '0';
      return;
    }
    const c = container.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    const x = a.left - c.left + container.scrollLeft;
    const y = a.top - c.top + container.scrollTop;
    ind.style.width = `${a.width}px`;
    ind.style.height = `${a.height}px`;
    ind.style.transform = `translate(${x}px, ${y}px)`;
    ind.style.opacity = '1';
  };

  const ro = new ResizeObserver(update);
  ro.observe(container);
  const raf = requestAnimationFrame(update);

  return {
    update,
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      ind.remove();
    },
  };
}

/**
 * Staggered entrance for a grid/list when it scrolls into view.
 * Hides children in JS then reveals them — so if JS fails, content stays
 * visible (CSS default). Under reduced motion, reveals everything instantly
 * and registers no observer.
 *
 * Returns a cleanup function.
 */
export function enterGrid(
  container: HTMLElement,
  opts: { base?: number; y?: number } = {}
): () => void {
  const kids = Array.from(container.children) as HTMLElement[];

  if (rm()) {
    kids.forEach((k) => {
      k.style.opacity = '1';
      k.style.transform = 'none';
    });
    return () => {};
  }

  const y = opts.y ?? 14;
  const base = opts.base ?? 60; // ms

  kids.forEach((k) => {
    k.style.opacity = '0';
    k.style.transform = `translateY(${y}px)`;
    k.style.willChange = 'opacity, transform';
  });

  let done = false;
  const reveal = () => {
    if (done) return;
    done = true;
    kids.forEach((k, i) => {
      k.style.transition = `opacity var(--dur-settle) ease ${i * base}ms, transform var(--dur-settle) var(--ease-settle) ${i * base}ms`;
      k.style.opacity = '1';
      k.style.transform = 'translateY(0)';
      // release the GPU layer hint after the animation has run
      window.setTimeout(() => { k.style.willChange = ''; }, i * base + 700);
    });
  };

  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          reveal();
          io?.disconnect();
        }
      },
      { rootMargin: '-10% 0px' }
    );
    io.observe(container);
  } else {
    reveal();
  }

  return () => io?.disconnect();
}

/**
 * First-load splash: the 8-point khatam star assembles, then fades to reveal
 * the dashboard. ≤900ms, skippable (click / Enter / Esc), once per session.
 * Under reduced motion (or if already shown) it dismisses on the next frame
 * and never blocks. The assembly itself is CSS keyframes on [data-spoke] /
 * .khatam-core; this just orchestrates timing + skip + the once-per-session gate.
 */
export function khatamSplash(
  node: HTMLElement,
  { onDone }: { onDone: () => void }
): { skip(): void } {
  const alreadyShown =
    typeof sessionStorage !== 'undefined' && sessionStorage.getItem('omos-splash') === '1';

  if (rm() || alreadyShown) {
    requestAnimationFrame(onDone);
    return { skip: onDone };
  }
  try {
    sessionStorage.setItem('omos-splash', '1');
  } catch {
    /* sessionStorage may be unavailable (private mode) — proceed without it */
  }

  let finished = false;
  let timer: ReturnType<typeof setTimeout>;

  // Function declarations (hoisted) so finish() and onKey() can reference
  // each other without TDZ issues.
  function finish(): void {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    node.removeEventListener('click', finish);
    window.removeEventListener('keydown', onKey);
    node.classList.add('khatam-splash--out');
    // allow the fade-out to play, then hand control back
    window.setTimeout(onDone, 280);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      finish();
    }
  }

  // Auto-dismiss once the star has assembled (~700ms) — total incl. fade ≈ 1s.
  timer = setTimeout(finish, 720);
  node.addEventListener('click', finish);
  window.addEventListener('keydown', onKey);

  return { skip: finish };
}

// ── Skeleton shimmer ──────────────────────────────────────────────────────────

/** Tailwind class string for skeleton shimmer (keyframe lives in tailwind.config.js). */
export const shimmerClass =
  'animate-shimmer bg-gradient-to-r from-surface-raised via-surface-overlay to-surface-raised bg-[length:200%_100%]';
