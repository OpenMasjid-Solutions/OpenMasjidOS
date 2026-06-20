/**
 * Platform settings only (CLAUDE.md §13) — appearance, language, account,
 * advanced. No masjid/prayer config ever lives here; that belongs to apps.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, GitBranch, RefreshCw, Check, SquareTerminal, KeyRound } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { usePrefs, prefsStore, ACCENTS, WALLPAPERS } from '../lib/prefs';
import { Toggle } from '../components/Toggle';
import { Page } from '../components/Page';
import { Modal } from '../components/Modal';
import { Terminal } from '../components/Terminal';
import { UpdateModal } from '../components/UpdateModal';
import { useToast } from '../components/ToastProvider';
import { cn } from '../lib/cn';

export function Settings() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const prefs = usePrefs();
  const utils = trpc.useUtils();

  const serverSettings = trpc.settings.get.useQuery();
  const sysInfo = trpc.system.info.useQuery();
  const updateInfo = trpc.system.checkUpdate.useQuery(undefined, { enabled: false });
  const [rootTermOpen, setRootTermOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);

  const updateSettings = trpc.settings.update.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
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
      </section>

      {/* Account */}
      <ChangePassword />

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
            <button className="btn" onClick={() => setRootTermOpen(true)}>
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
            <button className="btn" onClick={() => updateInfo.refetch()} disabled={updateInfo.isFetching}>
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

        <SshAccess />

        <div className="setting-row">
          <div className="setting-row__text">
            <div className="setting-row__title">{t('settings.backup')}</div>
            <div className="setting-row__hint">{t('settings.backupHint')} · {t('settings.restoreSoon')}</div>
          </div>
          <a className="btn" href="/api/backup">
            <Download size={15} /> {t('settings.downloadBackup')}
          </a>
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

      <Modal open={rootTermOpen} onClose={() => setRootTermOpen(false)} wide title={t('settings.rootTerminalTitle')}>
        {rootTermOpen && <Terminal wsPath="/api/terminal/root" />}
      </Modal>

      <UpdateModal open={updateOpen} onClose={() => setUpdateOpen(false)} currentVersion={sysInfo.data?.version ?? ''} />
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

function ChangePassword() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');

  const change = trpc.auth.changePassword.useMutation({
    onSuccess: () => {
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
        disabled={change.isPending || !current || next.length < 8}
        onClick={() => change.mutate({ currentPassword: current, newPassword: next })}
      >
        <Check size={15} /> {t('settings.changePassword')}
      </button>
    </section>
  );
}
