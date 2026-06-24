/**
 * An xterm.js terminal wired to a core WebSocket terminal endpoint. Used for
 * the root shell and per-app shells (both gated server-side).
 */
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { withKey } from '../lib/session';

export function Terminal({ wsPath }: { wsPath: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#02060f', foreground: '#E0F2FE' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The handshake can't carry a header, so the dashboard key rides in ?k=.
    const ws = new WebSocket(`${proto}//${window.location.host}${withKey(wsPath)}`);
    ws.binaryType = 'arraybuffer';

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ __resize: [term.cols, term.rows] }));
      }
    };

    ws.onopen = () => {
      sendResize();
      term.focus();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') term.write(ev.data);
      else term.write(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = () => term.write('\r\n\x1b[2m[session closed]\x1b[0m\r\n');

    const onData = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    });

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        /* element not measurable yet */
      }
      sendResize();
    };
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(() => onResize());
    ro.observe(el);

    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      onData.dispose();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
  }, [wsPath]);

  return <div ref={ref} className="glass-inset" style={{ width: '100%', height: '60vh', padding: '0.5rem' }} />;
}
