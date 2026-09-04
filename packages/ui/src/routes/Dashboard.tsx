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
import { Cpu, MemoryStick, HardDrive, Thermometer, Clock, Boxes, AlertTriangle, Sparkles, Download, Beaker } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { usePrefs } from '../lib/prefs';
import { formatBytes, formatUptime, percent } from '../lib/format';
import { StatCard } from '../components/StatCard';
import { AppCard } from '../components/AppCard';
import { UpdateModal } from '../components/UpdateModal';
import { AppUpdate } from '../components/AppUpdate';
import { UpdateAllApps } from '../components/UpdateAllApps';
import { useWindows } from '../components/Windows';
import { Page } from '../components/Page';
import { MasjidMark } from '../components/Glyphs';
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
  // Platform-managed apps are engines the OS drives, not places a masjid goes (currently
  // the WhatsApp gateway). They are reached from Settings, because opening them directly
  // is how the platform's session ownership and message pacing get broken — so they are
  // not cards here. They still count towards "apps running", which is a machine fact.
  const allApps = appsQuery.data ?? [];
  const apps = allApps.filter((a) => !a.managed);

  // Auto-check for a core update on load (and every ~6h while open) so a new
  // version surfaces right on the dashboard instead of going unnoticed.
  const updateQ = trpc.system.checkUpdate.useQuery(undefined, { refetchInterval: 21_600_000 });
  const updateReady = updateQ.data?.updateAvailable ?? false;
  // A standing "you're on Development" note, so an admin can tell at a glance that
  // this box runs untested software. It is NOT a substitute for the update banner any
  // more: Development builds are versioned prereleases, so `updateReady` above is
  // meaningful on both channels and both banners can show together.
  const onDevChannel = updateQ.data?.channel === 'dev';
  const [updateOpen, setUpdateOpen] = useState(false);

  // App updates — same idea as the core check: surface them right on the dashboard.
  const appUpdatesQ = trpc.apps.updates.useQuery(undefined, { refetchInterval: 21_600_000 });
  const appUpdates = appUpdatesQ.data ?? [];
  /**
   * Is WhatsApp signed out right now?
   *
   * The dashboard has never queried WhatsApp before, and this is the one WhatsApp state
   * worth the extra call: an active outage where messages are silently not going out. The
   * Settings panel only polls while its own pane is open, so without this the masjid's
   * first sign of a dead link is somebody saying they never got their message.
   *
   * Five minutes, not the ~6h the update checks use — an update can wait, an outage cannot.
   */
  const waHeldQ = trpc.whatsapp.held.useQuery(undefined, { refetchInterval: 300_000 });
  const waDown = waHeldQ.data?.health.down === true;
  const waHeld = waHeldQ.data?.total ?? 0;
  // Genuine version upgrades only — a channel move is a different operation with a
  // different follow-up (the OS has to move too, which only Settings → Updates does),
  // so it must not be swept into "Update all" from here.
  const versionUpdates = appUpdates.filter((u) => u.reason === 'version');
  const windows = useWindows();
  function openAppUpdate(u: { id: string; name: string }) {
    // Locked until it finishes — same rule as the app card and the core updater: an
    // update that can be closed can be started twice, and two at once break the app.
    let winId = -1;
    winId = windows.open({
      title: t('appUpdate.title', { name: u.name }),
      dedupeKey: `update:${u.id}`,
      wide: true,
      locked: true,
      icon: <Download size={15} />,
      node: <AppUpdate id={u.id} name={u.name} onDone={() => windows.setLocked(winId, false)} />,
    });
  }

  /**
   * Update every app that has a genuine version update, in one window.
   *
   * Channel moves are deliberately EXCLUDED. They are already driven by "Update all" in
   * Settings → Updates, which also brings the OS across afterwards; running them from
   * here would do half that job and leave the platform on the other channel's image —
   * the mixed state the channel feature exists to prevent.
   */
  function openUpdateAll(list: { id: string; name: string }[]) {
    let winId = -1;
    winId = windows.open({
      title: t('updateAll.title'),
      dedupeKey: 'update:all-apps',
      wide: true,
      // Locked while it runs, same rule as every other update path: a window that can be
      // closed can be started again over the top of the run already going.
      locked: true,
      icon: <Download size={15} />,
      node: <UpdateAllApps apps={list} onDone={() => windows.setLocked(winId, false)} />,
    });
  }

  const name = prefs.dashboardName.trim() || me.data?.username || t('dashboard.yourMasjid');
  // Pluralised and translated: "1 core" is not "1 cores", and a Pi is a single-core-visible
  // box often enough for that to show. The speed variant is a separate key so a translator
  // can reorder the two halves.
  const cpuSub = (() => {
    if (!stats || !stats.cpuCores) return undefined;
    const cores = t('dashboard.stats.cores', { count: stats.cpuCores });
    return stats.cpuSpeedGHz
      ? t('dashboard.stats.coresSpeed', { cores, speed: stats.cpuSpeedGHz.toFixed(1) })
      : cores;
  })();

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
          value={stats?.appsRunning ?? allApps.filter((a) => a.running).length}
        />
      </motion.section>

      {onDevChannel && (
        <div className="warn-banner glass" role="status" style={{ borderInlineStart: '3px solid var(--color-gold)' }}>
          <Beaker size={22} style={{ color: 'var(--color-gold)' }} />
          <div style={{ flex: 1 }}>
            <div className="warn-banner__title">{t('dashboard.devChannelTitle')}</div>
            <div className="warn-banner__body">{t('dashboard.devChannelBody')}</div>
          </div>
        </div>
      )}

      {updateReady && (
        <div className="warn-banner warn-banner--update glass" role="status">
          <Sparkles size={22} />
          <div style={{ flex: 1 }}>
            {/* A channel move is not "a new version" — the target can be an older
                number, and calling it an upgrade when someone is going back to Stable
                reads as a mistake. Name what is actually happening. */}
            <div className="warn-banner__title">
              {updateQ.data?.reason === 'channel'
                ? t('dashboard.channelFixTitle', {
                    channel:
                      updateQ.data.channel === 'dev' ? t('settings.channelDev') : t('settings.channelStable'),
                  })
                : t('dashboard.updateTitle', { version: updateQ.data?.latest })}
            </div>
            <div className="warn-banner__body">
              {updateQ.data?.reason === 'channel'
                ? t('dashboard.channelFixBody', { version: updateQ.data.latest })
                : t('dashboard.updateBody')}
            </div>
          </div>
          <button className="btn btn--primary" onClick={() => setUpdateOpen(true)}>
            <Download size={15} /> {t('settings.updateNow')}
          </button>
        </div>
      )}

      {/* An active WhatsApp outage. Above the update banners on purpose: an update is a
          "when you get a moment", this is "your messages are not going out right now". */}
      {waDown && (
        <div className="warn-banner glass" role="status">
          <AlertTriangle size={22} />
          <div style={{ flex: 1 }}>
            <div className="warn-banner__title">{t('dashboard.whatsappDownTitle')}</div>
            <div className="warn-banner__body">
              {waHeld > 0
                ? t('dashboard.whatsappDownBodyHeld', { count: waHeld })
                : t('dashboard.whatsappDownBody')}
            </div>
          </div>
          <Link className="btn btn--sm btn--primary" to="/settings/whatsapp">
            {t('dashboard.whatsappDownAction')}
          </Link>
        </div>
      )}

      {appUpdates.length > 0 && (
        <div className="warn-banner warn-banner--update glass" role="status">
          <Sparkles size={22} />
          <div style={{ flex: 1 }}>
            <div className="warn-banner__title">
              {/* A pending channel move is not an "update available" — calling it one
                  is how a row ended up reading "v0.66.1 → v0.66.0". Title by what the
                  list actually is. */}
              {appUpdates.every((u) => u.reason === 'channel')
                ? t('dashboard.appPendingTitle', { count: appUpdates.length })
                : t('dashboard.appUpdateTitle', { count: appUpdates.length })}
            </div>
            {/* Only once there is more than one to do — a single "Update all" sitting
                above a single app's own button is two buttons for one action. */}
            {versionUpdates.length > 1 && (
              <button
                className="btn btn--sm btn--primary"
                style={{ marginBlockStart: '0.5rem' }}
                onClick={() => openUpdateAll(versionUpdates)}
              >
                <Download size={14} /> {t('updateAll.button', { count: versionUpdates.length })}
              </button>
            )}
            <div className="warn-banner__body" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.35rem' }}>
              {appUpdates.map((u) => (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {/* Word each row by WHY it's listed. An arrow means "newer", so it
                        must only appear for a genuine version upgrade — never for a
                        channel move, whose target can legitimately be older. */}
                    {u.reason === 'channel'
                      ? u.channel === 'dev'
                        ? t('dashboard.appRowChannelToDev', { name: u.name, latest: u.latest })
                        : t('dashboard.appRowChannelToStable', { name: u.name, latest: u.latest })
                      : t('dashboard.appUpdateRow', { name: u.name, current: u.current, latest: u.latest })}
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
              {/* The real OpenMasjidOS mark, not the generic line-art masjid. It is a
                  currentColor mask, so `.empty-art`'s primary colour still applies and
                  it follows the theme — same component the dock, splash and login use,
                  so the brand reads identically everywhere. */}
              <MasjidMark size={88} />
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
