<script lang="ts">
  import { get } from 'svelte/store';
  import { onMount } from 'svelte';
  import { t, locale } from '$lib/i18n';
  import { theme } from '$lib/theme/theme';
  import { prefs, ACCENTS } from '$lib/stores/prefs';
  import { serverSettings } from '$lib/stores/serverSettings';
  import { riseIn, pressable, enterGrid } from '$lib/animations';
  import Terminal from '$lib/components/Terminal.svelte';

  onMount(() => serverSettings.load());

  let showRootTerm = false;

  function setWebTerminal(on: boolean) {
    serverSettings.update({ ...get(serverSettings), web_terminal: on });
  }
  function setRootTerminal(on: boolean) {
    serverSettings.update({ ...get(serverSettings), root_terminal: on });
  }

  // Live-applied presentation prefs read straight from their stores ($theme,
  // $locale, $prefs.accent). Content fields below are edited locally and
  // committed on Save.
  let dashboardName = get(prefs).dashboardName;
  let showSplash = get(prefs).showSplash;
  let customApps = get(prefs).customApps;

  let saved = false;
  let saving = false;

  const accentList = Object.entries(ACCENTS).map(([id, a]) => ({ id, ...a }));

  function chooseAccent(id: string) {
    prefs.patch({ accent: id }); // applies live + persists
  }

  function setLanguage(e: Event) {
    locale.set((e.target as HTMLSelectElement).value);
  }

  async function handleSave() {
    saving = true;
    prefs.patch({ dashboardName: dashboardName.trim(), showSplash, customApps });
    await new Promise((r) => setTimeout(r, 400));
    saving = false;
    saved = true;
    setTimeout(() => (saved = false), 3000);
  }

  function gridIn(node: HTMLElement) {
    return { destroy: enterGrid(node, { base: 90, y: 16 }) };
  }
</script>

<div class="page">
  <header class="page-header" in:riseIn>
    <h1 class="page-title">{$t('settings.title')}</h1>
    <p class="page-subtitle">{$t('settings.subtitle')}</p>
  </header>

  <form class="settings-form" on:submit|preventDefault={handleSave} use:gridIn>

    <!-- Appearance -->
    <section class="settings-card glass">
      <div class="card-header">
        <div class="card-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
            <circle cx="10" cy="10" r="7.5"/>
            <path d="M10 2.5 A7.5 7.5 0 0 0 10 17.5 Z" fill="currentColor" stroke="none"/>
          </svg>
        </div>
        <h2 class="card-title">{$t('settings.appearance')}</h2>
      </div>

      <div class="settings-rows">
        <!-- Theme -->
        <div class="setting-row">
          <span class="setting-label">{$t('settings.theme')}</span>
          <div class="segmented" role="group" aria-label={$t('settings.theme')}>
            <button
              type="button"
              class="seg"
              class:seg--active={$theme === 'dark'}
              aria-pressed={$theme === 'dark'}
              use:pressable
              on:click={() => theme.set('dark')}
            >{$t('settings.themeDark')}</button>
            <button
              type="button"
              class="seg"
              class:seg--active={$theme === 'light'}
              aria-pressed={$theme === 'light'}
              use:pressable
              on:click={() => theme.set('light')}
            >{$t('settings.themeLight')}</button>
          </div>
        </div>

        <!-- Accent -->
        <div class="setting-row">
          <span class="setting-label">{$t('settings.accent')}</span>
          <div class="swatches" role="group" aria-label={$t('settings.accent')}>
            {#each accentList as a}
              <button
                type="button"
                class="swatch"
                class:swatch--active={$prefs.accent === a.id}
                style="--sw: {a.primary}"
                aria-pressed={$prefs.accent === a.id}
                aria-label={a.label}
                title={a.label}
                use:pressable
                on:click={() => chooseAccent(a.id)}
              ></button>
            {/each}
          </div>
        </div>

        <!-- Dashboard name -->
        <div class="setting-row setting-row--stack">
          <label class="setting-label" for="dash-name">{$t('settings.dashboardName')}</label>
          <input id="dash-name" type="text" class="field" bind:value={dashboardName} placeholder={$t('settings.dashboardNamePlaceholder')} />
          <span class="setting-hint">{$t('settings.dashboardNameHint')}</span>
        </div>

        <!-- Splash toggle -->
        <label class="setting-row toggle-row">
          <span class="setting-label">{$t('settings.showSplash')}</span>
          <input type="checkbox" class="switch" bind:checked={showSplash} />
        </label>
      </div>
    </section>

    <!-- Language -->
    <section class="settings-card glass">
      <div class="card-header">
        <div class="card-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
            <circle cx="10" cy="10" r="7.5"/>
            <path d="M2.5 10 H17.5 M10 2.5 Q14 6 14 10 Q14 14 10 17.5 Q6 14 6 10 Q6 6 10 2.5"/>
          </svg>
        </div>
        <h2 class="card-title">{$t('settings.languageTitle')}</h2>
      </div>

      <div class="settings-rows">
        <div class="setting-row setting-row--stack">
          <label class="setting-label" for="language">{$t('settings.language')}</label>
          <select id="language" class="field" value={$locale} on:change={setLanguage}>
            <option value="en">{$t('settings.languages.english')}</option>
            <option value="ar">{$t('settings.languages.arabic')}</option>
            <option value="ur">{$t('settings.languages.urdu')}</option>
          </select>
          <span class="setting-hint">{$t('settings.languageHint')}</span>
        </div>
      </div>
    </section>

    <!-- Advanced -->
    <section class="settings-card glass">
      <div class="card-header">
        <div class="card-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
            <circle cx="10" cy="10" r="2.5"/>
            <path d="M10 2 L10 4 M10 16 L10 18 M2 10 L4 10 M16 10 L18 10
                     M4.22 4.22 L5.64 5.64 M14.36 14.36 L15.78 15.78
                     M4.22 15.78 L5.64 14.36 M14.36 5.64 L15.78 4.22"/>
          </svg>
        </div>
        <h2 class="card-title">{$t('settings.advanced')}</h2>
      </div>

      <div class="settings-rows">
        <label class="setting-row toggle-row">
          <span class="toggle-text">
            <span class="setting-label">{$t('settings.customApps')}</span>
            <span class="setting-hint">{$t('settings.customAppsHint')}</span>
          </span>
          <input type="checkbox" class="switch" bind:checked={customApps} />
        </label>

        <!-- Web terminal (per-app). Server-enforced toggle. -->
        <label class="setting-row toggle-row">
          <span class="toggle-text">
            <span class="setting-label">{$t('settings.webTerminal')}</span>
            <span class="setting-hint">{$t('settings.webTerminalHint')}</span>
          </span>
          <input
            type="checkbox"
            class="switch"
            checked={$serverSettings.web_terminal}
            on:change={(e) => setWebTerminal(e.currentTarget.checked)}
          />
        </label>

        <!-- Root terminal (core container). Server-enforced toggle. -->
        <label class="setting-row toggle-row">
          <span class="toggle-text">
            <span class="setting-label">{$t('settings.rootTerminal')}</span>
            <span class="setting-hint">{$t('settings.rootTerminalHint')}</span>
          </span>
          <input
            type="checkbox"
            class="switch"
            checked={$serverSettings.root_terminal}
            on:change={(e) => setRootTerminal(e.currentTarget.checked)}
          />
        </label>

        {#if $serverSettings.root_terminal}
          <div class="setting-row">
            <span class="setting-label">{$t('settings.rootTerminalOpen')}</span>
            <button type="button" class="term-launch" use:pressable on:click={() => (showRootTerm = true)}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 4 L6.5 8 L3 12 M8 12 L13 12" />
              </svg>
              {$t('settings.rootTerminalButton')}
            </button>
          </div>
        {/if}
      </div>
    </section>

    <!-- Save bar -->
    <div class="save-bar">
      {#if saved}
        <span class="saved-badge" in:riseIn={{ duration: 200 }}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M3 8 L6.5 11.5 L13 4.5"/>
          </svg>
          {$t('settings.saved')}
        </span>
      {/if}
      <button type="submit" class="btn-primary" class:btn-primary--saved={saved} use:pressable disabled={saving}>
        {saving ? $t('settings.saving') : $t('settings.save')}
      </button>
    </div>

  </form>
</div>

{#if showRootTerm}
  <Terminal
    wsPath="/api/terminal/root"
    title={$t('settings.rootTerminalTitle')}
    onClose={() => (showRootTerm = false)}
  />
{/if}

<style>
  .page {
    max-width: 720px;
    margin: 0 auto;
  }

  .page-header { margin-block-end: 2rem; }
  .page-title {
    font-family: 'Playfair Display', Georgia, serif;
    font-size: 1.75rem;
    font-weight: 600;
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
  .settings-card { padding: 1.5rem; }

  .card-header {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-block-end: 1.25rem;
    padding-block-end: 1rem;
    border-block-end: 1px solid var(--glass-border);
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

  .settings-rows {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .setting-row--stack {
    flex-direction: column;
    align-items: stretch;
    gap: 0.375rem;
  }
  .setting-label {
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--color-ink);
  }
  .setting-hint {
    font-size: 0.8125rem;
    color: var(--color-ink-muted);
    line-height: 1.4;
  }

  /* Segmented control (theme) */
  .segmented {
    display: inline-flex;
    padding: 0.1875rem;
    border-radius: var(--radius-button);
    background: var(--glass-bg-inset);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.18);
    gap: 0.1875rem;
  }
  .seg {
    padding: 0.3125rem 0.875rem;
    border: none;
    border-radius: calc(var(--radius-button) - 0.1875rem);
    background: transparent;
    color: var(--color-ink-muted);
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    transition: color 0.15s ease, background-color 0.15s ease;
  }
  .seg--active {
    background: var(--color-primary-subtle);
    color: var(--color-primary);
  }

  /* Accent swatches */
  .swatches { display: inline-flex; gap: 0.5rem; }
  .swatch {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    border: 2px solid transparent;
    background: var(--sw);
    cursor: pointer;
    padding: 0;
    box-shadow: 0 0 0 1px var(--color-border);
    transition: transform 0.15s var(--ease-settle), box-shadow 0.15s ease;
  }
  .swatch:hover { transform: scale(1.12); }
  .swatch--active {
    box-shadow: 0 0 0 2px var(--color-surface), 0 0 0 4px var(--sw);
  }

  /* Recessed fields */
  .field {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-button);
    border: 1px solid var(--glass-border);
    background: var(--glass-bg-inset);
    color: var(--color-ink);
    font-size: 0.9375rem;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
    appearance: none;
    -webkit-appearance: none;
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.18);
  }
  /* Adds the brand glow on focus. We do NOT set outline:none, so the global
     :focus-visible ring (app.css) still shows for keyboard users — mouse focus
     simply won't trigger :focus-visible and shows the glow alone. */
  .field:focus {
    border-color: var(--color-primary);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.18), var(--glow-primary);
  }
  .field::placeholder { color: var(--color-ink-faint); }

  select.field {
    cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' stroke='%2394A3B8' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.75rem center;
    padding-inline-end: 2.25rem;
  }
  :global([dir='rtl']) select.field {
    background-position: left 0.75rem center;
    padding-inline-end: 0.75rem;
    padding-inline-start: 2.25rem;
  }

  /* Toggle switch (native checkbox, styled) */
  .toggle-row { cursor: pointer; align-items: flex-start; }
  .toggle-text { display: flex; flex-direction: column; gap: 0.25rem; }
  .switch {
    appearance: none;
    -webkit-appearance: none;
    flex-shrink: 0;
    width: 2.5rem;
    height: 1.5rem;
    border-radius: 1rem;
    background: var(--glass-bg-inset);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.25), 0 0 0 1px var(--glass-border);
    cursor: pointer;
    position: relative;
    transition: background-color var(--dur-settle) var(--ease-settle);
    margin: 0;
  }
  .switch::after {
    content: "";
    position: absolute;
    inset-block-start: 0.1875rem;
    inset-inline-start: 0.1875rem;
    width: 1.125rem;
    height: 1.125rem;
    border-radius: 50%;
    background: var(--color-ink-muted);
    transition: transform var(--dur-settle) var(--ease-settle), background-color 0.15s ease;
  }
  .switch:checked {
    background: var(--color-primary);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.15), 0 0 0 1px var(--color-primary);
  }
  .switch:checked::after {
    transform: translateX(1rem);
    background: var(--color-on-primary);
  }
  :global([dir='rtl']) .switch:checked::after { transform: translateX(-1rem); }

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
    background: var(--color-btn);
    color: var(--color-on-primary);
    font-size: 0.9375rem;
    font-weight: 600;
    border: none;
    cursor: pointer;
    box-shadow: var(--glow-primary);
    transition: background-color 0.15s ease, box-shadow var(--dur-settle) var(--ease-settle);
  }
  .btn-primary:hover:not(:disabled) { background: var(--color-btn-hover); }
  .btn-primary--saved {
    box-shadow: 0 0 0 1px var(--color-success), 0 12px 32px -8px var(--color-success);
  }
  .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

  .term-launch {
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    padding: 0.4375rem 0.875rem;
    border-radius: var(--radius-button);
    border: 1px solid var(--color-primary);
    background: var(--color-primary-subtle);
    color: var(--color-primary);
    font-size: 0.8125rem;
    font-weight: 600;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .term-launch:hover { background: color-mix(in srgb, var(--color-primary) 18%, transparent); }

  @media (prefers-reduced-motion: reduce) {
    .seg,
    .swatch,
    .switch,
    .switch::after,
    .btn-primary { transition: none !important; }
    .swatch:hover { transform: none; }
  }

  @media (max-width: 580px) {
    .setting-row {
      flex-direction: column;
      align-items: stretch;
    }
    .toggle-row {
      flex-direction: row;
      align-items: flex-start;
      justify-content: space-between;
    }
  }
</style>
