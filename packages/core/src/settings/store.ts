// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
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
import { coerceChannel, DEFAULT_CHANNEL, type Channel } from '../system/channel';

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

/**
 * Scheduled off-site backup config. This holds only NON-secret metadata — the
 * actual destination credentials (NAS password / SFTP key / Google Drive token)
 * live ONLY in the rclone config file under the data dir (chmod 600), never here
 * and never in any API response. See system/backup-upload.ts.
 */
export interface BackupConfig {
  enabled: boolean;
  schedule: 'daily' | 'weekly';
  /** Keep the newest N backups on the remote; older ones are pruned. */
  retention: number;
  /** Which rclone backend is configured (for display only). 'none' = unset. */
  destKind: 'none' | 'drive' | 'sftp' | 'smb' | 'webdav';
  /** Short human label for the destination, e.g. "Google Drive" or "nas.local". */
  destLabel: string;
  /** Sub-path/folder on the remote where backups are written. */
  remotePath: string;
  /** True once a destination (rclone remote) has been saved. */
  configured: boolean;
  /** Last run status (surfaced in Settings). */
  lastRunAt: string;
  lastResult: 'ok' | 'error' | 'never';
  lastMessage: string;
  lastBackupName: string;
}

/**
 * Cloudflare Tunnel (remote access). The admin sets a tunnel token + their domain
 * once here; the OS runs `cloudflared` so apps are reachable from the internet at
 * that domain (CLAUDE.md §4 remote-access helper). The token is a SECRET and lives
 * only in config/cloudflare/.env (chmod 600), never here — this holds only the
 * non-secret domain + on/off. See system/cloudflared.ts.
 */
export interface CloudflareConfig {
  enabled: boolean;
  /** The public domain the tunnel serves, e.g. "omos.example.org" (no scheme). */
  domain: string;
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
  /** Update channel for the OS, the catalog and every installed app together
   *  (system/channel.ts). 'main' = Stable, 'dev' = Development. */
  updateChannel: Channel;
  /** Mirror of the dashboard's presentation prefs, exposed to apps. */
  appearance: Appearance;
  /** Notification webhook for the Fabric (apps relay through it). */
  notifications: NotificationConfig;
  /** Scheduled off-site backup config (non-secret; creds live in rclone.conf). */
  backups: BackupConfig;
  /** Cloudflare Tunnel remote access (non-secret; token lives in cloudflare/.env). */
  cloudflare: CloudflareConfig;
}

const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');
const DEFAULTS: PlatformSettings = {
  allowCustomApps: false,
  webTerminal: false,
  rootTerminal: false,
  communityRepos: [],
  updateChannel: DEFAULT_CHANNEL,
  appearance: { theme: 'dark', wallpaper: 'aurora', wallpaperImage: '', accent: 'cyan', lang: 'en' },
  notifications: { enabled: false, type: 'slack', url: '', label: '' },
  backups: {
    enabled: false,
    schedule: 'daily',
    retention: 7,
    destKind: 'none',
    destLabel: '',
    remotePath: 'OpenMasjidOS-Backups',
    configured: false,
    lastRunAt: '',
    lastResult: 'never',
    lastMessage: '',
    lastBackupName: '',
  },
  cloudflare: { enabled: false, domain: '' },
};

/** Merge persisted settings over defaults so a settings.json written by an older
 *  version (missing newer keys/sections like `backups`) never yields undefined. */
function withDefaults(s: Partial<PlatformSettings>): PlatformSettings {
  return {
    ...DEFAULTS,
    ...s,
    // MUST come after the spread. `updateChannel` shipped as 'stable' | 'beta' in
    // ≤0.48.x — declared and defaulted but never read — so an upgraded box has the
    // old word persisted, and spreading it over the default would win. Left alone it
    // would be interpolated into a catalog URL that 404s. coerceChannel maps the
    // legacy values and sends anything unrecognisable back to Stable.
    updateChannel: coerceChannel(s.updateChannel),
    appearance: { ...DEFAULTS.appearance, ...(s.appearance ?? {}) },
    notifications: { ...DEFAULTS.notifications, ...(s.notifications ?? {}) },
    backups: { ...DEFAULTS.backups, ...(s.backups ?? {}) },
    cloudflare: { ...DEFAULTS.cloudflare, ...(s.cloudflare ?? {}) },
  };
}

let cache: PlatformSettings = withDefaults(readJson(SETTINGS_PATH, {} as Partial<PlatformSettings>));

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

export function updateBackups(patch: Partial<BackupConfig>): PlatformSettings {
  return updateSettings({ backups: { ...cache.backups, ...patch } });
}

export function updateCloudflare(patch: Partial<CloudflareConfig>): PlatformSettings {
  return updateSettings({ cloudflare: { ...cache.cloudflare, ...patch } });
}
