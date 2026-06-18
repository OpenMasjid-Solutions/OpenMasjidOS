import { browser } from '$app/environment';
import { writable } from 'svelte/store';

type Theme = 'dark' | 'light';

const STORAGE_KEY = 'openmasjid-theme';

function getInitial(): Theme {
  if (!browser) return 'dark';
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
  if (stored === 'light' || stored === 'dark') return stored;
  // Default to dark per design spec
  return 'dark';
}

function createThemeStore() {
  const { subscribe, set, update } = writable<Theme>(getInitial());

  return {
    subscribe,
    toggle() {
      update(t => {
        const next = t === 'dark' ? 'light' : 'dark';
        if (browser) {
          localStorage.setItem(STORAGE_KEY, next);
          document.documentElement.setAttribute('data-theme', next);
        }
        return next;
      });
    },
    set(theme: Theme) {
      set(theme);
      if (browser) {
        localStorage.setItem(STORAGE_KEY, theme);
        document.documentElement.setAttribute('data-theme', theme);
      }
    },
  };
}

export const theme = createThemeStore();
