/**
 * Platform settings — NEVER masjid/prayer config (that belongs to apps,
 * CLAUDE.md §13). Presentation prefs live client-side; the server owns the
 * security-relevant switches (custom apps, terminals) and the community repo
 * list.
 */
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { readJson, writeJson } from '../util/json-store';

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
}

const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');
const DEFAULTS: PlatformSettings = {
  allowCustomApps: false,
  webTerminal: false,
  rootTerminal: false,
  communityRepos: [],
  updateChannel: 'stable',
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
