<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { api, ApiError } from '$lib/api/client';
  import type { FileEntry } from '$lib/api/client';
  import { riseIn, pressable } from '$lib/animations';

  let path = '';
  let entries: FileEntry[] = [];
  let loading = true;
  let busy = false;
  let error = '';

  let renamingName: string | null = null;
  let renameValue = '';
  let fileInput: HTMLInputElement;

  onMount(() => load(''));

  async function load(p: string) {
    loading = true;
    error = '';
    renamingName = null;
    try {
      const r = await api.files.list(p);
      path = r.path;
      entries = r.entries;
    } catch (e) {
      error = e instanceof ApiError ? e.message : $t('files.loadError');
      entries = [];
    } finally {
      loading = false;
    }
  }

  function join(dir: string, name: string): string {
    return dir ? dir.replace(/\/+$/, '') + '/' + name : name;
  }

  function openEntry(e: FileEntry) {
    if (e.is_dir) load(join(path, e.name));
    else download(e);
  }
  function download(e: FileEntry) {
    window.location.href = api.files.downloadUrl(join(path, e.name));
  }

  async function doUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    busy = true;
    error = '';
    try {
      for (const f of Array.from(files)) await api.files.upload(path, f);
      await load(path);
    } catch (e) {
      error = e instanceof ApiError ? e.message : $t('files.uploadError');
    } finally {
      busy = false;
      if (fileInput) fileInput.value = '';
    }
  }

  async function newFolder() {
    const name = prompt($t('files.newFolderPrompt'));
    if (!name) return;
    busy = true;
    error = '';
    try {
      await api.files.mkdir(path, name);
      await load(path);
    } catch (e) {
      error = e instanceof ApiError ? e.message : $t('files.genericError');
    } finally {
      busy = false;
    }
  }

  function startRename(e: FileEntry) {
    renamingName = e.name;
    renameValue = e.name;
  }
  async function commitRename(e: FileEntry) {
    const name = renameValue.trim();
    renamingName = null;
    if (!name || name === e.name) return;
    busy = true;
    error = '';
    try {
      await api.files.rename(join(path, e.name), name);
      await load(path);
    } catch (err) {
      error = err instanceof ApiError ? err.message : $t('files.genericError');
    } finally {
      busy = false;
    }
  }

  async function remove(e: FileEntry) {
    if (!confirm($t('files.deleteConfirm', { name: e.name }))) return;
    busy = true;
    error = '';
    try {
      await api.files.remove(join(path, e.name));
      await load(path);
    } catch (err) {
      error = err instanceof ApiError ? err.message : $t('files.genericError');
    } finally {
      busy = false;
    }
  }

  function fmtSize(n: number): string {
    if (n <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
  }

  $: segments = path ? path.split('/').filter(Boolean) : [];
  function crumbPath(idx: number): string {
    return segments.slice(0, idx + 1).join('/');
  }
</script>

<div class="page">
  <header class="page-header" in:riseIn>
    <h1 class="page-title">{$t('files.title')}</h1>
    <p class="page-subtitle">{$t('files.subtitle')}</p>
  </header>

  <!-- Toolbar: breadcrumb + actions -->
  <div class="toolbar glass" in:riseIn={{ delay: 60 }}>
    <nav class="crumbs" aria-label="Breadcrumb">
      <button class="crumb" on:click={() => load('')} use:pressable>{$t('files.home')}</button>
      {#each segments as seg, i}
        <span class="crumb-sep" aria-hidden="true">/</span>
        {#if i === segments.length - 1}
          <span class="crumb crumb--current">{seg}</span>
        {:else}
          <button class="crumb" on:click={() => load(crumbPath(i))} use:pressable>{seg}</button>
        {/if}
      {/each}
    </nav>

    <div class="tools">
      <button class="tool-btn" on:click={newFolder} use:pressable disabled={busy}>
        <svg viewBox="0 0 18 18" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M2 5 Q2 4 3 4 H7 L8.5 6 H15 Q16 6 16 7 V13 Q16 14 15 14 H3 Q2 14 2 13 Z"/>
          <path d="M9 8.5 V12 M7.25 10.25 H10.75"/>
        </svg>
        {$t('files.newFolder')}
      </button>
      <button class="tool-btn tool-btn--primary" on:click={() => fileInput?.click()} use:pressable disabled={busy}>
        <svg viewBox="0 0 18 18" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 12 V3 M5.5 6.5 L9 3 L12.5 6.5 M3 12 V14 Q3 15 4 15 H14 Q15 15 15 14 V12"/>
        </svg>
        {busy ? $t('files.uploading') : $t('files.upload')}
      </button>
      <input
        bind:this={fileInput}
        type="file"
        multiple
        class="visually-hidden"
        on:change={(e) => doUpload((e.target as HTMLInputElement).files)}
      />
    </div>
  </div>

  {#if error}
    <p class="files-error" role="alert">{error}</p>
  {/if}

  <!-- Listing -->
  <div class="listing glass" in:riseIn={{ delay: 120 }}>
    {#if loading}
      <div class="empty-row">{$t('files.loading')}</div>
    {:else if entries.length === 0}
      <div class="empty-row">{$t('files.empty')}</div>
    {:else}
      {#each entries as e (e.name)}
        <div class="row" class:row--dir={e.is_dir}>
          <button class="row-main" on:click={() => openEntry(e)} use:pressable>
            <span class="row-icon" aria-hidden="true">
              {#if e.is_dir}
                <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor"><path d="M2 5.5 Q2 4.5 3 4.5 H7.5 L9 6.5 H17 Q18 6.5 18 7.5 V15 Q18 16 17 16 H3 Q2 16 2 15 Z"/></svg>
              {:else}
                <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5 2.5 H12 L16 6.5 V17 Q16 17.5 15.5 17.5 H4.5 Q4 17.5 4 17 V3.5 Q4 2.5 5 2.5 Z M12 2.5 V6.5 H16"/></svg>
              {/if}
            </span>
            {#if renamingName === e.name}
              <input
                class="rename-input"
                bind:value={renameValue}
                on:click|stopPropagation
                on:keydown={(ev) => { if (ev.key === 'Enter') commitRename(e); if (ev.key === 'Escape') renamingName = null; }}
                on:blur={() => commitRename(e)}
                aria-label={$t('files.rename')}
                autofocus
              />
            {:else}
              <span class="row-name">{e.name}</span>
            {/if}
          </button>

          <span class="row-size">{e.is_dir ? '' : fmtSize(e.size)}</span>

          <div class="row-actions">
            {#if !e.is_dir}
              <button class="row-act" on:click|stopPropagation={() => download(e)} use:pressable aria-label={$t('files.download')} title={$t('files.download')}>
                <svg viewBox="0 0 18 18" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3 V11 M5.5 7.5 L9 11 L12.5 7.5 M3.5 14.5 H14.5"/></svg>
              </button>
            {/if}
            <button class="row-act" on:click|stopPropagation={() => startRename(e)} use:pressable aria-label={$t('files.rename')} title={$t('files.rename')}>
              <svg viewBox="0 0 18 18" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 3.5 L14.5 6.5 M3 12 L11 4 L14 7 L6 15 H3 Z"/></svg>
            </button>
            <button class="row-act row-act--danger" on:click|stopPropagation={() => remove(e)} use:pressable aria-label={$t('actions.uninstall')} title={$t('files.delete')}>
              <svg viewBox="0 0 18 18" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 5 H14 M7 5 V3.5 H11 V5 M5.5 5 L6 14.5 H12 L12.5 5"/></svg>
            </button>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .page { max-width: 56rem; margin: 0 auto; }
  .page-header { margin-block-end: 1.5rem; }
  .page-title {
    font-family: var(--font-display);
    font-size: 1.75rem;
    font-weight: 600;
    color: var(--color-ink);
    margin: 0 0 0.375rem;
    letter-spacing: -0.02em;
  }
  .page-subtitle { font-size: 0.9375rem; color: var(--color-ink-muted); margin: 0; }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 0.75rem 1rem;
    margin-block-end: 1rem;
  }
  .crumbs { display: flex; align-items: center; gap: 0.25rem; flex-wrap: wrap; min-width: 0; }
  .crumb {
    border: none;
    background: transparent;
    color: var(--color-ink-muted);
    font-size: 0.875rem;
    font-family: inherit;
    cursor: pointer;
    padding: 0.125rem 0.375rem;
    border-radius: 0.375rem;
  }
  .crumb:hover { color: var(--color-primary); background: var(--color-surface-hover); }
  .crumb--current { color: var(--color-ink); font-weight: 600; }
  .crumb-sep { color: var(--color-ink-faint); }

  .tools { display: flex; gap: 0.5rem; flex-shrink: 0; }
  .tool-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.4375rem 0.75rem;
    border-radius: var(--radius-button);
    border: 1px solid var(--glass-border);
    background: var(--glass-bg-inset);
    color: var(--color-ink);
    font-size: 0.8125rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .tool-btn:hover:not(:disabled) { background: var(--color-surface-hover); }
  .tool-btn--primary {
    background: var(--color-btn);
    color: var(--color-on-primary);
    border-color: transparent;
  }
  .tool-btn--primary:hover:not(:disabled) { background: var(--color-btn-hover); }
  .tool-btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .files-error {
    margin: 0 0 1rem;
    padding: 0.625rem 0.875rem;
    border-radius: var(--radius-button);
    border: 1px solid color-mix(in srgb, var(--color-danger) 30%, transparent);
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
    color: var(--color-danger);
    font-size: 0.875rem;
  }

  .listing { padding: 0.375rem; overflow: hidden; }
  .empty-row { padding: 2rem; text-align: center; color: var(--color-ink-muted); font-size: 0.9375rem; }

  .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.375rem 0.5rem;
    border-radius: 0.5rem;
  }
  .row:hover { background: var(--color-surface-hover); }
  .row-main {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--color-ink);
    font-size: 0.9375rem;
    font-family: inherit;
    text-align: start;
    cursor: pointer;
    padding: 0.25rem;
  }
  .row-icon { display: flex; flex-shrink: 0; color: var(--color-ink-muted); }
  .row--dir .row-icon { color: var(--color-primary); }
  .row-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rename-input {
    flex: 1;
    min-width: 0;
    padding: 0.125rem 0.375rem;
    border-radius: 0.375rem;
    border: 1px solid var(--color-primary);
    background: var(--glass-bg-inset);
    color: var(--color-ink);
    font-size: 0.9375rem;
    font-family: inherit;
    outline: none;
  }
  .row-size {
    flex-shrink: 0;
    font-size: 0.8125rem;
    color: var(--color-ink-muted);
    min-width: 4.5rem;
    text-align: end;
  }
  .row-actions { display: flex; gap: 0.125rem; flex-shrink: 0; opacity: 0; transition: opacity 0.15s ease; }
  .row:hover .row-actions,
  .row:focus-within .row-actions { opacity: 1; }
  .row-act {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.875rem;
    height: 1.875rem;
    border-radius: 0.4375rem;
    border: none;
    background: transparent;
    color: var(--color-ink-muted);
    cursor: pointer;
  }
  .row-act:hover { color: var(--color-ink); background: var(--color-surface-hover); }
  .row-act--danger:hover { color: var(--color-danger); }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  @media (max-width: 560px) {
    .row-actions { opacity: 1; }
    .row-size { display: none; }
  }
</style>
