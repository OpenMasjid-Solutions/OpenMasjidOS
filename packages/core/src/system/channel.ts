// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Update channels — the ONE place that turns "which channel is this masjid on?"
 * into concrete URLs, branches and image tags.
 *
 * Two channels, one global setting (CLAUDE.md §13.4):
 *   `main` → **Stable**. What beta masjids run. The default.
 *   `dev`  → **Development**. Untested, moves constantly.
 *
 * The channel governs the OS *and* every installed app together — never a mix.
 * Every consumer (catalog, changelog, version check, self-update, app installs)
 * derives its target from here, so adding a channel or moving a branch is a change
 * in one file rather than a hunt through five.
 *
 * **The channel name is not always the branch name.** The channel value matches
 * OpenMasjidAPPS, whose stable branch genuinely is `main`. This repo's stable
 * branch is `master`, so `osBranch()` maps it. That asymmetry is deliberate and
 * worth keeping visible: the alternative was renaming this repo's default branch,
 * which breaks every existing clone and the branch protection rule for no
 * functional gain. Anything that needs a git ref for the OS must go through
 * `osBranch()` and never interpolate the channel directly.
 */
import { z } from 'zod';

export const CHANNELS = ['main', 'dev'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Validate a channel wherever it crosses a boundary (tRPC input, settings file). */
export const channelSchema = z.enum(CHANNELS);

export const DEFAULT_CHANNEL: Channel = 'main';

/**
 * Coerce anything persisted or supplied into a valid channel.
 *
 * Needed because `updateChannel` already existed as `'stable' | 'beta'` (declared,
 * defaulted, accepted by the settings router — but never actually read). A masjid
 * upgrading from an older build therefore has `"updateChannel": "stable"` sitting in
 * settings.json, and `withDefaults` spreads persisted values OVER the defaults — so
 * without this the stale word would win and we would fetch
 * `…/OpenMasjidAPPS/stable/catalog.json`, which 404s. Legacy values map to their
 * obvious successors; anything unrecognised falls back to Stable, because the safe
 * failure for "I can't tell which channel you wanted" is the tested one.
 */
export function coerceChannel(value: unknown): Channel {
  if (value === 'main' || value === 'dev') return value;
  if (value === 'stable') return 'main'; // legacy ≤0.48.x
  if (value === 'beta') return 'dev'; // legacy ≤0.48.x
  return DEFAULT_CHANNEL;
}

export function isChannel(value: unknown): value is Channel {
  return value === 'main' || value === 'dev';
}

// ── What each channel resolves to ────────────────────────────────────────────

const APPS_REPO = 'https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidAPPS';
const OS_RAW = 'https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS';

/**
 * This repo's git branch for a channel. `main` → `master` (see the header note).
 * Everything needing an OS ref must call this.
 */
export function osBranch(channel: Channel): string {
  return channel === 'dev' ? 'dev' : 'master';
}

/**
 * The core's channel ALIAS image tag — the moving pointer, used when we don't know
 * (or can't reach) the target version. The platform updates by pulling its own image
 * rather than by pulling git, so a channel maps to a TAG here, not a branch.
 * `type=ref,event=branch` in the build workflow publishes `:dev` for the dev branch;
 * `:latest` is default-branch-only, which is what keeps Stable stable.
 */
export function coreImageTag(channel: Channel): string {
  return channel === 'dev' ? 'dev' : 'latest';
}

/**
 * The tag to actually PULL for an update, given the version the update check found.
 *
 * Development pulls the **exact version** (`:0.50.0-dev.2`), not `:dev`. The two are
 * not equivalent: `:dev` is a moving alias that can still point at the previous build
 * while the new one is mid-publish, so pulling it can silently install different bytes
 * from the version the admin was just told about. Pulling the exact tag either gets
 * that build or fails loudly — and a visible "that build isn't published yet" beats
 * an update that quietly does nothing, which is the failure this whole change exists
 * to remove.
 *
 * Stable deliberately stays on `:latest`. There the two ARE equivalent by
 * construction (only the default branch publishes `:latest`), and `:latest` is what
 * the installer writes and what every existing box already pulls — so making Stable
 * depend on a per-version tag would add a new way for a release to fail for no gain.
 */
export function coreTargetTag(channel: Channel, version: string | null | undefined): string {
  const v = String(version ?? '').trim();
  if (channel === 'dev' && v) return v;
  return coreImageTag(channel);
}

/** The App Store catalog for a channel. OpenMasjidAPPS's stable branch IS `main`. */
export function catalogUrl(channel: Channel): string {
  // An explicit override wins outright (air-gapped installs, a local mirror, tests).
  // It is channel-independent on purpose: if an operator pinned a catalog, switching
  // channels must not silently reach past it to GitHub.
  const override = process.env.OPENMASJID_CATALOG_URL;
  if (override) return override;
  return `${APPS_REPO}/${channel}/catalog.json`;
}

/** The VERSION file used by the "is there an update?" check. */
export function versionCheckUrl(channel: Channel): string {
  const override = process.env.OPENMASJID_VERSION_CHECK_URL;
  if (override) return override;
  return `${OS_RAW}/${osBranch(channel)}/VERSION`;
}

/** The changelog shown in "What's new". */
export function changelogUrl(channel: Channel): string {
  const override = process.env.OPENMASJID_CHANGELOG_URL;
  if (override) return override;
  return `${OS_RAW}/${osBranch(channel)}/CHANGELOG.md`;
}

/**
 * A channel's user-facing name. Deliberately NOT the raw value: a volunteer should
 * read "Stable", not "main" — they are not choosing a git branch, they are choosing
 * whether this masjid runs tested software.
 */
export function channelLabel(channel: Channel): string {
  return channel === 'dev' ? 'Development' : 'Stable';
}

// There is deliberately NO `usesMovingTags()` here any more, and nothing should
// reintroduce one. Both channels now version their builds — Development uses semver
// prereleases (`0.50.0-dev.2`) and pins an immutable per-build image tag, exactly as
// Stable pins a release and a digest. That is what lets Development share Stable's
// update path: compare versions, notify, pull, recreate. Every "Development is
// special" branch that used to hang off this predicate (digest comparison, published
// image digests in the catalogue, a manual "check for a new Development build"
// button, a suppressed update banner) existed only because dev builds had no version
// to compare, and all of it is gone.
