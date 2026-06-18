import { cubicOut, cubicInOut } from 'svelte/easing';

// Check user preference once at module load
const reducedMotion = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
  : false;

// Gentle rise + fade transition for page elements
export function riseIn(node: Element, { delay = 0, duration = 300 } = {}) {
  if (reducedMotion) {
    return { duration: 0, css: () => '' };
  }
  return {
    delay,
    duration,
    easing: cubicOut,
    css: (t: number) => `
      opacity: ${t};
      transform: translateY(${(1 - t) * 12}px);
    `,
  };
}

// Staggered delay helper for grid animations
export function stagger(index: number, base = 60): number {
  return reducedMotion ? 0 : index * base;
}

// Skeleton shimmer: returns a class string
export const shimmerClass = 'animate-shimmer bg-gradient-to-r from-surface-raised via-surface-overlay to-surface-raised bg-[length:200%_100%]';
