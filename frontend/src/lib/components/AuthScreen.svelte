<script lang="ts">
  import { t } from '$lib/i18n';
  import { api, ApiError } from '$lib/api/client';
  import { riseIn, pressable } from '$lib/animations';

  // mode: 'setup' for first-run admin creation, 'login' for returning admins.
  // onAuthed is called once a session has been established.
  let { mode, onAuthed }: { mode: 'setup' | 'login'; onAuthed: () => void } = $props();

  let username = $state('');
  let password = $state('');
  let confirm = $state('');
  let error = $state('');
  let busy = $state(false);

  async function submit() {
    error = '';
    if (mode === 'setup') {
      if (password.length < 8) { error = $t('auth.passwordTooShort'); return; }
      if (password !== confirm) { error = $t('auth.passwordsMismatch'); return; }
    }
    busy = true;
    try {
      if (mode === 'setup') {
        await api.auth.setup(username.trim(), password);
      } else {
        await api.auth.login(username.trim(), password);
      }
      onAuthed();
    } catch (e) {
      error = e instanceof ApiError ? e.message : $t('auth.genericError');
      busy = false;
    }
  }
</script>

<div class="auth-screen">
  <div class="auth-card glass-raised glow-accent" in:riseIn>
    <!-- Logo -->
    <div class="auth-logo" aria-hidden="true">
      <svg viewBox="0 0 40 40" width="48" height="48" fill="none" xmlns="http://www.w3.org/2000/svg" color="var(--color-primary)">
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
    </div>

    <h1 class="auth-title">{mode === 'setup' ? $t('auth.setupTitle') : $t('auth.loginTitle')}</h1>
    <p class="auth-subtitle">{mode === 'setup' ? $t('auth.setupSubtitle') : $t('auth.loginSubtitle')}</p>

    <form class="auth-form" on:submit|preventDefault={submit}>
      <div class="auth-group">
        <label class="auth-label" for="auth-username">{$t('auth.username')}</label>
        <input
          id="auth-username"
          class="field"
          type="text"
          autocomplete="username"
          bind:value={username}
          placeholder={$t('auth.usernamePlaceholder')}
          required
        />
      </div>

      <div class="auth-group">
        <label class="auth-label" for="auth-password">{$t('auth.password')}</label>
        <input
          id="auth-password"
          class="field"
          type="password"
          autocomplete={mode === 'setup' ? 'new-password' : 'current-password'}
          aria-describedby={mode === 'setup' ? 'auth-password-hint' : undefined}
          bind:value={password}
          required
        />
        {#if mode === 'setup'}
          <span id="auth-password-hint" class="auth-hint">{$t('auth.passwordHint')}</span>
        {/if}
      </div>

      {#if mode === 'setup'}
        <div class="auth-group">
          <label class="auth-label" for="auth-confirm">{$t('auth.confirmPassword')}</label>
          <input
            id="auth-confirm"
            class="field"
            type="password"
            autocomplete="new-password"
            bind:value={confirm}
            required
          />
        </div>
      {/if}

      {#if error}
        <p class="auth-error" role="alert">{error}</p>
      {/if}

      <button type="submit" class="auth-submit" use:pressable disabled={busy}>
        {#if busy}
          {$t('auth.working')}
        {:else}
          {mode === 'setup' ? $t('auth.createAccount') : $t('auth.signIn')}
        {/if}
      </button>
    </form>
  </div>
</div>

<style>
  .auth-screen {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }

  .auth-card {
    width: 100%;
    max-width: 24rem;
    padding: 2.25rem 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .auth-logo {
    margin-block-end: 1rem;
  }

  .auth-title {
    font-family: 'Playfair Display', Georgia, serif;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--color-ink);
    margin: 0 0 0.375rem;
    letter-spacing: -0.02em;
  }

  .auth-subtitle {
    font-size: 0.9375rem;
    color: var(--color-ink-muted);
    margin: 0 0 1.75rem;
  }

  .auth-form {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    text-align: start;
  }

  .auth-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .auth-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-ink-muted);
  }

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
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.18);
  }
  .field:focus {
    border-color: var(--color-primary);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.18), var(--glow-primary);
  }
  .field::placeholder { color: var(--color-ink-faint); }

  .auth-hint {
    font-size: 0.75rem;
    color: var(--color-ink-faint);
  }

  .auth-error {
    margin: 0;
    font-size: 0.875rem;
    color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-danger) 30%, transparent);
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-button);
  }

  .auth-submit {
    margin-block-start: 0.25rem;
    padding: 0.625rem 1.25rem;
    border-radius: var(--radius-button);
    background: var(--color-btn);
    color: var(--color-on-primary);
    font-size: 0.9375rem;
    font-weight: 600;
    border: none;
    cursor: pointer;
    box-shadow: var(--glow-primary);
    transition: background-color 0.15s ease;
  }
  .auth-submit:hover:not(:disabled) { background: var(--color-btn-hover); }
  .auth-submit:disabled { opacity: 0.6; cursor: not-allowed; }

  @media (prefers-reduced-motion: reduce) {
    .field, .auth-submit { transition: none; }
  }
</style>
