// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Cloud, CloudUpload, Trash2, Copy, ExternalLink, AlertTriangle } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Toggle } from '../../components/Toggle';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useWindows } from '../../components/Windows';
import { useToast } from '../../components/ToastProvider';
import { cn } from '../../lib/cn';
import { errorText } from '../../lib/errors';
import { Field } from './shared';

type BackupKind = 'drive' | 'sftp' | 'smb' | 'webdav';

/** Scheduled off-site backups — upload the config + app-data backup to Google
 *  Drive or a NAS (SFTP/SMB/WebDAV) on a schedule. Credentials are entered here
 *  but only ever stored server-side (rclone config); status never echoes them. */
export function ScheduledBackupPanel() {
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
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  // Removing the destination deletes its saved sign-in details, so it is asked first —
  // it sits one click from the harmless "Change".
  const [askRemove, setAskRemove] = useState(false);
  const clearDest = trpc.backups.clearDestination.useMutation({
    onSuccess: () => { setAskRemove(false); refresh(); toast(t('settings.backupRemoved'), 'success'); },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const test = trpc.backups.test.useMutation({
    onSuccess: (r) => toast(r.message || t('settings.backupTestOk'), r.ok ? 'success' : 'error'),
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
  });
  const runNow = trpc.backups.runNow.useMutation({
    onSuccess: () => { refresh(); toast(t('settings.backupRunDone'), 'success'); },
    onError: (e) => toast(errorText(e, t('errors.generic')), 'error'),
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
            <button className="btn" disabled={clearDest.isPending} onClick={() => setAskRemove(true)}>
              <Trash2 size={15} /> {t('settings.backupRemove')}
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={askRemove}
        onClose={() => setAskRemove(false)}
        onConfirm={() => clearDest.mutate()}
        title={t('confirm.backupRemoveTitle')}
        body={t('confirm.backupRemoveBody')}
        cost={t('confirm.backupRemoveCost')}
        confirmLabel={t('confirm.backupRemoveConfirm')}
        pending={clearDest.isPending}
      />

      {b.configured && (
        <>
          <div className="setting-row">
            <div className="setting-row__text"><div className="setting-row__title">{t('settings.backupEnable')}</div></div>
            <Toggle checked={b.enabled} onChange={(v) => update.mutate({ enabled: v })} label={t('settings.backupEnable')} />
          </div>

          <div className="setting-row">
            <div className="setting-row__text"><div className="setting-row__title">{t('settings.backupSchedule')}</div></div>
            <div className="segmented glass-inset">
              <button
                className={cn(b.schedule === 'daily' && 'is-active')}
                aria-pressed={b.schedule === 'daily'}
                onClick={() => update.mutate({ schedule: 'daily' })}
              >
                {t('settings.backupDaily')}
              </button>
              <button
                className={cn(b.schedule === 'weekly' && 'is-active')}
                aria-pressed={b.schedule === 'weekly'}
                onClick={() => update.mutate({ schedule: 'weekly' })}
              >
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
              aria-label={t('settings.backupRetention')}
              defaultValue={b.retention}
              // The box always ends up saying what is stored: the number as it was saved
              // (kept in range), or the old one back when it was empty or refused —
              // never a value that was not kept.
              onBlur={(e) => {
                const box = e.currentTarget;
                const typed = Math.round(Number(box.value));
                if (!box.value.trim() || !Number.isFinite(typed)) {
                  box.value = String(b.retention);
                  return;
                }
                const n = Math.max(1, Math.min(365, typed));
                box.value = String(n);
                if (n === b.retention) return;
                update.mutate(
                  { retention: n },
                  {
                    onSuccess: (r) => { box.value = String(r.retention); },
                    onError: () => { box.value = String(b.retention); },
                  },
                );
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
  const typeId = useId();

  const save = trpc.backups.setDestination.useMutation({
    onSuccess: () => { toast(t('settings.backupSaved'), 'success'); onSaved(); },
    onError: (e) => setError(errorText(e, t('errors.generic'))),
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
      {/* A group of buttons, not a form control, so it is named by the heading rather
          than by a <label> that could point at nothing. */}
      <div className="label" id={typeId}>{t('settings.backupType')}</div>
      <div className="segmented glass-inset" role="group" aria-labelledby={typeId} style={{ marginBlockEnd: '0.7rem' }}>
        {types.map((ty) => (
          <button
            key={ty.id}
            className={cn(kind === ty.id && 'is-active')}
            aria-pressed={kind === ty.id}
            onClick={() => { setKind(ty.id); setError(''); }}
          >
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
            aria-label={t('settings.backupDriveTokenLabel')}
            value={driveToken}
            onChange={(e) => setDriveToken(e.target.value)}
          />
        </>
      )}

      {kind === 'sftp' && (
        <>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Field label={t('settings.backupHost')} style={{ flex: 2 }}>
              {(id) => <input id={id} className="input glass-inset" value={host} onChange={(e) => setHost(e.target.value)} placeholder="nas.local" />}
            </Field>
            <Field label={t('settings.backupPort')} style={{ flex: 1 }}>
              {(id) => <input id={id} className="input glass-inset" type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />}
            </Field>
          </div>
          <Field label={t('settings.backupUser')}>
            {(id) => <input id={id} className="input glass-inset" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />}
          </Field>
          <Field label={t('settings.backupPassword')}>
            {(id) => (
              <input id={id} className="input glass-inset" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            )}
          </Field>
          <details>
            <summary className="setting-row__hint" style={{ cursor: 'pointer' }}>{t('settings.backupKeyOptional')}</summary>
            <textarea
              className="textarea glass-inset"
              style={{ minHeight: '4.5rem', fontFamily: 'ui-monospace, monospace', marginBlockStart: '0.4rem' }}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              aria-label={t('settings.backupKeyLabel')}
              value={keyPem}
              onChange={(e) => setKeyPem(e.target.value)}
            />
          </details>
        </>
      )}

      {kind === 'smb' && (
        <>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Field label={t('settings.backupHost')} style={{ flex: 2 }}>
              {(id) => <input id={id} className="input glass-inset" value={host} onChange={(e) => setHost(e.target.value)} placeholder="nas.local" />}
            </Field>
            <Field label={t('settings.backupShare')} style={{ flex: 1 }}>
              {(id) => <input id={id} className="input glass-inset" value={share} onChange={(e) => setShare(e.target.value)} placeholder="backups" />}
            </Field>
          </div>
          <Field label={t('settings.backupUser')}>
            {(id) => <input id={id} className="input glass-inset" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />}
          </Field>
          <Field label={t('settings.backupPassword')}>
            {(id) => (
              <input id={id} className="input glass-inset" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            )}
          </Field>
        </>
      )}

      {kind === 'webdav' && (
        <>
          <Field label={t('settings.backupUrl')}>
            {(id) => (
              <input
                id={id}
                className="input glass-inset"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://nas.local/remote.php/dav/files/me/"
              />
            )}
          </Field>
          <Field label={t('settings.backupUser')}>
            {(id) => <input id={id} className="input glass-inset" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />}
          </Field>
          <Field label={t('settings.backupPassword')}>
            {(id) => (
              <input id={id} className="input glass-inset" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            )}
          </Field>
        </>
      )}

      <Field label={t('settings.backupFolder')} style={{ marginBlockStart: '0.4rem' }}>
        {(id) => (
          <>
            <input id={id} className="input glass-inset" value={folder} onChange={(e) => setFolder(e.target.value)} />
            <div className="setting-row__hint">{t('settings.backupFolderHint')}</div>
          </>
        )}
      </Field>

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
