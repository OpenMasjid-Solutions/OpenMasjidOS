// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * "What's new" — the project changelog, fetched server-side (we're LAN-only, so the
 * browser never reaches GitHub itself).
 *
 * Lives in a managed traffic-light window rather than a centered modal, matching
 * OpenMasjid Kiosk's panel and the rest of this OS: release notes are something an
 * admin reads down and refers back to, so it wants a frame they can move, resize and
 * leave open beside the page — not a dialog that traps focus.
 *
 * Its own component (rather than living inside Settings) because it opens from two
 * places now: Settings → Advanced, and the account menu in the top-right. Both use
 * the same `openChangelogWindow` below, so the shared `dedupeKey` means the second
 * one focuses the window already open instead of stacking a duplicate.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { Changelog } from './Changelog';

export function ChangelogWindow() {
  const { t } = useTranslation();
  const info = trpc.system.info.useQuery();
  const log = trpc.system.changelog.useQuery();
  const version = info.data?.version;
  return (
    <div className="wn">
      <p className="wn-sub">
        {version ? t('changelog.subtitle', { version }) : t('changelog.subtitleNoVersion')}
      </p>
      {log.isPending ? (
        <div className="skeleton" style={{ height: '10rem' }} />
      ) : log.data?.text ? (
        <>
          {!log.data.fresh && <p className="setting-row__hint">{t('changelog.stale')}</p>}
          <Changelog md={log.data.text} currentVersion={version} />
        </>
      ) : (
        <p className="setting-row__hint">{t('changelog.offline')}</p>
      )}
    </div>
  );
}

/** What both entry points pass to `windows.open()`. Keeping the options here (not
 *  just the component) is what guarantees both callers share the same `dedupeKey`. */
export function changelogWindowOptions(title: string): {
  title: string;
  icon: ReactNode;
  dedupeKey: string;
  wide: boolean;
  node: ReactNode;
} {
  return {
    title,
    icon: <Sparkles size={15} />,
    dedupeKey: 'changelog',
    wide: true,
    node: <ChangelogWindow />,
  };
}
