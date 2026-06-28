// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A small glass clock for the dashboard's top bar. Honors the user's 12/24-hour
 * and time-zone preferences (Settings → Customize). Display-only — never used
 * for prayer times (that's an app concern, CLAUDE.md §13).
 */
import { useEffect, useRef, useState } from 'react';
import { usePrefs } from '../lib/prefs';
import { ambient } from '../lib/ambient';

function format(now: Date, clock24h: boolean, tz: string): { time: string; date: string } {
  const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12: !clock24h };
  const dateOpts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  try {
    const zone = tz || undefined;
    return {
      time: new Intl.DateTimeFormat(undefined, { ...timeOpts, timeZone: zone }).format(now),
      date: new Intl.DateTimeFormat(undefined, { ...dateOpts, timeZone: zone }).format(now),
    };
  } catch {
    // Invalid/unknown time zone → fall back to the device's local zone.
    return {
      time: new Intl.DateTimeFormat(undefined, timeOpts).format(now),
      date: new Intl.DateTimeFormat(undefined, dateOpts).format(now),
    };
  }
}

export function Clock() {
  const prefs = usePrefs();
  const [now, setNow] = useState(() => new Date());
  // Rapid taps on the clock toggle the optional ambient scene (a quiet extra).
  const taps = useRef<number[]>([]);

  useEffect(() => {
    if (!prefs.showClock) return;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [prefs.showClock]);

  if (!prefs.showClock) return null;
  const { time, date } = format(now, prefs.clock24h, prefs.timezone);

  function onTap() {
    const t = Date.now();
    taps.current = taps.current.filter((p) => t - p < 3000).concat(t);
    if (taps.current.length >= 15) {
      taps.current = [];
      ambient.toggle();
    }
  }

  return (
    <div className="clock-widget glass-raised" role="group" aria-label="Clock" onClick={onTap}>
      <span className="clock-time">{time}</span>
      <span className="clock-date">{date}</span>
    </div>
  );
}
