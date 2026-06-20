/**
 * Home: a live system-stats strip (tRPC subscription, seeded by a query for
 * instant first paint) above the installed-apps grid.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Cpu, MemoryStick, HardDrive, Thermometer, Clock, Boxes, AlertTriangle } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { usePrefs } from '../lib/prefs';
import { formatBytes, formatUptime, percent } from '../lib/format';
import { StatCard } from '../components/StatCard';
import { AppCard } from '../components/AppCard';
import { Page } from '../components/Page';
import { MasjidScene } from '../components/Glyphs';
import { staggerContainer } from '../lib/motion';
import { cn } from '../lib/cn';
import type { StatsSnapshot } from '../lib/types';

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
  // The WS subscription streams live stats (~2s); the query is just for the
  // first paint, with a slow refetch as a fallback if the socket drops.
  const initial = trpc.stats.get.useQuery(undefined, { refetchInterval: 30000 });
  const [live, setLive] = useState<StatsSnapshot | null>(null);
  trpc.stats.stream.useSubscription(undefined, {
    onData: (d: StatsSnapshot) => setLive(d),
  });
  const stats = live ?? initial.data ?? null;

  const appsQuery = trpc.apps.list.useQuery(undefined, { refetchInterval: 8000 });
  const apps = appsQuery.data ?? [];

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
          icon={<Cpu size={15} />}
          value={`${stats?.cpuPercent ?? 0}%`}
          sub={cpuSub}
          percent={stats?.cpuPercent ?? 0}
        />
        <StatCard
          label={t('dashboard.stats.memory')}
          icon={<MemoryStick size={15} />}
          value={formatBytes(stats?.memUsed ?? 0)}
          sub={`/ ${formatBytes(stats?.memTotal ?? 0)}`}
          percent={percent(stats?.memUsed ?? 0, stats?.memTotal ?? 0)}
        />
        <StatCard
          label={t('dashboard.stats.disk')}
          icon={<HardDrive size={15} />}
          value={formatBytes(stats?.diskUsed ?? 0)}
          sub={`/ ${formatBytes(stats?.diskTotal ?? 0)}`}
          percent={diskPct}
          warn={diskLow}
        />
        <StatCard
          label={t('dashboard.stats.temp')}
          icon={<Thermometer size={15} />}
          value={stats?.cpuTempC != null ? `${stats.cpuTempC}°C` : '—'}
        />
        <StatCard
          label={t('dashboard.stats.uptime')}
          icon={<Clock size={15} />}
          value={formatUptime(stats?.uptimeSec ?? 0)}
        />
        <StatCard
          label={t('dashboard.stats.apps')}
          icon={<Boxes size={15} />}
          value={stats?.appsRunning ?? apps.filter((a) => a.running).length}
        />
      </motion.section>

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
            <AppCard key={app.id} app={app} />
          ))}
        </motion.div>
      )}
    </Page>
  );
}
