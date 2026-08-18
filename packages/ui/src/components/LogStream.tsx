// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Streams plain-text lines from a core WebSocket into a scrolling log view.
 * Used by the live updater (and reusable for other long-running actions).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { withKey } from '../lib/session';

// Keep the buffer bounded so a chatty, long-running stream can't grow the DOM
// (and memory) without limit. We trim from the front, keeping the visible tail.
const MAX_CHARS = 200_000;
const MAX_LINES = 1000;

function trimBuffer(s: string): string {
  let out = s;
  if (out.length > MAX_CHARS) out = out.slice(out.length - MAX_CHARS);
  const nl = out.length - 1;
  let count = 0;
  for (let i = nl; i >= 0; i--) {
    if (out.charCodeAt(i) === 10 /* \n */) {
      count++;
      if (count > MAX_LINES) return out.slice(i + 1);
    }
  }
  return out;
}

export function LogStream({ wsPath, onClosed }: { wsPath: string; onClosed?: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLPreElement>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The handshake can't carry a header, so the dashboard key rides in ?k=.
    const ws = new WebSocket(`${proto}//${window.location.host}${withKey(wsPath)}`);

    // Coalesce a burst of messages into one state update per frame, so a flood
    // of lines doesn't trigger a render (and reflow) per message.
    let pending = '';
    let raf = 0;
    const flush = () => {
      raf = 0;
      const chunk = pending;
      pending = '';
      setText((t) => trimBuffer(t + chunk));
    };
    ws.onmessage = (e) => {
      pending += String(e.data);
      if (!raf) raf = requestAnimationFrame(flush);
    };
    ws.onclose = () => onClosed?.();
    return () => {
      if (raf) cancelAnimationFrame(raf);
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
      {text || t('common.starting')}
    </pre>
  );
}
