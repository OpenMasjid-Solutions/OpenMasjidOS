<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import '$lib/theme/tokens.css';
  import '../app.css';
  import '$lib/theme/glass.css';
  import { theme } from '$lib/theme/theme';
  import { t, dir } from '$lib/i18n';
  import { page } from '$app/stores';
  import { afterNavigate } from '$app/navigation';
  import { pressable, routeRise, khatamSplash } from '$lib/animations';
  import { prefs } from '$lib/stores/prefs';
  import { api } from '$lib/api/client';
  import type { InstalledApp } from '$lib/api/client';
  import SceneBackground from '$lib/components/SceneBackground.svelte';
  import AuthScreen from '$lib/components/AuthScreen.svelte';

  // Svelte 5 + SvelteKit 2: child page content arrives as a snippet prop.
  let { children }: { children: Snippet } = $props();

  // Auth gate: the whole dashboard sits behind a session. 'loading' until the
  // first /api/auth/me resolves, then setup / login / ready.
  let authState = $state<'loading' | 'setup' | 'login' | 'ready'>('loading');

  // Guards the async auth check from writing state after the component unmounts.
  let mounted = true;

  // First-load splash overlay (assembling khatam star). Self-dismisses via the
  // khatamSplash action; collapses instantly under reduced-motion / repeat visit.
  let showSplash = $state(true);

  onMount(() => {
    // Re-apply persisted accent colour from prefs.
    prefs.hydrate();
    checkAuth();

    const unsubTheme = theme.subscribe((value) => {
      document.documentElement.setAttribute('data-theme', value);
    });
    const unsubDir = dir.subscribe((value) => {
      document.documentElement.setAttribute('dir', value);
    });

    return () => {
      mounted = false;
      unsubTheme();
      unsubDir();
    };
  });

  async function checkAuth() {
    try {
      const s = await api.auth.me();
      if (mounted) {
        authState = s.setup_required ? 'setup' : s.authenticated ? 'ready' : 'login';
        if (authState === 'ready') loadDockApps();
      }
    } catch {
      // Backend unreachable — fall back to the login screen so the user has a
      // path forward once it comes back up.
      if (mounted) authState = 'login';
    }
  }

  function handleAuthed() {
    authState = 'ready';
    loadDockApps();
  }

  // Refresh dock apps after navigation (e.g. returning from an install/remove).
  afterNavigate(() => {
    if (authState === 'ready') loadDockApps();
  });

  async function handleLogout() {
    try {
      await api.auth.logout();
    } catch {
      /* ignore — clearing client state is what matters */
    }
    authState = 'login';
  }

  function toggleTheme() {
    theme.toggle();
  }

  // ── Profile menu (top-right) ────────────────────────────────────────────
  let profileOpen = $state(false);

  // ── Dock: pinned apps ───────────────────────────────────────────────────
  // Load all apps once; the dock reactively shows the ones whose id is in
  // $prefs.pinnedApps, so pinning/unpinning anywhere updates the dock instantly.
  let dockApps = $state<InstalledApp[]>([]);

  async function loadDockApps() {
    try {
      const r = await api.apps.list();
      dockApps = r.apps ?? [];
    } catch {
      /* keep whatever we had */
    }
  }

  function appPorts(app: InstalledApp): number[] {
    return Array.isArray(app.ports) ? app.ports : [];
  }

  function openApp(app: InstalledApp) {
    const ports = appPorts(app);
    if (ports.length === 0) return;
    window.open(`http://${window.location.hostname}:${ports[0]}`, '_blank', 'noopener');
  }

  // Drag an app card (from the dashboard) onto the dock to pin it. The card
  // sets dataTransfer 'application/omos-app' to the app id.
  let dragOverDock = $state(false);
  function onDockDragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes('application/omos-app')) {
      e.preventDefault();
      dragOverDock = true;
    }
  }
  function onDockDrop(e: DragEvent) {
    dragOverDock = false;
    const id = e.dataTransfer?.getData('application/omos-app');
    if (id) {
      e.preventDefault();
      prefs.pin(id);
      loadDockApps();
    }
  }

  function splashAction(node: HTMLElement) {
    const s = khatamSplash(node, { onDone: () => { showSplash = false; } });
    return { destroy() { s.skip(); } };
  }

  // Dock items — labels go through i18n; no hardcoded English in template.
  const navItems = [
    { href: '/',         labelKey: 'nav.dashboard', icon: 'home' },
    { href: '/store',    labelKey: 'nav.appStore',  icon: 'store' },
    { href: '/settings', labelKey: 'nav.settings',  icon: 'settings' },
  ];

  function isActive(href: string, pathname: string): boolean {
    return pathname === href || (href !== '/' && pathname.startsWith(href));
  }
</script>

<!-- Ambient scene behind everything -->
<SceneBackground />

<!-- Close the profile menu on any outside click (button uses stopPropagation). -->
<svelte:window on:click={() => (profileOpen = false)} />

{#if authState === 'ready'}
<div class="shell">
  <!-- Main content area — route content with a gentle rise transition -->
  <main class="main-content" id="main-content">
    {#key $page.url.pathname}
      <div class="route-wrap" in:routeRise>
        {@render children()}
      </div>
    {/key}
  </main>

  <!-- Profile button + menu (top-right corner) -->
  <div class="profile">
    <button
      class="profile-btn"
      class:profile-btn--open={profileOpen}
      on:click|stopPropagation={() => (profileOpen = !profileOpen)}
      use:pressable
      aria-haspopup="menu"
      aria-expanded={profileOpen}
      aria-label={$t('profile.menu')}
      type="button"
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <circle cx="12" cy="8.5" r="3.5"/>
        <path d="M5 19.5 Q5 14.5 12 14.5 Q19 14.5 19 19.5"/>
      </svg>
    </button>
    {#if profileOpen}
      <div class="profile-menu glass-raised" role="menu">
        <button role="menuitem" class="pm-item" on:click|stopPropagation={() => { toggleTheme(); }}>
          <span class="pm-glyph" aria-hidden="true">
            {#if $theme === 'dark'}
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
                <circle cx="10" cy="10" r="3.5"/>
                <path d="M10 2 L10 4 M10 16 L10 18 M2 10 L4 10 M16 10 L18 10 M4.22 4.22 L5.64 5.64 M14.36 14.36 L15.78 15.78 M4.22 15.78 L5.64 14.36 M14.36 5.64 L15.78 4.22"/>
              </svg>
            {:else}
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
                <path d="M15 10 A6 6 0 1 1 10 5 A4 4 0 0 0 15 10 Z"/>
              </svg>
            {/if}
          </span>
          {$t($theme === 'dark' ? 'theme.switchToLight' : 'theme.switchToDark')}
        </button>
        <a role="menuitem" class="pm-item" href="/settings" on:click={() => (profileOpen = false)}>
          <span class="pm-glyph" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
              <circle cx="10" cy="10" r="2.5"/>
              <path d="M10 2 L10 4 M10 16 L10 18 M2 10 L4 10 M16 10 L18 10 M4.22 4.22 L5.64 5.64 M14.36 14.36 L15.78 15.78 M4.22 15.78 L5.64 14.36 M14.36 5.64 L15.78 4.22"/>
            </svg>
          </span>
          {$t('nav.settings')}
        </a>
        <button role="menuitem" class="pm-item pm-item--danger" on:click|stopPropagation={handleLogout}>
          <span class="pm-glyph" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
              <path d="M8 17 L4 17 Q3 17 3 16 L3 4 Q3 3 4 3 L8 3 M13 14 L17 10 L13 6 M17 10 L8 10"/>
            </svg>
          </span>
          {$t('auth.signOut')}
        </button>
      </div>
    {/if}
  </div>

  <!-- Floating glass dock (Umbrel-style app launcher / navigation) -->
  <nav
    class="dock glass-dock"
    class:dock--dragover={dragOverDock}
    aria-label={$t('nav.aria.primary')}
    on:dragover={onDockDragOver}
    on:drop={onDockDrop}
    on:dragleave={() => (dragOverDock = false)}
  >
    {#each navItems as item}
      {@const active = isActive(item.href, $page.url.pathname)}
      <a
        href={item.href}
        class="dock-item"
        class:dock-item--active={active}
        aria-current={active ? 'page' : undefined}
        aria-label={$t(item.labelKey)}
      >
        <span class="dock-glyph" aria-hidden="true">
          {#if item.icon === 'home'}
            <svg viewBox="0 0 40 40" width="26" height="26" fill="none" xmlns="http://www.w3.org/2000/svg" color="currentColor">
              <circle cx="20" cy="20" r="17" stroke="currentColor" stroke-width="1.8"/>
              <rect x="8" y="23" width="3" height="8.5" rx="0.8" fill="currentColor"/>
              <path d="M8 23 Q9.5 19.2 11 23 Z" fill="currentColor"/>
              <rect x="29" y="23" width="3" height="8.5" rx="0.8" fill="currentColor"/>
              <path d="M29 23 Q30.5 19.2 32 23 Z" fill="currentColor"/>
              <rect x="7" y="30.5" width="26" height="2" rx="0.8" fill="currentColor"/>
              <path d="M11 30.5 Q11 18 20 15 Q29 18 29 30.5 Z" fill="currentColor"/>
              <circle cx="20" cy="13" r="2.8" fill="currentColor"/>
              <circle cx="21.4" cy="11.8" r="2.1" fill="var(--color-surface-overlay)"/>
            </svg>
          {:else if item.icon === 'store'}
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="22" height="22">
              <path d="M3 9 Q3 5 10 5 Q17 5 17 9 L17 17 Q17 18 16 18 L4 18 Q3 18 3 17 Z"/>
              <path d="M7 18 L7 13 Q7 11 10 11 Q13 11 13 13 L13 18"/>
            </svg>
          {:else if item.icon === 'settings'}
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="22" height="22">
              <circle cx="10" cy="10" r="2.5"/>
              <path d="M10 2 L10 4 M10 16 L10 18 M2 10 L4 10 M16 10 L18 10
                       M4.22 4.22 L5.64 5.64 M14.36 14.36 L15.78 15.78
                       M4.22 15.78 L5.64 14.36 M14.36 5.64 L15.78 4.22"/>
            </svg>
          {/if}
        </span>
        <span class="dock-tip">{$t(item.labelKey)}</span>
      </a>
    {/each}

    {#if $prefs.pinnedApps.length > 0}
      <span class="dock-divider" aria-hidden="true"></span>
      {#each dockApps.filter((a) => $prefs.pinnedApps.includes(a.id)) as app (app.id)}
        <button
          class="dock-item dock-app"
          on:click={() => openApp(app)}
          use:pressable
          aria-label={app.name}
          type="button"
        >
          <span class="dock-glyph dock-app-glyph" aria-hidden="true">{app.name.slice(0, 1).toUpperCase()}</span>
          <span class="dock-tip">{app.name}</span>
        </button>
      {/each}
    {/if}
  </nav>
</div>
{:else if authState === 'setup' || authState === 'login'}
  <AuthScreen mode={authState} onAuthed={handleAuthed} />
{:else}
  <div class="auth-loading" role="status" aria-label={$t('auth.loading')}>
    <span class="auth-loading__dot"></span>
  </div>
{/if}

<!-- First-load splash: assembling khatam star. Skippable; once per session.
     Suppressed when the user turns it off in Settings. -->
{#if showSplash && $prefs.showSplash}
  <div
    class="khatam-splash"
    use:splashAction
    role="button"
    tabindex="0"
    aria-label={$t('a11y.loading')}
  >
    <svg class="khatam-svg" viewBox="0 0 120 120" width="120" height="120" fill="none" aria-hidden="true">
      <g stroke="var(--color-primary)" stroke-width="1.5" stroke-linecap="round">
        <line data-spoke x1="60" y1="60" x2="60" y2="14"/>
        <line data-spoke x1="60" y1="60" x2="92.5" y2="27.5"/>
        <line data-spoke x1="60" y1="60" x2="106" y2="60"/>
        <line data-spoke x1="60" y1="60" x2="92.5" y2="92.5"/>
        <line data-spoke x1="60" y1="60" x2="60" y2="106"/>
        <line data-spoke x1="60" y1="60" x2="27.5" y2="92.5"/>
        <line data-spoke x1="60" y1="60" x2="14" y2="60"/>
        <line data-spoke x1="60" y1="60" x2="27.5" y2="27.5"/>
      </g>
      <polygon
        class="khatam-core"
        points="60,30 67,46 84,42 73,56 90,60 73,64 84,78 67,74 60,90 53,74 36,78 47,64 30,60 47,56 36,42 53,46"
        fill="none" stroke="var(--color-gold)" stroke-width="1.5" stroke-linejoin="round"
      />
    </svg>
  </div>
{/if}

<style>
  /* Layout shell — full-width content with a floating bottom dock. */
  .shell {
    min-height: 100vh;
  }

  /* ── Floating glass dock (Umbrel-style launcher) ───────────────────── */
  .dock {
    position: fixed;
    bottom: 1rem;
    left: 50%;                 /* geometric centering — direction-agnostic */
    transform: translateX(-50%);
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem;
    border-radius: 1.25rem;
    max-width: calc(100vw - 1.5rem);
  }

  .dock-divider {
    width: 1px;
    align-self: stretch;
    margin-inline: 0.25rem;
    margin-block: 0.375rem;
    background: var(--glass-border);
    flex-shrink: 0;
  }

  .dock-item {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3rem;
    height: 3rem;
    flex-shrink: 0;
    border-radius: 0.875rem;
    border: none;
    background: transparent;
    color: var(--color-ink-muted);
    cursor: pointer;
    text-decoration: none;
    transition:
      transform var(--dur-settle) var(--ease-settle),
      background-color 0.15s ease,
      color 0.15s ease;
  }
  .dock-item:hover {
    color: var(--color-ink);
    background: var(--color-surface-hover);
    transform: translateY(-4px) scale(1.06);
  }
  .dock-item--active {
    color: var(--color-primary);
    background: var(--color-primary-subtle);
  }
  .dock-item--active::after {
    /* small active dot under the icon (macOS / Umbrel style) */
    content: "";
    position: absolute;
    bottom: -0.3125rem;
    left: 50%;
    transform: translateX(-50%);
    width: 0.25rem;
    height: 0.25rem;
    border-radius: 50%;
    background: var(--color-primary);
  }
  .dock-item--danger:hover { color: var(--color-danger); }
  .dock-glyph { display: flex; align-items: center; justify-content: center; }

  /* Hover/focus tooltip above the icon */
  .dock-tip {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    left: 50%;
    transform: translateX(-50%) translateY(4px);
    padding: 0.25rem 0.625rem;
    border-radius: 0.5rem;
    background: var(--color-surface-overlay);
    color: var(--color-ink);
    font-size: 0.75rem;
    font-weight: 500;
    white-space: nowrap;
    box-shadow: var(--shadow-card);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  .dock-item:hover .dock-tip,
  .dock-item:focus-visible .dock-tip {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  @media (prefers-reduced-motion: reduce) {
    .dock-item,
    .dock-tip { transition: none; }
    .dock-item:hover { transform: none; }
  }

  /* Dock highlight while dragging an app over it */
  .dock--dragover {
    box-shadow: var(--glass-shadow-raised), 0 0 0 2px var(--color-primary);
  }
  /* Pinned app icon — rounded-square with the app's initial */
  .dock-app-glyph {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.5rem;
    background: var(--color-primary-subtle);
    color: var(--color-primary);
    font-size: 0.9375rem;
    font-weight: 700;
  }

  /* ── Profile button + menu (top-right) ─────────────────────────────── */
  .profile {
    position: fixed;
    top: 1rem;
    inset-inline-end: 1rem;
    z-index: 45;
  }
  .profile-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 50%;
    border: 1px solid var(--glass-border);
    background-color: var(--glass-bg-raised);
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    color: var(--color-ink-muted);
    cursor: pointer;
    box-shadow: var(--glass-shadow);
    transition: color 0.15s ease, transform var(--dur-micro) var(--ease-settle);
  }
  .profile-btn:hover { color: var(--color-ink); }
  .profile-btn--open { color: var(--color-primary); }

  .profile-menu {
    position: absolute;
    top: calc(100% + 0.5rem);
    inset-inline-end: 0;
    min-width: 12rem;
    padding: 0.375rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    animation: pmIn 0.16s var(--ease-settle) both;
  }
  @keyframes pmIn {
    from { opacity: 0; transform: translateY(-6px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .pm-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.625rem;
    border-radius: 0.5rem;
    border: none;
    background: transparent;
    color: var(--color-ink);
    font-size: 0.875rem;
    font-family: inherit;
    text-align: start;
    text-decoration: none;
    cursor: pointer;
    transition: background-color 0.12s ease;
  }
  .pm-item:hover { background: var(--color-surface-hover); }
  .pm-item--danger { color: var(--color-danger); }
  .pm-glyph { display: flex; flex-shrink: 0; color: var(--color-ink-muted); }
  .pm-item--danger .pm-glyph { color: var(--color-danger); }

  @media (prefers-reduced-motion: reduce) {
    .profile-btn { transition: none; }
    .profile-menu { animation: none; }
  }

  /* Brief loading state while the first /api/auth/me resolves. */
  .auth-loading {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .auth-loading__dot {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 50%;
    background: var(--color-primary);
    animation: authPulse 1.2s ease-in-out infinite;
  }
  @keyframes authPulse {
    0%, 100% { opacity: 0.4; transform: scale(0.8); }
    50%      { opacity: 1; transform: scale(1.2); }
  }
  @media (prefers-reduced-motion: reduce) {
    .auth-loading__dot { animation: none; opacity: 0.8; }
  }

  /* Main content — full width; bottom padding leaves room for the dock. */
  .main-content {
    min-height: 100vh;
    overflow-y: auto;
    padding: 2rem 2rem 7rem;
  }

  .route-wrap {
    min-height: 100%;
  }

  /* ── First-load splash overlay ─────────────────────────────────────────── */
  .khatam-splash {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--scene-base);
    cursor: pointer;
    animation: splashFade 0.3s ease both;
  }
  .khatam-splash--out {
    animation: splashOut 0.28s ease forwards;
  }
  .khatam-svg {
    animation: khatamIn 0.6s var(--ease-settle) both;
  }
  .khatam-svg [data-spoke] {
    stroke-dasharray: 46;
    stroke-dashoffset: 46;
    animation: spokeDraw 0.4s ease forwards;
  }
  .khatam-svg [data-spoke]:nth-child(1) { animation-delay: 0.02s; }
  .khatam-svg [data-spoke]:nth-child(2) { animation-delay: 0.06s; }
  .khatam-svg [data-spoke]:nth-child(3) { animation-delay: 0.10s; }
  .khatam-svg [data-spoke]:nth-child(4) { animation-delay: 0.14s; }
  .khatam-svg [data-spoke]:nth-child(5) { animation-delay: 0.18s; }
  .khatam-svg [data-spoke]:nth-child(6) { animation-delay: 0.22s; }
  .khatam-svg [data-spoke]:nth-child(7) { animation-delay: 0.26s; }
  .khatam-svg [data-spoke]:nth-child(8) { animation-delay: 0.30s; }
  .khatam-core {
    stroke-dasharray: 320;
    stroke-dashoffset: 320;
    animation: spokeDraw 0.45s ease 0.22s forwards;
  }

  @keyframes khatamIn {
    from { opacity: 0; transform: scale(0.6); }
    to   { opacity: 1; transform: scale(1); }
  }
  @keyframes spokeDraw {
    to { stroke-dashoffset: 0; }
  }
  @keyframes splashFade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes splashOut {
    to { opacity: 0; visibility: hidden; }
  }

  /* Accessibility: respect reduced-motion preference. */
  @media (prefers-reduced-motion: reduce) {
    .khatam-splash,
    .khatam-svg,
    .khatam-svg [data-spoke],
    .khatam-core {
      animation: none !important;
      stroke-dashoffset: 0 !important;
      opacity: 1;
    }
  }

  /* Narrow viewports: a touch tighter so the dock fits comfortably. */
  @media (max-width: 480px) {
    .main-content { padding: 1.25rem 1rem 6.5rem; }
    .dock { gap: 0.125rem; padding: 0.375rem; }
    .dock-item { width: 2.75rem; height: 2.75rem; }
  }
</style>
