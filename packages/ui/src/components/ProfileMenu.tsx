// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Top-right account button + menu: dark/light toggle, What's new, Settings, Sign out.
 *
 * Built on the shared DropdownMenu primitive rather than a hand-rolled panel.
 * The old version declared `role="menu"` on a plain <div> whose children were
 * ordinary <button>s with no `role="menuitem"` — an ARIA menu with no items,
 * which reads WORSE to a screen reader than claiming nothing at all. It also
 * had no arrow-key movement, no Escape, no `aria-expanded` on the trigger, and
 * no focus return when it closed, so a keyboard user who opened it was left
 * with focus on the page body.
 *
 * Radix supplies all of that, plus typeahead and collision-aware placement, and
 * it mirrors correctly in RTL for free — the old `.menu` panel was pinned with
 * logical properties, but its open/close focus behaviour was direction-blind.
 */
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Moon, Sun, Settings as SettingsIcon, LogOut, User, Sparkles } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { clearCsrf } from '../lib/session';
import { usePrefs, prefsStore } from '../lib/prefs';
import { useWindows } from './Windows';
import { changelogWindowOptions } from './ChangelogWindow';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

export function ProfileMenu({ onSignedOut }: { onSignedOut: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Subscribed so the icon flips the instant the theme changes; the value read
  // below still comes from the DOM, which is the source of truth `applyTheme`
  // writes to (and which the pre-paint script sets before React ever runs).
  usePrefs();
  const windows = useWindows();

  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const logout = trpc.auth.logout.useMutation({
    onSettled: () => {
      clearCsrf();
      onSignedOut();
    },
  });
  const sysInfo = trpc.system.info.useQuery();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="profile-btn" aria-label={t('profile.menu')}>
          <User size={20} />
        </button>
      </DropdownMenuTrigger>
      {/* `align="end"` is direction-aware: it pins to the inline end, so the
          menu hangs left of the button in LTR and right of it in RTL. The old
          panel used a fixed `inset-inline-end`, which happened to agree in both
          — but only because the button is in the corner. */}
      <DropdownMenuContent align="end" className="glass-raised" sideOffset={8}>
        <DropdownMenuItem onSelect={() => prefsStore.patch({ theme: isDark ? 'light' : 'dark' })}>
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
          {isDark ? t('profile.lightMode') : t('profile.darkMode')}
        </DropdownMenuItem>

        {/* Release notes reachable without hunting through Settings → Advanced —
            it's the first thing an admin looks for after an update. Same managed
            window as the Settings button, so opening it from either place focuses
            the one window instead of stacking a duplicate. */}
        <DropdownMenuItem onSelect={() => windows.open(changelogWindowOptions(t('changelog.title')))}>
          <Sparkles size={16} /> {t('changelog.open')}
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <SettingsIcon size={16} /> {t('profile.settings')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => logout.mutate()}>
          <LogOut size={16} /> {t('profile.signOut')}
        </DropdownMenuItem>

        {sysInfo.data?.version && (
          <div className="menu-version">OpenMasjidOS v{sysInfo.data.version}</div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
