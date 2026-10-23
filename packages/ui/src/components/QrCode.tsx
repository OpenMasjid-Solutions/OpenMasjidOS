// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Draws a QR module grid, as produced by the core's `auth/qr.ts`.
 *
 * The grid arrives as DATA — a size and a string of bits — so nothing here is
 * injected as HTML. There is no `dangerouslySetInnerHTML` anywhere near the
 * sign-in flow, and the component can be handed a grid from anywhere without
 * that being a question anyone has to think about.
 *
 * Drawn as ONE path rather than a few hundred rects: each row becomes a run of
 * horizontal segments, which keeps the DOM small enough that a 45x45 code does
 * not put two thousand nodes on the page.
 */

/** Structurally the core's `QrMatrix`. Kept local so a presentational component
 *  does not depend on the server package for a shape this simple. */
export interface QrGrid {
  size: number;
  /** Row-major, '1' = dark, length size x size. */
  modules: string;
}

/**
 * The quiet zone, in modules. Four is what the spec requires: without it a
 * scanner cannot find the code's edge against whatever is behind it, and the
 * usual symptom is "it works on my phone but not on theirs".
 */
const QUIET = 4;

function toPath(grid: QrGrid): string {
  const { size, modules } = grid;
  let d = '';
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (modules[row * size + col] !== '1') {
        col++;
        continue;
      }
      let run = 1;
      while (col + run < size && modules[row * size + col + run] === '1') run++;
      d += `M${col},${row}h${run}v1h${-run}Z`;
      col += run;
    }
  }
  return d;
}

export function QrCode({
  grid,
  size = 232,
  label,
}: {
  grid: QrGrid;
  /** Rendered size in px. Responsive down to the container width. */
  size?: number;
  label: string;
}) {
  const span = grid.size + QUIET * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-QUIET} ${-QUIET} ${span} ${span}`}
      width={size}
      height={size}
      style={{ width: '100%', maxWidth: `${size}px`, height: 'auto', display: 'block', borderRadius: 'var(--radius-button)' }}
      /* Without this, browsers antialias the module edges and a dense grid turns
         into grey mush at small sizes — which reads to a scanner as noise. */
      shapeRendering="crispEdges"
    >
      {/*
        BLACK ON WHITE IN BOTH THEMES, DELIBERATELY, and not a theme token.
        A QR code is read by contrast between dark and light modules; a scanner
        is not guaranteed to handle an inverted one, and on the dark theme a
        token-coloured code would be near-invisible to a camera. These are not
        colours in the design sense — they are part of the encoding — so a
        token here would invite someone to theme it and quietly break scanning.
      */}
      <rect x={-QUIET} y={-QUIET} width={span} height={span} fill="white" />
      <path d={toPath(grid)} fill="black" />
    </svg>
  );
}
