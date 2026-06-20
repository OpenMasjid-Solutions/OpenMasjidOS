/**
 * 3rd Party Apps hub (advanced, opt-in — CLAUDE.md §11). Two ways in:
 *   - Community apps: browse CasaOS-compatible app stores you've added.
 *   - Docker Compose: paste your own compose file.
 * Both validate + risk-check before anything runs.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ShieldCheck, Plus, Trash2, Store as StoreIcon, Search } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { appInitial, appColor } from '../lib/apps';
import { Page } from '../components/Page';
import { Modal } from '../components/Modal';
import { PortConflicts, initialRemap } from '../components/PortConflicts';
import { useToast } from '../components/ToastProvider';
import { cn } from '../lib/cn';
import type { CommunityApp } from '../lib/types';

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

export function StoreCustom() {
  const { t } = useTranslation();
  const settings = trpc.settings.get.useQuery();
  const [tab, setTab] = useState<'community' | 'compose'>('community');

  if (settings.data && !settings.data.allowCustomApps) {
    return (
      <Page>
        <div className="glass panel">
          <div className="empty-state">
            <h3>{t('custom.disabledTitle')}</h3>
            <p>{t('custom.disabledBody')}</p>
            <Link to="/settings" className="btn btn--primary" style={{ marginTop: '1rem' }}>
              {t('nav.settings')}
            </Link>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <header className="page-head">
        <h1 className="page-title">{t('community.title')}</h1>
        <p className="page-sub">{t('community.subtitle')}</p>
      </header>

      <div className="segmented glass-inset" style={{ marginBottom: '1.25rem' }}>
        <button className={cn(tab === 'community' && 'is-active')} onClick={() => setTab('community')}>
          {t('community.tabCommunity')}
        </button>
        <button className={cn(tab === 'compose' && 'is-active')} onClick={() => setTab('compose')}>
          {t('community.tabCompose')}
        </button>
      </div>

      {tab === 'community' ? <CommunityTab /> : <ComposeTab parseEnv={parseEnv} />}
    </Page>
  );
}

function CommunityTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const repos = trpc.community.repos.useQuery();
  const apps = trpc.community.apps.useQuery();
  const [repoUrl, setRepoUrl] = useState('');
  const [repoError, setRepoError] = useState('');
  const [query, setQuery] = useState('');
  const [confirmApp, setConfirmApp] = useState<CommunityApp | null>(null);
  const [needsAck, setNeedsAck] = useState(false);
  const [installError, setInstallError] = useState('');
  const [portRemap, setPortRemap] = useState<Record<string, number>>({});

  const check = trpc.community.check.useMutation();
  const conflicts = check.data?.conflicts ?? [];

  useEffect(() => {
    if (check.data) setPortRemap(initialRemap(check.data.conflicts));
  }, [check.data]);

  const visibleApps = (apps.data ?? []).filter((a) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return a.name.toLowerCase().includes(q) || (a.tagline ?? '').toLowerCase().includes(q);
  });

  const addRepo = trpc.community.addRepo.useMutation({
    onSuccess: () => {
      setRepoUrl('');
      setRepoError('');
      utils.community.repos.invalidate();
      utils.community.apps.invalidate();
    },
    onError: (e) => setRepoError(e.message || t('community.addRepoError')),
  });
  const removeRepo = trpc.community.removeRepo.useMutation({
    onSuccess: () => {
      utils.community.repos.invalidate();
      utils.community.apps.invalidate();
    },
  });
  const install = trpc.community.install.useMutation({
    onSuccess: () => {
      utils.apps.list.invalidate();
      setConfirmApp(null);
      setNeedsAck(false);
      toast(t('common.saved'), 'success');
    },
    onError: (e) => {
      // The server asks for an explicit risk ack when the compose is dangerous.
      if (e.message.includes('powerful permissions')) setNeedsAck(true);
      else setInstallError(e.message || t('custom.error'));
    },
  });

  function openConfirm(app: CommunityApp) {
    setConfirmApp(app);
    setNeedsAck(false);
    setInstallError('');
    setPortRemap({});
    check.reset();
    check.mutate({ compose: app.compose }); // surface port conflicts before install
  }

  function confirmInstall() {
    if (!confirmApp) return;
    setInstallError('');
    // The install input requires a valid URL for icon, so drop non-http icons.
    const icon = confirmApp.icon && /^https?:\/\//i.test(confirmApp.icon) ? confirmApp.icon : undefined;
    install.mutate({
      name: confirmApp.name,
      compose: confirmApp.compose,
      icon,
      acknowledgeRisk: needsAck,
      portRemap: conflicts.length > 0 ? portRemap : undefined,
    });
  }

  return (
    <>
      <div className="glass-raised panel">
        <h2 className="panel-title">{t('community.repos')}</h2>
        <p className="hint" style={{ marginBottom: '0.8rem' }}>{t('community.casaNote')}</p>

        {(repos.data ?? []).map((url) => (
          <div className="setting-row" key={url}>
            <div className="setting-row__text" style={{ wordBreak: 'break-all' }}>{url}</div>
            <button className="btn btn--sm" onClick={() => removeRepo.mutate({ url })}>
              <Trash2 size={14} /> {t('community.removeRepo')}
            </button>
          </div>
        ))}
        {(repos.data ?? []).length === 0 && <p className="hint">{t('community.noRepos')}</p>}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.9rem', flexWrap: 'wrap' }}>
          <input
            className="input glass-inset"
            style={{ flex: 1, minWidth: '16rem' }}
            placeholder={t('community.addRepoPlaceholder')}
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
          />
          <button className="btn btn--primary" disabled={addRepo.isPending || !repoUrl.trim()} onClick={() => addRepo.mutate({ url: repoUrl.trim() })}>
            <Plus size={15} /> {addRepo.isPending ? t('community.adding') : t('community.addRepoCta')}
          </button>
        </div>
        {repoError && <p className="form-error">{repoError}</p>}
      </div>

      {(apps.data ?? []).length > 0 && (
        <div className="glass-inset" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0 0.7rem', maxWidth: '22rem', marginBottom: '1rem' }}>
          <Search size={16} style={{ color: 'var(--color-ink-faint)' }} />
          <input
            className="input"
            style={{ background: 'transparent', boxShadow: 'none', paddingInline: 0 }}
            placeholder={t('community.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {apps.isFetching ? (
        <p className="hint">{t('community.loadingApps')}</p>
      ) : visibleApps.length === 0 ? (
        <div className="empty-state"><StoreIcon size={40} /><p>{t('community.noApps')}</p></div>
      ) : (
        <div className="app-grid">
          {visibleApps.map((app) => (
            <div key={app.id} className="app-card glass fx-glint">
              <div className="app-card__top">
                <div className="app-icon" style={{ background: app.icon ? 'var(--color-surface-overlay)' : appColor(app.id) }}>
                  {app.icon ? <img src={app.icon} alt="" /> : appInitial(app.name)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="app-name">{app.name}</div>
                  <div className="app-meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.tagline}</div>
                </div>
              </div>
              <div className="app-card__actions">
                <button className="btn btn--sm btn--primary" style={{ marginInlineStart: 'auto' }} onClick={() => openConfirm(app)}>
                  {t('actions.install')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={!!confirmApp}
        onClose={() => !install.isPending && setConfirmApp(null)}
        title={t('community.installTitle', { name: confirmApp?.name ?? '' })}
      >
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', marginBottom: '1rem' }}>
          <AlertTriangle size={20} style={{ color: 'var(--color-warning)', flexShrink: 0 }} />
          <span>{t('community.thirdPartyNotice')}</span>
        </div>
        {needsAck && (
          <div className="glass-inset panel" style={{ marginBottom: '1rem' }}>
            <strong style={{ color: 'var(--color-warning)' }}>{t('custom.dangersTitle')}</strong>
            <p style={{ marginBlock: '0.4rem 0' }}>{t('custom.warning')}</p>
          </div>
        )}
        <PortConflicts conflicts={conflicts} remap={portRemap} onChange={setPortRemap} />
        {install.isPending ? (
          <p style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span className="spinner" /> {t('community.installing')}
          </p>
        ) : (
          <>
            {installError && <p className="form-error">{installError}</p>}
            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setConfirmApp(null)}>{t('common.cancel')}</button>
              <button className="btn btn--primary" onClick={confirmInstall}>
                {needsAck ? t('custom.riskAck') : t('actions.install')}
              </button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

function ComposeTab({ parseEnv }: { parseEnv: (t: string) => Record<string, string> }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [compose, setCompose] = useState('');
  const [env, setEnv] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const [portRemap, setPortRemap] = useState<Record<string, number>>({});

  const check = trpc.custom.check.useMutation();
  const install = trpc.custom.install.useMutation({
    onSuccess: () => {
      toast(t('common.saved'), 'success');
      navigate('/');
    },
    onError: (e) => setError(e.message || t('custom.error')),
  });
  const dangers = check.data?.dangers ?? [];
  const conflicts = check.data?.conflicts ?? [];

  // Pre-fill the remap with suggested free ports whenever a check finds conflicts.
  useEffect(() => {
    if (check.data) setPortRemap(initialRemap(check.data.conflicts));
  }, [check.data]);

  return (
    <>
      <div className="glass panel" style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', borderInlineStart: '3px solid var(--color-warning)' }}>
        <AlertTriangle size={20} style={{ color: 'var(--color-warning)', flexShrink: 0, marginTop: 2 }} />
        <span style={{ color: 'var(--color-ink-muted)' }}>{t('custom.warning')}</span>
      </div>

      <div className="glass-raised panel">
        <div className="field">
          <label className="label">{t('custom.name')}</label>
          <input className="input glass-inset" placeholder={t('custom.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="label">{t('custom.compose')}</label>
          <textarea className="textarea glass-inset" placeholder={t('custom.composePlaceholder')} value={compose} onChange={(e) => { setCompose(e.target.value); check.reset(); }} />
        </div>
        <div className="field">
          <label className="label">{t('custom.env')}</label>
          <textarea className="textarea glass-inset" style={{ minHeight: '5rem' }} placeholder={t('custom.envPlaceholder')} value={env} onChange={(e) => setEnv(e.target.value)} />
        </div>

        {check.data && dangers.length === 0 && (
          <p style={{ color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <ShieldCheck size={16} /> {t('custom.servicesFound', { count: check.data.services.length, names: check.data.services.join(', ') })}
          </p>
        )}

        {dangers.length > 0 && (
          <div className="glass-inset panel" style={{ marginBottom: '1rem' }}>
            <strong style={{ color: 'var(--color-warning)' }}>{t('custom.dangersTitle')}</strong>
            <ul style={{ margin: '0.5rem 0 0', paddingInlineStart: '1.2rem' }}>
              {dangers.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
            <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              {t('custom.riskAck')}
            </label>
          </div>
        )}

        <PortConflicts conflicts={conflicts} remap={portRemap} onChange={setPortRemap} />

        {error && <p className="form-error">{error}</p>}

        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <button className="btn" disabled={check.isPending || !compose.trim()} onClick={() => { setError(''); check.mutate({ compose }); }}>
            {check.isPending ? t('custom.checking') : t('custom.check')}
          </button>
          <button
            className="btn btn--primary"
            disabled={install.isPending || (dangers.length > 0 && !ack)}
            onClick={() => {
              setError('');
              if (!name.trim()) return setError(t('custom.nameRequired'));
              if (!compose.trim()) return setError(t('custom.composeRequired'));
              install.mutate({
                name,
                compose,
                env: parseEnv(env),
                acknowledgeRisk: ack,
                portRemap: conflicts.length > 0 ? portRemap : undefined,
              });
            }}
          >
            {install.isPending ? t('custom.installing') : t('custom.install')}
          </button>
        </div>
      </div>
    </>
  );
}
