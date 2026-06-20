/*
 * serverSettings — the server-enforced platform toggles (web-terminal switches).
 * Unlike `prefs` (client-only presentation), these are authoritative on the
 * backend; this store just mirrors them for the UI and writes changes back.
 */

import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { api, type ServerSettings } from '$lib/api/client';

const DEFAULTS: ServerSettings = { web_terminal: false, root_terminal: false };

function create() {
  const { subscribe, set } = writable<ServerSettings>({ ...DEFAULTS });

  return {
    subscribe,
    /** Load the current settings from the server. */
    async load() {
      if (!browser) return;
      try {
        set(await api.settings.get());
      } catch {
        /* not signed in yet / unreachable — keep safe defaults */
      }
    },
    /** Persist new settings and reflect the server's response. */
    async update(next: ServerSettings) {
      set(next); // optimistic
      try {
        set(await api.settings.update(next));
      } catch {
        // revert to whatever the server actually has on failure
        try {
          set(await api.settings.get());
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export const serverSettings = create();
