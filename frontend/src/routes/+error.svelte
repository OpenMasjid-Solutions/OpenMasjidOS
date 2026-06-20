<script lang="ts">
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import { riseIn, pressable } from '$lib/animations';

  $: status = $page.status;
  $: isNotFound = status === 404;
</script>

<div class="error-page" in:riseIn>
  <!-- Dome / minaret / crescent hero, over the ambient scene with a soft halo -->
  <div class="error-illustration glow-accent" aria-hidden="true">
    <svg viewBox="0 0 160 130" width="160" height="130" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="30" y="60" width="9" height="50" rx="2" fill="currentColor" opacity=".30"/>
      <path d="M30 60 Q34.5 46 39 60 Z" fill="currentColor" opacity=".30"/>
      <circle cx="34.5" cy="44" r="2.4" fill="var(--color-gold)" opacity=".7"/>
      <rect x="121" y="60" width="9" height="50" rx="2" fill="currentColor" opacity=".30"/>
      <path d="M121 60 Q125.5 46 130 60 Z" fill="currentColor" opacity=".30"/>
      <circle cx="125.5" cy="44" r="2.4" fill="var(--color-gold)" opacity=".7"/>
      <rect x="26" y="108" width="108" height="5" rx="2" fill="currentColor" opacity=".25"/>
      <path d="M48 108 Q48 64 80 50 Q112 64 112 108 Z" fill="currentColor" opacity=".55"/>
      <path d="M70 108 L70 88 Q80 78 90 88 L90 108 Z" fill="var(--color-surface)"/>
      <circle cx="80" cy="42" r="7" fill="var(--color-gold)" opacity=".85"/>
      <circle cx="83" cy="39" r="5" fill="var(--color-surface)"/>
    </svg>
  </div>

  <div class="error-code">{status}</div>

  <h1 class="error-title">
    {isNotFound ? $t('errors.notFound') : $t('errors.serverError')}
  </h1>

  <p class="error-hint">
    {isNotFound ? $t('errors.notFoundHint') : $t('errors.serverErrorHint')}
  </p>

  <a href="/" class="home-link" use:pressable>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14" aria-hidden="true">
      <path d="M10 14 L4 8 L10 2"/>
    </svg>
    {$t('errors.goHome')}
  </a>
</div>

<style>
  .error-page {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    min-height: 60vh;
    padding: 2rem;
    gap: 0.75rem;
    color: var(--color-primary);
  }

  .error-illustration {
    margin-block-end: 0.5rem;
    opacity: 0.95;
  }

  .error-code {
    font-family: var(--font-display);
    font-size: 4rem;
    font-weight: 700;
    color: var(--color-primary);
    line-height: 1;
    letter-spacing: -0.04em;
    opacity: 0.6;
  }

  .error-title {
    font-size: 1.375rem;
    font-weight: 600;
    color: var(--color-ink);
    margin: 0;
    letter-spacing: -0.01em;
  }

  .error-hint {
    font-size: 0.9375rem;
    color: var(--color-ink-muted);
    margin: 0 0 0.75rem;
    max-width: 340px;
  }

  .home-link {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 1.125rem;
    border-radius: var(--radius-button);
    background: var(--color-primary-subtle);
    color: var(--color-primary);
    font-size: 0.9375rem;
    font-weight: 500;
    text-decoration: none;
    transition: background-color 0.15s ease;
  }
  .home-link:hover {
    background: var(--color-primary-subtle);
    box-shadow: var(--glow-primary);
  }
</style>
