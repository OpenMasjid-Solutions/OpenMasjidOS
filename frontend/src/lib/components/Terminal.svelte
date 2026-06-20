<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from '$lib/i18n';

  // wsPath e.g. '/api/apps/<id>/terminal' or '/api/terminal/root'.
  let { wsPath, title, onClose }: { wsPath: string; title: string; onClose: () => void } =
    $props();

  let termEl: HTMLDivElement;
  let ws: WebSocket | undefined;
  // xterm types are loaded dynamically; `any` keeps the heavy lib out of the
  // main bundle without pulling its type graph into this component.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let term: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fit: any;
  let status = $state<'connecting' | 'open' | 'closed'>('connecting');

  onMount(() => {
    let disposed = false;
    const enc = new TextEncoder();

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/xterm/css/xterm.css'),
      ]);
      if (disposed) return;

      term = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        cursorBlink: true,
        theme: { background: '#02060d', foreground: '#e0f2fe', cursor: '#22d3ee' },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(termEl);
      fit.fit();

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}${wsPath}`);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        status = 'open';
        sendResize();
        term.focus();
      };
      ws.onmessage = (e: MessageEvent) => {
        if (typeof e.data === 'string') term.write(e.data);
        else term.write(new Uint8Array(e.data));
      };
      ws.onclose = () => {
        status = 'closed';
        term?.write('\r\n\x1b[2m— session closed —\x1b[0m\r\n');
      };
      ws.onerror = () => { status = 'closed'; };

      term.onData((d: string) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
      });

      window.addEventListener('resize', handleResize);
    })();

    return () => {
      disposed = true;
    };
  });

  function sendResize() {
    if (ws?.readyState === WebSocket.OPEN && term) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }
  function handleResize() {
    try {
      fit?.fit();
      sendResize();
    } catch {
      /* terminal may not be ready yet */
    }
  }

  onDestroy(() => {
    window.removeEventListener('resize', handleResize);
    ws?.close();
    term?.dispose();
  });
</script>

<svelte:window on:keydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<div class="term-overlay" role="dialog" aria-modal="true" aria-label={title}>
  <div class="term-window glass-raised">
    <div class="term-bar">
      <span
        class="term-dot"
        class:term-dot--open={status === 'open'}
        class:term-dot--closed={status === 'closed'}
        aria-hidden="true"
      ></span>
      <span class="term-title">{title}</span>
      <button class="term-close" on:click={onClose} aria-label={$t('actions.close')}>✕</button>
    </div>
    <div class="term-body" bind:this={termEl}></div>
  </div>
</div>

<style>
  .term-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: rgba(0, 0, 0, 0.6);
  }
  .term-window {
    width: 100%;
    max-width: 60rem;
    height: min(80vh, 40rem);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: var(--shadow-modal), var(--glass-shadow-raised);
  }
  .term-bar {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 0.875rem;
    border-block-end: 1px solid var(--glass-border);
    flex-shrink: 0;
  }
  .term-dot {
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 50%;
    background: var(--color-warning);
    flex-shrink: 0;
  }
  .term-dot--open { background: var(--color-success); }
  .term-dot--closed { background: var(--color-danger); }
  .term-title {
    flex: 1;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-ink);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .term-close {
    border: none;
    background: transparent;
    color: var(--color-ink-muted);
    font-size: 1rem;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    line-height: 1;
  }
  .term-close:hover { color: var(--color-ink); background: var(--color-surface-hover); }
  .term-body {
    flex: 1;
    min-height: 0;
    padding: 0.5rem;
    background: #02060d;
  }
</style>
