// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Platform settings only (CLAUDE.md §13) — appearance, account, email, WhatsApp,
 * alerts, payments, remote access, advanced. No masjid/prayer config ever lives here;
 * that belongs to apps.
 */
import { useRef, useState } from 'react';
import { useParams, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, Upload, GitBranch, RefreshCw, SquareTerminal, KeyRound, HardDrive, Bell, Heart, CreditCard, Globe, Power, AlertTriangle, Sparkles, MessageCircle, SlidersHorizontal } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { getCsrf, withKey } from '../lib/session';
import { Toggle } from '../components/Toggle';
import { Page } from '../components/Page';
import { LazyTerminal } from '../components/LazyTerminal';
import { UpdateModal } from '../components/UpdateModal';
import { RestoreModal } from '../components/RestoreModal';
import { Modal } from '../components/Modal';
import { isRemoteSession } from '../lib/apps';
import { REMOTE_UPLOAD_LIMIT } from '../lib/files';
import { changelogWindowOptions } from '../components/ChangelogWindow';
import { UpdateChannel } from '../components/UpdateChannel';
import { ChannelMigrate } from '../components/ChannelMigrate';
import { useWindows } from '../components/Windows';
import { useToast } from '../components/ToastProvider';
import { cn } from '../lib/cn';
import { TwoFactorPanel } from '../components/TwoFactorPanel';
import { errorText, ShownError } from '../lib/errors';
import { SshAccess } from './settings/SshAccess';
import { NetworkRow } from './settings/NetworkRow';
import { SslSection } from './settings/SslSection';
import { ChangePassword } from './settings/ChangePassword';
import { EagerNote } from './settings/EagerNote';
import { NotificationsPanel } from './settings/NotificationsPanel';
import { ScheduledBackupPanel } from './settings/ScheduledBackupPanel';
import { EmailPanel } from './settings/EmailPanel';
import { WhatsAppPanel } from './settings/WhatsAppPanel';
import { AlertsPanel } from './settings/AlertsPanel';
import { StripePanel } from './settings/StripePanel';
import { CloudflarePanel } from './settings/CloudflarePanel';
import { AppearancePane } from './settings/AppearancePane';

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
  // `latest === null` means the check could not READ the channel's version — the server
  // catches a failed fetch, logs it and returns normally, so "no update available" is
  // indistinguishable from "we never found out" unless this is checked first.
  //
  // Saying "You're on the latest version" there is the dashboard asserting something it
  // does not know, on the one screen a masjid uses to find out whether they are missing a
  // security release. Offline is the common case on a box behind a captive portal or a
  // blocked registry, and it is not an error the admin needs to fix — it just is not an
  // answer, and has to read as one.
  if (info.latest == null) return t('settings.updateCheckFailed');
  if (!info.updateAvailable) return t('settings.upToDate');
  if (info.reason === 'channel') {
    return info.channel === 'dev'
      ? t('settings.updateChannelMoveToDev', { version: info.latest })
      : t('settings.updateChannelMoveToStable', { version: info.latest });
  }
  return t('settings.updateAvailable', { version: info.latest });
}

/**
 * The sections of Settings, in nav order.
 *
 * Settings had grown to eleven stacked panels on one page — around three thousand lines
 * of it — and finding anything meant scrolling past everything. Each entry here is now a
 * pane of its own with its own address, so `/settings/whatsapp` can be linked to directly
 * from an app's page, a toast, or the App Store, instead of dropping someone at the top
 * of the page to hunt.
 *
 * Order is by how often a masjid touches it, not by how the code is organised: the things
 * a volunteer changes (how it looks, who they are, how it reaches people) come first, and
 * the machine-shaped settings sit at the bottom under Advanced.
 */
const SECTIONS = [
  { id: 'appearance', icon: Sparkles },
  { id: 'account', icon: KeyRound },
  { id: 'email', icon: Bell },
  { id: 'whatsapp', icon: MessageCircle },
  { id: 'alerts', icon: AlertTriangle },
  { id: 'payments', icon: CreditCard },
  { id: 'remote', icon: Globe },
  { id: 'advanced', icon: SlidersHorizontal },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

const DEFAULT_SECTION: SectionId = 'appearance';

function isSectionId(v: string | undefined): v is SectionId {
  return SECTIONS.some((s) => s.id === v);
}

/**
 * The section list.
 *
 * `NavLink`s rather than buttons with state: the section IS the URL, so back and forward
 * work, a section can be bookmarked, and refreshing the page keeps you where you were —
 * none of which a state-only tab strip gives you.
 *
 * On a narrow screen the same list turns into a horizontal strip above the pane (see
 * `.settings-nav` in app.css). A dropdown was the alternative and hides the choices;
 * with only eight of them, a strip you can swipe shows what is there.
 */
function SettingsNav({ active }: { active: SectionId }) {
  const { t } = useTranslation();
  // Written out rather than built as `settings.nav.${id}`. A key assembled at runtime
  // cannot be checked against en.json, and `i18n-keys.test.ts` exists precisely because
  // a missing key ships as the raw key on screen — which it once did, in this panel.
  const labels: Record<SectionId, string> = {
    appearance: t('settings.nav.appearance'),
    account: t('settings.nav.account'),
    email: t('settings.nav.email'),
    whatsapp: t('settings.nav.whatsapp'),
    alerts: t('settings.nav.alerts'),
    payments: t('settings.nav.payments'),
    remote: t('settings.nav.remote'),
    advanced: t('settings.nav.advanced'),
  };
  return (
    <nav className="settings-nav" aria-label={t('settings.title')}>
      {SECTIONS.map((s) => {
        const Icon = s.icon;
        return (
          <NavLink
            key={s.id}
            to={`/settings/${s.id}`}
            className={cn('settings-nav__item', s.id === active && 'is-active')}
            aria-current={s.id === active ? 'page' : undefined}
          >
            <Icon size={16} aria-hidden />
            <span>{labels[s.id]}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

export function Settings() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  // An unknown or missing section falls back rather than 404s: a stale bookmark from
  // before a section was renamed should land somewhere useful, not on an error.
  const { section: sectionParam } = useParams();
  const section: SectionId = isSectionId(sectionParam) ? sectionParam : DEFAULT_SECTION;
  const show = (id: SectionId) => section === id;

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
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });

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

  // Release notes open as a managed window (traffic-light chrome, like the terminal
  // and file windows). The options come from the shared component so this and the
  // account menu use the same `dedupeKey` — opening from either focuses the one
  // window rather than stacking a second copy of the same notes.
  function openChangelog() {
    windows.open(changelogWindowOptions(t('changelog.title')));
  }

  async function uploadAndRestore(file: File) {
    // Cloudflare's free plan carries nothing larger through the tunnel, and answers with
    // its own error page — which used to surface here as "Something went wrong".
    if (isRemoteSession() && file.size > REMOTE_UPLOAD_LIMIT) {
      toast(t('settings.restoreTooBigRemote'), 'error');
      return;
    }
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
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        // Not our answer at all: Cloudflare's own page, almost always the size limit.
        if (!body && isRemoteSession() && res.status === 413) throw new ShownError(t('settings.restoreTooBigRemote'));
        throw new ShownError(body?.error || t('errors.generic'));
      }
      setRestoreFile(null);
      setRestoreOpen(true);
    } catch (e) {
      toast(errorText(e, t('errors.generic')), 'error');
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
      // A check that could not reach the channel is reported as INFO, not success: a green
      // tick is what made "we could not find out" look identical to "you are current".
      // Not an error either — the box is fine, and nothing needs fixing.
      toast(updateSentence(r.data, t), r.data.latest == null ? 'info' : 'success');
    } else {
      toast(t('errors.generic'), 'error');
    }
  }

  const updateSettings = trpc.settings.update.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
    // A refusal (a change asked for while a backup is being restored, say) would
    // otherwise leave the switch where it was with nothing saying why.
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });

  const freeSpace = trpc.system.freeSpace.useMutation({
    onSuccess: (r) => toast(r.reclaimed === '0B' ? t('settings.freedNone') : t('settings.freedSpace', { amount: r.reclaimed }), 'success'),
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });

  return (
    <Page>
      <header className="page-head">
        <h1 className="page-title">{t('settings.title')}</h1>
        <p className="page-sub">{t('settings.subtitle')}</p>
      </header>

      <div className="settings-layout">
        <SettingsNav active={section} />

        {/* Only the chosen section is mounted. That is the point of the split — a pane
            no one is looking at should not be running its polling queries either (the
            WhatsApp panel alone polls the gateway, and the email, payments and remote
            access panels each poll a status of their own). */}
        <div className="settings-pane">

      {show('appearance') && <AppearancePane />}

      {/* Account — who you are, and how you prove it */}
      {show('account') && (
        <>
          <ChangePassword />
          {/* Two-step sign-in. Below the password because that is the order an
              admin sets them up in, and because it is meaningless without one. */}
          <TwoFactorPanel />
        </>
      )}

      {/* Email provider (SMTP / Resend, shared with apps via the Fabric) */}
      {show('email') && <EmailPanel />}

      {/* WhatsApp gateway (OpenWA, shared with apps via the Fabric). Its own section
          rather than sitting beside Email: it is the same kind of thing — an outbound
          transport the platform owns on every app's behalf — but it carries a gateway
          app, groups and admin commands with it, and stacked below Email it was a third
          of the whole page. */}
      {show('whatsapp') && <WhatsAppPanel />}

      {show('alerts') && (
        <>
          {/* Where alerts GO (the webhook), then WHICH alerts go there. Together,
              because choosing a channel and choosing what routes to it is one task. */}
          <NotificationsPanel />
          <AlertsPanel />
        </>
      )}

      {/* Payments (Stripe vault, shared with apps via the Fabric) */}
      {show('payments') && <StripePanel />}

      {/* Remote access (Cloudflare tunnel + domain) */}
      {show('remote') && <CloudflarePanel />}

      {show('advanced') && (
        <>
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

      {/* Off-site backups (scheduled upload to Google Drive / NAS). Sits under Advanced
          beside the manual download/restore rows above, so a masjid looking for "my
          backups" finds both in one place rather than in two different sections. */}
      <ScheduledBackupPanel />
        </>
      )}

        </div>
      </div>

      {/* The dialogs stay OUTSIDE the section panes. Several are opened from one section
          and survive a navigation (the restore upload especially), and a modal unmounted
          mid-flight by a nav click would abandon whatever it was doing. */}
      <UpdateModal open={updateOpen} onClose={() => setUpdateOpen(false)} currentVersion={sysInfo.data?.version ?? ''} />

      <Modal open={!!restoreFile} onClose={() => !restoreUploading && setRestoreFile(null)} title={t('settings.restoreConfirmTitle')}>
        <p>{t('settings.restoreConfirmBody')}</p>
        {/* From outside, a restore that would close the way back in is refused by the
            platform (core system/restore.ts) — say so before the upload, not after. */}
        {isRemoteSession() && <p className="setting-row__hint">{t('settings.restoreConfirmRemote')}</p>}
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
