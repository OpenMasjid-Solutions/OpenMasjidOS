<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { api } from '$lib/api/client';
  import type { StatsSnapshot, InstalledApp } from '$lib/api/client';
  import { serverSettings } from '$lib/stores/serverSettings';
  import { riseIn, tiltCard, pressable, enterGrid } from '$lib/animations';
  import Terminal from '$lib/components/Terminal.svelte';

  onMount(() => serverSettings.load());

  // App whose web terminal is open (null = none).
  let termApp: InstalledApp | null = null;

  // Health response shape from GET /api/health
  interface HealthResponse {
    status: string;
    version: string;
    masjid_name?: string;
  }

  let health: HealthResponse | null = null;
  let healthError = false;
  let loading = true;

  // Live host stats (polled). netRx/netTx are derived rates (bytes/sec).
  let stats: StatsSnapshot | null = null;
  let netRx = 0;
  let netTx = 0;
  let prevNet: { rx: number; tx: number; t: number } | null = null;

  onMount(async () => {
    try {
      health = await api.health();
    } catch {
      healthError = true;
    } finally {
      loading = false;
    }
  });

  async function pollStats() {
    try {
      const s = await api.stats();
      const now = Date.now();
      if (prevNet) {
        const dt = (now - prevNet.t) / 1000;
        if (dt > 0) {
          netRx = Math.max(0, (s.net_rx_bytes - prevNet.rx) / dt);
          netTx = Math.max(0, (s.net_tx_bytes - prevNet.tx) / dt);
        }
      }
      prevNet = { rx: s.net_rx_bytes, tx: s.net_tx_bytes, t: now };
      stats = s;
    } catch {
      // Stats endpoint unavailable (e.g. an older host without the /proc
      // mount) — leave the panel hidden rather than showing an error.
    }
  }

  onMount(() => {
    pollStats();
    const id = setInterval(pollStats, 3000);
    return () => clearInterval(id);
  });

  // Installed apps
  let installedApps: InstalledApp[] = [];
  let removingId = '';
  let openMenuId = '';

  async function loadApps() {
    try {
      const r = await api.apps.list();
      installedApps = r.apps ?? [];
    } catch {
      installedApps = [];
    }
  }

  onMount(loadApps);

  // Open the app in a new tab on its first published port, using whatever host
  // the dashboard is being viewed from.
  function openApp(app: InstalledApp) {
    if (!app.ports || app.ports.length === 0) return;
    window.open(`http://${window.location.hostname}:${app.ports[0]}`, '_blank', 'noopener');
  }

  function toggleMenu(id: string) {
    openMenuId = openMenuId === id ? '' : id;
  }

  async function appAction(kind: 'stop' | 'start' | 'restart', app: InstalledApp) {
    openMenuId = '';
    removingId = app.id;
    try {
      await api.apps[kind](app.id);
      await loadApps();
    } catch {
      /* leave state as-is on a transient failure */
    } finally {
      removingId = '';
    }
  }

  async function removeApp(app: InstalledApp) {
    openMenuId = '';
    if (!confirm($t('dashboard.removeConfirm', { name: app.name }))) return;
    removingId = app.id;
    try {
      await api.apps.remove(app.id, false);
      await loadApps();
    } catch {
      // leave the app in the list; a transient failure shouldn't hide it
    } finally {
      removingId = '';
    }
  }

  // Staggered-entrance action for the content stack (hides then reveals on view).
  function gridIn(node: HTMLElement) {
    return { destroy: enterGrid(node, { base: 90, y: 16 }) };
  }

  function fmtBytes(n: number): string {
    if (n <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
  }
  function fmtRate(bps: number): string {
    return fmtBytes(bps) + '/s';
  }
  function fmtUptime(sec: number): string {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }
  function pct(used: number, total: number): number {
    return total > 0 ? Math.round((used / total) * 100) : 0;
  }
</script>

<!-- Close any open ⋮ menu when clicking elsewhere (kebab uses stopPropagation). -->
<svelte:window on:click={() => (openMenuId = '')} />

<div class="page">

  <!-- ── Welcome hero — sits on the bare scene (no glass) so the first glass
       pane below has contrast to read against. ── -->
  {#if loading}
    <div class="hero-skeleton shimmer" aria-hidden="true"></div>
  {:else}
    <header class="hero" in:riseIn>
      <h1 class="hero-title">
        {$t('dashboard.welcome')}
      </h1>
      {#if health?.version && !healthError}
        <p class="hero-sub">{$t('dashboard.coreVersion', { version: health.version })}</p>
      {/if}
    </header>
  {/if}

  <!-- ── Live host stats (CPU / RAM / Storage / Network) ── -->
  {#if stats}
    <section class="stats-grid" aria-label={$t('dashboard.stats.title')} in:riseIn>
      <div class="stat-card glass">
        <div class="stat-head">
          <span class="stat-label">{$t('dashboard.stats.cpu')}</span>
          <span class="stat-val">{Math.round(stats.cpu_percent)}%</span>
        </div>
        <div class="stat-bar"><span style="width:{Math.min(100, stats.cpu_percent)}%"></span></div>
      </div>

      <div class="stat-card glass">
        <div class="stat-head">
          <span class="stat-label">{$t('dashboard.stats.memory')}</span>
          <span class="stat-val">{pct(stats.mem_used, stats.mem_total)}%</span>
        </div>
        <div class="stat-bar"><span style="width:{pct(stats.mem_used, stats.mem_total)}%"></span></div>
        <div class="stat-sub">{fmtBytes(stats.mem_used)} / {fmtBytes(stats.mem_total)}</div>
      </div>

      <div class="stat-card glass">
        <div class="stat-head">
          <span class="stat-label">{$t('dashboard.stats.disk')}</span>
          <span class="stat-val">{pct(stats.disk_used, stats.disk_total)}%</span>
        </div>
        <div class="stat-bar"><span style="width:{pct(stats.disk_used, stats.disk_total)}%"></span></div>
        <div class="stat-sub">{fmtBytes(stats.disk_used)} / {fmtBytes(stats.disk_total)}</div>
      </div>

      <div class="stat-card glass">
        <div class="stat-head">
          <span class="stat-label">{$t('dashboard.stats.network')}</span>
        </div>
        <div class="stat-net">
          <span class="stat-net-item">↓ {fmtRate(netRx)}</span>
          <span class="stat-net-item">↑ {fmtRate(netTx)}</span>
        </div>
        <div class="stat-sub">{$t('dashboard.stats.uptime')} {fmtUptime(stats.uptime_sec)}</div>
      </div>
    </section>
  {/if}

  {#if loading}
    <!-- Skeleton placeholders while health loads -->
    <div class="status-card glass-raised">
      <div class="skel-line skel-line--lg shimmer"></div>
    </div>
    <div class="apps-grid">
      {#each Array(3) as _}
        <div class="glass app-skeleton">
          <div class="skel-block shimmer"></div>
          <div class="skel-line shimmer"></div>
          <div class="skel-line skel-line--sm shimmer"></div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="content-stack" use:gridIn>

      <!-- ── System Status card ── -->
      <div
        class="status-card glass-raised glow-accent"
        use:tiltCard
        role="status"
        aria-live="polite"
      >
        <span
          class="status-dot"
          class:status-dot--error={healthError}
          aria-hidden="true"
        ></span>
        <div class="status-text">
          <p class="status-title">{$t('dashboard.systemStatus')}</p>
          <p class="status-sub">
            {#if healthError}
              {$t('dashboard.statusError')}
            {:else}
              {$t('dashboard.statusOk')}
            {/if}
          </p>
        </div>
        {#if health?.version && !healthError}
          <span class="version-badge">v{health.version}</span>
        {/if}
      </div>

      <!-- ── Installed Apps section ── -->
      <section class="apps-section" aria-labelledby="installed-apps-heading">
        <h2 id="installed-apps-heading" class="section-title">
          {$t('dashboard.installedApps')}
        </h2>

        {#if installedApps.length > 0}
          <!-- Installed apps -->
          <div class="installed-grid">
            {#each installedApps as app (app.id)}
              <div
                class="installed-card glass"
                class:clickable={app.ports.length > 0}
                on:click={() => openApp(app)}
                role={app.ports.length > 0 ? 'link' : undefined}
                tabindex={app.ports.length > 0 ? 0 : undefined}
                on:keydown={(e) => { if (app.ports.length > 0 && (e.key === 'Enter')) openApp(app); }}
              >
                <div class="installed-head">
                  <span
                    class="status-dot"
                    class:status-dot--error={!app.running}
                    aria-hidden="true"
                  ></span>
                  <span class="installed-name">{app.name}</span>

                  <!-- ⋮ options menu -->
                  <div class="kebab-wrap">
                    <button
                      class="kebab"
                      aria-label={$t('dashboard.appOptions')}
                      aria-haspopup="menu"
                      aria-expanded={openMenuId === app.id}
                      on:click|stopPropagation={() => toggleMenu(app.id)}
                    >
                      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
                        <circle cx="8" cy="3" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="8" cy="13" r="1.4" />
                      </svg>
                    </button>
                    {#if openMenuId === app.id}
                      <div class="kebab-menu glass-raised" role="menu">
                        {#if app.ports.length > 0}
                          <button role="menuitem" on:click|stopPropagation={() => { openMenuId=''; openApp(app); }}>{$t('actions.open')}</button>
                        {/if}
                        {#if $serverSettings.web_terminal && app.running}
                          <button role="menuitem" on:click|stopPropagation={() => { openMenuId=''; termApp = app; }}>{$t('actions.terminal')}</button>
                        {/if}
                        {#if app.running}
                          <button role="menuitem" on:click|stopPropagation={() => appAction('restart', app)}>{$t('actions.restart')}</button>
                          <button role="menuitem" on:click|stopPropagation={() => appAction('stop', app)}>{$t('actions.shutdown')}</button>
                        {:else}
                          <button role="menuitem" on:click|stopPropagation={() => appAction('start', app)}>{$t('actions.start')}</button>
                        {/if}
                        <button role="menuitem" class="danger" on:click|stopPropagation={() => removeApp(app)}>{$t('actions.uninstall')}</button>
                      </div>
                    {/if}
                  </div>
                </div>

                <div class="installed-meta">
                  <span class="app-tag" class:app-tag--official={!app.custom}>
                    {app.custom ? $t('dashboard.tagThirdParty') : $t('dashboard.tagOfficial')}
                  </span>
                  <span class="installed-status">
                    {removingId === app.id ? $t('status.updating') : (app.running ? $t('status.running') : $t('status.stopped'))}
                  </span>
                </div>
              </div>
            {/each}
          </div>
        {:else}
        <!-- Empty state — no apps installed yet -->
        <div class="empty-card glass glow-accent">
          <div class="empty-illustration" aria-hidden="true">
            <svg viewBox="0 0 160 130" width="150" height="122" fill="none" xmlns="http://www.w3.org/2000/svg">
              <!-- side minarets -->
              <rect x="30" y="60" width="9" height="50" rx="2" fill="currentColor" opacity=".30"/>
              <path d="M30 60 Q34.5 46 39 60 Z" fill="currentColor" opacity=".30"/>
              <circle cx="34.5" cy="44" r="2.4" fill="var(--color-gold)" opacity=".7"/>
              <rect x="121" y="60" width="9" height="50" rx="2" fill="currentColor" opacity=".30"/>
              <path d="M121 60 Q125.5 46 130 60 Z" fill="currentColor" opacity=".30"/>
              <circle cx="125.5" cy="44" r="2.4" fill="var(--color-gold)" opacity=".7"/>
              <!-- main dome on a mihrab body -->
              <rect x="26" y="108" width="108" height="5" rx="2" fill="currentColor" opacity=".25"/>
              <path d="M48 108 Q48 64 80 50 Q112 64 112 108 Z" fill="currentColor" opacity=".55"/>
              <!-- mihrab arch doorway -->
              <path d="M70 108 L70 88 Q80 78 90 88 L90 108 Z" fill="var(--color-surface)"/>
              <!-- crescent finial -->
              <circle cx="80" cy="42" r="7" fill="var(--color-gold)" opacity=".85"/>
              <circle cx="83" cy="39" r="5" fill="var(--color-surface)"/>
            </svg>
          </div>

          <h3 class="empty-title">{$t('dashboard.noAppsTitle')}</h3>
          <p class="empty-body">{$t('dashboard.noAppsBody')}</p>

          <a href="/store" class="browse-btn" use:pressable>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
            </svg>
            {$t('dashboard.browseStore')}
          </a>
        </div>
        {/if}
      </section>

    </div>
  {/if}
</div>

{#if termApp}
  <Terminal
    wsPath={`/api/apps/${termApp.id}/terminal`}
    title={termApp.name}
    onClose={() => (termApp = null)}
  />
{/if}

<style>
  .page {
    max-width: 64rem;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  /* Hero */
  .hero {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .hero-title {
    font-family: 'Playfair Display', Georgia, serif;
    font-size: 2rem;
    font-weight: 600;
    line-height: 1.15;
    letter-spacing: -0.02em;
    color: var(--color-ink);
    margin: 0;
  }
  .hero-sub {
    font-size: 0.875rem;
    color: var(--color-primary);
    margin: 0;
  }
  .hero-skeleton {
    height: 2.75rem;
    width: 18rem;
    border-radius: var(--radius-button);
  }

  /* Skeleton shimmer — gradient sweep (on-brand khatam tint). */
  .shimmer {
    background-image: linear-gradient(
      90deg,
      var(--color-surface-raised) 0%,
      var(--color-surface-shimmer) 50%,
      var(--color-surface-raised) 100%
    );
    background-size: 200% 100%;
    animation: shimmer 1.8s ease-in-out infinite;
  }
  @keyframes shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .shimmer {
      animation: none;
      background: var(--color-surface-overlay);
    }
  }

  /* Live stats */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1rem;
  }
  .stat-card { padding: 1rem 1.125rem; }
  .stat-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .stat-label { font-size: 0.8125rem; color: var(--color-ink-muted); font-weight: 500; }
  .stat-val { font-size: 1.125rem; font-weight: 600; color: var(--color-ink); }
  .stat-bar {
    margin-block-start: 0.625rem;
    height: 6px;
    border-radius: 3px;
    background: var(--glass-bg-inset);
    overflow: hidden;
  }
  .stat-bar span {
    display: block;
    height: 100%;
    border-radius: 3px;
    background: var(--color-primary);
    transition: width 0.6s var(--ease-settle);
  }
  .stat-sub { margin-block-start: 0.5rem; font-size: 0.75rem; color: var(--color-ink-faint); }
  .stat-net { display: flex; gap: 0.875rem; margin-block-start: 0.375rem; }
  .stat-net-item { font-size: 0.9375rem; font-weight: 600; color: var(--color-ink); }
  @media (prefers-reduced-motion: reduce) {
    .stat-bar span { transition: none; }
  }

  .content-stack {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  /* System Status card */
  .status-card {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1.25rem 1.5rem;
  }
  .status-text {
    min-width: 0;
    flex: 1;
  }
  .status-title {
    font-weight: 600;
    color: var(--color-ink);
    margin: 0;
  }
  .status-sub {
    font-size: 0.875rem;
    color: var(--color-ink-muted);
    margin: 0.125rem 0 0;
  }
  .version-badge {
    flex-shrink: 0;
    border-radius: 2rem;
    border: 1px solid var(--glass-border);
    padding: 0.125rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-ink-muted);
  }

  /* Apps section */
  .section-title {
    font-family: 'Playfair Display', Georgia, serif;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--color-ink);
    margin: 0 0 1rem;
  }

  .empty-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 3.5rem 2rem;
    border: 1px dashed var(--glass-border);
  }
  .empty-illustration {
    color: var(--color-primary);
    margin-block-end: 1rem;
    opacity: 0.9;
  }
  .empty-title {
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--color-ink);
    margin: 0 0 0.5rem;
  }
  .empty-body {
    font-size: 0.875rem;
    color: var(--color-ink-muted);
    max-width: 22rem;
    margin: 0 0 1.5rem;
  }

  .browse-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    border-radius: var(--radius-button);
    background: var(--color-btn);
    color: var(--color-on-primary);
    padding: 0.625rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 600;
    text-decoration: none;
    box-shadow: var(--glow-primary);
    transition: background-color 0.15s ease;
  }
  .browse-btn:hover {
    background: var(--color-btn-hover);
  }

  /* Installed apps */
  .installed-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 1rem;
  }
  .installed-card {
    padding: 1.125rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    transition: box-shadow 0.15s ease, transform 0.15s var(--ease-settle);
  }
  .installed-card.clickable { cursor: pointer; }
  .installed-card.clickable:hover {
    box-shadow: var(--glow-primary);
    transform: translateY(-2px);
  }
  .installed-head { display: flex; align-items: center; gap: 0.5rem; }
  .installed-name {
    font-weight: 600;
    color: var(--color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .installed-meta {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    font-size: 0.8125rem;
    color: var(--color-ink-muted);
  }
  .installed-status { color: var(--color-ink-muted); }

  /* Source tag */
  .app-tag {
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    padding: 0.125rem 0.5rem;
    border-radius: 2rem;
    color: var(--color-ink-muted);
    background: var(--glass-bg-inset);
    border: 1px solid var(--glass-border);
  }
  .app-tag--official {
    color: var(--color-gold);
    background: var(--color-gold-subtle);
    border-color: color-mix(in srgb, var(--color-gold) 30%, transparent);
  }

  /* ⋮ kebab menu */
  .kebab-wrap { position: relative; flex-shrink: 0; }
  .kebab {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 0.5rem;
    border: none;
    background: transparent;
    color: var(--color-ink-muted);
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .kebab:hover { background: var(--color-surface-hover); color: var(--color-ink); }
  .kebab-menu {
    position: absolute;
    inset-inline-end: 0;
    inset-block-start: calc(100% + 0.25rem);
    z-index: 5;
    min-width: 9rem;
    padding: 0.3125rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .kebab-menu button {
    text-align: start;
    padding: 0.4375rem 0.625rem;
    border-radius: 0.4375rem;
    border: none;
    background: transparent;
    color: var(--color-ink);
    font-size: 0.875rem;
    cursor: pointer;
    transition: background-color 0.12s ease;
  }
  .kebab-menu button:hover { background: var(--color-surface-hover); }
  .kebab-menu button.danger { color: var(--color-danger); }
  .kebab-menu button.danger:hover { background: color-mix(in srgb, var(--color-danger) 14%, transparent); }

  @media (prefers-reduced-motion: reduce) {
    .installed-card { transition: none; }
    .installed-card.clickable:hover { transform: none; }
  }

  /* App grid + skeletons */
  .apps-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  }
  .app-skeleton {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.25rem;
  }
  .skel-block {
    width: 48px;
    height: 48px;
    border-radius: 0.75rem;
    background-color: var(--color-surface-overlay);
  }
  .skel-line {
    height: 0.875rem;
    width: 75%;
    border-radius: 0.375rem;
    background-color: var(--color-surface-overlay);
  }
  .skel-line--sm { width: 50%; }
  .skel-line--lg { width: 60%; height: 1.25rem; }
</style>
