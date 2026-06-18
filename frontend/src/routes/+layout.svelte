<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import '$lib/theme/tokens.css';
  import '../app.css';
  import { theme } from '$lib/theme/theme';
  import { t, dir } from '$lib/i18n';
  import { page } from '$app/stores';

  // Svelte 5 + SvelteKit 2: child page content arrives as a snippet prop.
  // <slot /> no longer works in layouts when using Svelte 5.
  let { children }: { children: Snippet } = $props();

  // Apply theme and text direction to the html element on mount and whenever
  // the store changes — doing it here (root layout) means every page benefits.
  onMount(() => {
    const unsubTheme = theme.subscribe((value) => {
      document.documentElement.setAttribute('data-theme', value);
    });

    const unsubDir = dir.subscribe((value) => {
      document.documentElement.setAttribute('dir', value);
    });

    return () => {
      unsubTheme();
      unsubDir();
    };
  });

  function toggleTheme() {
    theme.update((current) => (current === 'dark' ? 'light' : 'dark'));
  }

  // Nav items — labels go through i18n; no hardcoded English in template.
  const navItems = [
    { href: '/',       labelKey: 'nav.dashboard', icon: 'grid' },
    { href: '/store',  labelKey: 'nav.appStore',  icon: 'store' },
    { href: '/settings', labelKey: 'nav.settings', icon: 'settings' },
  ];
</script>

<div class="layout">
  <!-- Sidebar navigation -->
  <aside class="sidebar" aria-label={$t('nav.aria.sidebar')}>

    <!-- Logo / wordmark -->
    <div class="sidebar-brand">
      <!-- Dome icon placeholder — replaced by the real SVG glyph from
           lib/components/icons once the custom glyph set is wired up. -->
      <span class="dome-icon" aria-hidden="true">
        <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" width="32" height="32">
          <!-- Minaret finial -->
          <circle cx="20" cy="4" r="2" fill="var(--color-accent)"/>
          <!-- Dome body -->
          <path
            d="M8 24 C8 14 32 14 32 24 L32 28 L8 28 Z"
            fill="var(--color-primary)"
          />
          <!-- Base structure -->
          <rect x="6" y="28" width="28" height="4" rx="1" fill="var(--color-primary-muted)"/>
          <!-- Door arch (mihrab motif) -->
          <path
            d="M17 32 L17 29 Q20 26 23 29 L23 32 Z"
            fill="var(--color-surface-raised)"
          />
        </svg>
      </span>
      <span class="brand-name">{$t('brand.name')}</span>
    </div>

    <!-- Primary navigation links -->
    <nav class="sidebar-nav" aria-label={$t('nav.aria.primary')}>
      {#each navItems as item}
        {@const isActive = $page.url.pathname === item.href ||
          (item.href !== '/' && $page.url.pathname.startsWith(item.href))}
        <a
          href={item.href}
          class="nav-link"
          class:nav-link--active={isActive}
          aria-current={isActive ? 'page' : undefined}
        >
          <!-- Icon slot — uses Tailwind + token classes so it reads correctly
               in both LTR and RTL without position overrides. -->
          <span class="nav-icon" aria-hidden="true">
            {#if item.icon === 'grid'}
              <!-- Dashboard: simple grid motif -->
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
                <rect x="2" y="2" width="7" height="7" rx="1.5"/>
                <rect x="11" y="2" width="7" height="7" rx="1.5"/>
                <rect x="2" y="11" width="7" height="7" rx="1.5"/>
                <rect x="11" y="11" width="7" height="7" rx="1.5"/>
              </svg>
            {:else if item.icon === 'store'}
              <!-- App Store: arch / storefront shape -->
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
                <path d="M3 9 Q3 5 10 5 Q17 5 17 9 L17 17 Q17 18 16 18 L4 18 Q3 18 3 17 Z"/>
                <path d="M7 18 L7 13 Q7 11 10 11 Q13 11 13 13 L13 18"/>
              </svg>
            {:else if item.icon === 'settings'}
              <!-- Settings: simple gear outline -->
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
        aria-label={$t($theme === 'dark' ? 'theme.switchToLight' : 'theme.switchToDark')}
        title={$t($theme === 'dark' ? 'theme.switchToLight' : 'theme.switchToDark')}
        type="button"
      >
        {#if $theme === 'dark'}
          <!-- Sun icon for "switch to light" -->
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18" aria-hidden="true">
            <circle cx="10" cy="10" r="3.5"/>
            <path d="M10 2 L10 4 M10 16 L10 18 M2 10 L4 10 M16 10 L18 10
                     M4.22 4.22 L5.64 5.64 M14.36 14.36 L15.78 15.78
                     M4.22 15.78 L5.64 14.36 M14.36 5.64 L15.78 4.22"/>
          </svg>
        {:else}
          <!-- Crescent moon icon for "switch to dark" -->
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18" aria-hidden="true">
            <path d="M15 10 A6 6 0 1 1 10 5 A4 4 0 0 0 15 10 Z"/>
          </svg>
        {/if}
        <span class="nav-label">{$t($theme === 'dark' ? 'theme.light' : 'theme.dark')}</span>
      </button>
    </div>
  </aside>

  <!-- Main content area — renders the active route page via Svelte 5 snippet -->
  <main class="main-content" id="main-content">
    {@render children()}
  </main>
</div>

<style>
  /* Layout shell — sidebar + content using logical CSS properties
     so the flex direction respects RTL automatically. */
  .layout {
    display: flex;
    flex-direction: row;
    min-height: 100vh;
  }

  /* Sidebar */
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 220px;
    flex-shrink: 0;
    background-color: var(--color-surface-raised);
    border-inline-end: 1px solid var(--color-border);
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

  /* Nav */
  .sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    flex: 1;
  }

  .nav-link {
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
    /* Spring-like transition — honors prefers-reduced-motion below */
    transition:
      background-color 0.15s ease,
      color 0.15s ease,
      transform 0.15s ease;
  }

  .nav-link:hover {
    background-color: var(--color-surface-hover);
    color: var(--color-ink);
    transform: translateX(2px);
  }

  /* Flip the hover translate direction for RTL */
  :global([dir='rtl']) .nav-link:hover {
    transform: translateX(-2px);
  }

  .nav-link--active {
    background-color: var(--color-primary-subtle);
    color: var(--color-primary);
    font-weight: 600;
  }

  .nav-link--active:hover {
    background-color: var(--color-primary-subtle);
    transform: none;
  }

  .nav-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
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
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .theme-toggle:hover {
    background-color: var(--color-surface-hover);
    color: var(--color-ink);
  }

  /* Main content */
  .main-content {
    flex: 1;
    min-width: 0; /* prevent flex blowout */
    overflow-y: auto;
    padding: 2rem;
  }

  /* Accessibility: respect reduced-motion preference */
  @media (prefers-reduced-motion: reduce) {
    .nav-link,
    .theme-toggle {
      transition: none;
    }

    .nav-link:hover {
      transform: none;
    }
  }

  /* Responsive: collapse sidebar to icon-only on narrow viewports */
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
