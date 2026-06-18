import { writable, derived } from 'svelte/store';
import en from './en.json';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
type Locale = typeof en;

const locales: Record<string, DeepPartial<Locale>> = { en };

export const locale = writable<string>('en');

export const t = derived(locale, ($locale) => {
  const strings = locales[$locale] ?? locales['en'];
  // Simple dot-path accessor: t('dashboard.title')
  return function get(path: string): string {
    const parts = path.split('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic traversal
    let cur: any = strings;
    for (const p of parts) {
      cur = cur?.[p];
      if (cur === undefined) return path;
    }
    return typeof cur === 'string' ? cur : path;
  };
});
