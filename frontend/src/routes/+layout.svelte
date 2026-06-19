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
  import { liquidIndicator, pressable, routeRise, khatamSplash } from '$lib/animations';
  import { prefs } from '$lib/stores/prefs';
  import { api } from '$lib/api/client';
  import SceneBackground from '$lib/components/SceneBackground.svelte';
  import AuthScreen from '$lib/components/AuthScreen.svelte';

  // Svelte 5 + SvelteKit 2: child page content arrives as a snippet prop.
  let { children }: { children: Snippet } = $props();

  // Auth gate: the whole dashboard sits behind a session. 'loading' until the
  // first /api/auth/me resolves, then setup / login / ready.
  let authState = $state<'loading' | 'setup' | 'login' | 'ready'>('loading');

  let navEl = $state<HTMLElement | undefined>(undefined);
  let indicator: ReturnType<typeof liquidIndicator> | undefined;

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

  // The sidebar only mounts once auth resolves to 'ready', which is AFTER
  // onMount — so create the liquid indicator in an effect keyed on navEl, and
  // tear it down when the shell unmounts (e.g. on sign-out).
  $effect(() => {
    if (!navEl) return;
    const ind = liquidIndicator(navEl, { activeSelector: '.nav-link--active' });
    indicator = ind;
    return () => {
      ind.destroy();
      indicator = undefined;
    };
  });

  async function checkAuth() {
    try {
      const s = await api.auth.me();
      if (mounted) authState = s.setup_required ? 'setup' : s.authenticated ? 'ready' : 'login';
    } catch {
      // Backend unreachable — fall back to the login screen so the user has a
      // path forward once it comes back up.
      if (mounted) authState = 'login';
    }
  }

  function handleAuthed() {
    authState = 'ready';
  }

  async function handleLogout() {
    try {
      await api.auth.logout();
    } catch {
      /* ignore — clearing client state is what matters */
    }
    authState = 'login';
  }

  // Re-place the liquid pill after each client-side navigation (DOM settled).
  afterNavigate(() => {
    indicator?.update();
  });

  function toggleTheme() {
    theme.toggle();
  }

  function splashAction(node: HTMLElement) {
    const s = khatamSplash(node, { onDone: () => { showSplash = false; } });
    return { destroy() { s.skip(); } };
  }

  // Nav items — labels go through i18n; no hardcoded English in template.
  const navItems = [
    { href: '/',         labelKey: 'nav.dashboard', icon: 'grid' },
    { href: '/store',    labelKey: 'nav.appStore',  icon: 'store' },
    { href: '/settings', labelKey: 'nav.settings',  icon: 'settings' },
  ];
</script>

<!-- Ambient scene behind everything -->
<SceneBackground />

{#if authState === 'ready'}
<div class="layout">
  <!-- Sidebar navigation (frosted glass) -->
  <aside class="sidebar glass-raised" aria-label={$t('nav.aria.sidebar')}>

    <!-- Logo / wordmark -->
    <div class="sidebar-brand">
      <span class="dome-icon" aria-hidden="true">
        <!--
          Logo: OSI-inspired circular badge with a stylised masjid silhouette.
          Uses currentColor so the icon inherits --color-primary from CSS.
          The crescent "bite" uses --color-surface-raised to match the sidebar bg.
        -->
        <svg viewBox="0 0 40 40" width="34" height="34" fill="none" xmlns="http://www.w3.org/2000/svg" color="var(--color-primary)">
          <circle cx="20" cy="20" r="17" stroke="currentColor" stroke-width="1.8"/>
          <rect x="8" y="23" width="3" height="8.5" rx="0.8" fill="currentColor"/>
          <path d="M8 23 Q9.5 19.2 11 23 Z" fill="currentColor"/>
          <rect x="29" y="23" width="3" height="8.5" rx="0.8" fill="currentColor"/>
          <path d="M29 23 Q30.5 19.2 32 23 Z" fill="currentColor"/>
          <rect x="7" y="30.5" width="26" height="2" rx="0.8" fill="currentColor"/>
          <path d="M11 30.5 Q11 18 20 15 Q29 18 29 30.5 Z" fill="currentColor"/>
          <circle cx="20" cy="13" r="2.8" fill="currentColor"/>
          <circle cx="21.4" cy="11.8" r="2.1" fill="var(--color-surface-raised)"/>
        </svg>
      </span>
      <span class="brand-name">{$prefs.dashboardName || $t('brand.name')}</span>
    </div>

    <!-- Primary navigation links -->
    <nav class="sidebar-nav" aria-label={$t('nav.aria.primary')} bind:this={navEl}>
      {#each navItems as item}
        {@const isActive = $page.url.pathname === item.href ||
          (item.href !== '/' && $page.url.pathname.startsWith(item.href))}
        <a
          href={item.href}
          class="nav-link"
          class:nav-link--active={isActive}
          aria-current={isActive ? 'page' : undefined}
        >
          <span class="nav-icon" aria-hidden="true">
            {#if item.icon === 'grid'}
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
                <rect x="2" y="2" width="7" height="7" rx="1.5"/>
                <rect x="11" y="2" width="7" height="7" rx="1.5"/>
                <rect x="2" y="11" width="7" height="7" rx="1.5"/>
                <rect x="11" y="11" width="7" height="7" rx="1.5"/>
              </svg>
            {:else if item.icon === 'store'}
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
                <path d="M3 9 Q3 5 10 5 Q17 5 17 9 L17 17 Q17 18 16 18 L4 18 Q3 18 3 17 Z"/>
                <path d="M7 18 L7 13 Q7 11 10 11 Q13 11 13 13 L13 18"/>
              </svg>
            {:else if item.icon === 'settings'}
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
                <circle cx="10" cy="10" r="2.5"/>
                <path d="M10 2 L10 4 M10 16 L10 18 M2 10 L4 10 M16 10 L18 10
                         M4.22 4.22 L5.64 5.64 M14.36 14.36 L15.78 15.78
                         M4.22 15.78 L5.64 14.36 M14.36 5.64 L15.78 4.22"/>
              </svg>
            {/if}
          </span>
          <span class="nav-label">{$t(item.labelKey)}</span>
        </a>
      {/each}
    </nav>

    <!-- Theme toggle pinned to bottom of sidebar -->
    <div class="sidebar-footer">
      <button
        class="theme-toggle"
        on:click={toggleTheme}
        use:pressable
        aria-label={$t($theme === 'dark' ? 'theme.switchToLight' : 'theme.switchToDark')}
        title={$t($theme === 'dark' ? 'theme.switchToLight' : 'theme.switchToDark')}
        type="button"
      >
        {#if $theme === 'dark'}
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18" aria-hidden="true">
            <circle cx="10" cy="10" r="3.5"/>
            <path d="M10 2 L10 4 M10 16 L10 18 M2 10 L4 10 M16 10 L18 10
                     M4.22 4.22 L5.64 5.64 M14.36 14.36 L15.78 15.78
                     M4.22 15.78 L5.64 14.36 M14.36 5.64 L15.78 4.22"/>
          </svg>
        {:else}
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18" aria-hidden="true">
            <path d="M15 10 A6 6 0 1 1 10 5 A4 4 0 0 0 15 10 Z"/>
          </svg>
        {/if}
        <span class="nav-label">{$t($theme === 'dark' ? 'theme.light' : 'theme.dark')}</span>
      </button>

      <button
        class="theme-toggle signout"
        on:click={handleLogout}
        use:pressable
        aria-label={$t('auth.signOut')}
        title={$t('auth.signOut')}
        type="button"
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18" aria-hidden="true">
          <path d="M8 17 L4 17 Q3 17 3 16 L3 4 Q3 3 4 3 L8 3 M13 14 L17 10 L13 6 M17 10 L8 10"/>
        </svg>
        <span class="nav-label">{$t('auth.signOut')}</span>
      </button>
    </div>
  </aside>

  <!-- Main content area — route content with a gentle rise transition -->
  <main class="main-content" id="main-content">
    {#key $page.url.pathname}
      <div class="route-wrap" in:routeRise>
        {@render children()}
      </div>
    {/key}
  </main>
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
  /* Layout shell — sidebar + content using logical CSS properties
     so the flex direction respects RTL automatically. */
  .layout {
    display: flex;
    flex-direction: row;
    min-height: 100vh;
  }

  /* Sidebar — frosted glass (.glass-raised supplies fill/blur/shadow). */
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 220px;
    flex-shrink: 0;
    border-radius: 0;
    border-inline-end: 1px solid var(--glass-border);
    padding-block: 1.5rem;
    padding-inline: 1rem;
    gap: 0.5rem;
  }

  /* Brand row */
  .sidebar-brand {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding-inline: 0.25rem;
    padding-block-end: 1.25rem;
    border-block-end: 1px solid var(--color-border);
    margin-block-end: 0.5rem;
  }

  .dome-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .brand-name {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-ink);
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Nav — position:relative so the liquid indicator (z-index:0) sits behind links */
  .sidebar-nav {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    flex: 1;
  }

  .nav-link {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding-block: 0.5rem;
    padding-inline: 0.75rem;
    border-radius: 0.5rem;
    color: var(--color-ink-muted);
    text-decoration: none;
    font-size: 0.875rem;
    font-weight: 500;
    transition: color 0.15s ease;
  }

  .nav-link:hover {
    color: var(--color-ink);
  }

  .nav-link:hover .nav-icon {
    transform: scale(1.08);
  }

  .nav-link--active {
    color: var(--color-primary);
    font-weight: 600;
  }

  .nav-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    transition: transform var(--dur-settle) var(--ease-settle);
  }

  .nav-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Footer / theme toggle */
  .sidebar-footer {
    padding-block-start: 0.75rem;
    border-block-start: 1px solid var(--color-border);
    margin-block-start: auto;
  }

  .theme-toggle {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding-block: 0.5rem;
    padding-inline: 0.75rem;
    border-radius: 0.5rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-ink-muted);
    font-size: 0.875rem;
    font-weight: 500;
    text-align: start;
    transition: background-color 0.15s ease, color 0.15s ease;
  }

  .theme-toggle:hover {
    background-color: var(--color-surface-hover);
    color: var(--color-ink);
  }

  .signout:hover {
    color: var(--color-danger);
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

  /* Main content */
  .main-content {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 2rem;
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
    .nav-link,
    .nav-icon,
    .theme-toggle {
      transition: none;
    }
    .nav-link:hover .nav-icon {
      transform: none;
    }
    .khatam-splash,
    .khatam-svg,
    .khatam-svg [data-spoke],
    .khatam-core {
      animation: none !important;
      stroke-dashoffset: 0 !important;
      opacity: 1;
    }
  }

  /* Responsive: collapse sidebar to icon-only on narrow viewports. */
  @media (max-width: 640px) {
    .sidebar {
      width: 56px;
      padding-inline: 0.5rem;
    }
    .brand-name,
    .nav-label {
      display: none;
    }
    .sidebar-brand {
      justify-content: center;
      padding-inline: 0;
    }
    .nav-link,
    .theme-toggle {
      justify-content: center;
      padding-inline: 0;
    }
  }
</style>
