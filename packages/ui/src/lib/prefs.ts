// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Platform-only presentation preferences, persisted per-browser in
 * localStorage. NONE of this is masjid/prayer config (CLAUDE.md §13). Exposed to
 * React via useSyncExternalStore so changes apply live everywhere.
 */
import { useSyncExternalStore } from 'react';
import i18n from './i18n';

export interface Prefs {
  theme: 'dark' | 'light' | 'system';
  accent: string;
  wallpaper: string;
  /** Optional custom wallpaper image URL — overrides the preset when set. */
  wallpaperImage: string;
  dashboardName: string;
  language: string;
  showSplash: boolean;
  pinnedApps: string[];
  /** Show the glass clock widget on the dashboard. */
  showClock: boolean;
  /** 24-hour clock when true, else 12-hour. */
  clock24h: boolean;
  /** IANA time zone for the clock; "" = the device's local zone. */
  timezone: string;
}

const KEY = 'omos-prefs';

const DEFAULTS: Prefs = {
  theme: 'dark',
  accent: 'cyan',
  wallpaper: 'aurora',
  wallpaperImage: '',
  dashboardName: '',
  language: 'en',
  showSplash: true,
  pinnedApps: [],
  showClock: true,
  clock24h: false,
  timezone: '',
};

/**
 * The accent palette.
 *
 * `onPrimary` is the ink that goes ON this accent — a very dark variant of the accent
 * itself, not a shared near-black. It has to travel with the accent because
 * `applyAccent` sets `--color-btn` to `primary`, and an inline custom property on
 * the root element beats the stylesheet's own `[data-theme="light"]` block. So
 * choosing any accent in LIGHT mode replaced the dark blue button with a bright one
 * while `--color-on-primary` stayed `#FFFFFF` — white on gold measures 1.67:1, about
 * a third of the 4.5:1 AA needs, and every primary button, avatar and app-icon
 * fallback on the page went with it. Keep each of these above 4.5:1 against its own
 * `primary`; `theme-tokens.test.ts` does the arithmetic.
 */
export const ACCENTS: Record<
  string,
  { label: string; primary: string; hover: string; subtle: string; onPrimary: string }
> = {
  cyan: { label: 'Cyan', primary: '#22D3EE', hover: '#67E8F9', subtle: 'rgba(34,211,238,0.12)', onPrimary: '#00131C' },
  teal: { label: 'Teal', primary: '#2DD4BF', hover: '#5EEAD4', subtle: 'rgba(45,212,191,0.12)', onPrimary: '#00201B' },
  sky: { label: 'Sky', primary: '#38BDF8', hover: '#7DD3FC', subtle: 'rgba(56,189,248,0.12)', onPrimary: '#001B2E' },
  violet: { label: 'Violet', primary: '#A78BFA', hover: '#C4B5FD', subtle: 'rgba(167,139,250,0.14)', onPrimary: '#190B3D' },
  gold: { label: 'Gold', primary: '#FBBF24', hover: '#FCD34D', subtle: 'rgba(251,191,36,0.14)', onPrimary: '#2B1B00' },
};

export const WALLPAPERS: Record<string, { label: string; preview: string }> = {
  aurora: { label: 'Aurora', preview: 'radial-gradient(circle at 30% 25%, #22D3EE, #0A1828 70%)' },
  ocean: { label: 'Ocean', preview: 'linear-gradient(150deg, #38BDF8, #2563EB 55%, #0a1838 100%)' },
  twilight: { label: 'Twilight', preview: 'linear-gradient(150deg, #C084FC, #7C3AED 55%, #0a0618 100%)' },
  berry: { label: 'Berry', preview: 'linear-gradient(150deg, #F472B6, #A21CAF 55%, #1a0518 100%)' },
  sunset: { label: 'Sunset', preview: 'linear-gradient(150deg, #FBBF24, #FB7185 55%, #1a0d08 100%)' },
  ember: { label: 'Ember', preview: 'linear-gradient(150deg, #FB923C, #DC2626 55%, #190806 100%)' },
  forest: { label: 'Forest', preview: 'linear-gradient(150deg, #4ADE80, #15803D 55%, #04140e 100%)' },
  night: { label: 'Night', preview: 'linear-gradient(150deg, #60A5FA, #1E3A8A 55%, #02060f 100%)' },
  graphite: { label: 'Graphite', preview: 'linear-gradient(150deg, #64748B, #334155 55%, #0b0f17 100%)' },
};

const RTL_LANGS = new Set(['ar', 'ur']);

// ── side effects ────────────────────────────────────────────────────────────
export function applyAccent(id: string): void {
  const el = document.documentElement;
  const a = ACCENTS[id];
  if (!a || id === 'cyan') {
    el.style.removeProperty('--color-primary');
    el.style.removeProperty('--color-primary-hover');
    el.style.removeProperty('--color-primary-subtle');
    el.style.removeProperty('--color-btn');
    el.style.removeProperty('--color-btn-hover');
    // The default accent alone falls back to the stylesheet, and that is deliberate
    // rather than an omission: light theme's default button is a DARK blue (#0369A1)
    // that wants white ink, while every other accent paints a BRIGHT button that
    // wants dark ink. Clearing the property is the only way both themes get the one
    // that suits them.
    el.style.removeProperty('--color-on-primary');
    return;
  }
  el.style.setProperty('--color-primary', a.primary);
  el.style.setProperty('--color-primary-hover', a.hover);
  el.style.setProperty('--color-primary-subtle', a.subtle);
  el.style.setProperty('--color-btn', a.primary);
  el.style.setProperty('--color-btn-hover', a.hover);
  // Set alongside the background, never separately — these two are one decision, and
  // an accent whose ink is left behind is unreadable in light mode.
  el.style.setProperty('--color-on-primary', a.onPrimary);
}

export function applyWallpaper(id: string): void {
  document.documentElement.setAttribute('data-wallpaper', WALLPAPERS[id] ? id : 'aurora');
}

export function applyTheme(theme: Prefs['theme']): void {
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

export function applyLanguage(lang: string): void {
  document.documentElement.setAttribute('lang', lang);
  document.documentElement.setAttribute('dir', RTL_LANGS.has(lang) ? 'rtl' : 'ltr');
  void i18n.changeLanguage(lang);
}

// ── store ───────────────────────────────────────────────────────────────────
function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

let state: Prefs = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode — just won't persist */
  }
}
function emit() {
  for (const l of listeners) l();
}

export const prefsStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  patch(part: Partial<Prefs>) {
    state = { ...state, ...part };
    persist();
    if (part.accent !== undefined) applyAccent(state.accent);
    if (part.wallpaper !== undefined) applyWallpaper(state.wallpaper);
    if (part.theme !== undefined) applyTheme(state.theme);
    if (part.language !== undefined) applyLanguage(state.language);
    emit();
  },
  togglePin(id: string) {
    const pinned = state.pinnedApps.includes(id)
      ? state.pinnedApps.filter((x) => x !== id)
      : [...state.pinnedApps, id];
    state = { ...state, pinnedApps: pinned };
    persist();
    emit();
  },
  pin(id: string) {
    if (state.pinnedApps.includes(id)) return;
    state = { ...state, pinnedApps: [...state.pinnedApps, id] };
    persist();
    emit();
  },
  /** Replace the pinned order (drag-to-reorder in the dock). The caller passes
   *  the full intended order. */
  setPins(ids: string[]) {
    state = { ...state, pinnedApps: ids };
    persist();
    emit();
  },
  /** Apply all persisted side effects on first load. */
  hydrate() {
    applyAccent(state.accent);
    applyWallpaper(state.wallpaper);
    applyTheme(state.theme);
    applyLanguage(state.language);
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (state.theme === 'system') applyTheme('system');
    });
  },
};

export function usePrefs(): Prefs {
  return useSyncExternalStore(prefsStore.subscribe, prefsStore.get, prefsStore.get);
}
