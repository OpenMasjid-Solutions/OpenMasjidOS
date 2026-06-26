// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Custom masjid glyph set, used as the brand mark and empty-state art
 * (CLAUDE.md §14 motifs). No sacred text — geometric/architectural motifs only.
 *
 * MasjidMark is the OpenMasjid crescent-and-dome logo, drawn in `currentColor`
 * so it adapts to the theme (dark/light) at any size. Clip-path IDs are made
 * unique per instance with useId() so the mark can render many times on a page
 * (dock + login + splash) without duplicate-id collisions.
 */
import { useId } from 'react';

interface GlyphProps {
  size?: number;
  className?: string;
}

/** Crescent cradling a domed masjid + star — the OpenMasjid mark. */
export function MasjidMark({ size = 28, className }: GlyphProps) {
  const uid = useId();
  const moon = `omos-moon-${uid}`;
  const accent = `omos-accent-${uid}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={moon}><circle cx="50" cy="50" r="46" /></clipPath>
        <clipPath id={accent}><circle cx="45" cy="32" r="6.5" /></clipPath>
      </defs>
      {/* Crescent, opening to the right (clip removes the inner circle's overhang) */}
      <path
        clipPath={`url(#${moon})`}
        fillRule="evenodd"
        d="M50 4a46 46 0 1 0 0 92 46 46 0 1 0 0-92ZM66 12a38 38 0 1 1 0 76 38 38 0 1 1 0-76Z"
      />
      {/* Accent crescent + star, nestled in the cradle */}
      <path
        clipPath={`url(#${accent})`}
        fillRule="evenodd"
        d="M45 25.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13ZM48 24a5 5 0 1 1 0 10 5 5 0 1 1 0-10Z"
      />
      <path d="M50 25.2L50.94 27.71L53.61 27.83L51.52 29.49L52.23 32.07L50 30.6L47.77 32.07L48.48 29.49L46.39 27.83L49.06 27.71Z" />
      {/* Masjid: finial + onion dome */}
      <path d="M64 22.5l1.7 3.8-3.4 0z" />
      <circle cx="64" cy="20.6" r="1.7" />
      <path d="M64 28c-6.1 0-10 4.7-10 10.4 0 3.3 1.8 6.1 4.5 7.6h11c2.7-1.5 4.5-4.3 4.5-7.6C74 32.7 70.1 28 64 28Z" />
      {/* Base + ledge */}
      <path d="M56 49.5h16v18.5H56z" />
      <path d="M53 47h22v3.2H53z" />
      {/* Smaller dome to the left */}
      <path d="M43 40.5c-5.5 0-9.2 4.3-9.2 10.2V68h18.4V50.7C52.2 44.8 48.5 40.5 43 40.5Z" />
    </svg>
  );
}

/** Minaret-and-dome empty-state illustration. */
export function MasjidScene({ size = 96, className }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth="2" fill="none" opacity="0.9">
        <path d="M40 70c0-14 9-22 20-22s20 8 20 22" />
        <rect x="34" y="70" width="52" height="34" rx="2" />
        <path d="M52 104V88a8 8 0 0 1 16 0v16" />
        <rect x="20" y="56" width="10" height="48" rx="2" />
        <path d="M25 50a5 5 0 0 1 0 10" />
        <rect x="90" y="56" width="10" height="48" rx="2" />
        <path d="M95 50a5 5 0 0 1 0 10" />
      </g>
      <circle cx="60" cy="34" r="4" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.7" />
    </svg>
  );
}
