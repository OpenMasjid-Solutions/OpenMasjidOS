// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Platform settings only (CLAUDE.md §13) — appearance, language, account,
 * advanced. No masjid/prayer config ever lives here; that belongs to apps.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Upload, GitBranch, RefreshCw, Check, SquareTerminal, KeyRound, HardDrive, Bell, Heart, ShieldCheck, Cloud, CloudUpload, Trash2, Copy, ExternalLink, CreditCard, Pencil, Globe, Power } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { getCsrf, setCsrf, withKey } from '../lib/session';
import { usePrefs, prefsStore, ACCENTS, WALLPAPERS } from '../lib/prefs';
import { Toggle } from '../components/Toggle';
import { Page } from '../components/Page';
import { LazyTerminal } from '../components/LazyTerminal';
import { UpdateModal } from '../components/UpdateModal';
import { RestoreModal } from '../components/RestoreModal';
import { Modal } from '../components/Modal';
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

export function Settings() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const prefs = usePrefs();
  const utils = trpc.useUtils();

  const serverSettings = trpc.settings.get.useQuery();
  const sysInfo = trpc.system.info.useQuery();
  const updateInfo = trpc.system.checkUpdate.useQuery(undefined, { enabled: false });
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
      toast(
        r.data.updateAvailable
          ? t('settings.updateAvailable', { version: r.data.latest })
          : t('settings.upToDate'),
        'success',
      );
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

      {/* Account */}
      <ChangePassword />

      {/* Notifications */}
      <NotificationsPanel />

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
              {updateInfo.data
                ? updateInfo.data.updateAvailable
                  ? t('settings.updateAvailable', { version: updateInfo.data.latest })
                  : t('settings.upToDate')
                : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn" onClick={checkUpdates}>
              <RefreshCw size={15} /> {updateInfo.isFetching ? t('settings.checking') : t('settings.checkUpdates')}
            </button>
            {updateInfo.data?.updateAvailable && (
              <button className="btn btn--primary" onClick={() => setUpdateOpen(true)}>
                <Download size={15} /> {t('settings.updateNow')}
              </button>
            )}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.network')}</div>
            <div className="setting-row__hint">
              {`${t('settings.address')}: ${window.location.host}`}
            </div>
          </div>
        </div>

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
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');

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

/** Stripe account vault. The admin stores named accounts here once; apps with the
 *  Fabric `stripe` capability fetch them at runtime — no re-entering keys per app. */
function StripePanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const accounts = trpc.stripe.list.useQuery();
  const refresh = () => utils.stripe.list.invalidate();
  const windows = useWindows();

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
            <div className="setting-row__title">{a.label}</div>
            <div className="setting-row__hint" style={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
              {a.publishableKey || '—'} · {a.hasSecret ? t('settings.stripeSecretSet') : t('settings.stripeSecretMissing')}
              {a.hasWebhook ? ` · ${t('settings.stripeWebhookSet')}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn--sm" onClick={() => openForm(a)}><Pencil size={14} /> {t('settings.stripeEdit')}</button>
            <button className="btn btn--sm" disabled={remove.isPending} onClick={() => remove.mutate({ id: a.id })}>
              <Trash2 size={14} /> {t('settings.backupRemove')}
            </button>
          </div>
        </div>
      ))}

      <button className="btn btn--primary" style={{ marginBlockStart: '0.6rem' }} onClick={() => openForm(null)}>
        <CreditCard size={15} /> {t('settings.stripeAdd')}
      </button>
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

  if (!cf) return null;

  return (
    <section className="glass-raised panel">
      <h2 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
        <Globe size={18} /> {t('settings.remoteAccess')}
      </h2>
      <p className="setting-row__hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.remoteAccessHint')}</p>

      <div className="setting-row">
        <div className="setting-row__text">
          <div className="setting-row__title">{t('settings.cfEnable')}</div>
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
              <li>{t('settings.cfStep3Sub')} <code>omos</code></li>
              <li>{t('settings.cfStep3Domain')}</li>
              <li>{t('settings.cfStep3Service', { port: routes.data?.ingressPort ?? 80 })}</li>
            </ul>
          </li>
          <li>{t('settings.cfStep4')}</li>
        </ol>

        {/* Where each app ends up — the OS routes these paths for you (NOT added in Cloudflare). */}
        {(routes.data?.apps.length ?? 0) > 0 && (
          <div style={{ marginBlockStart: '0.8rem' }}>
            <div className="setting-row__title" style={{ marginBlockEnd: '0.3rem' }}>{t('settings.cfRoutesTitle')}</div>
            <div style={{ overflowX: 'auto' }}>
              <table className="cf-routes" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ textAlign: 'start', color: 'var(--color-ink-muted)' }}>
                    <th style={{ textAlign: 'start', padding: '0.25rem 0.6rem 0.25rem 0' }}>{t('settings.cfColApp')}</th>
                    <th style={{ textAlign: 'start', padding: '0.25rem 0' }}>{t('settings.cfColUrl')}</th>
                  </tr>
                </thead>
                <tbody>
                  {routes.data?.apps.map((r) => (
                    <tr key={r.id} style={{ borderBlockStart: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '0.3rem 0.6rem 0.3rem 0' }}>{r.name}</td>
                      <td style={{ padding: '0.3rem 0', fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>
                        https://{routes.data?.host || 'omos.your-domain'}/
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="setting-row__hint" style={{ marginBlockStart: '0.4rem' }}>{t('settings.cfRoutesHint')}</div>
          </div>
        )}
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
