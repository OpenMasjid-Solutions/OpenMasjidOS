/**
 * Derive an accent colour from a custom wallpaper image so the dashboard's
 * highlights match the picture. Best-effort: it draws the image to a tiny canvas
 * and reads a saturation-weighted average. If the image host doesn't allow
 * cross-origin canvas reads (tainted canvas), it resolves null and the caller
 * keeps the chosen accent.
 */
export interface AccentColors {
  primary: string;
  hover: string;
  subtle: string;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');

export function deriveAccentFromImage(url: string): Promise<AccentColors | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      try {
        const n = 24;
        const canvas = document.createElement('canvas');
        canvas.width = n;
        canvas.height = n;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, n, n);
        const { data } = ctx.getImageData(0, 0, n, n); // throws if cross-origin tainted
        let r = 0;
        let g = 0;
        let b = 0;
        let w = 0;
        for (let i = 0; i < data.length; i += 4) {
          const R = data[i];
          const G = data[i + 1];
          const B = data[i + 2];
          if (data[i + 3] < 200) continue;
          const mx = Math.max(R, G, B);
          const mn = Math.min(R, G, B);
          const sat = mx === 0 ? 0 : (mx - mn) / mx;
          const weight = sat * sat + 0.04; // favour vivid pixels over greys
          r += R * weight;
          g += G * weight;
          b += B * weight;
          w += weight;
        }
        if (w === 0) return resolve(null);
        const [h, s, l] = rgbToHsl(r / w, g / w, b / w);
        // Normalize to a vibrant, readable accent regardless of the source.
        const S = Math.min(0.85, Math.max(0.5, s));
        const L = Math.min(0.62, Math.max(0.48, l));
        const [pr, pg, pb] = hslToRgb(h, S, L);
        const [hr, hg, hb] = hslToRgb(h, S, Math.min(0.74, L + 0.1));
        resolve({ primary: toHex(pr, pg, pb), hover: toHex(hr, hg, hb), subtle: `rgba(${pr}, ${pg}, ${pb}, 0.16)` });
      } catch {
        resolve(null); // tainted canvas — host didn't allow cross-origin reads
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
