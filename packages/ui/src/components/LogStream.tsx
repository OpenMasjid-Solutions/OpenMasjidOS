/**
 * Streams plain-text lines from a core WebSocket into a scrolling log view.
 * Used by the live updater (and reusable for other long-running actions).
 */
import { useEffect, useRef, useState } from 'react';
import { withKey } from '../lib/session';

export function LogStream({ wsPath, onClosed }: { wsPath: string; onClosed?: () => void }) {
  const ref = useRef<HTMLPreElement>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The handshake can't carry a header, so the dashboard key rides in ?k=.
    const ws = new WebSocket(`${proto}//${window.location.host}${withKey(wsPath)}`);
    ws.onmessage = (e) => setText((t) => t + String(e.data));
    ws.onclose = () => onClosed?.();
    return () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsPath]);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <pre ref={ref} className="logs glass-inset" style={{ minHeight: '14rem' }}>
      {text || 'Starting…'}
    </pre>
  );
}
