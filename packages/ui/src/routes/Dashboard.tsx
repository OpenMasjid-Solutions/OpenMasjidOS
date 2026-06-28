// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Home: a live system-stats strip (tRPC subscription, seeded by a query for
 * instant first paint) above the installed-apps grid.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Cpu, MemoryStick, HardDrive, Thermometer, Clock, Boxes, AlertTriangle, Sparkles, Download } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { usePrefs } from '../lib/prefs';
import { formatBytes, formatUptime, percent } from '../lib/format';
import { StatCard } from '../components/StatCard';
import { AppCard } from '../components/AppCard';
import { UpdateModal } from '../components/UpdateModal';
import { AppUpdate } from '../components/AppUpdate';
import { useWindows } from '../components/Windows';
import { Page } from '../components/Page';
import { MasjidScene } from '../components/Glyphs';
import { staggerContainer } from '../lib/motion';
import { cn } from '../lib/cn';
import type { StatsSnapshot } from '../lib/types';

// Hoisted so each render passes the *same* element to StatCard, keeping its
// memo intact (a fresh <Cpu/> each render would defeat it).
const CPU_ICON = <Cpu size={15} />;
const MEMORY_ICON = <MemoryStick size={15} />;
const DISK_ICON = <HardDrive size={15} />;
const TEMP_ICON = <Thermometer size={15} />;
const UPTIME_ICON = <Clock size={15} />;
const APPS_ICON = <Boxes size={15} />;

function greetingKey(): 'morning' | 'afternoon' | 'evening' {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

/** True when any metric is high enough to warrant an "under load" tagline. */
function isUnderLoad(s: StatsSnapshot | null): boolean {
  if (!s) return false;
  const mem = percent(s.memUsed, s.memTotal);
  const disk = percent(s.diskUsed, s.diskTotal);
  return s.cpuPercent >= 90 || mem >= 90 || disk >= 90 || (s.cpuTempC != null && s.cpuTempC >= 85);
}

export function Dashboard() {
  const { t } = useTranslation();
  const prefs = usePrefs();

  const me = trpc.auth.me.useQuery();
  const settings = trpc.settings.get.useQuery();
  const [live, setLive] = useState<StatsSnapshot | null>(null);
  // The WS subscription streams live stats (~2s); the query is just for the
  // first paint, with a slow refetch as a fallback that self-disables while the
  // socket is healthy (no redundant 30s poll once live data is flowing).
  const initial = trpc.stats.get.useQuery(undefined, { refetchInterval: live ? false : 30000 });
  trpc.stats.stream.useSubscription(undefined, {
    onData: (d: StatsSnapshot) => setLive(d),
  });
  const stats = live ?? initial.data ?? null;

  // The dock polls apps.list every 8s and is always mounted; here we rely on the
  // global staleTime + that shared poll instead of a second interval.
  const appsQuery = trpc.apps.list.useQuery();
  const apps = appsQuery.data ?? [];

  // Auto-check for a core update on load (and every ~6h while open) so a new
  // version surfaces right on the dashboard instead of going unnoticed.
  const updateQ = trpc.system.checkUpdate.useQuery(undefined, { refetchInterval: 21_600_000 });
  const updateReady = updateQ.data?.updateAvailable ?? false;
  const [updateOpen, setUpdateOpen] = useState(false);

  // App updates — same idea as the core check: surface them right on the dashboard.
  const appUpdatesQ = trpc.apps.updates.useQuery(undefined, { refetchInterval: 21_600_000 });
  const appUpdates = appUpdatesQ.data ?? [];
  const windows = useWindows();
  function openAppUpdate(u: { id: string; name: string }) {
    windows.open({
      title: t('appUpdate.title', { name: u.name }),
      dedupeKey: `update:${u.id}`,
      wide: true,
      icon: <Download size={15} />,
      node: <AppUpdate id={u.id} name={u.name} />,
    });
  }

  const name = prefs.dashboardName.trim() || me.data?.username || t('dashboard.yourMasjid');
  const cpuSub =
    stats && stats.cpuCores
      ? `${stats.cpuCores} cores${stats.cpuSpeedGHz ? ` · ${stats.cpuSpeedGHz.toFixed(1)} GHz` : ''}`
      : undefined;

  const diskPct = percent(stats?.diskUsed ?? 0, stats?.diskTotal ?? 0);
  const diskLow = (stats?.diskTotal ?? 0) > 0 && diskPct >= 80;

  // A random tagline per load (stable across re-renders), switching to the
  // "under load" set when a metric is high.
  const [seed] = useState(() => Math.random());
  const underLoad = isUnderLoad(stats);
  const taglines = t(underLoad ? 'dashboard.taglinesBusy' : 'dashboard.taglines', {
    returnObjects: true,
  }) as unknown as string[];
  const tagline = Array.isArray(taglines) && taglines.length > 0
    ? taglines[Math.floor(seed * taglines.length)]
    : t('dashboard.statusOk');

  return (
    <Page>
      <header className="page-head">
        <h1 className="page-title">
          {t(`dashboard.greeting.${greetingKey()}`)}, {name}
        </h1>
        <p className={cn('page-sub', underLoad && 'page-sub--warn')}>{tagline}</p>
      </header>

      <motion.section className="stat-strip" variants={staggerContainer} initial="initial" animate="animate" aria-label={t('dashboard.statsTitle')}>
        <StatCard
          label={t('dashboard.stats.cpu')}
          icon={CPU_ICON}
          value={`${stats?.cpuPercent ?? 0}%`}
          sub={cpuSub}
          percent={stats?.cpuPercent ?? 0}
        />
        <StatCard
          label={t('dashboard.stats.memory')}
          icon={MEMORY_ICON}
          value={formatBytes(stats?.memUsed ?? 0)}
          sub={`/ ${formatBytes(stats?.memTotal ?? 0)}`}
          percent={percent(stats?.memUsed ?? 0, stats?.memTotal ?? 0)}
        />
        <StatCard
          label={t('dashboard.stats.disk')}
          icon={DISK_ICON}
          value={formatBytes(stats?.diskUsed ?? 0)}
          sub={`/ ${formatBytes(stats?.diskTotal ?? 0)}`}
          percent={diskPct}
          warn={diskLow}
        />
        <StatCard
          label={t('dashboard.stats.temp')}
          icon={TEMP_ICON}
          value={stats?.cpuTempC != null ? `${stats.cpuTempC}°C` : '—'}
        />
        <StatCard
          label={t('dashboard.stats.uptime')}
          icon={UPTIME_ICON}
          value={formatUptime(stats?.uptimeSec ?? 0)}
        />
        <StatCard
          label={t('dashboard.stats.apps')}
          icon={APPS_ICON}
          value={stats?.appsRunning ?? apps.filter((a) => a.running).length}
        />
      </motion.section>

      {updateReady && (
        <div className="warn-banner warn-banner--update glass" role="status">
          <Sparkles size={22} />
          <div style={{ flex: 1 }}>
            <div className="warn-banner__title">{t('dashboard.updateTitle', { version: updateQ.data?.latest })}</div>
            <div className="warn-banner__body">{t('dashboard.updateBody')}</div>
          </div>
          <button className="btn btn--primary" onClick={() => setUpdateOpen(true)}>
            <Download size={15} /> {t('settings.updateNow')}
          </button>
        </div>
      )}

      {appUpdates.length > 0 && (
        <div className="warn-banner warn-banner--update glass" role="status">
          <Sparkles size={22} />
          <div style={{ flex: 1 }}>
            <div className="warn-banner__title">{t('dashboard.appUpdateTitle', { count: appUpdates.length })}</div>
            <div className="warn-banner__body" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.35rem' }}>
              {appUpdates.map((u) => (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {t('dashboard.appUpdateRow', { name: u.name, current: u.current, latest: u.latest })}
                  </span>
                  <button className="btn btn--sm btn--primary" onClick={() => openAppUpdate(u)}>
                    <Download size={14} /> {t('settings.updateNow')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {diskLow && (
        <div className="warn-banner glass" role="status">
          <AlertTriangle size={22} />
          <div>
            <div className="warn-banner__title">{t('dashboard.diskWarnTitle', { percent: Math.round(diskPct) })}</div>
            <div className="warn-banner__body">{t('dashboard.diskWarnBody')}</div>
          </div>
        </div>
      )}

      <h2 className="section-title">{t('dashboard.installedApps')}</h2>

      {apps.length === 0 ? (
        <div className="glass panel">
          <div className="empty-state">
            <div className="empty-art">
              <MasjidScene size={88} />
            </div>
            <h3>{t('dashboard.noAppsTitle')}</h3>
            <p>{t('dashboard.noAppsBody')}</p>
            <Link to="/store" className="btn btn--primary" style={{ marginTop: '1rem' }}>
              {t('dashboard.browseStore')}
            </Link>
          </div>
        </div>
      ) : (
        <motion.div className="app-grid" variants={staggerContainer} initial="initial" animate="animate">
          {apps.map((app) => (
            <AppCard key={app.id} app={app} webTerminal={settings.data?.webTerminal ?? false} />
          ))}
        </motion.div>
      )}

      <UpdateModal open={updateOpen} onClose={() => setUpdateOpen(false)} currentVersion={updateQ.data?.current ?? ''} />
    </Page>
  );
}
