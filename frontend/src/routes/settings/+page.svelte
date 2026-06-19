<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { t } from '$lib/i18n';

  const prefersReducedMotion =
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

  const flyIn = prefersReducedMotion
    ? { y: 0, duration: 0 }
    : { y: 20, duration: 400, easing: cubicOut };

  function sectionDelay(i: number) {
    return prefersReducedMotion ? 0 : i * 80;
  }

  // Form state — not yet wired to backend
  let masjidName = '';
  let streetAddress = '';
  let city = '';
  let state = '';
  let zipCode = '';
  let country = '';
  let calcMethod = 'mwl';
  let asrMadhab = 'hanafi';  // Hanafi is the default
  let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let language = 'en';

  let saved = false;
  let saving = false;

  async function handleSave() {
    saving = true;
    // Backend not yet connected — will wire up in next milestone
    await new Promise((r) => setTimeout(r, 600));
    saving = false;
    saved = true;
    setTimeout(() => (saved = false), 3000);
  }

  const calcMethods = [
    { value: 'mwl',     label: $t('settings.calcMethods.mwl') },
    { value: 'isna',    label: $t('settings.calcMethods.isna') },
    { value: 'egypt',   label: $t('settings.calcMethods.egypt') },
    { value: 'makkah',  label: $t('settings.calcMethods.makkah') },
    { value: 'karachi', label: $t('settings.calcMethods.karachi') },
  ];

  // Hanafi is listed first and selected by default
  const asrMethods = [
    { value: 'hanafi',   label: $t('settings.asrMethods.hanafi') },
    { value: 'standard', label: $t('settings.asrMethods.standard') },
  ];
</script>

<div class="page" in:fly={flyIn}>
  <header class="page-header" in:fly={{ ...flyIn, delay: 0 }}>
    <h1 class="page-title">{$t('settings.title')}</h1>
    <p class="page-subtitle">{$t('settings.subtitle')}</p>
  </header>

  <form class="settings-form" on:submit|preventDefault={handleSave}>

    <!-- Masjid Profile -->
    <section class="settings-card" in:fly={{ ...flyIn, delay: sectionDelay(0) }}>
      <div class="card-header">
        <div class="card-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
            <path d="M4 18 Q4 11 10 9 Q16 11 16 18"/>
            <rect x="2" y="17" width="16" height="1.5" rx="0.75"/>
            <circle cx="10" cy="7.5" r="1.5"/>
          </svg>
        </div>
        <h2 class="card-title">{$t('settings.masjidProfile')}</h2>
      </div>

      <div class="form-grid">
        <div class="form-group form-group--full">
          <label for="masjid-name" class="form-label">{$t('settings.masjidName')}</label>
          <input
            id="masjid-name"
            type="text"
            bind:value={masjidName}
            placeholder={$t('settings.masjidNamePlaceholder')}
            class="form-input"
          />
        </div>
        <div class="form-group form-group--full">
          <label for="street-address" class="form-label">{$t('settings.streetAddress')}</label>
          <input
            id="street-address"
            type="text"
            bind:value={streetAddress}
            placeholder={$t('settings.streetAddressPlaceholder')}
            class="form-input"
          />
        </div>
        <div class="form-group">
          <label for="city" class="form-label">{$t('settings.city')}</label>
          <input
            id="city"
            type="text"
            bind:value={city}
            placeholder={$t('settings.cityPlaceholder')}
            class="form-input"
          />
        </div>
        <div class="form-group">
          <label for="state" class="form-label">{$t('settings.state')}</label>
          <input
            id="state"
            type="text"
            bind:value={state}
            placeholder={$t('settings.statePlaceholder')}
            class="form-input"
          />
        </div>
        <div class="form-group">
          <label for="zip-code" class="form-label">{$t('settings.zipCode')}</label>
          <input
            id="zip-code"
            type="text"
            bind:value={zipCode}
            placeholder={$t('settings.zipCodePlaceholder')}
            class="form-input"
          />
        </div>
        <div class="form-group">
          <label for="country" class="form-label">{$t('settings.country')}</label>
          <input
            id="country"
            type="text"
            bind:value={country}
            placeholder={$t('settings.countryPlaceholder')}
            class="form-input"
          />
        </div>
      </div>
    </section>

    <!-- Prayer Settings -->
    <section class="settings-card" in:fly={{ ...flyIn, delay: sectionDelay(1) }}>
      <div class="card-header">
        <div class="card-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
            <circle cx="10" cy="10" r="7.5"/>
            <path d="M10 5.5 L10 10 L13.5 12"/>
          </svg>
        </div>
        <h2 class="card-title">{$t('settings.prayerSettings')}</h2>
      </div>

      <div class="form-grid">
        <div class="form-group form-group--full">
          <label for="calc-method" class="form-label">{$t('settings.calculationMethod')}</label>
          <select id="calc-method" bind:value={calcMethod} class="form-input">
            {#each calcMethods as m}
              <option value={m.value}>{m.label}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label for="asr-madhab" class="form-label">{$t('settings.asrMadhab')}</label>
          <select id="asr-madhab" bind:value={asrMadhab} class="form-input">
            {#each asrMethods as m}
              <option value={m.value}>{m.label}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label for="timezone" class="form-label">{$t('settings.timezone')}</label>
          <input
            id="timezone"
            type="text"
            bind:value={timezone}
            class="form-input"
            placeholder="Europe/London"
          />
        </div>
      </div>
    </section>

    <!-- Interface -->
    <section class="settings-card" in:fly={{ ...flyIn, delay: sectionDelay(2) }}>
      <div class="card-header">
        <div class="card-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
            <rect x="2" y="3" width="16" height="11" rx="1.5"/>
            <path d="M6 18 L14 18 M10 14 L10 18"/>
          </svg>
        </div>
        <h2 class="card-title">{$t('settings.interface')}</h2>
      </div>

      <div class="form-grid">
        <div class="form-group">
          <label for="language" class="form-label">{$t('settings.language')}</label>
          <select id="language" bind:value={language} class="form-input">
            <option value="en">English</option>
            <option value="ar">العربية</option>
            <option value="ur">اردو</option>
          </select>
        </div>
      </div>
    </section>

    <!-- Save bar -->
    <div class="save-bar" in:fly={{ ...flyIn, delay: sectionDelay(3) }}>
      {#if saved}
        <span class="saved-badge" in:fade={{ duration: 200 }}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M3 8 L6.5 11.5 L13 4.5"/>
          </svg>
          {$t('settings.saved')}
        </span>
      {/if}
      <button type="submit" class="btn-primary" disabled={saving}>
        {saving ? '...' : $t('settings.save')}
      </button>
    </div>

  </form>
</div>

<style>
  .page {
    max-width: 720px;
    margin: 0 auto;
  }

  .page-header {
    margin-block-end: 2rem;
  }

  .page-title {
    font-size: 1.625rem;
    font-weight: 700;
    color: var(--color-ink);
    margin: 0 0 0.375rem;
    letter-spacing: -0.02em;
  }

  .page-subtitle {
    font-size: 0.9375rem;
    color: var(--color-ink-muted);
    margin: 0;
  }

  .settings-form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .settings-card {
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-card);
    padding: 1.5rem;
    box-shadow: var(--shadow-card);
    transition: box-shadow 0.2s ease;
  }

  .settings-card:hover {
    box-shadow: var(--shadow-card), 0 0 0 1px var(--color-border);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-block-end: 1.25rem;
    padding-block-end: 1rem;
    border-block-end: 1px solid var(--color-border);
  }

  .card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 0.5rem;
    background: var(--color-primary-subtle);
    color: var(--color-primary);
    flex-shrink: 0;
  }

  .card-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-ink);
    margin: 0;
  }

  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .form-group--full {
    grid-column: 1 / -1;
  }

  .form-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-ink-muted);
    letter-spacing: 0.01em;
  }

  .form-input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-ink);
    font-size: 0.9375rem;
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
    appearance: none;
    -webkit-appearance: none;
  }

  .form-input:focus {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
  }

  .form-input::placeholder {
    color: var(--color-ink-faint);
  }

  select.form-input {
    cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' stroke='%2394A3B8' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.75rem center;
    padding-inline-end: 2.25rem;
  }

  .save-bar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 1rem;
    padding-block-start: 0.5rem;
  }

  .saved-badge {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.875rem;
    color: var(--color-success);
    font-weight: 500;
  }

  .btn-primary {
    padding: 0.5rem 1.25rem;
    border-radius: var(--radius-button);
    background: var(--color-primary);
    color: #000;
    font-size: 0.9375rem;
    font-weight: 600;
    border: none;
    cursor: pointer;
    transition: background-color 0.15s ease, transform 0.1s ease;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
    transform: translateY(-1px);
  }

  .btn-primary:active:not(:disabled) {
    transform: translateY(0);
  }

  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  @media (max-width: 580px) {
    .form-grid {
      grid-template-columns: 1fr;
    }

    .form-group--full {
      grid-column: 1;
    }
  }
</style>
