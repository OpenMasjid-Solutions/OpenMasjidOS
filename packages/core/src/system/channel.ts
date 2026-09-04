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
 * The core's channel ALIAS image tag — the moving pointer. Used only as a FALLBACK,
 * when the target version isn't known (offline, or an unreadable VERSION file). The
 * platform updates by pulling its own image rather than by pulling git, so a channel
 * maps to a TAG here, not a branch. `type=ref,event=branch` publishes `:dev` for the
 * dev branch; `:latest` is published only by a non-prerelease release tag.
 */
export function coreImageTag(channel: Channel): string {
  return channel === 'dev' ? 'dev' : 'latest';
}

/**
 * The tag to actually PULL for an update, given the version the update check found.
 *
 * **Both channels pull the exact version** (`:0.50.2`, `:0.50.2-dev.1`) — never the
 * moving alias. An alias can point at different bytes than the version just announced,
 * and every failure that produces is silent: you pull, you recreate, you are still on
 * the old build, and the check keeps offering the same update forever.
 *
 * Stable used to stay on `:latest` here, and the justification in this comment was
 * simply wrong: it claimed the two were "equivalent by construction". They were not.
 * `:latest` was published by BOTH the master-branch build and the release-tag build,
 * two independent runs of the same commit, so it routinely differed from `:X.Y.Z` in
 * bytes — verified on v0.50.1 (`latest` 5eaf997, `0.50.1` 23696bb). Worse, `:0.50.0`
 * was itself republished by a README-only commit pushed straight to master, so a
 * "pinned" release tag had already moved once in the wild.
 *
 * The workflow now publishes `:latest` from exactly one place (a non-prerelease `v*`
 * tag). That makes the alias trustworthy again — and pulling the exact version anyway
 * means a release whose tag was never pushed fails LOUDLY ("that build isn't published
 * yet") instead of quietly installing the previous release under the new version's name.
 *
 * Falls back to the alias only when there's no version to aim at, which is the offline
 * case: better to pull something than nothing.
 */
export function coreTargetTag(channel: Channel, version: string | null | undefined): string {
  const v = String(version ?? '').trim();
  return v || coreImageTag(channel);
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
