/*
 * prefs — platform-only dashboard preferences (presentation + dock pins).
 *
 * Persisted to localStorage so they survive reloads. (Backend persistence will
 * arrive with the settings API; localStorage is the honest interim store.)
 */

import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export interface Prefs {
  /** Optional custom name shown in the greeting / dock. */
  dashboardName: string;
  /** Accent colour id — see ACCENTS. Applied live to the primary CSS tokens. */
  accent: string;
  /** Wallpaper id — see WALLPAPERS. Applied via data-wallpaper on <html>. */
  wallpaper: string;
  /** Advanced: when on, the App Store exposes a "3rd Party App" installer. */
  customApps: boolean;
  /** Whether to play the first-load khatam splash. */
  showSplash: boolean;
  /** App ids pinned to the dock. */
  pinnedApps: string[];
}

const KEY = 'omos-prefs';

const DEFAULTS: Prefs = {
  dashboardName: '',
  accent: 'cyan',
  wallpaper: 'aurora',
  customApps: false,
  showSplash: true,
  pinnedApps: [],
};

/** Selectable accent presets. Each live-applies to the primary tokens. */
export const ACCENTS: Record<string, { label: string; primary: string; hover: string; subtle: string }> = {
  cyan:   { label: 'Cyan',   primary: '#22D3EE', hover: '#67E8F9', subtle: 'rgba(34,211,238,0.12)' },
  teal:   { label: 'Teal',   primary: '#2DD4BF', hover: '#5EEAD4', subtle: 'rgba(45,212,191,0.12)' },
  sky:    { label: 'Sky',    primary: '#38BDF8', hover: '#7DD3FC', subtle: 'rgba(56,189,248,0.12)' },
  violet: { label: 'Violet', primary: '#A78BFA', hover: '#C4B5FD', subtle: 'rgba(167,139,250,0.14)' },
  gold:   { label: 'Gold',   primary: '#FBBF24', hover: '#FCD34D', subtle: 'rgba(251,191,36,0.14)' },
};

/** Selectable wallpapers. `preview` is a CSS gradient for the settings swatch;
 *  the actual scene colours live in tokens.css under [data-wallpaper="<id>"]. */
export const WALLPAPERS: Record<string, { label: string; preview: string }> = {
  aurora:   { label: 'Aurora',   preview: 'radial-gradient(circle at 30% 30%, #22D3EE, #0A1828 70%)' },
  twilight: { label: 'Twilight', preview: 'radial-gradient(circle at 30% 30%, #A78BFA, #0a0618 70%)' },
  sunset:   { label: 'Sunset',   preview: 'radial-gradient(circle at 30% 30%, #FB923C, #1a0d08 70%)' },
  forest:   { label: 'Forest',   preview: 'radial-gradient(circle at 30% 30%, #22C55E, #04140e 70%)' },
  night:    { label: 'Night',    preview: 'radial-gradient(circle at 30% 30%, #385AA0, #02060f 75%)' },
};

function load(): Prefs {
  if (!browser) return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(p: Prefs): void {
  if (!browser) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode / storage disabled — preferences just won't persist */
  }
}

/** Live-apply an accent to the primary CSS custom properties. The default
 *  'cyan' removes the inline override so each theme's tuned primary applies. */
export function applyAccent(id: string): void {
  if (!browser) return;
  const el = document.documentElement;
  if (id === 'cyan' || !ACCENTS[id]) {
    el.style.removeProperty('--color-primary');
    el.style.removeProperty('--color-primary-hover');
    el.style.removeProperty('--color-primary-subtle');
    return;
  }
  const a = ACCENTS[id];
  el.style.setProperty('--color-primary', a.primary);
  el.style.setProperty('--color-primary-hover', a.hover);
  el.style.setProperty('--color-primary-subtle', a.subtle);
}

/** Live-apply a wallpaper by setting data-wallpaper on <html>. */
export function applyWallpaper(id: string): void {
  if (!browser) return;
  document.documentElement.setAttribute('data-wallpaper', WALLPAPERS[id] ? id : 'aurora');
}

function createPrefs() {
  const { subscribe, set, update } = writable<Prefs>(load());

  return {
    subscribe,
    /** Merge a partial update, persist, and apply side effects. */
    patch(part: Partial<Prefs>) {
      update((p) => {
        const next = { ...p, ...part };
        persist(next);
        if (part.accent !== undefined) applyAccent(next.accent);
        if (part.wallpaper !== undefined) applyWallpaper(next.wallpaper);
        return next;
      });
    },
    /** Toggle an app's presence in the dock pins. */
    togglePin(id: string) {
      update((p) => {
        const pinned = p.pinnedApps.includes(id)
          ? p.pinnedApps.filter((x) => x !== id)
          : [...p.pinnedApps, id];
        const next = { ...p, pinnedApps: pinned };
        persist(next);
        return next;
      });
    },
    /** Pin an app to the dock (idempotent — used by drag-and-drop). */
    pin(id: string) {
      update((p) => {
        if (p.pinnedApps.includes(id)) return p;
        const next = { ...p, pinnedApps: [...p.pinnedApps, id] };
        persist(next);
        return next;
      });
    },
    /** Re-apply persisted side effects on app load. */
    hydrate() {
      const p = load();
      set(p);
      applyAccent(p.accent);
      applyWallpaper(p.wallpaper);
    },
  };
}

export const prefs = createPrefs();
