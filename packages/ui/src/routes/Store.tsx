// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * App Store: browse the OpenMasjidAPPS catalog and one-click install. The
 * "3rd Party App" entry only appears when custom apps are enabled (CLAUDE.md §11).
 */
import { useMemo, useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Search, Plus, RefreshCw, Check } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { appInitial } from '../lib/apps';
import { Page } from '../components/Page';
import { Modal } from '../components/Modal';
import { MasjidScene } from '../components/Glyphs';
import { useToast } from '../components/ToastProvider';
import { staggerContainer, staggerItem } from '../lib/motion';
import type { CatalogApp } from '../lib/types';

export function Store() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  // The server already caches the catalog ~5 min; match it here so reopening the
  // Store paints instantly instead of refetching + skeletoning. The Refresh
  // button still force-updates via the mutation + invalidate below.
  const catalog = trpc.store.catalog.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const installed = trpc.apps.list.useQuery();
  const settings = trpc.settings.get.useQuery();
  const refresh = trpc.store.refresh.useMutation({ onSuccess: () => utils.store.catalog.invalidate() });

  const [query, setQuery] = useState('');
  const [active, setActive] = useState<CatalogApp | null>(null);

  const installedIds = new Set((installed.data ?? []).map((a) => a.id));
  const apps = catalog.data ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(
      (a) => a.name.toLowerCase().includes(q) || (a.tagline ?? '').toLowerCase().includes(q),
    );
  }, [apps, query]);

  return (
    <Page>
      <header className="page-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">{t('store.title')}</h1>
          <p className="page-sub">{t('store.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {settings.data?.allowCustomApps && (
            <Link to="/store/custom" className="btn btn--ghost">
              <Plus size={16} /> {t('store.thirdParty')}
            </Link>
          )}
          <button className="btn" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            <RefreshCw size={16} /> {t('store.refresh')}
          </button>
        </div>
      </header>

      <div className="field" style={{ maxWidth: '22rem' }}>
        <div className="glass-inset" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0 0.7rem' }}>
          <Search size={16} style={{ color: 'var(--color-ink-faint)' }} />
          <input
            className="input"
            style={{ background: 'transparent', boxShadow: 'none', paddingInline: 0 }}
            placeholder={t('store.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {catalog.isLoading ? (
        <div className="app-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 130 }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass panel">
          <div className="empty-state">
            <div className="empty-art"><MasjidScene size={88} /></div>
            <h3>{t('store.empty')}</h3>
            <p>{t('store.emptyHint')}</p>
          </div>
        </div>
      ) : (
        <motion.div className="app-grid" variants={staggerContainer} initial="initial" animate="animate">
          {filtered.map((app) => {
            const isInstalled = installedIds.has(app.id);
            return (
              <motion.div
                key={app.id}
                className="app-card glass fx-glint"
                variants={staggerItem}
                style={app.comingSoon ? { opacity: 0.92 } : undefined}
              >
                <div className="app-card__top">
                  <div className="app-icon">{app.icon ? <img src={app.icon} alt="" /> : appInitial(app.name)}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="app-name" title={app.name}>{app.name}</div>
                    <div className="app-meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{app.tagline}</div>
                  </div>
                </div>
                <div className="app-card__actions">
                  {app.comingSoon ? (
                    <span className="tag tag--custom" style={{ marginInlineStart: 'auto' }}>{t('store.comingSoon')}</span>
                  ) : isInstalled ? (
                    <span className="btn btn--sm" style={{ marginInlineStart: 'auto' }}>
                      <Check size={15} /> {t('store.installedAlready')}
                    </span>
                  ) : (
                    <button className="btn btn--sm btn--primary" style={{ marginInlineStart: 'auto' }} onClick={() => setActive(app)}>
                      {t('actions.install')}
                    </button>
                  )}
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      )}

      {active && (
        <InstallModal
          app={active}
          onClose={() => setActive(null)}
          onInstalled={() => {
            setActive(null);
            utils.apps.list.invalidate();
            toast(t('common.saved'), 'success');
          }}
        />
      )}
    </Page>
  );
}

function InstallModal({
  app,
  onClose,
  onInstalled,
}: {
  app: CatalogApp;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const fields = app.settings ?? [];
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, f.default ?? ''])),
  );
  // A `stripe-account` field is a picker of the Stripe accounts configured in the
  // OS — the admin chooses one instead of re-typing keys (see Settings → Payments).
  const hasStripeField = fields.some((f) => f.type === 'stripe-account');
  const stripeAccounts = trpc.stripe.list.useQuery(undefined, { enabled: hasStripeField });
  // Default each stripe-account field to the first configured account.
  useEffect(() => {
    const accts = stripeAccounts.data;
    if (!accts || accts.length === 0) return;
    setValues((v) => {
      const next = { ...v };
      let changed = false;
      for (const f of app.settings ?? []) {
        if (f.type === 'stripe-account' && !next[f.key]) { next[f.key] = accts[0].id; changed = true; }
      }
      return changed ? next : v;
    });
  }, [stripeAccounts.data, app.settings]);

  const install = trpc.store.install.useMutation({
    onSuccess: onInstalled,
    onError: (e) => toast(e.message || t('store.installError'), 'error'),
  });

  return (
    <Modal open onClose={onClose} title={t('store.installTitle', { name: app.name })}>
      {app.description && <p style={{ marginBottom: '1rem' }}>{app.tagline}</p>}
      {fields.map((f) => (
        <div className="field" key={f.key}>
          <label className="label">{f.label}</label>
          {f.type === 'stripe-account' ? (
            (stripeAccounts.data?.length ?? 0) > 0 ? (
              <select
                className="select glass-inset"
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              >
                {stripeAccounts.data!.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            ) : (
              <p className="setting-row__hint">
                {t('store.stripeNone')}{' '}
                <Link to="/settings" style={{ color: 'var(--color-primary)' }}>{t('store.stripeNoneLink')}</Link>
              </p>
            )
          ) : f.type === 'select' ? (
            <select
              className="select glass-inset"
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            >
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              className="input glass-inset"
              type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          )}
        </div>
      ))}
      {install.isPending ? (
        <p style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <span className="spinner" /> {t('store.installingHint')}
        </p>
      ) : (
        <button
          className="btn btn--primary btn--block"
          onClick={() => install.mutate({ id: app.id, settings: values })}
        >
          {t('store.installCta')}
        </button>
      )}
    </Modal>
  );
}
