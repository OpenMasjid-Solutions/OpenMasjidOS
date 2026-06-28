// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Optional ambient scene toggle (a small, persisted client-only flag). Kept out
 * of the synced appearance prefs on purpose — it's a local, per-device extra and
 * never leaves the browser.
 */
import { useEffect, useState } from 'react';

const KEY = 'omos.ambient';

let on = (() => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();

const subs = new Set<() => void>();

export const ambient = {
  get: (): boolean => on,
  toggle: (): void => {
    on = !on;
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* private mode / storage disabled — keep the in-memory value */
    }
    subs.forEach((f) => f());
  },
  subscribe: (f: () => void): (() => void) => {
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  },
};

export function useAmbient(): boolean {
  const [v, setV] = useState(ambient.get());
  useEffect(() => ambient.subscribe(() => setV(ambient.get())), []);
  return v;
}
