// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Platform settings only (CLAUDE.md §13) — appearance, language, account,
 * advanced. No masjid/prayer config ever lives here; that belongs to apps.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, Upload, GitBranch, RefreshCw, Check, SquareTerminal, KeyRound, HardDrive, Bell, Heart, ShieldCheck, Cloud, CloudUpload, Trash2, Copy, ExternalLink, CreditCard, Pencil, Globe, Power, AlertTriangle, Image as ImageIcon, Sparkles, Wifi, ScrollText } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { getCsrf, setCsrf, withKey } from '../lib/session';
import { usePrefs, prefsStore, ACCENTS, WALLPAPERS } from '../lib/prefs';
import { Toggle } from '../components/Toggle';
import { Page } from '../components/Page';
import { LazyTerminal } from '../components/LazyTerminal';
import { UpdateModal } from '../components/UpdateModal';
import { RestoreModal } from '../components/RestoreModal';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PhoneField } from '../components/PhoneField';
import { AppLogs } from '../components/AppLogs';
import { openApp } from '../lib/apps';
import { changelogWindowOptions } from '../components/ChangelogWindow';
import { UpdateChannel } from '../components/UpdateChannel';
import { ChannelMigrate } from '../components/ChannelMigrate';
import { useWindows } from '../components/Windows';
import { useToast } from '../components/ToastProvider';
import { cn } from '../lib/cn';

// IANA zones for the clock picker, when the browser exposes them.
const TIMEZONES: string[] = (() => {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    return fn ? fn('timeZone') : [];
  } catch {
    return [];
  }
})();

/**
 * How to word an available core update.
 *
 * "Version X is available" is wrong for a CHANNEL move: going back to Stable targets an
 * OLDER number, so that sentence reads as an update to a lower version — the same mistake
 * the app rows already fixed by branching on `reason`. The server tells us which it is.
 */
function updateSentence(
  info: { updateAvailable: boolean; latest: string | null; reason: 'version' | 'channel' | null; channel: string },
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  if (!info.updateAvailable) return t('settings.upToDate');
  if (info.reason === 'channel') {
    return info.channel === 'dev'
      ? t('settings.updateChannelMoveToDev', { version: info.latest })
      : t('settings.updateChannelMoveToStable', { version: info.latest });
  }
  return t('settings.updateAvailable', { version: info.latest });
}

/** A small red/green/grey status dot. `online` undefined = unknown (grey). */
function StatusDot({ online, label: override }: { online: boolean | undefined; label?: string }) {
  const { t } = useTranslation();
  const color = online === undefined ? 'var(--color-ink-muted)' : online ? '#22c55e' : '#ef4444';
  // `override` exists for states that are not simply up or down. "Connected, but the
  // gateway has sent nothing" is red because the feature does not work — but calling
  // it "Offline" sends the admin to check a connection that is fine.
  const label =
    override ?? (online === undefined ? t('settings.statusChecking') : online ? t('settings.statusOnline') : t('settings.statusOffline'));
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      style={{
        display: 'inline-block',
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        boxShadow: online ? '0 0 6px rgba(34,197,94,0.6)' : undefined,
      }}
    />
  );
}

/** Masjid logo upload — reused across the masjid's outbound emails (alerts +
 *  receipts an app sends) and notification-webhook avatars. Presentation, not
 *  masjid/prayer config (that lives in apps). */
function BrandingPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [present, setPresent] = useState(false);
  const [ver, setVer] = useState(0); // cache-buster so a replace/remove reloads the preview

  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/branding/logo', {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-omos-csrf': getCsrf() },
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || t('errors.generic'));
      }
      setVer((v) => v + 1);
      setPresent(true);
      toast(t('settings.logoSaved'), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    try {
      const res = await fetch('/api/branding/logo', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'x-omos-csrf': getCsrf() },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || t('errors.generic'));
      }
      setVer((v) => v + 1);
      setPresent(false);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title">{t('settings.logo')}</h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.6rem' }}>{t('settings.logoHint')}</p>
      <div className="setting-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 12,
              display: 'grid',
              placeItems: 'center',
              background: 'rgba(255,255,255,0.9)',
              border: '1px solid var(--color-border, rgba(255,255,255,0.1))',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {/* onError hides the img + Remove button when no logo is set (404). */}
            <img
              src={`/api/public/logo?v=${ver}`}
              alt=""
              style={{ maxWidth: '100%', maxHeight: '100%', display: present ? 'block' : 'none', padding: 6 }}
              onLoad={() => setPresent(true)}
              onError={() => setPresent(false)}
            />
            {!present && <ImageIcon size={22} style={{ opacity: 0.4 }} />}
          </div>
          <div className="setting-row__text">
            <div className="setting-row__title">{present ? t('settings.logoSet') : t('settings.logoNone')}</div>
            <div className="setting-row__hint">{t('settings.logoFormats')}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
          <button className="btn btn--sm" disabled={uploading} onClick={() => inputRef.current?.click()}>
            {uploading ? t('settings.logoUploading') : present ? t('settings.logoReplace') : t('settings.logoUpload')}
          </button>
          {present && (
            <button className="btn btn--sm" onClick={() => void remove()} disabled={uploading}>
              {t('settings.logoRemove')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

export function Settings() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const prefs = usePrefs();
  const utils = trpc.useUtils();

  const serverSettings = trpc.settings.get.useQuery();
  const sysInfo = trpc.system.info.useQuery();
  const updateInfo = trpc.system.checkUpdate.useQuery(undefined, { enabled: false });
  // Needed by the channel-migration window (which apps are pending, and which way).
  const channelQ = trpc.system.channel.useQuery();
  const windows = useWindows();
  const [updateOpen, setUpdateOpen] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreUploading, setRestoreUploading] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [rebootOpen, setRebootOpen] = useState(false);
  const restoreInput = useRef<HTMLInputElement>(null);
  const updateClicks = useRef<number[]>([]);

  const reboot = trpc.system.reboot.useMutation({
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });

  // Release notes open as a managed window (traffic-light chrome, like the terminal
  // and file windows). The options come from the shared component so this and the
  // account menu use the same `dedupeKey` — opening from either focuses the one
  // window rather than stacking a second copy of the same notes.
  // Move every pending app onto the selected channel, then the OS when returning to
  // Stable. A window (not a modal) because it streams for minutes and the admin
  // should be able to look at something else while it runs.
  function openChannelMigrate() {
    const ch = channelQ.data;
    if (!ch || ch.pending.length === 0) return;
    windows.open({
      title: t('settings.channelMigrateTitle', { label: ch.label }),
      icon: <GitBranch size={15} />,
      dedupeKey: 'channel-migrate',
      wide: true,
      // No `apps` prop: ChannelMigrate reads what is still pending itself, so a remount
      // after the OS restart signs everyone out cannot replay a finished migration.
      node: <ChannelMigrate channelLabel={ch.label} revertOs={ch.channel === 'main'} />,
    });
  }

  function openChangelog() {
    windows.open(changelogWindowOptions(t('changelog.title')));
  }

  async function uploadAndRestore(file: File) {
    setRestoreUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/restore/upload', {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-omos-csrf': getCsrf() },
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || t('errors.generic'));
      }
      setRestoreFile(null);
      setRestoreOpen(true);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRestoreUploading(false);
    }
  }

  function openRootTerminal() {
    windows.open({
      title: t('settings.rootTerminalTitle'),
      dedupeKey: 'root-terminal',
      wide: true,
      icon: <SquareTerminal size={15} />,
      node: <LazyTerminal wsPath="/api/terminal/root" />,
    });
  }

  // Check for a core update and clearly report the result (the old version only
  // updated a tiny hint, so it felt like nothing happened). Spam-clicking it pops
  // a small, grateful easter egg — we're only human!
  async function checkUpdates() {
    const now = Date.now();
    updateClicks.current = [...updateClicks.current.filter((ts) => now - ts < 4000), now];
    if (updateClicks.current.length >= 6) {
      updateClicks.current = [];
      windows.open({
        title: t('settings.eagerTitle'),
        dedupeKey: 'update-eager',
        icon: <Heart size={15} />,
        node: <EagerNote sourceUrl={sysInfo.data?.sourceUrl} />,
      });
    }
    if (updateInfo.isFetching) return; // don't stack checks/toasts during a spam burst
    const r = await updateInfo.refetch();
    if (r.data) {
      toast(updateSentence(r.data, t), 'success');
    } else {
      toast(t('errors.generic'), 'error');
    }
  }

  const updateSettings = trpc.settings.update.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });

  const freeSpace = trpc.system.freeSpace.useMutation({
    onSuccess: (r) => toast(r.reclaimed === '0B' ? t('settings.freedNone') : t('settings.freedSpace', { amount: r.reclaimed }), 'success'),
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });

  const themes: Array<{ id: 'dark' | 'light' | 'system'; label: string }> = [
    { id: 'dark', label: t('settings.themeDark') },
    { id: 'light', label: t('settings.themeLight') },
    { id: 'system', label: t('settings.themeSystem') },
  ];

  return (
    <Page>
      <header className="page-head">
        <h1 className="page-title">{t('settings.title')}</h1>
        <p className="page-sub">{t('settings.subtitle')}</p>
      </header>

      {/* Appearance */}
      <section className="glass-raised panel">
        <h2 className="panel-title">{t('settings.appearance')}</h2>

        <div className="setting-row">
          <div className="setting-row__text"><div className="setting-row__title">{t('settings.theme')}</div></div>
          <div className="segmented glass-inset">
            {themes.map((th) => (
              <button key={th.id} className={cn(prefs.theme === th.id && 'is-active')} onClick={() => prefsStore.patch({ theme: th.id })}>
                {th.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row__text"><div className="setting-row__title">{t('settings.accent')}</div></div>
          <div className="swatch-row">
            {Object.entries(ACCENTS).map(([id, a]) => (
              <button
                key={id}
                className={cn('swatch', prefs.accent === id && 'is-active')}
                style={{ background: a.primary }}
                aria-label={a.label}
                onClick={() => prefsStore.patch({ accent: id })}
              />
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row__text"><div className="setting-row__title">{t('settings.wallpaper')}</div></div>
          <div className="wallpaper-row">
            {Object.entries(WALLPAPERS).map(([id, w]) => (
              <button
                key={id}
                className={cn('wallpaper', !prefs.wallpaperImage && prefs.wallpaper === id && 'is-active')}
                style={{ background: w.preview }}
                aria-label={w.label}
                onClick={() => prefsStore.patch({ wallpaper: id, wallpaperImage: '' })}
              />
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.wallpaperImage')}</div>
            <div className="setting-row__hint">{t('settings.wallpaperImageHint')}</div>
          </div>
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <input
              className="input glass-inset"
              style={{ maxWidth: '16rem' }}
              placeholder="https://…/wallpaper.jpg"
              value={prefs.wallpaperImage}
              onChange={(e) => prefsStore.patch({ wallpaperImage: e.target.value.trim() })}
            />
            {prefs.wallpaperImage && (
              <button className="btn btn--sm" onClick={() => prefsStore.patch({ wallpaperImage: '' })}>
                {t('common.cancel')}
              </button>
            )}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.dashboardName')}</div>
            <div className="setting-row__hint">{t('settings.dashboardNameHint')}</div>
          </div>
          <input
            className="input glass-inset"
            style={{ maxWidth: '14rem' }}
            placeholder={t('settings.dashboardNamePlaceholder')}
            value={prefs.dashboardName}
            onChange={(e) => prefsStore.patch({ dashboardName: e.target.value })}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row__text"><div className="setting-row__title">{t('settings.showSplash')}</div></div>
          <Toggle checked={prefs.showSplash} onChange={(v) => prefsStore.patch({ showSplash: v })} label={t('settings.showSplash')} />
        </div>

        <div className="setting-row">
          <div className="setting-row__text"><div className="setting-row__title">{t('settings.showClock')}</div></div>
          <Toggle checked={prefs.showClock} onChange={(v) => prefsStore.patch({ showClock: v })} label={t('settings.showClock')} />
        </div>

        {prefs.showClock && (
          <>
            <div className="setting-row">
              <div className="setting-row__text"><div className="setting-row__title">{t('settings.clockFormat')}</div></div>
              <div className="segmented glass-inset">
                <button className={cn(!prefs.clock24h && 'is-active')} onClick={() => prefsStore.patch({ clock24h: false })}>
                  {t('settings.clock12h')}
                </button>
                <button className={cn(prefs.clock24h && 'is-active')} onClick={() => prefsStore.patch({ clock24h: true })}>
                  {t('settings.clock24h')}
                </button>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-row__text"><div className="setting-row__title">{t('settings.timezone')}</div></div>
              <select
                className="select glass-inset"
                style={{ maxWidth: '16rem' }}
                value={prefs.timezone}
                onChange={(e) => prefsStore.patch({ timezone: e.target.value })}
              >
                <option value="">{t('settings.timezoneAuto')}</option>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </section>

      {/* Masjid logo (branding for emails + webhooks) */}
      <BrandingPanel />

      {/* Account */}
      <ChangePassword />

      {/* Notifications */}
      <NotificationsPanel />

      {/* Email provider (SMTP / Resend, shared with apps via the Fabric) */}
      <EmailPanel />

      {/* WhatsApp gateway (OpenWA, shared with apps via the Fabric). Sits beside Email
          because it is the same kind of thing — an outbound transport the platform owns
          on every app's behalf. */}
      <WhatsAppPanel />

      {/* Alerts — granular on/off per alert type (OS + apps) */}
      <AlertsPanel />

      {/* Payments (Stripe vault, shared with apps via the Fabric) */}
      <StripePanel />

      {/* Remote access (Cloudflare tunnel + domain) */}
      <CloudflarePanel />

      {/* Advanced */}
      <section className="glass-raised panel">
        <h2 className="panel-title">{t('settings.advanced')}</h2>

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.customApps')}</div>
            <div className="setting-row__hint">{t('settings.customAppsHint')}</div>
          </div>
          <Toggle
            checked={serverSettings.data?.allowCustomApps ?? false}
            onChange={(v) => updateSettings.mutate({ allowCustomApps: v })}
            label={t('settings.customApps')}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.webTerminal')}</div>
            <div className="setting-row__hint">{t('settings.webTerminalHint')}</div>
          </div>
          <Toggle
            checked={serverSettings.data?.webTerminal ?? false}
            onChange={(v) => updateSettings.mutate({ webTerminal: v })}
            label={t('settings.webTerminal')}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.rootTerminal')}</div>
            <div className="setting-row__hint">{t('settings.rootTerminalHint')}</div>
          </div>
          <Toggle
            checked={serverSettings.data?.rootTerminal ?? false}
            onChange={(v) => updateSettings.mutate({ rootTerminal: v })}
            label={t('settings.rootTerminal')}
          />
        </div>

        {serverSettings.data?.rootTerminal && (
          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">{t('settings.rootTerminalOpen')}</div>
            </div>
            <button className="btn" onClick={openRootTerminal}>
              <SquareTerminal size={15} /> {t('settings.rootTerminalOpen')}
            </button>
          </div>
        )}

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.updates')}</div>
            <div className="setting-row__hint">
              {updateInfo.data ? updateSentence(updateInfo.data, t) : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="btn" onClick={checkUpdates}>
              <RefreshCw size={15} /> {updateInfo.isFetching ? t('settings.checking') : t('settings.checkUpdates')}
            </button>
            <button className="btn" onClick={openChangelog}>
              <Sparkles size={15} /> {t('changelog.open')}
            </button>
            {updateInfo.data?.updateAvailable && (
              <button className="btn btn--primary" onClick={() => setUpdateOpen(true)}>
                <Download size={15} /> {t('settings.updateNow')}
              </button>
            )}
          </div>
        </div>

        <UpdateChannel onUpdateAll={openChannelMigrate} />

        <NetworkRow />

        <SslSection />

        <SshAccess />

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.storage')}</div>
            <div className="setting-row__hint">{t('settings.freeSpaceHint')}</div>
          </div>
          <button className="btn" disabled={freeSpace.isPending} onClick={() => freeSpace.mutate()}>
            <HardDrive size={15} /> {freeSpace.isPending ? t('settings.freeing') : t('settings.freeSpace')}
          </button>
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.reboot')}</div>
            <div className="setting-row__hint">{t('settings.rebootHint')}</div>
          </div>
          <button className="btn btn--danger" onClick={() => setRebootOpen(true)}>
            <Power size={15} /> {t('settings.reboot')}
          </button>
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.backup')}</div>
            <div className="setting-row__hint">{t('settings.backupHint')}</div>
            {/* The downloaded file is unencrypted and carries everything — say so
                here too, not only on the off-site panel. */}
            <div className="setting-row__hint">{t('settings.backupContentsBody')}</div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <a className="btn" href={withKey('/api/backup')}>
              <Download size={15} /> {t('settings.downloadBackup')}
            </a>
            <button className="btn" disabled={restoreUploading} onClick={() => restoreInput.current?.click()}>
              <Upload size={15} /> {restoreUploading ? t('settings.restoreUploading') : t('settings.restore')}
            </button>
            <input
              ref={restoreInput}
              type="file"
              accept=".gz,.tgz,application/gzip"
              className="visually-hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                if (f) setRestoreFile(f);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.sourceCode')}</div>
            <div className="setting-row__hint">{t('settings.sourceCodeHint')}</div>
          </div>
          <a className="btn btn--ghost" href={sysInfo.data?.sourceUrl ?? '#'} target="_blank" rel="noopener noreferrer">
            <GitBranch size={15} /> {t('settings.sourceCode')}
          </a>
        </div>

        <div className="setting-row">
          <div className="setting-row__text"><div className="setting-row__title">{t('settings.version')}</div></div>
          <span style={{ color: 'var(--color-ink-muted)', fontVariantNumeric: 'tabular-nums' }}>v{sysInfo.data?.version ?? '—'}</span>
        </div>
      </section>

      {/* Off-site backups (scheduled upload to Google Drive / NAS) */}
      <ScheduledBackupPanel />

      <UpdateModal open={updateOpen} onClose={() => setUpdateOpen(false)} currentVersion={sysInfo.data?.version ?? ''} />

      <Modal open={!!restoreFile} onClose={() => !restoreUploading && setRestoreFile(null)} title={t('settings.restoreConfirmTitle')}>
        <p>{t('settings.restoreConfirmBody')}</p>
        {restoreUploading ? (
          <p style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '1rem' }}>
            <span className="spinner" /> {t('settings.restoreUploading')}
          </p>
        ) : (
          <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
            <button className="btn" onClick={() => setRestoreFile(null)}>{t('common.cancel')}</button>
            <button className="btn btn--danger" onClick={() => restoreFile && uploadAndRestore(restoreFile)}>
              {t('settings.restore')}
            </button>
          </div>
        )}
      </Modal>

      <RestoreModal open={restoreOpen} onClose={() => setRestoreOpen(false)} />

      <Modal open={rebootOpen} onClose={() => !reboot.isPending && !reboot.isSuccess && setRebootOpen(false)} title={t('settings.rebootConfirmTitle')}>
        {reboot.isSuccess ? (
          <p style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span className="spinner" /> {t('settings.rebooting')}
          </p>
        ) : (
          <>
            <p>{t('settings.rebootConfirmBody')}</p>
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button className="btn" onClick={() => setRebootOpen(false)}>{t('common.cancel')}</button>
              <button className="btn btn--danger" disabled={reboot.isPending} onClick={() => reboot.mutate()}>
                <Power size={15} /> {reboot.isPending ? t('settings.rebooting') : t('settings.rebootConfirm')}
              </button>
            </div>
          </>
        )}
      </Modal>
    </Page>
  );
}

function SshAccess() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [key, setKey] = useState('');
  const [error, setError] = useState('');

  const addKey = trpc.system.addSshKey.useMutation({
    onSuccess: () => {
      setKey('');
      setError('');
      toast(t('settings.sshKeyAdded'), 'success');
    },
    onError: (e) => setError(e.message || t('errors.generic')),
  });

  return (
    <div style={{ paddingBlock: '0.9rem', borderBlockStart: '1px solid var(--color-border)' }}>
      <div className="setting-row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <KeyRound size={16} /> {t('settings.ssh')}
      </div>
      <div className="setting-row__hint" style={{ marginBlock: '0.2rem 0.6rem' }}>{t('settings.sshHint')}</div>
      <textarea
        className="textarea glass-inset"
        style={{ minHeight: '4.5rem' }}
        placeholder={t('settings.sshKeyPlaceholder')}
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn--primary btn--sm" style={{ marginBlock: '0.5rem' }} disabled={addKey.isPending || !key.trim()} onClick={() => { setError(''); addKey.mutate({ publicKey: key.trim() }); }}>
        <KeyRound size={14} /> {addKey.isPending ? t('settings.sshAdding') : t('settings.sshAddKey')}
      </button>
      <div className="setting-row__hint" style={{ marginBlock: '0.4rem 0.3rem' }}>{t('settings.sshPasswordNote')}</div>
      <pre className="logs glass-inset" style={{ maxHeight: 'none' }}>{t('settings.sshPasswordCmd')}</pre>
    </div>
  );
}

/**
 * Network row. Shows the address the CORE believes this machine has, not
 * `window.location.host` — the browser's URL bar is what the admin typed and told
 * us nothing about what the platform hands to apps, which is exactly how a stale
 * address went unnoticed after a subnet move.
 */
function NetworkRow() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const info = trpc.system.info.useQuery();
  const reconnect = trpc.system.reconnectApps.useMutation({
    onSuccess: (r) => toast(t('settings.reconnectDone', { count: r.updated.length }), 'success'),
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const net = info.data?.network;
  return (
    <div className="setting-row">
      <div className="setting-row__text">
        <div className="setting-row__title">{t('settings.network')}</div>
        <div className="setting-row__hint">
          {`${t('settings.address')}: ${net?.addresses?.[0] ?? window.location.host}`}
          {net?.localDomain ? ` · ${net.localDomain}` : ''}
        </div>
        <div className="setting-row__hint">{t('settings.reconnectHint')}</div>
      </div>
      <button className="btn" onClick={() => reconnect.mutate()} disabled={reconnect.isPending}>
        <Wifi size={15} /> {reconnect.isPending ? t('settings.reconnecting') : t('settings.reconnect')}
      </button>
    </div>
  );
}

function SslSection() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const tls = trpc.system.tlsInfo.useQuery();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');

  const refresh = () => utils.system.tlsInfo.invalidate();
  const regenerate = trpc.system.regenerateCert.useMutation({
    onSuccess: () => { refresh(); toast(t('settings.sslRegenerated'), 'success'); },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const setCustom = trpc.system.setCustomCert.useMutation({
    onSuccess: () => {
      refresh();
      setUploadOpen(false);
      setCert('');
      setKey('');
      setError('');
      toast(t('settings.sslSaved'), 'success');
    },
    onError: (e) => setError(e.message || t('errors.generic')),
  });

  const info = tls.data;
  const validTo = info?.validTo ? new Date(info.validTo).toLocaleDateString() : '—';
  // Set when the platform had to replace a damaged certificate at boot to keep the
  // dashboard reachable. Without saying so, an admin whose own certificate was
  // replaced would just meet an unexplained browser warning one morning.
  const recovered = info?.recovered;

  return (
    <div style={{ paddingBlock: '0.9rem', borderBlockStart: '1px solid var(--color-border)' }}>
      <div className="setting-row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <ShieldCheck size={16} /> {t('settings.ssl')}
      </div>
      <div className="setting-row__hint" style={{ marginBlock: '0.2rem 0.6rem' }}>
        {info
          ? info.type === 'custom'
            ? t('settings.sslCustomNote', { date: validTo })
            : t('settings.sslSelfSignedNote', { date: validTo })
          : t('settings.sslHint')}
      </div>
      {recovered && (
        <div
          className="glass-inset panel"
          style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', marginBlockEnd: '0.6rem', borderInlineStart: '3px solid var(--color-warning)' }}
        >
          <AlertTriangle size={18} style={{ color: 'var(--color-warning)', flexShrink: 0, marginBlockStart: 2 }} />
          <div className="setting-row__hint">
            {t(recovered.replaced === 'custom' ? 'settings.sslRecoveredCustom' : 'settings.sslRecoveredSelfSigned', {
              date: new Date(recovered.at).toLocaleDateString(),
              reason: recovered.reason,
            })}
          </div>
        </div>
      )}
      {info && (
        <pre className="logs glass-inset" style={{ maxHeight: 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {`${t('settings.sslFingerprint')}: ${info.fingerprint}`}
        </pre>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBlockStart: '0.6rem' }}>
        <button className="btn btn--sm" disabled={regenerate.isPending} onClick={() => regenerate.mutate()}>
          <RefreshCw size={14} /> {regenerate.isPending ? t('settings.sslRegenerating') : t('settings.sslRegenerate')}
        </button>
        <button className="btn btn--sm" onClick={() => { setError(''); setUploadOpen(true); }}>
          <ShieldCheck size={14} /> {t('settings.sslUseOwn')}
        </button>
      </div>

      <Modal open={uploadOpen} onClose={() => !setCustom.isPending && setUploadOpen(false)} title={t('settings.sslUploadTitle')}>
        <p className="setting-row__hint">{t('settings.sslUploadBody')}</p>
        <label className="label" style={{ marginBlockStart: '0.6rem' }}>{t('settings.sslCertLabel')}</label>
        <textarea
          className="textarea glass-inset"
          style={{ minHeight: '6rem', fontFamily: 'ui-monospace, monospace' }}
          placeholder="-----BEGIN CERTIFICATE-----"
          value={cert}
          onChange={(e) => setCert(e.target.value)}
        />
        <label className="label" style={{ marginBlockStart: '0.6rem' }}>{t('settings.sslKeyLabel')}</label>
        <textarea
          className="textarea glass-inset"
          style={{ minHeight: '6rem', fontFamily: 'ui-monospace, monospace' }}
          placeholder="-----BEGIN PRIVATE KEY-----"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        {error && <p className="form-error">{error}</p>}
        <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginBlockStart: '1rem' }}>
          <button className="btn" onClick={() => setUploadOpen(false)}>{t('common.cancel')}</button>
          <button
            className="btn btn--primary"
            disabled={setCustom.isPending || !cert.trim() || !key.trim()}
            onClick={() => setCustom.mutate({ cert: cert.trim() + '\n', key: key.trim() + '\n' })}
          >
            {setCustom.isPending ? t('settings.sslSaving') : t('settings.sslSave')}
          </button>
        </div>
      </Modal>
    </div>
  );
}

function ChangePassword() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');

  // Admin profile (name + email + WhatsApp number). Email is where OS alerts are sent;
  // a pre-email install sets it here for the first time. The phone is the same idea for
  // the WhatsApp channel — a destination, never a sign-in.
  const me = trpc.auth.me.useQuery();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const seeded = useRef(false);
  useEffect(() => {
    if (me.data && !seeded.current) {
      setName(me.data.name ?? '');
      setEmail(me.data.email ?? '');
      setPhone(me.data.phone ?? '');
      seeded.current = true;
    }
  }, [me.data]);
  const saveProfile = trpc.auth.updateProfile.useMutation({
    onSuccess: () => {
      utils.auth.me.invalidate();
      toast(t('settings.profileSaved'), 'success');
    },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });

  const change = trpc.auth.changePassword.useMutation({
    onSuccess: (res) => {
      // Changing the password rotates the session (and its dashboard key).
      setCsrf(res.csrf);
      setCurrent('');
      setNext('');
      setError('');
      toast(t('settings.passwordChanged'), 'success');
    },
    onError: (e) => setError(e.message || t('errors.generic')),
  });

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title">{t('settings.account')}</h2>
      <div className="field" style={{ maxWidth: '20rem' }}>
        <label className="label">{t('settings.accountName')}</label>
        <input className="input glass-inset" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field" style={{ maxWidth: '20rem' }}>
        <label className="label">{t('settings.accountEmail')}</label>
        <input className="input glass-inset" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <span className="hint">{t('settings.accountEmailHint')}</span>
      </div>
      <PhoneField
        value={phone}
        onChange={setPhone}
        label={t('settings.accountPhone')}
        hint={t('settings.accountPhoneHint')}
      />
      <button
        className="btn"
        style={{ marginBlockEnd: '1rem' }}
        disabled={saveProfile.isPending || (!name.trim() && !email.trim() && !phone.trim())}
        onClick={() =>
          saveProfile.mutate({
            name: name.trim() || undefined,
            email: email.trim() || undefined,
            // Sent even when blank, so clearing the box actually removes the number —
            // `undefined` would mean "leave it alone" and the field would look cleared
            // while alerts kept going to the old phone.
            phone: phone.trim(),
          })
        }
      >
        <Check size={15} /> {t('settings.saveProfile')}
      </button>
      <div className="field" style={{ maxWidth: '20rem' }}>
        <label className="label">{t('settings.currentPassword')}</label>
        <input className="input glass-inset" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="field" style={{ maxWidth: '20rem' }}>
        <label className="label">{t('settings.newPassword')}</label>
        <input className="input glass-inset" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      {error && <p className="form-error">{error}</p>}
      <button
        className="btn btn--primary"
        disabled={change.isPending || !current || next.length < 12}
        onClick={() => change.mutate({ currentPassword: current, newPassword: next })}
      >
        <Check size={15} /> {t('settings.changePassword')}
      </button>
    </section>
  );
}

/** Easter egg — shown when the "Check for updates" button is spam-clicked. */
function EagerNote({ sourceUrl }: { sourceUrl?: string }) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '0.85rem', padding: '0.5rem 0.25rem' }}>
      <Heart size={40} style={{ color: 'var(--color-primary)' }} />
      <h3 style={{ margin: 0, fontFamily: 'var(--font-display)' }}>{t('settings.eagerTitle')}</h3>
      <p style={{ color: 'var(--color-ink-muted)', maxWidth: '30rem', lineHeight: 1.55 }}>{t('settings.eagerBody')}</p>
      <a className="btn btn--primary" href={sourceUrl ?? 'https://github.com/OpenMasjid-Solutions/OpenMasjidOS'} target="_blank" rel="noopener noreferrer">
        <Heart size={15} /> {t('settings.eagerDonate')}
      </a>
    </div>
  );
}

type NotifType = 'slack' | 'discord' | 'generic';

function NotificationsPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const settings = trpc.settings.get.useQuery();
  const save = trpc.settings.update.useMutation({ onSuccess: () => utils.settings.get.invalidate() });
  const test = trpc.notifications.test.useMutation({
    onSuccess: () => toast(t('settings.notificationsTestSent'), 'success'),
    onError: (e) => toast(e.message || t('settings.notificationsTestFailed'), 'error'),
  });

  const n = settings.data?.notifications;
  // URL/label are edited locally and saved on blur; enabled/type save immediately.
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const seeded = useRef(false);
  useEffect(() => {
    if (n && !seeded.current) {
      setUrl(n.url);
      setLabel(n.label);
      seeded.current = true;
    }
  }, [n]);

  if (!n) return null;

  const config = (next: { enabled?: boolean; type?: NotifType; url?: string; label?: string }) => ({
    enabled: n.enabled,
    type: n.type,
    url,
    label,
    ...next,
  });
  const patch = (next: Parameters<typeof config>[0]) => save.mutate({ notifications: config(next) });

  const types: Array<{ id: NotifType; label: string }> = [
    { id: 'slack', label: t('settings.notificationsSlack') },
    { id: 'discord', label: t('settings.notificationsDiscord') },
    { id: 'generic', label: t('settings.notificationsGeneric') },
  ];

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title">{t('settings.notifications')}</h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.notificationsHint')}</p>

      <div className="setting-row">
        <div className="setting-row__text"><div className="setting-row__title">{t('settings.notificationsEnable')}</div></div>
        <Toggle checked={n.enabled} onChange={(v) => patch({ enabled: v })} label={t('settings.notificationsEnable')} />
      </div>

      {n.enabled && (
        <>
          <div className="setting-row">
            <div className="setting-row__text"><div className="setting-row__title">{t('settings.notificationsService')}</div></div>
            <div className="segmented glass-inset">
              {types.map((ty) => (
                <button key={ty.id} className={cn(n.type === ty.id && 'is-active')} onClick={() => patch({ type: ty.id })}>
                  {ty.label}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">{t('settings.notificationsUrl')}</div>
              <div className="setting-row__hint">{t('settings.notificationsUrlHint')}</div>
            </div>
            <input
              className="input glass-inset"
              style={{ maxWidth: '18rem' }}
              type="url"
              placeholder="https://hooks.slack.com/…"
              value={url}
              onChange={(e) => setUrl(e.target.value.trim())}
              onBlur={() => patch({})}
            />
          </div>

          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">{t('settings.notificationsLabel')}</div>
              <div className="setting-row__hint">{t('settings.notificationsLabelHint')}</div>
            </div>
            <input
              className="input glass-inset"
              style={{ maxWidth: '14rem' }}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={() => patch({})}
            />
          </div>

          <div className="setting-row">
            <div className="setting-row__text"><div className="setting-row__title">{t('settings.notificationsTest')}</div></div>
            <button
              className="btn"
              disabled={test.isPending || !url}
              onClick={async () => {
                // Persist the latest URL/label first so the test uses them.
                try {
                  await save.mutateAsync({ notifications: config({}) });
                } catch {
                  /* surfaced below if the test then fails */
                }
                test.mutate();
              }}
            >
              <Bell size={15} /> {test.isPending ? t('settings.notificationsTesting') : t('settings.notificationsTest')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

type BackupKind = 'drive' | 'sftp' | 'smb' | 'webdav';

/** Scheduled off-site backups — upload the config + app-data backup to Google
 *  Drive or a NAS (SFTP/SMB/WebDAV) on a schedule. Credentials are entered here
 *  but only ever stored server-side (rclone config); status never echoes them. */
function ScheduledBackupPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const windows = useWindows();
  const status = trpc.backups.status.useQuery();
  const refresh = () => utils.backups.status.invalidate();

  // Open the destination setup as a managed window (traffic-light chrome, like
  // the terminal/file windows) rather than a centered modal.
  function openSetup() {
    let id = -1;
    id = windows.open({
      title: t('settings.backupSetupTitle'),
      icon: <Cloud size={15} />,
      dedupeKey: 'backup-destination',
      node: (
        <BackupDestinationForm
          onClose={() => windows.close(id)}
          onSaved={() => { windows.close(id); refresh(); }}
        />
      ),
    });
  }

  const update = trpc.backups.update.useMutation({
    onSuccess: refresh,
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const clearDest = trpc.backups.clearDestination.useMutation({
    onSuccess: () => { refresh(); toast(t('settings.backupRemoved'), 'success'); },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const test = trpc.backups.test.useMutation({
    onSuccess: (r) => toast(r.message || t('settings.backupTestOk'), r.ok ? 'success' : 'error'),
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const runNow = trpc.backups.runNow.useMutation({
    onSuccess: () => { refresh(); toast(t('settings.backupRunDone'), 'success'); },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });

  const b = status.data;
  if (!b) return null;

  const kindLabel: Record<BackupKind, string> = {
    drive: t('settings.backupTypeDrive'),
    sftp: t('settings.backupTypeSftp'),
    smb: t('settings.backupTypeSmb'),
    webdav: t('settings.backupTypeWebdav'),
  };

  const lastRun =
    b.lastResult === 'never' || !b.lastRunAt
      ? t('settings.backupLastNever')
      : b.lastResult === 'ok'
        ? t('settings.backupLastOk', { date: new Date(b.lastRunAt).toLocaleString() })
        : t('settings.backupLastError', { date: new Date(b.lastRunAt).toLocaleString(), message: b.lastMessage });

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
        <Cloud size={18} /> {t('settings.offsiteBackups')}
      </h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.offsiteBackupsHint')}</p>

      {/* Say what is actually in the file BEFORE the admin picks somewhere to send
          it. A backup carries people's personal details and every saved key, and
          it is not encrypted — that has to be known at the moment of choosing. */}
      <div
        className="glass-inset panel"
        style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', marginBlockEnd: '0.9rem', borderInlineStart: '3px solid var(--color-warning)' }}
      >
        <AlertTriangle size={18} style={{ color: 'var(--color-warning)', flexShrink: 0, marginBlockStart: 2 }} />
        <div>
          <div className="setting-row__title">{t('settings.backupContentsTitle')}</div>
          <div className="setting-row__hint">{t('settings.backupContentsBody')}</div>
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-row__text">
          <div className="setting-row__title">{t('settings.backupDestination')}</div>
          <div className="setting-row__hint">
            {b.configured && b.destKind !== 'none'
              ? `${b.destLabel} · ${kindLabel[b.destKind as BackupKind]}`
              : t('settings.backupNoDestination')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button className="btn" onClick={openSetup}>
            <Cloud size={15} /> {b.configured ? t('settings.backupChange') : t('settings.backupSetUp')}
          </button>
          {b.configured && (
            <button className="btn" disabled={clearDest.isPending} onClick={() => clearDest.mutate()}>
              <Trash2 size={15} /> {t('settings.backupRemove')}
            </button>
          )}
        </div>
      </div>

      {b.configured && (
        <>
          <div className="setting-row">
            <div className="setting-row__text"><div className="setting-row__title">{t('settings.backupEnable')}</div></div>
            <Toggle checked={b.enabled} onChange={(v) => update.mutate({ enabled: v })} label={t('settings.backupEnable')} />
          </div>

          <div className="setting-row">
            <div className="setting-row__text"><div className="setting-row__title">{t('settings.backupSchedule')}</div></div>
            <div className="segmented glass-inset">
              <button className={cn(b.schedule === 'daily' && 'is-active')} onClick={() => update.mutate({ schedule: 'daily' })}>
                {t('settings.backupDaily')}
              </button>
              <button className={cn(b.schedule === 'weekly' && 'is-active')} onClick={() => update.mutate({ schedule: 'weekly' })}>
                {t('settings.backupWeekly')}
              </button>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">{t('settings.backupRetention')}</div>
              <div className="setting-row__hint">{t('settings.backupRetentionHint')}</div>
            </div>
            <input
              className="input glass-inset"
              style={{ maxWidth: '6rem' }}
              type="number"
              min={1}
              max={365}
              defaultValue={b.retention}
              onBlur={(e) => {
                const n = Math.max(1, Math.min(365, Math.round(Number(e.target.value) || b.retention)));
                if (n !== b.retention) update.mutate({ retention: n });
              }}
            />
          </div>

          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">{t('settings.backupStatus')}</div>
              <div className="setting-row__hint">{lastRun}</div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
                <RefreshCw size={15} /> {test.isPending ? t('settings.backupTesting') : t('settings.backupTest')}
              </button>
              <button className="btn btn--primary" disabled={runNow.isPending} onClick={() => runNow.mutate()}>
                <CloudUpload size={15} /> {runNow.isPending ? t('settings.backupRunning') : t('settings.backupRunNow')}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function BackupDestinationForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [kind, setKind] = useState<BackupKind>('drive');
  const [folder, setFolder] = useState('OpenMasjidOS-Backups');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [share, setShare] = useState('');
  const [url, setUrl] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [driveToken, setDriveToken] = useState('');
  const [error, setError] = useState('');

  const save = trpc.backups.setDestination.useMutation({
    onSuccess: () => { toast(t('settings.backupSaved'), 'success'); onSaved(); },
    onError: (e) => setError(e.message || t('errors.generic')),
  });

  const types: Array<{ id: BackupKind; label: string }> = [
    { id: 'drive', label: t('settings.backupTypeDrive') },
    { id: 'sftp', label: t('settings.backupTypeSftp') },
    { id: 'smb', label: t('settings.backupTypeSmb') },
    { id: 'webdav', label: t('settings.backupTypeWebdav') },
  ];

  function submit() {
    setError('');
    const trimmedFolder = folder.trim() || undefined;
    if (kind === 'drive') {
      save.mutate({ kind, folder: trimmedFolder, driveToken: driveToken.trim() });
    } else if (kind === 'sftp') {
      save.mutate({
        kind,
        folder: trimmedFolder,
        host: host.trim(),
        port: port ? Number(port) : undefined,
        user: user.trim(),
        ...(keyPem.trim() ? { keyPem } : { password }),
      });
    } else if (kind === 'smb') {
      save.mutate({ kind, folder: trimmedFolder, host: host.trim(), share: share.trim(), user: user.trim() || undefined, password: password || undefined });
    } else {
      save.mutate({ kind, folder: trimmedFolder, url: url.trim(), user: user.trim() || undefined, password: password || undefined });
    }
  }

  return (
    <>
      <label className="label">{t('settings.backupType')}</label>
      <div className="segmented glass-inset" style={{ marginBlockEnd: '0.7rem' }}>
        {types.map((ty) => (
          <button key={ty.id} className={cn(kind === ty.id && 'is-active')} onClick={() => { setKind(ty.id); setError(''); }}>
            {ty.label}
          </button>
        ))}
      </div>

      {kind === 'drive' && (
        <>
          <p className="setting-row__hint">{t('settings.backupDriveIntro')}</p>
          <ol style={{ margin: '0.4rem 0 0.6rem', paddingInlineStart: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', color: 'var(--color-ink)', lineHeight: 1.5 }}>
            <li>
              {t('settings.backupDriveStep1')}{' '}
              <a
                href="https://rclone.org/downloads/"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--color-primary)', textDecoration: 'none', whiteSpace: 'nowrap' }}
              >
                {t('settings.backupDriveStep1Link')} <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
              </a>
            </li>
            <li>
              {t('settings.backupDriveStep2')}
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'stretch', marginBlockStart: '0.35rem' }}>
                <pre className="logs glass-inset" style={{ maxHeight: 'none', flex: 1, margin: 0 }}>rclone authorize "drive"</pre>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText('rclone authorize "drive"');
                      toast(t('settings.backupCopied'), 'success');
                    } catch {
                      toast(t('errors.generic'), 'error');
                    }
                  }}
                >
                  <Copy size={14} /> {t('settings.backupCopy')}
                </button>
              </div>
            </li>
            <li>{t('settings.backupDriveStep3')}</li>
          </ol>
          <textarea
            className="textarea glass-inset"
            style={{ minHeight: '5rem', fontFamily: 'ui-monospace, monospace' }}
            placeholder='{"access_token":"…","token_type":"Bearer",…}'
            value={driveToken}
            onChange={(e) => setDriveToken(e.target.value)}
          />
        </>
      )}

      {kind === 'sftp' && (
        <>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <div className="field" style={{ flex: 2 }}>
              <label className="label">{t('settings.backupHost')}</label>
              <input className="input glass-inset" value={host} onChange={(e) => setHost(e.target.value)} placeholder="nas.local" />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="label">{t('settings.backupPort')}</label>
              <input className="input glass-inset" type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
            </div>
          </div>
          <div className="field">
            <label className="label">{t('settings.backupUser')}</label>
            <input className="input glass-inset" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
          </div>
          <div className="field">
            <label className="label">{t('settings.backupPassword')}</label>
            <input className="input glass-inset" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </div>
          <details>
            <summary className="setting-row__hint" style={{ cursor: 'pointer' }}>{t('settings.backupKeyOptional')}</summary>
            <textarea
              className="textarea glass-inset"
              style={{ minHeight: '4.5rem', fontFamily: 'ui-monospace, monospace', marginBlockStart: '0.4rem' }}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              value={keyPem}
              onChange={(e) => setKeyPem(e.target.value)}
            />
          </details>
        </>
      )}

      {kind === 'smb' && (
        <>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <div className="field" style={{ flex: 2 }}>
              <label className="label">{t('settings.backupHost')}</label>
              <input className="input glass-inset" value={host} onChange={(e) => setHost(e.target.value)} placeholder="nas.local" />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="label">{t('settings.backupShare')}</label>
              <input className="input glass-inset" value={share} onChange={(e) => setShare(e.target.value)} placeholder="backups" />
            </div>
          </div>
          <div className="field">
            <label className="label">{t('settings.backupUser')}</label>
            <input className="input glass-inset" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
          </div>
          <div className="field">
            <label className="label">{t('settings.backupPassword')}</label>
            <input className="input glass-inset" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </div>
        </>
      )}

      {kind === 'webdav' && (
        <>
          <div className="field">
            <label className="label">{t('settings.backupUrl')}</label>
            <input className="input glass-inset" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://nas.local/remote.php/dav/files/me/" />
          </div>
          <div className="field">
            <label className="label">{t('settings.backupUser')}</label>
            <input className="input glass-inset" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
          </div>
          <div className="field">
            <label className="label">{t('settings.backupPassword')}</label>
            <input className="input glass-inset" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </div>
        </>
      )}

      <div className="field" style={{ marginBlockStart: '0.4rem' }}>
        <label className="label">{t('settings.backupFolder')}</label>
        <input className="input glass-inset" value={folder} onChange={(e) => setFolder(e.target.value)} />
        <div className="setting-row__hint">{t('settings.backupFolderHint')}</div>
      </div>

      {error && <p className="form-error">{error}</p>}
      <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginBlockStart: '1rem' }}>
        <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn--primary" disabled={save.isPending} onClick={submit}>
          {save.isPending ? t('settings.backupSaving') : t('settings.backupSave')}
        </button>
      </div>
    </>
  );
}

interface StripeAccountPublic {
  id: string;
  label: string;
  publishableKey: string;
  hasSecret: boolean;
  hasWebhook: boolean;
}

/** Email provider (SMTP / Resend). Configured once; the OS sends admin alerts and
 *  apps send mail (receipts, parent notices) through it via the Fabric — no app ever
 *  handles mail credentials. */
function EmailPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const cfg = trpc.email.get.useQuery();
  const status = trpc.email.status.useQuery(undefined, { refetchInterval: 60_000 });

  const [provider, setProvider] = useState<'none' | 'smtp' | 'resend'>('none');
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(587);
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [apiKey, setApiKey] = useState('');
  const seeded = useRef(false);
  useEffect(() => {
    if (cfg.data && !seeded.current) {
      setProvider(cfg.data.provider);
      setFromEmail(cfg.data.fromEmail);
      setFromName(cfg.data.fromName);
      setHost(cfg.data.smtp.host);
      setPort(cfg.data.smtp.port);
      setSecure(cfg.data.smtp.secure);
      setUser(cfg.data.smtp.user);
      seeded.current = true;
    }
  }, [cfg.data]);

  const save = trpc.email.save.useMutation({
    onSuccess: () => {
      setPass('');
      setApiKey('');
      utils.email.get.invalidate();
      utils.email.status.invalidate();
      toast(t('settings.emailSaved'), 'success');
    },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const test = trpc.email.test.useMutation({
    onSuccess: (r) => toast(t('settings.emailTestSent', { to: r.to }), 'success'),
    onError: (e) => toast(e.message || t('settings.emailTestFailed'), 'error'),
  });

  // Basic From-address validation so an invalid address is caught before Save
  // (the server also validates + verifies the provider before persisting).
  const EMAIL_OK = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
  const fromTrimmed = fromEmail.trim();
  const fromInvalid = provider !== 'none' && fromTrimmed !== '' && !EMAIL_OK.test(fromTrimmed);
  const canSave = provider === 'none' || EMAIL_OK.test(fromTrimmed);

  function onSave() {
    save.mutate({
      provider,
      fromEmail: fromEmail.trim(),
      fromName: fromName.trim(),
      smtp: { host: host.trim(), port, secure, user: user.trim(), pass: pass || undefined },
      resend: { apiKey: apiKey || undefined },
    });
  }

  if (!cfg.data) return null;

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
        <StatusDot online={status.isLoading ? undefined : status.data?.configured} /> {t('settings.email')}
      </h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.emailHint')}</p>

      <div className="field" style={{ maxWidth: '22rem' }}>
        <label className="label">{t('settings.emailProvider')}</label>
        <select className="input glass-inset" value={provider} onChange={(e) => setProvider(e.target.value as 'none' | 'smtp' | 'resend')}>
          <option value="none">{t('settings.emailNone')}</option>
          <option value="smtp">SMTP</option>
          <option value="resend">Resend</option>
        </select>
      </div>

      {provider !== 'none' && (
        <>
          <div className="field" style={{ maxWidth: '22rem' }}>
            <label className="label">{t('settings.emailFrom')}</label>
            <input
              className="input glass-inset"
              type="email"
              placeholder="no-reply@yourmasjid.org"
              value={fromEmail}
              aria-invalid={fromInvalid}
              style={fromInvalid ? { borderColor: '#ef4444' } : undefined}
              onChange={(e) => setFromEmail(e.target.value)}
            />
            {fromInvalid && <span className="hint" style={{ color: '#ef4444' }}>{t('settings.emailFromInvalid')}</span>}
          </div>
          <div className="field" style={{ maxWidth: '22rem' }}>
            <label className="label">{t('settings.emailFromName')}</label>
            <input className="input glass-inset" value={fromName} onChange={(e) => setFromName(e.target.value)} />
          </div>
        </>
      )}

      {provider === 'smtp' && (
        <>
          <div className="field" style={{ maxWidth: '22rem' }}>
            <label className="label">{t('settings.emailSmtpHost')}</label>
            <input className="input glass-inset" placeholder="smtp.example.org" value={host} onChange={(e) => setHost(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div className="field" style={{ maxWidth: '8rem' }}>
              <label className="label">{t('settings.emailSmtpPort')}</label>
              <input className="input glass-inset" type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 587)} />
            </div>
            <div className="setting-row" style={{ alignItems: 'end' }}>
              <div className="setting-row__text"><div className="setting-row__title">{t('settings.emailSmtpSecure')}</div></div>
              <Toggle checked={secure} onChange={setSecure} label={t('settings.emailSmtpSecure')} />
            </div>
          </div>
          <div className="field" style={{ maxWidth: '22rem' }}>
            <label className="label">{t('settings.emailSmtpUser')}</label>
            <input className="input glass-inset" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <div className="field" style={{ maxWidth: '22rem' }}>
            <label className="label">{t('settings.emailSmtpPass')}</label>
            <input className="input glass-inset" type="password" autoComplete="off" placeholder={cfg.data.hasSmtpPass ? t('settings.emailSecretKept') : ''} value={pass} onChange={(e) => setPass(e.target.value)} />
          </div>
        </>
      )}

      {provider === 'resend' && (
        <div className="field" style={{ maxWidth: '22rem' }}>
          <label className="label">{t('settings.emailResendKey')}</label>
          <input className="input glass-inset" type="password" autoComplete="off" placeholder={cfg.data.hasResendKey ? t('settings.emailSecretKept') : 're_…'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBlockStart: '0.6rem' }}>
        <button className="btn btn--primary" disabled={save.isPending || !canSave} onClick={onSave}>
          <Check size={15} /> {save.isPending ? t('settings.emailVerifying') : t('settings.emailSave')}
        </button>
        {status.data?.configured && (
          <button className="btn" disabled={test.isPending} onClick={() => test.mutate({})}>
            {test.isPending ? t('settings.emailTesting') : t('settings.emailTest')}
          </button>
        )}
      </div>
    </section>
  );
}

/** Granular alert matrix (UniFi-style): OS built-ins + each app's declared alerts,
 *  each routable to Email and/or Webhook (both on by default; both off = muted). */
/** WhatsApp gateway (OpenWA). The admin installs OpenWA from the App Store, pastes the
 *  API key + session id it was configured with, links the phone with a pairing code, and
 *  every alert/app message then flows through the platform's paced queue. The API key is
 *  write-only here: the server returns an "is set" flag, never the value. */
function WhatsAppPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const windows = useWindows();
  const cfg = trpc.whatsapp.get.useQuery();
  const [pairing, setPairing] = useState<string | null>(null);
  // While a pairing code is on screen the admin is standing at their phone typing it
  // in, and the only thing they want to know is whether it worked. A one-minute poll
  // meant reloading the page to find out. Fast only during that window — every poll is
  // an HTTP call to the gateway.
  const status = trpc.whatsapp.status.useQuery(undefined, {
    refetchInterval: pairing ? 3_000 : 60_000,
  });

  const [provider, setProvider] = useState<'none' | 'openwa'>('none');
  const [baseUrl, setBaseUrl] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [linkPhone, setLinkPhone] = useState('');
  const [askEnable, setAskEnable] = useState(false);
  /** The gateway's own last words when a start attempt did not stick. */
  const [gatewayCrash, setGatewayCrash] = useState<string | null>(null);
  // The pairing code stops being useful the instant the phone is linked, and leaving
  // it on screen is what made "did that work?" a page reload.
  useEffect(() => {
    if (pairing && status.data?.state === 'ready') {
      setPairing(null);
      toast(t('settings.whatsappLinkedNow'), 'success');
      void utils.whatsapp.get.invalidate();
    }
    // `toast`/`utils`/`t` are stable for the life of the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing, status.data?.state]);

  const seededWa = useRef(false);
  useEffect(() => {
    if (cfg.data && !seededWa.current) {
      setProvider(cfg.data.provider);
      setBaseUrl(cfg.data.baseUrl);
      setSessionName(cfg.data.sessionName);
      seededWa.current = true;
    }
  }, [cfg.data]);

  const save = trpc.whatsapp.save.useMutation({
    onSuccess: () => {
      setApiKey('');
      utils.whatsapp.get.invalidate();
      utils.whatsapp.status.invalidate();
      // Turning the feature on or off changes whether the gateway app is listed at all,
      // so the store's cached catalog is now stale.
      utils.store.catalog.invalidate();
      toast(t('settings.whatsappSaved'), 'success');
    },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const link = trpc.whatsapp.link.useMutation({
    onSuccess: (r) => {
      setPairing(r.code ?? null);
      utils.whatsapp.get.invalidate();
      utils.whatsapp.status.invalidate();
    },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const test = trpc.whatsapp.test.useMutation({
    onSuccess: () => toast(t('settings.whatsappTestSent'), 'success'),
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const restartGateway = trpc.whatsapp.restartGateway.useMutation({
    onSuccess: (r) => {
      // Only clear the previous failure when this attempt actually held — otherwise
      // the panel would flash back to looking healthy while the container restarts.
      setGatewayCrash(r.ok ? null : (r.output ?? null));
      if (r.ok) toast(t('settings.whatsappGatewayStarted'), 'success');
      utils.whatsapp.get.invalidate();
      utils.whatsapp.status.invalidate();
    },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });

  if (!cfg.data) return null;
  const s = status.data;
  const gw = cfg.data.gateway;
  const on = provider !== 'none';

  /** Turning it ON is gated on the warning; turning it OFF is immediate and reversible. */
  function setEnabled(next: boolean) {
    if (next) return setAskEnable(true);
    setProvider('none');
    save.mutate({ provider: 'none' });
  }

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
        <StatusDot online={status.isLoading ? undefined : Boolean(s?.connected)} /> {t('settings.whatsapp')}
      </h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.6rem' }}>{t('settings.whatsappHint')}</p>

      {/* One switch owns the whole feature. Off, the gateway app is not even listed in
          the App Store — nobody can install a WhatsApp client from OpenMasjidOS without
          first reading, here, what it risks. */}
      <Toggle checked={on} onChange={setEnabled} label={t('settings.whatsappEnable')} />

      {/* This dialog is the exception to "no confirmation on reversible switches"
          (ConfirmDialog's own rule): what it risks is not a platform setting but the
          masjid's phone number, and a banned number does not come back. */}
      <ConfirmDialog
        open={askEnable}
        onClose={() => setAskEnable(false)}
        onConfirm={() => {
          setAskEnable(false);
          setProvider('openwa');
          save.mutate({ provider: 'openwa' });
        }}
        title={t('settings.whatsappRiskTitle')}
        body={t('settings.whatsappRiskBody')}
        cost={t('settings.whatsappRiskCost')}
        confirmLabel={t('settings.whatsappRiskAccept')}
        pending={save.isPending}
      />

      {on && (
        <>
          {/* Step one is the gateway app itself. It is hidden from the dashboard and the
              store on purpose, so this is the only place it can be installed or opened. */}
          <div
            className="glass-inset panel"
            style={{ marginBlock: '0.8rem', borderInlineStart: '3px solid var(--color-accent)' }}
          >
            <div className="setting-row__title">{t('settings.whatsappGatewayStep')}</div>
            {!gw.installed ? (
              <>
                <div className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>
                  {t('settings.whatsappGatewayInstallHint')}
                </div>
                <Link className="btn btn--primary" to={`/store?install=${gw.id}`}>
                  <Download size={15} /> {t('settings.whatsappGatewayInstall')}
                </Link>
              </>
            ) : (
              <>
                <div className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>
                  {/* Said plainly, because doing it the other way silently breaks the
                      platform's ownership of the session and its pacing. */}
                  {t('settings.whatsappGatewayOpenHint')}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {/* The gateway is hidden from the dashboard grid and the dock, which
                      also took away the only Start button in the product — so a masjid
                      whose gateway stopped had no way to start it again short of a root
                      terminal, exactly when they can least afford one. */}
                  <button
                    className="btn"
                    disabled={restartGateway.isPending}
                    onClick={() => restartGateway.mutate()}
                  >
                    <RefreshCw size={15} />{' '}
                    {restartGateway.isPending
                      ? t('settings.whatsappGatewayStarting')
                      : gw.running
                        ? t('settings.whatsappGatewayRestart')
                        : t('settings.whatsappGatewayStart')}
                  </button>
                  <button
                    className="btn"
                    disabled={!gw.running || gw.openPort == null}
                    onClick={() => openApp(gw)}
                  >
                    <ExternalLink size={15} /> {t('settings.whatsappGatewayOpen')}
                  </button>
                  {/* Hiding the app took its logs away with it, and the gateway's own log
                      is the only place some failures are visible (an engine that won't
                      start says nothing over the API). So the button comes here. */}
                  <button
                    className="btn"
                    onClick={() =>
                      windows.open({
                        title: `${t('appDetail.logs')} — OpenWA`,
                        dedupeKey: `logs:${gw.id}`,
                        wide: true,
                        icon: <ScrollText size={15} />,
                        node: <AppLogs id={gw.id} />,
                      })
                    }
                  >
                    <ScrollText size={15} /> {t('settings.whatsappLogs')}
                  </button>
                </div>
                {!gw.running && !gatewayCrash && (
                  <span className="hint" style={{ marginInlineStart: '0.5rem' }}>
                    {t('settings.whatsappGatewayStopped')}
                  </span>
                )}
                {/* When it starts and dies, the reason is already in hand — putting it
                    on screen beats sending the admin to the logs button to find the one
                    line that matters. */}
                {gatewayCrash && (
                  <div style={{ marginBlockStart: '0.6rem' }}>
                    <div className="setting-row__hint" style={{ color: 'var(--color-danger)' }}>
                      {t('settings.whatsappGatewayCrashed')}
                    </div>
                    <pre
                      style={{
                        marginBlockStart: '0.4rem',
                        maxHeight: '11rem',
                        overflow: 'auto',
                        fontSize: '0.76rem',
                        lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        padding: '0.6rem 0.75rem',
                        borderRadius: '4px',
                        background: 'var(--color-surface-sunken, rgba(0,0,0,0.25))',
                      }}
                    >
                      {gatewayCrash}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {on && (
        <>
          <div className="field" style={{ maxWidth: '22rem' }}>
            <label className="label">{t('settings.whatsappSession')}</label>
            <input
              className="input glass-inset"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="openmasjid"
            />
            <span className="hint">{t('settings.whatsappSessionHint')}</span>
          </div>
          <div className="field" style={{ maxWidth: '22rem' }}>
            <label className="label">{t('settings.whatsappKey')}</label>
            <input
              className="input glass-inset"
              type="password"
              autoComplete="off"
              placeholder={cfg.data.hasApiKey ? t('settings.emailSecretKept') : ''}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <span className="hint">{t('settings.whatsappKeyHint')}</span>
          </div>
          <div className="field" style={{ maxWidth: '22rem' }}>
            <label className="label">{t('settings.whatsappUrl')}</label>
            <input
              className="input glass-inset"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t('settings.whatsappUrlAuto')}
            />
            <span className="hint">{t('settings.whatsappUrlHint')}</span>
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBlockStart: '0.3rem' }}>
        <button
          className="btn"
          disabled={save.isPending}
          onClick={() =>
            save.mutate({
              provider,
              baseUrl: baseUrl.trim(),
              sessionName: sessionName.trim() || undefined,
              apiKey: apiKey.trim() || undefined,
            })
          }
        >
          <Check size={15} /> {t('common.save')}
        </button>
        {cfg.data.configured && (
          <button className="btn" disabled={test.isPending} onClick={() => test.mutate({})}>
            {test.isPending ? t('settings.whatsappTesting') : t('settings.whatsappTest')}
          </button>
        )}
      </div>

      {/* Linking by pairing code, not QR: there is no screen on a headless box to
          photograph, and the admin may be nowhere near the machine. */}
      {cfg.data.configured && (
        <div style={{ marginBlockStart: '0.9rem' }}>
          <div className="setting-row__title">{t('settings.whatsappLink')}</div>
          <div className="setting-row__hint" style={{ marginBlockEnd: '0.4rem' }}>
            {t('settings.whatsappLinkHint')}
          </div>
          {/* The button rides INSIDE the field's input row, so it lines up with the
              number rather than with the bottom of the hint beneath it. */}
          <PhoneField
            value={linkPhone}
            onChange={setLinkPhone}
            hint={t('settings.whatsappLinkNumberHint')}
            trailing={
              <button
                className="btn"
                style={{ flex: '0 0 auto' }}
                disabled={link.isPending || linkPhone.length < 8}
                onClick={() => link.mutate({ phone: linkPhone })}
              >
                {link.isPending ? t('common.working') : t('settings.whatsappGetCode')}
              </button>
            }
          />
          {/* The code is typed into a phone held in the other hand, from a screen that
              may be across the room — so it is the biggest thing on the panel, spaced
              like a code rather than set as body text. */}
          {pairing && (
            <div
              className="glass-inset panel"
              style={{ marginBlockStart: '0.7rem', textAlign: 'center', padding: '1rem 1.2rem' }}
            >
              <div className="setting-row__hint" style={{ marginBlockEnd: '0.35rem' }}>
                {t('settings.whatsappCode')}
              </div>
              <code
                style={{
                  fontSize: '2.1rem',
                  fontWeight: 700,
                  letterSpacing: '0.35em',
                  // The trailing letter-space would otherwise push the code off-centre.
                  textIndent: '0.35em',
                  lineHeight: 1.25,
                  display: 'block',
                  userSelect: 'all',
                }}
              >
                {pairing}
              </code>
              <div className="setting-row__hint" style={{ marginBlockStart: '0.35rem' }}>
                {t('settings.whatsappCodeExpires')}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Which phone is actually linked. Without it the panel says "connected" and the
          admin has to take on trust that it is the number they meant — and on a masjid's
          spare handset that is exactly the thing worth double-checking. */}
      {s?.state === 'ready' && s.phone && (
        <p className="setting-row__hint" style={{ marginBlockStart: '0.8rem' }}>
          {t('settings.whatsappLinkedTo')} <strong>+{s.phone}</strong>
        </p>
      )}

      {/* Groups. Only once a phone is actually linked — there is nothing to list before
          that, and offering the section would just produce an error. */}
      {s?.state === 'ready' && <WhatsAppGroups approved={cfg.data.groups} />}

      {/* Commands. Same gate as Groups: there is nothing to configure before a phone
          is linked, and offering it would only produce an error. */}
      {s?.state === 'ready' && <WhatsAppCommands />}

      {/* The risk we warned about, actually happening. WhatsApp told the gateway it has
          limited this number, so the admin hears it here rather than wondering why
          messages stopped. */}
      {s?.restriction && (
        <div
          className="glass-inset panel"
          style={{ marginBlockStart: '0.8rem', borderInlineStart: '3px solid var(--color-danger)' }}
        >
          <div className="setting-row__hint">
            {t('settings.whatsappStateRestricted', { detail: s.restriction })}
          </div>
        </div>
      )}

      {/* Live state plus the queue depth, which is the honest answer to "why has my
          message not arrived?" — it is paced, so it may still be waiting its turn. */}
      {s && (
        <p className="setting-row__hint" style={{ marginBlockStart: '0.8rem' }}>
          {/* One line per distinct state. "Gateway down", "nothing created yet" and
              "created but not linked" have different fixes, so they must read differently. */}
          {s.state === 'ready'
            ? t('settings.whatsappStateReady', { queued: s.queued })
            : s.state === 'pending'
              ? t('settings.whatsappStateNotLinked')
              : s.state === 'no-session'
                ? t('settings.whatsappStateNoSession')
                : s.state === 'problem'
                  ? t('settings.whatsappStateProblem', { detail: s.detail })
                  : s.state === 'bad-key'
                    ? t('settings.whatsappStateBadKey')
                    : s.state === 'unreachable'
                      ? // The reason is the whole message here: "OpenWA is not installed"
                        // and "nothing is listening at the gateway address" have different
                        // fixes, and a single generic line gave the admin nothing to act on.
                        t('settings.whatsappStateUnreachable', { detail: s.detail })
                      : t('settings.whatsappStateOff')}
        </p>
      )}
    </section>
  );
}

/**
 * Approved WhatsApp groups.
 *
 * The approval step is the security model, not a convenience: OpenWA's group list holds
 * EVERY group the linked phone is in — the imam's family chat included — so apps are
 * never shown it. They see only what an admin deliberately approves here.
 *
 * The list is fetched on demand rather than polled: it is a handful of clicks a masjid
 * makes once, and a background poll of someone's entire group membership every minute is
 * both wasteful and slightly grim.
 */
function WhatsAppGroups({
  approved,
}: {
  approved: { id: string; label: string; name?: string; participants?: number }[];
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [browsing, setBrowsing] = useState(false);
  /** The group being renamed, and the text so far. */
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  /** The group a test is pending for — a message to a whole group cannot be unsent. */
  const [confirmTest, setConfirmTest] = useState<{ id: string; label: string } | null>(null);

  // Fetched only while the picker is open. The error is rendered inline rather than
  // toasted: "couldn't read your groups" is about the panel you are looking at, and a
  // toast would vanish before you had finished reading the list it failed to fill.
  const groups = trpc.whatsapp.groups.useQuery(undefined, { enabled: browsing, retry: false });

  const refresh = () => {
    utils.whatsapp.get.invalidate();
    utils.whatsapp.groups.invalidate();
  };
  const approve = trpc.whatsapp.approveGroup.useMutation({
    onSuccess: refresh,
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const unapprove = trpc.whatsapp.unapproveGroup.useMutation({
    onSuccess: refresh,
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const rename = trpc.whatsapp.renameGroup.useMutation({
    onSuccess: () => {
      setRenaming(null);
      refresh();
    },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const testGroup = trpc.whatsapp.testGroup.useMutation({
    onSuccess: () => {
      setConfirmTest(null);
      toast(t('settings.whatsappGroupTestSent'), 'success');
    },
    onError: (e) => {
      setConfirmTest(null);
      toast(e.message || t('errors.generic'), 'error');
    },
  });

  const approvedIds = new Set(approved.map((g) => g.id));

  return (
    <div style={{ marginBlockStart: '1rem' }}>
      <div className="setting-row__title">{t('settings.whatsappGroups')}</div>
      <div className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>
        {t('settings.whatsappGroupsHint')}
      </div>

      {approved.length > 0 && (
        <div className="glass-inset panel" style={{ marginBlockEnd: '0.6rem', padding: '0.6rem 0.9rem' }}>
          {approved.map((g) => (
            <div className="setting-row" key={g.id}>
              <div className="setting-row__text" style={{ flex: 1, minWidth: 0 }}>
                {renaming?.id === g.id ? (
                  <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      className="input glass-inset"
                      style={{ maxWidth: '16rem' }}
                      autoFocus
                      value={renaming.label}
                      maxLength={80}
                      onChange={(e) => setRenaming({ id: g.id, label: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && renaming.label.trim()) rename.mutate(renaming);
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                    <button
                      className="btn btn--sm"
                      disabled={rename.isPending || !renaming.label.trim()}
                      onClick={() => rename.mutate(renaming)}
                    >
                      <Check size={14} /> {t('common.save')}
                    </button>
                    <button className="btn btn--sm" onClick={() => setRenaming(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : (
                  <div className="setting-row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    {g.label}
                    <button
                      className="icon-btn"
                      aria-label={t('settings.whatsappGroupRename')}
                      title={t('settings.whatsappGroupRename')}
                      onClick={() => setRenaming({ id: g.id, label: g.label })}
                    >
                      <Pencil size={13} />
                    </button>
                  </div>
                )}
                {/* The group's real WhatsApp subject, when the nickname differs — so the
                    admin can tell which group a nickname actually refers to. */}
                {g.name && g.name !== g.label && (
                  <div className="setting-row__hint">{t('settings.whatsappGroupRealName', { name: g.name })}</div>
                )}
                <div className="setting-row__hint">
                  {g.participants != null && `${t('settings.whatsappGroupMembers', { count: g.participants })} · `}
                  {/* The id apps send to. Shown because it is the value that appears in an
                      app's own settings and its logs, and matching it up otherwise means
                      guessing. Selectable in one click, and it is not a secret. */}
                  <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{g.id}</code>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <button
                  className="btn btn--sm"
                  disabled={testGroup.isPending}
                  onClick={() => setConfirmTest({ id: g.id, label: g.label })}
                >
                  {t('settings.whatsappGroupTest')}
                </button>
                <button
                  className="btn btn--sm"
                  disabled={unapprove.isPending}
                  onClick={() => unapprove.mutate({ id: g.id })}
                >
                  <Trash2 size={14} /> {t('settings.whatsappGroupRemove')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Confirmed, unlike the test to your own number: everyone in the group receives
          this, and a message cannot be unsent from two hundred phones. */}
      <ConfirmDialog
        open={confirmTest !== null}
        onClose={() => setConfirmTest(null)}
        onConfirm={() => confirmTest && testGroup.mutate({ id: confirmTest.id })}
        title={t('settings.whatsappGroupTestTitle', { name: confirmTest?.label ?? '' })}
        body={t('settings.whatsappGroupTestBody')}
        confirmLabel={t('settings.whatsappGroupTestConfirm')}
        pending={testGroup.isPending}
      />

      {!browsing ? (
        <button className="btn" onClick={() => setBrowsing(true)}>
          <RefreshCw size={15} /> {t('settings.whatsappGroupsFind')}
        </button>
      ) : (
        <>
          {/* Both warnings are real, non-obvious, and cheaper to read than to discover:
              a WhatsApp group shows every member's number to every other member, and a
              group that is not announcement-only lets 200 people reply to a notice. */}
          <div
            className="glass-inset panel"
            style={{ marginBlockEnd: '0.6rem', borderInlineStart: '3px solid var(--color-warning)' }}
          >
            <div className="setting-row__hint">{t('settings.whatsappGroupsWarning')}</div>
          </div>
          {groups.isLoading ? (
            <p className="setting-row__hint">{t('common.loading')}</p>
          ) : groups.error ? (
            <p className="setting-row__hint">{groups.error.message || t('errors.generic')}</p>
          ) : (groups.data ?? []).length === 0 ? (
            <p className="setting-row__hint">{t('settings.whatsappGroupsNone')}</p>
          ) : (
            <div className="glass-inset panel" style={{ padding: '0.6rem 0.9rem' }}>
              {(groups.data ?? []).map((g) => (
                <div className="setting-row" key={g.id}>
                  <div className="setting-row__text" style={{ flex: 1 }}>
                    <div className="setting-row__title">
                      {g.name}
                      {g.community && <span className="tag" style={{ marginInlineStart: '0.4rem' }}>{t('settings.whatsappGroupCommunity')}</span>}
                    </div>
                    <div className="setting-row__hint">
                      {g.participants != null && t('settings.whatsappGroupMembers', { count: g.participants })}
                      {/* Posting into an announcement-only group requires being an admin
                          of it, and that is not something we can fix from here. */}
                      {g.isAdmin === false && ` · ${t('settings.whatsappGroupNotAdmin')}`}
                    </div>
                  </div>
                  <button
                    className="btn btn--sm"
                    disabled={approve.isPending || approvedIds.has(g.id)}
                    onClick={() =>
                      approve.mutate({ id: g.id, label: g.name, participants: g.participants, name: g.name })
                    }
                  >
                    {approvedIds.has(g.id) ? t('settings.whatsappGroupApproved') : t('settings.whatsappGroupApprove')}
                  </button>
                </div>
              ))}
            </div>
          )}
          <button className="btn btn--sm" style={{ marginBlockStart: '0.5rem' }} onClick={() => setBrowsing(false)}>
            {t('common.close')}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Admin commands over WhatsApp.
 *
 * The matrix is TRANSPOSED relative to the alerts one: rows are scopes, columns are
 * people. The person axis is the small stable one (a masjid trusts a handful of
 * numbers); the scope axis grows with every app installed. Rows = people × columns =
 * a dozen apps is unusable at panel width.
 *
 * Each row lists the commands it grants, because "allow Yusuf !notice-board" is not
 * legible on its own — and an app can add a command in an update, so the admin should
 * be able to see what a grant currently covers.
 */
function WhatsAppCommands() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const cfg = trpc.commands.get.useQuery();
  const status = trpc.commands.status.useQuery(undefined, { refetchInterval: 30_000 });

  const [askEnable, setAskEnable] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<{ phone: string; label: string } | null>(null);
  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');

  const refresh = () => {
    void utils.commands.get.invalidate();
    void utils.commands.status.invalidate();
  };
  const onError = (e: { message?: string }) => toast(e.message || t('errors.generic'), 'error');

  const setEnabled = trpc.commands.setEnabled.useMutation({ onSuccess: refresh, onError });
  const addPerson = trpc.commands.addPerson.useMutation({
    onSuccess: () => {
      setNewPhone('');
      setNewName('');
      refresh();
    },
    onError,
  });
  const removePerson = trpc.commands.removePerson.useMutation({
    onSuccess: () => {
      setConfirmRemove(null);
      refresh();
    },
    onError,
  });
  const setScope = trpc.commands.setScope.useMutation({ onSuccess: refresh, onError });

  // The probe's verdict, in words. The raw counts are the evidence; the sentence is
  // what tells an admin whose problem it is.
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const probe = trpc.commands.probe.useMutation({
    onSuccess: (r) => {
      const g = r.gateway;
      // A dead page reads as "no activity" unless it is reported separately — and
      // that is exactly the failure being looked for.
      if (g.chatsError) {
        setProbeResult(t('settings.commandsProbeFailed', { reason: g.chatsError }));
        return;
      }
      if (!g.ok) {
        setProbeResult(t('settings.commandsProbeFailed', { reason: g.error ?? '' }));
        return;
      }
      const heard = g.incoming;
      const when = g.newestIncomingAt ? new Date(g.newestIncomingAt).toLocaleString() : '';
      const chatAt = g.newestChatActivityAt ? Date.parse(g.newestChatActivityAt) : 0;
      const msgAt = g.newestIncomingAt ? Date.parse(g.newestIncomingAt) : 0;
      // THE signature of an alive-but-deaf engine: WhatsApp shows a conversation more
      // recent than anything the gateway managed to record. It can see the chat and
      // cannot hear the message.
      const deaf = g.chatsOk && chatAt > 0 && chatAt > msgAt + 60_000;

      if (deaf) {
        setProbeResult(
          t('settings.commandsProbeBridgeDead', { when: new Date(chatAt).toLocaleString() }),
        );
      } else if (heard === 0) {
        setProbeResult(t('settings.commandsProbeDeaf'));
      } else if (r.inbound.counters.seen === 0 && Object.keys(r.inbound.dropped).length === 0) {
        setProbeResult(t('settings.commandsProbeNotPassedOn', { count: heard, when }));
      } else {
        setProbeResult(t('settings.commandsProbeReaching', { count: heard, when }));
      }
    },
    onError,
  });

  if (!cfg.data) return null;
  const { enabled, people, grants, adminPhone, adminName } = cfg.data;
  const s = status.data;

  // Group the rows the way the alerts matrix does, so OpenMasjidOS's two halves sit
  // under one heading.
  const groups = new Map<string, typeof grants>();
  for (const g of grants) groups.set(g.group, [...(groups.get(g.group) ?? []), g]);

  const colHead = {
    width: '5rem',
    textAlign: 'center' as const,
    color: 'var(--color-ink-muted)',
    fontSize: '0.8rem',
    paddingInlineStart: '0.4rem',
  };
  const cell = { width: '5rem', display: 'flex', justifyContent: 'center', paddingInlineStart: '0.4rem' };

  const alreadyListed = people.some((p) => p.phone === adminPhone);

  return (
    <div style={{ marginBlockStart: '1rem' }}>
      <div className="setting-row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        {t('settings.commands')}
        {enabled && (
          <StatusDot
            online={s?.state === 'connected'}
            label={s?.state === 'silent' ? t('settings.commandsDotSilent') : undefined}
          />
        )}
      </div>
      <div className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.commandsHint')}</div>

      <div className="setting-row">
        <div className="setting-row__text" style={{ flex: 1 }}>
          <div className="setting-row__title">{t('settings.commandsEnable')}</div>
          <div className="setting-row__hint">{t('settings.commandsEnableHint')}</div>
        </div>
        <Toggle
          checked={enabled}
          onChange={(v) => (v ? setAskEnable(true) : setEnabled.mutate({ enabled: false }))}
          label={t('settings.commandsEnable')}
        />
      </div>

      {enabled && (
        <>
          {/* People. Kept visible even with the switch off would be pointless here —
              but turning it off never DELETES the list, which would be surprising loss. */}
          <div className="setting-row__title" style={{ marginBlockStart: '0.8rem' }}>
            {t('settings.commandsPeople')}
          </div>
          <div className="setting-row__hint">{t('settings.commandsPeopleHint')}</div>

          {people.length > 0 && (
            <div className="glass-inset panel" style={{ marginBlock: '0.6rem', padding: '0.6rem 0.9rem' }}>
              {people.map((p) => (
                <div className="setting-row" key={p.phone}>
                  <div className="setting-row__text" style={{ flex: 1, minWidth: 0 }}>
                    <div className="setting-row__title">{p.label}</div>
                    <div className="setting-row__hint">
                      +{p.phone}
                      {p.scopes.length === 0 && ` · ${t('settings.commandsNoGrants')}`}
                    </div>
                  </div>
                  <button
                    className="btn btn--sm"
                    disabled={removePerson.isPending}
                    onClick={() => setConfirmRemove({ phone: p.phone, label: p.label })}
                  >
                    {t('actions.remove')}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Aligned at the TOP, not the bottom. PhoneField carries its own hint under
              the inputs, so bottom-aligning made every sibling hang two lines lower
              than the number field it sits beside. Both blocks are label + control row,
              so their labels and their inputs line up on their own. The Add button
              lives INSIDE the name field's control row for the same reason — as a
              third flex child it had no label above it and nothing to align to. */}
          <div style={{ display: 'flex', gap: '0.9rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <PhoneField
              id="cmd-phone"
              label={t('settings.commandsPhone')}
              value={newPhone}
              onChange={setNewPhone}
              disabled={addPerson.isPending}
            />
            <div className="field" style={{ flex: '1 1 16rem', minInlineSize: '13rem' }}>
              <label className="label" htmlFor="cmd-name">{t('settings.commandsName')}</label>
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <input
                  id="cmd-name"
                  className="input glass-inset"
                  style={{ flex: '1 1 auto', minInlineSize: '8rem' }}
                  value={newName}
                  maxLength={60}
                  placeholder={t('settings.commandsNamePlaceholder')}
                  disabled={addPerson.isPending}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newPhone.trim() && newName.trim()) {
                      addPerson.mutate({ phone: newPhone, label: newName });
                    }
                  }}
                />
                <button
                  className="btn btn--primary"
                  style={{ flex: '0 0 auto' }}
                  disabled={addPerson.isPending || !newPhone.trim() || !newName.trim()}
                  onClick={() => addPerson.mutate({ phone: newPhone, label: newName })}
                >
                  {t('settings.commandsAdd')}
                </button>
              </div>
            </div>
          </div>
          {/* Offered, never automatic: the admin's number was collected as a place to
              send alerts, not as a way to authorise changes. No scopes are ticked.
              On its own line so it cannot disturb the alignment above. */}
          {adminPhone && !alreadyListed && (
            <button
              className="btn btn--sm"
              style={{ marginBlockStart: '0.4rem' }}
              onClick={() => addPerson.mutate({ phone: adminPhone, label: adminName || t('settings.commandsMe') })}
            >
              {t('settings.commandsAddMe')}
            </button>
          )}

          {people.length > 0 && (
            <>
              <div className="setting-row__title" style={{ marginBlockStart: '1rem' }}>
                {t('settings.commandsWhoCan')}
              </div>
              {/* Physical on purpose: `overflow-inline` is barely supported, and a
                  horizontal scroller flips correctly in RTL on its own. */}
              <div style={{ overflowX: 'auto' }}>
                {[...groups.entries()].map(([group, rows]) => (
                  <div key={group} style={{ marginBlockStart: '0.7rem' }}>
                    <div style={{ display: 'flex', alignItems: 'end', marginBlockEnd: '0.15rem' }}>
                      <div className="setting-row__title" style={{ flex: 1, color: 'var(--color-ink-muted)' }}>
                        {group}
                      </div>
                      {people.map((p) => (
                        <div key={p.phone} style={colHead}>{p.label}</div>
                      ))}
                    </div>
                    {rows.map((r) => (
                      <div className="setting-row" key={r.key}>
                        <div className="setting-row__text" style={{ flex: 1, minWidth: 0 }}>
                          <div className="setting-row__title">{r.label || `!${r.word}`}</div>
                          <div className="setting-row__hint">
                            {r.available
                              ? r.commands.map((c) => c.label).join(' · ')
                              : t('settings.commandsAppNone')}
                          </div>
                        </div>
                        {people.map((p) =>
                          r.available ? (
                            <div key={p.phone} style={cell}>
                              <Toggle
                                checked={p.scopes.includes(r.key)}
                                onChange={(v) => setScope.mutate({ phone: p.phone, scope: r.key, allowed: v })}
                                label={`${p.label} — ${r.group} ${r.label}`}
                              />
                            </div>
                          ) : (
                            // A third state, not a dead switch: there is nothing to grant.
                            <div key={p.phone} style={{ ...cell, alignItems: 'center' }}>
                              <span className="hint">—</span>
                            </div>
                          ),
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          {s && (
            <>
              <p className="setting-row__hint" style={{ marginBlockStart: '0.8rem' }}>
                {s.state === 'connected'
                  ? t('settings.commandsStateConnected')
                  : s.state === 'silent'
                    ? s.detail
                    : s.state === 'no-senders'
                      ? t('settings.commandsStateNoSenders')
                      : s.state === 'not-linked'
                        ? t('settings.commandsStateNotLinked')
                        : s.state === 'off'
                          ? t('settings.commandsStateOff')
                          : t('settings.commandsStateProblem', { detail: s.detail })}
              </p>
              {/* ALWAYS shown, not just when the platform thinks something is wrong.
                  The case that matters most is precisely the one where it thinks all is
                  well — connected, subscribed, acked — and no message ever arrives. On
                  the first real install this box was hidden behind a 'silent' state
                  that the ack fix had just stopped it from reaching, so the admin was
                  left staring at "Listening for commands." with no way to look further.

                  It is the difference between "it doesn't work" and a fact somebody can
                  act on: an empty list means the gateway has said nothing at all to us,
                  a non-empty one names exactly what it did say. Event names only —
                  never a payload, never a body. */}
              {(
                <div className="glass-inset panel" style={{ marginBlockStart: '0.5rem', padding: '0.6rem 0.9rem' }}>
                  <div className="setting-row__hint">
                    {t('settings.commandsDiagHeard')}{' '}
                    {s.eventNames.length === 0 ? (
                      <strong>{t('settings.commandsDiagNothing')}</strong>
                    ) : (
                      <code style={{ userSelect: 'all' }}>{s.eventNames.join(', ')}</code>
                    )}
                  </div>
                  <div className="setting-row__hint">
                    {t('settings.commandsDiagCounts', {
                      seen: s.counters.seen,
                      ignored: s.counters.ignoredUnknown,
                      unreadable: s.counters.unparseable,
                    })}
                  </div>
                  {/* The reason a message that DID arrive was thrown away. Without
                      this, "it arrived and we discarded it" and "nothing arrived" look
                      identical from here — which is exactly the ambiguity that cost a
                      round trip. Reason words and counts; no content. */}
                  {Object.keys(s.dropped).length > 0 && (
                    <div className="setting-row__hint">
                      {t('settings.commandsDiagDropped')}{' '}
                      <code style={{ userSelect: 'all' }}>
                        {Object.entries(s.dropped)
                          .sort((a, b) => b[1] - a[1])
                          .map(([reason, n]) => `${reason} ×${n}`)
                          .join(', ')}
                      </code>
                    </div>
                  )}
                  <div className="setting-row__hint">
                    {t('settings.commandsDiagAck', {
                      ack: s.subscribeAck + (s.subscribeAckCode ? ` (${s.subscribeAckCode})` : ''),
                    })}
                  </div>
                  {/* Raw transport activity vs application events. Traffic with no
                      events means the gateway is not emitting to us; no traffic at all
                      means the socket is not really carrying anything despite saying
                      connected. Opposite fixes, identical symptoms without this. */}
                  <div className="setting-row__hint">
                    {t('settings.commandsDiagWire', {
                      packet: s.lastPacketAt ? new Date(s.lastPacketAt).toLocaleTimeString() : '—',
                      event: s.lastEventAt ? new Date(s.lastEventAt).toLocaleTimeString() : '—',
                    })}
                  </div>
                  {/* The one question that splits the problem in half: has the GATEWAY
                      itself heard anything from WhatsApp? If not, nothing on our side
                      matters. Read-only, and it reads counts and times — never a body. */}
                  <div style={{ marginBlockStart: '0.6rem' }}>
                    <button className="btn btn--sm" disabled={probe.isPending} onClick={() => probe.mutate()}>
                      {probe.isPending ? t('common.working') : t('settings.commandsProbe')}
                    </button>
                    {probeResult && (
                      <div className="setting-row__hint" style={{ marginBlockStart: '0.4rem' }}>
                        {probeResult}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={askEnable}
        onClose={() => setAskEnable(false)}
        onConfirm={() => {
          setAskEnable(false);
          setEnabled.mutate({ enabled: true });
        }}
        title={t('settings.commandsRiskTitle')}
        body={t('settings.commandsRiskBody')}
        cost={t('settings.commandsRiskCost')}
        confirmLabel={t('settings.commandsRiskAccept')}
        pending={setEnabled.isPending}
      />
      <ConfirmDialog
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => confirmRemove && removePerson.mutate({ phone: confirmRemove.phone })}
        title={t('settings.commandsRemoveTitle', { name: confirmRemove?.label ?? '' })}
        body={t('settings.commandsRemoveBody')}
        confirmLabel={t('actions.remove')}
        pending={removePerson.isPending}
      />
    </div>
  );
}

function AlertsPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const list = trpc.alerts.list.useQuery();
  const setChannel = trpc.alerts.setChannel.useMutation({
    onSuccess: () => utils.alerts.list.invalidate(),
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });

  const rows = list.data ?? [];
  // Group by source for a tidy list.
  const groups = new Map<string, { label: string; items: typeof rows }>();
  for (const r of rows) {
    const g = groups.get(r.source) ?? { label: r.sourceLabel, items: [] as typeof rows };
    g.items.push(r);
    groups.set(r.source, g);
  }

  const colHead = { width: '4.5rem', textAlign: 'center' as const, color: 'var(--color-ink-muted)', fontSize: '0.8rem', paddingInlineStart: '0.4rem' };

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title">{t('settings.alerts')}</h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.alertsHint')}</p>
      {rows.length === 0 && <p className="setting-row__hint">{t('settings.alertsNone')}</p>}
      {[...groups.entries()].map(([source, g]) => (
        <div key={source} style={{ marginBlockStart: '0.7rem' }}>
          <div style={{ display: 'flex', alignItems: 'end', marginBlockEnd: '0.15rem' }}>
            <div className="setting-row__title" style={{ flex: 1, color: 'var(--color-ink-muted)' }}>{g.label}</div>
            <div style={colHead}>{t('settings.alertsEmail')}</div>
            <div style={colHead}>{t('settings.alertsWebhook')}</div>
            <div style={colHead}>{t('settings.alertsWhatsapp')}</div>
          </div>
          {g.items.map((r) => (
            <div className="setting-row" key={`${r.source}:${r.id}`}>
              <div className="setting-row__text" style={{ flex: 1 }}>
                <div className="setting-row__title">{r.label}</div>
                {r.description && <div className="setting-row__hint">{r.description}</div>}
              </div>
              <div style={{ width: '4.5rem', display: 'flex', justifyContent: 'center', paddingInlineStart: '0.4rem' }}>
                <Toggle
                  checked={r.channels.email}
                  onChange={(v) => setChannel.mutate({ source: r.source, id: r.id, channel: 'email', enabled: v })}
                  label={`${r.label} — ${t('settings.alertsEmail')}`}
                />
              </div>
              <div style={{ width: '4.5rem', display: 'flex', justifyContent: 'center', paddingInlineStart: '0.4rem' }}>
                <Toggle
                  checked={r.channels.webhook}
                  onChange={(v) => setChannel.mutate({ source: r.source, id: r.id, channel: 'webhook', enabled: v })}
                  label={`${r.label} — ${t('settings.alertsWebhook')}`}
                />
              </div>
              {/* WhatsApp is only for the platform's own alerts. An app that messages
                  people over WhatsApp is reaching a parent or a donor, not the admin's
                  phone — so who it messages, and what it says, belongs in that app's own
                  settings. A toggle here would have implied the platform could route an
                  app's messages to the right people, when it only knows one number. */}
              <div
                style={{
                  width: '4.5rem',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  paddingInlineStart: '0.4rem',
                }}
              >
                {r.whatsappAvailable ? (
                  <Toggle
                    checked={r.channels.whatsapp}
                    onChange={(v) => setChannel.mutate({ source: r.source, id: r.id, channel: 'whatsapp', enabled: v })}
                    label={`${r.label} — ${t('settings.alertsWhatsapp')}`}
                  />
                ) : (
                  <span className="hint" style={{ textAlign: 'center', lineHeight: 1.2 }}>
                    {t('settings.alertsWhatsappInApp')}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

/** Stripe account vault. The admin stores named accounts here once; apps with the
 *  Fabric `stripe` capability fetch them at runtime — no re-entering keys per app. */
function StripePanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const accounts = trpc.stripe.list.useQuery();
  // Per-account online/offline (green/red dot). Re-checks ~every 60s.
  const stripeStatus = trpc.stripe.status.useQuery(undefined, { refetchInterval: 60_000 });
  const onlineById = new Map((stripeStatus.data ?? []).map((s) => [s.id, s.online]));
  const refresh = () => utils.stripe.list.invalidate();
  const windows = useWindows();
  /** The account pending removal, or null. Drives the confirmation dialog. */
  const [confirmRemove, setConfirmRemove] = useState<StripeAccountPublic | null>(null);

  // Open the add/edit form as a managed traffic-light window (like the rest of the OS).
  function openForm(account: StripeAccountPublic | null) {
    let id = -1;
    id = windows.open({
      title: account ? t('settings.stripeEditTitle') : t('settings.stripeAddTitle'),
      icon: <CreditCard size={15} />,
      dedupeKey: account ? `stripe-${account.id}` : 'stripe-new',
      node: (
        <StripeAccountForm
          account={account}
          onClose={() => windows.close(id)}
          onSaved={() => { windows.close(id); refresh(); }}
        />
      ),
    });
  }

  const remove = trpc.stripe.remove.useMutation({
    onSuccess: () => { refresh(); toast(t('settings.stripeRemoved'), 'success'); },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });

  const list = accounts.data ?? [];
  return (
    <section className="glass-raised panel">
      <h2 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
        <CreditCard size={18} /> {t('settings.payments')}
      </h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.paymentsHint')}</p>

      <details style={{ marginBlockEnd: '0.6rem' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('settings.stripeGuideTitle')}</summary>
        <ul style={{ margin: '0.5rem 0 0', paddingInlineStart: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', lineHeight: 1.55, color: 'var(--color-ink)' }}>
          <li>
            {t('settings.stripeGuideKeys')}{' '}
            <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', whiteSpace: 'nowrap' }}>
              dashboard.stripe.com/apikeys <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
            </a>{' '}
            {t('settings.stripeGuideKeysAfter')}
          </li>
          <li>{t('settings.stripeGuideWebhook')}</li>
          <li style={{ color: 'var(--color-ink-muted)' }}>{t('settings.stripeGuideTest')}</li>
        </ul>
      </details>

      {list.length === 0 && <p className="setting-row__hint">{t('settings.stripeNone')}</p>}
      {list.map((a) => (
        <div className="setting-row" key={a.id}>
          <div className="setting-row__text">
            <div className="setting-row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
              <StatusDot online={stripeStatus.isLoading ? undefined : onlineById.get(a.id)} />
              {a.label}
            </div>
            <div className="setting-row__hint" style={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
              {a.publishableKey || '—'} · {a.hasSecret ? t('settings.stripeSecretSet') : t('settings.stripeSecretMissing')}
              {a.hasWebhook ? ` · ${t('settings.stripeWebhookSet')}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn--sm" onClick={() => openForm(a)}><Pencil size={14} /> {t('settings.stripeEdit')}</button>
            {/* Confirmed, not immediate: this button used to sit 8px from Edit with
                identical styling, and one misclick dropped a secret key the
                dashboard can never show back — recovery means re-issuing it in
                Stripe and re-entering the webhook secret. */}
            <button className="btn btn--sm" disabled={remove.isPending} onClick={() => setConfirmRemove(a)}>
              <Trash2 size={14} /> {t('settings.backupRemove')}
            </button>
          </div>
        </div>
      ))}

      <button className="btn btn--primary" style={{ marginBlockStart: '0.6rem' }} onClick={() => openForm(null)}>
        <CreditCard size={15} /> {t('settings.stripeAdd')}
      </button>

      <ConfirmDialog
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        pending={remove.isPending}
        title={t('confirm.stripeRemoveTitle', { name: confirmRemove?.label ?? '' })}
        body={t('confirm.stripeRemoveBody')}
        cost={t('confirm.stripeRemoveCost')}
        confirmLabel={t('confirm.stripeRemoveConfirm')}
        onConfirm={() => {
          if (confirmRemove) {
            remove.mutate({ id: confirmRemove.id }, { onSuccess: () => setConfirmRemove(null) });
          }
        }}
      />
    </section>
  );
}

/** Cloudflare Tunnel — paste a token + domain once; the OS runs cloudflared so the
 *  masjid's apps are reachable from the internet. Apps read their public URL via the
 *  Fabric (`GET /api/fabric/site`). */
function CloudflarePanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const status = trpc.cloudflare.status.useQuery();
  const routes = trpc.cloudflare.routes.useQuery();
  const refresh = () => utils.cloudflare.status.invalidate();
  const cf = status.data;

  const [domain, setDomain] = useState('');
  const [token, setToken] = useState('');
  const seeded = useRef(false);
  useEffect(() => {
    if (cf && !seeded.current) {
      setDomain(cf.domain);
      seeded.current = true;
    }
  }, [cf]);

  const save = trpc.cloudflare.save.useMutation({
    onSuccess: () => { setToken(''); refresh(); toast(t('settings.cfSaved'), 'success'); },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const setEnabled = trpc.cloudflare.setEnabled.useMutation({
    onSuccess: () => refresh(),
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const clear = trpc.cloudflare.clear.useMutation({
    onSuccess: () => { setToken(''); refresh(); toast(t('settings.cfCleared'), 'success'); },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const setPath = trpc.cloudflare.setPath.useMutation({
    onSuccess: (r) => { utils.cloudflare.routes.invalidate(); toast(t('settings.cfPathSaved', { path: r.path }), 'success'); },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });
  const setExposed = trpc.cloudflare.setExposed.useMutation({
    onSuccess: (r) => {
      utils.cloudflare.routes.invalidate();
      toast(r.exposed ? t('settings.cfExposedOn') : t('settings.cfExposedOff'), 'success');
    },
    onError: (e) => toast(e.message || t('errors.generic'), 'error'),
  });

  if (!cf) return null;

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
        <Globe size={18} /> {t('settings.remoteAccess')}
      </h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.remoteAccessHint')}</p>

      <div className="setting-row">
        <div className="setting-row__text">
          <div className="setting-row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <StatusDot online={cf.enabled ? cf.running : undefined} />
            {t('settings.cfEnable')}
          </div>
          <div className="setting-row__hint">
            {cf.running ? t('settings.cfRunning') : cf.hasToken ? t('settings.cfStopped') : t('settings.cfNoToken')}
          </div>
        </div>
        <Toggle checked={cf.enabled} onChange={(v) => setEnabled.mutate({ enabled: v })} label={t('settings.cfEnable')} />
      </div>

      <div className="setting-row">
        <div className="setting-row__text">
          <div className="setting-row__title">{t('settings.cfDomain')}</div>
          <div className="setting-row__hint">{t('settings.cfDomainHint')}</div>
        </div>
        <input className="input glass-inset" style={{ maxWidth: '16rem' }} placeholder="omos.example.org" value={domain} onChange={(e) => setDomain(e.target.value)} />
      </div>

      <div className="field">
        <label className="label">{t('settings.cfToken')}</label>
        <input
          className="input glass-inset"
          type="password"
          style={{ fontFamily: 'ui-monospace, monospace' }}
          placeholder={cf.hasToken ? t('settings.cfTokenSet') : 'eyJ…'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
        />
        <div className="setting-row__hint">{t('settings.cfTokenHint')}</div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBlockStart: '0.6rem' }}>
        <button className="btn btn--primary" disabled={save.isPending} onClick={() => save.mutate({ domain: domain.trim(), token: token.trim() || undefined })}>
          <Check size={15} /> {save.isPending ? t('settings.cfSaving') : t('settings.cfSave')}
        </button>
        {cf.hasToken && (
          <button className="btn" disabled={clear.isPending} onClick={() => clear.mutate()}>
            <Trash2 size={15} /> {t('settings.cfClear')}
          </button>
        )}
      </div>

      {/* Which apps are shared, and where. This is the per-app consent switch — it
          lives OUTSIDE the collapsed setup guide on purpose: an admin who declined
          (or never saw) the question at install has to be able to find it here, and
          a control hidden behind "How to set this up" is a control nobody finds. */}
      {(routes.data?.apps.length ?? 0) > 0 && (
        <div style={{ marginBlockStart: '0.9rem', borderBlockStart: '1px solid var(--color-border)', paddingBlockStart: '0.8rem' }}>
          <div className="setting-row__title" style={{ marginBlockEnd: '0.3rem' }}>{t('settings.cfRoutesTitle')}</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="cf-routes" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ textAlign: 'start', color: 'var(--color-ink-muted)' }}>
                  <th style={{ textAlign: 'start', padding: '0.25rem 0.6rem 0.25rem 0' }}>{t('settings.cfColApp')}</th>
                  <th style={{ textAlign: 'start', padding: '0.25rem 0.6rem 0.25rem 0' }}>{t('settings.cfColShared')}</th>
                  <th style={{ textAlign: 'start', padding: '0.25rem 0' }}>{t('settings.cfColUrl')}</th>
                </tr>
              </thead>
              <tbody>
                {routes.data?.apps.map((r) => (
                  <tr key={r.id} style={{ borderBlockStart: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '0.3rem 0.6rem 0.3rem 0' }}>{r.name}</td>
                    <td style={{ padding: '0.3rem 0.6rem 0.3rem 0' }}>
                      <Toggle
                        checked={r.exposed}
                        onChange={(v) => setExposed.mutate({ id: r.id, exposed: v })}
                        label={t('settings.cfColShared')}
                      />
                    </td>
                    <td style={{ padding: '0.3rem 0', fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>
                      {r.exposed ? (
                        <>
                          https://{routes.data?.host || 'your-domain'}/
                          <input
                            className="input glass-inset"
                            style={{ width: '7rem', padding: '0.12rem 0.4rem', fontFamily: 'ui-monospace, monospace' }}
                            defaultValue={r.path.replace(/^\//, '')}
                            aria-label={t('settings.cfColPath')}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v && v !== r.path.replace(/^\//, '')) setPath.mutate({ id: r.id, path: v });
                            }}
                          />
                        </>
                      ) : (
                        <span style={{ color: 'var(--color-ink-muted)', fontFamily: 'inherit' }}>{t('settings.cfNotShared')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="setting-row__hint" style={{ marginBlockStart: '0.4rem' }}>{t('settings.cfRoutesHint')}</div>
        </div>
      )}

      {/* Guided, step-by-step setup with the exact Cloudflare fields. */}
      <details className="cf-guide" style={{ marginBlockStart: '0.9rem', borderBlockStart: '1px solid var(--color-border)', paddingBlockStart: '0.8rem' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('settings.cfGuideTitle')}</summary>
        <ol style={{ margin: '0.6rem 0 0', paddingInlineStart: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.6rem', lineHeight: 1.55, color: 'var(--color-ink)' }}>
          <li>
            {t('settings.cfStep1')}{' '}
            <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', whiteSpace: 'nowrap' }}>
              Cloudflare Zero Trust <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
            </a>{' '}
            {t('settings.cfStep1b')}
          </li>
          <li>{t('settings.cfStep2')}</li>
          <li>
            {t('settings.cfStep3')}
            <ul style={{ margin: '0.35rem 0 0', paddingInlineStart: '1.1rem', color: 'var(--color-ink-muted)' }}>
              <li>{t('settings.cfStep3Host')} <code>{routes.data?.host || domain || 'your-hostname'}</code></li>
              <li>{t('settings.cfStep3Service', { port: routes.data?.ingressPort ?? 80 })}</li>
            </ul>
          </li>
          <li>{t('settings.cfStep4')}</li>
        </ol>

        <p
          className="setting-row__hint"
          style={{ marginBlockStart: '0.5rem', color: 'var(--color-gold, #d4af37)', fontWeight: 600 }}
        >
          {t('settings.cfHttpWarn', { port: routes.data?.ingressPort ?? 80 })}
        </p>

      </details>
    </section>
  );
}

function StripeAccountForm({ account, onClose, onSaved }: { account: StripeAccountPublic | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const isEdit = account !== null;
  const [label, setLabel] = useState(account?.label ?? '');
  const [publishableKey, setPublishableKey] = useState(account?.publishableKey ?? '');
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [error, setError] = useState('');

  const save = trpc.stripe.save.useMutation({
    onSuccess: onSaved,
    onError: (e) => setError(e.message || t('errors.generic')),
  });

  function submit() {
    setError('');
    save.mutate({
      id: account?.id,
      label: label.trim(),
      publishableKey: publishableKey.trim(),
      secretKey: secretKey.trim() || undefined,
      webhookSecret: webhookSecret.trim() || undefined,
    });
  }

  return (
    <>
      <div className="field">
        <label className="label">{t('settings.stripeLabel')}</label>
        <input className="input glass-inset" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('settings.stripeLabelPlaceholder')} />
      </div>
      <div className="field">
        <label className="label">{t('settings.stripePublishable')}</label>
        <input className="input glass-inset" style={{ fontFamily: 'ui-monospace, monospace' }} value={publishableKey} onChange={(e) => setPublishableKey(e.target.value)} placeholder="pk_live_…" autoComplete="off" />
      </div>
      <div className="field">
        <label className="label">{t('settings.stripeSecret')}</label>
        <input className="input glass-inset" type="password" style={{ fontFamily: 'ui-monospace, monospace' }} value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder={isEdit ? t('settings.stripeKeepBlank') : 'sk_live_…'} autoComplete="off" />
      </div>
      <div className="field">
        <label className="label">{t('settings.stripeWebhook')}</label>
        <input className="input glass-inset" type="password" style={{ fontFamily: 'ui-monospace, monospace' }} value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder={isEdit ? t('settings.stripeKeepBlank') : 'whsec_…'} autoComplete="off" />
        <div className="setting-row__hint">{t('settings.stripeWebhookHint')}</div>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginBlockStart: '1rem' }}>
        <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn--primary" disabled={save.isPending || !label.trim()} onClick={submit}>
          {save.isPending ? t('settings.stripeSaving') : t('settings.stripeSave')}
        </button>
      </div>
    </>
  );
}
