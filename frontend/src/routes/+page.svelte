<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { t } from '$lib/i18n';
  import { api } from '$lib/api/client';

  // Health response shape from GET /api/health
  interface HealthResponse {
    status: string;
    version: string;
    masjid_name?: string;
  }

  let health: HealthResponse | null = null;
  let healthError = false;
  let loading = true;

  // Detect user's reduced-motion preference once — used to gate animations.
  // We read this synchronously so the first render already knows the preference.
  const prefersReducedMotion =
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

  // Stagger delay per card index (ms). Collapsed to 0 when motion is reduced.
  function staggerDelay(index: number): number {
    return prefersReducedMotion ? 0 : index * 80;
  }

  // Shared fly parameters for entrance animations.
  const flyIn = prefersReducedMotion
    ? { y: 0, duration: 0 }
    : { y: 18, duration: 420, easing: cubicOut };

  onMount(async () => {
    try {
      const data = await api.get<HealthResponse>('/api/health');
      health = data;
    } catch {
      healthError = true;
    } finally {
      loading = false;
    }
  });
</script>

<!--
  Main dashboard page.
  Tokens used (defined in tokens.css as CSS custom properties and mapped via
  tailwind.config.js):
    bg-surface         – page / card background
    bg-surface-raised  – elevated card surface
    text-ink           – primary text
    text-ink-muted     – secondary / muted text
    border-border      – subtle divider colour
    bg-primary         – emerald action colour
    text-primary       – emerald text
    bg-gold            – warm gold accent (used sparingly)
    text-gold          – gold text
-->

<main class="min-h-screen bg-surface px-4 py-8 sm:px-8">
  <div class="mx-auto max-w-5xl space-y-8">

    <!-- ── Welcome section ── -->
    {#if loading}
      <div class="animate-shimmer h-10 w-64 rounded-lg bg-surface-raised" aria-hidden="true"></div>
    {:else}
      <div
        in:fly={{ ...flyIn, delay: staggerDelay(0) }}
        class="space-y-1"
      >
        <h1 class="text-3xl font-display font-semibold text-ink leading-tight">
          {$t('dashboard.welcome', {
            name: health?.masjid_name ?? $t('dashboard.yourMasjid')
          })}
        </h1>
        {#if health?.version}
          <p class="text-sm text-ink-muted">
            {$t('dashboard.coreVersion', { version: health.version })}
          </p>
        {/if}
      </div>
    {/if}

    <!-- ── System Status card ── -->
    {#if loading}
      <div
        class="animate-shimmer h-24 w-full rounded-2xl bg-surface-raised"
        aria-hidden="true"
      ></div>
    {:else}
      <div
        in:fly={{ ...flyIn, delay: staggerDelay(1) }}
        class="flex items-center gap-4 rounded-2xl border border-border bg-surface-raised px-6 py-5"
        role="status"
        aria-live="polite"
      >
        <!-- Status indicator dot -->
        <span
          class="relative flex h-3 w-3 shrink-0"
          aria-hidden="true"
        >
          {#if !healthError}
            <!-- Pulsing ring — respects reduced-motion via Tailwind's motion-safe variant -->
            <span
              class="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60"
            ></span>
            <span class="relative inline-flex h-3 w-3 rounded-full bg-primary"></span>
          {:else}
            <span class="relative inline-flex h-3 w-3 rounded-full bg-red-500"></span>
          {/if}
        </span>

        <div class="min-w-0 flex-1">
          <p class="font-medium text-ink">
            {$t('dashboard.systemStatus')}
          </p>
          <p class="text-sm text-ink-muted">
            {#if healthError}
              {$t('dashboard.statusError')}
            {:else}
              {$t('dashboard.statusOk')}
            {/if}
          </p>
        </div>

        <!-- Version badge -->
        {#if health?.version && !healthError}
          <span
            class="shrink-0 rounded-full border border-border px-3 py-0.5 text-xs font-medium text-ink-muted"
          >
            v{health.version}
          </span>
        {/if}
      </div>
    {/if}

    <!-- ── Installed Apps section ── -->
    <section aria-labelledby="installed-apps-heading">
      {#if loading}
        <!-- Skeleton for section heading -->
        <div
          class="animate-shimmer mb-4 h-7 w-40 rounded-lg bg-surface-raised"
          aria-hidden="true"
        ></div>
        <!-- Skeleton cards -->
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {#each Array(3) as _}
            <div
              class="animate-shimmer h-40 rounded-2xl bg-surface-raised"
              aria-hidden="true"
            ></div>
          {/each}
        </div>
      {:else}
        <div in:fly={{ ...flyIn, delay: staggerDelay(2) }}>
          <h2
            id="installed-apps-heading"
            class="mb-4 text-xl font-display font-semibold text-ink"
          >
            {$t('dashboard.installedApps')}
          </h2>

          <!--
            Empty state — no apps installed yet.
            The dome SVG is a simple stylised silhouette: a hemisphere body
            sitting on a rectangular base with two narrow minarets flanking it,
            and a crescent finial on top. Drawn with a single closed path so it
            scales cleanly at any size.
          -->
          <div
            class="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface-raised px-8 py-16 text-center"
          >
            <!-- Dome illustration -->
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 120 100"
              class="mb-6 h-24 w-24 text-primary opacity-70"
              aria-hidden="true"
              fill="currentColor"
            >
              <!--
                Stylised masjid dome silhouette.
                Composed of:
                  - Two thin minarets (left and right rectangles + small caps)
                  - A wide base rectangle
                  - A semicircular dome on top of the base
                  - A crescent finial at the apex of the dome
              -->

              <!-- Left minaret shaft -->
              <rect x="6" y="30" width="10" height="52" rx="2" />
              <!-- Left minaret cap (small dome) -->
              <ellipse cx="11" cy="30" rx="5" ry="6" />
              <!-- Left minaret finial dot -->
              <circle cx="11" cy="24" r="2" />

              <!-- Right minaret shaft -->
              <rect x="104" y="30" width="10" height="52" rx="2" />
              <!-- Right minaret cap -->
              <ellipse cx="109" cy="30" rx="5" ry="6" />
              <!-- Right minaret finial dot -->
              <circle cx="109" cy="24" r="2" />

              <!-- Base platform -->
              <rect x="20" y="68" width="80" height="14" rx="3" />

              <!-- Main dome body — hemisphere sitting on the base -->
              <path d="M22,68 Q22,28 60,28 Q98,28 98,68 Z" />

              <!--
                Crescent finial at the top of the dome.
                Drawn as a filled circle minus a slightly offset smaller circle
                to create the crescent shape using clip/mask isn't available in
                simple SVG without defs, so we use two overlapping circles with
                the background colour for the inner bite. We render the inner
                circle in bg-surface colour via a CSS variable fallback so it
                adapts to both themes.
              -->
              <circle cx="60" cy="26" r="5" />
              <!-- Bite out of the crescent — use surface colour -->
              <circle
                cx="62.5"
                cy="24.5"
                r="4"
                class="text-surface-raised"
                fill="var(--color-surface-raised, #1a2820)"
              />
            </svg>

            <h3 class="mb-2 text-lg font-semibold text-ink">
              {$t('dashboard.noAppsTitle')}
            </h3>
            <p class="mb-6 max-w-xs text-sm text-ink-muted">
              {$t('dashboard.noAppsBody')}
            </p>

            <a
              href="/store"
              class="
                inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5
                text-sm font-semibold text-white
                transition-transform duration-150
                motion-safe:hover:scale-[1.03] motion-safe:active:scale-[0.97]
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary
              "
            >
              <!-- Simple compass / store icon -->
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
              </svg>
              {$t('dashboard.browseStore')}
            </a>
          </div>
        </div>
      {/if}
    </section>

  </div>
</main>

<style>
  /*
    Shimmer skeleton animation.
    Uses a gradient sweep across the surface-raised colour to create the
    classic loading shimmer effect. Falls back to a static colour when the
    user prefers reduced motion.
  */
  @keyframes shimmer {
    0% {
      background-position: -200% 0;
    }
    100% {
      background-position: 200% 0;
    }
  }

  .animate-shimmer {
    background: linear-gradient(
      90deg,
      var(--color-surface-raised, #1a2820) 25%,
      var(--color-surface-shimmer, #243328) 50%,
      var(--color-surface-raised, #1a2820) 75%
    );
    background-size: 200% 100%;
    animation: shimmer 1.6s ease-in-out infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .animate-shimmer {
      animation: none;
      background: var(--color-surface-raised, #1a2820);
    }
  }
</style>
