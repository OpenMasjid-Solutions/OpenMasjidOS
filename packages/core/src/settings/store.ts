/**
 * Platform settings — NEVER masjid/prayer config (that belongs to apps,
 * CLAUDE.md §13). The server owns the security-relevant switches (custom apps,
 * terminals), the community repo list, and a small mirror of the dashboard's
 * PRESENTATION prefs (`appearance`) so apps can inherit the masjid's look via
 * GET /api/public/appearance. Appearance is still authored in the browser
 * (lib/prefs.ts) and synced here — it carries no masjid data.
 */
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { readJson, writeJson } from '../util/json-store';

/** Presentation only — theme/wallpaper/accent/language. No masjid data. */
export interface Appearance {
  theme: 'system' | 'dark' | 'light';
  wallpaper: string;
  wallpaperImage: string;
  accent: string;
  lang: string;
}

/**
 * Notification webhook config (OpenMasjidOS Fabric). The admin sets one
 * destination; apps relay messages through the platform (POST /api/fabric/notify)
 * and never see the URL. `url` is a secret — only exposed via the protected
 * settings API, never on the public appearance endpoint.
 */
export interface NotificationConfig {
  enabled: boolean;
  type: 'slack' | 'discord' | 'generic';
  url: string;
  /** Optional short label prefixed to each message (e.g. the masjid's name). */
  label: string;
}

export interface PlatformSettings {
  /** Gates the App Store "3rd Party App" button (CLAUDE.md §11). */
  allowCustomApps: boolean;
  /** Adds a "Shell" option to each app (a terminal into its container). */
  webTerminal: boolean;
  /** Adds a root terminal into the OpenMasjidOS core itself. */
  rootTerminal: boolean;
  /** CasaOS-compatible community app-store repo URLs. */
  communityRepos: string[];
  /** Update channel for the core itself. */
  updateChannel: 'stable' | 'beta';
  /** Mirror of the dashboard's presentation prefs, exposed to apps. */
  appearance: Appearance;
  /** Notification webhook for the Fabric (apps relay through it). */
  notifications: NotificationConfig;
}

const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');
const DEFAULTS: PlatformSettings = {
  allowCustomApps: false,
  webTerminal: false,
  rootTerminal: false,
  communityRepos: [],
  updateChannel: 'stable',
  appearance: { theme: 'dark', wallpaper: 'aurora', wallpaperImage: '', accent: 'cyan', lang: 'en' },
  notifications: { enabled: false, type: 'slack', url: '', label: '' },
};

let cache: PlatformSettings = readJson(SETTINGS_PATH, DEFAULTS);

export function getSettings(): PlatformSettings {
  return cache;
}

export function updateSettings(patch: Partial<PlatformSettings>): PlatformSettings {
  cache = { ...cache, ...patch };
  writeJson(SETTINGS_PATH, cache);
  return cache;
}

export function addCommunityRepo(url: string): PlatformSettings {
  const repos = cache.communityRepos.includes(url)
    ? cache.communityRepos
    : [...cache.communityRepos, url];
  return updateSettings({ communityRepos: repos });
}

export function removeCommunityRepo(url: string): PlatformSettings {
  return updateSettings({ communityRepos: cache.communityRepos.filter((r) => r !== url) });
}
