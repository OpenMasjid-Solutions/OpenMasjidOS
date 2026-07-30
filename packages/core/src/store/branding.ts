// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Masjid branding — the logo the admin uploads once in Settings, reused across the
 * masjid's outbound communications: OS-sent emails (alerts + the test message) embed
 * it inline, notification webhooks (Slack/Discord) show it as the sender avatar, and
 * apps can pull it over the Fabric to brand their own receipts.
 *
 * We store the RAW bytes on disk (not a data URI in settings.json) because email
 * needs them for a CID inline attachment and the public endpoint streams them. Only
 * raster formats are accepted (PNG/JPG/WebP): email clients render those reliably,
 * and refusing SVG sidesteps SVG-borne script entirely.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { readJson, writeJson, ensureDir } from '../util/json-store';
import { imageSize } from '../util/image-size';

const BRANDING_DIR = path.join(CONFIG_DIR, 'branding');
const META_PATH = path.join(BRANDING_DIR, 'branding.json');

/** Accepted logo MIME types → file extension. Raster only (see file header). */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
export const ALLOWED_LOGO_MIME = Object.keys(MIME_EXT);
export const MAX_LOGO_BYTES = 1024 * 1024; // 1 MB — plenty for a logo, keeps email light

interface BrandingMeta {
  logo?: { ext: string; mime: string };
}

function readMeta(): BrandingMeta {
  return readJson<BrandingMeta>(META_PATH, {});
}

/** Is the given MIME type an accepted logo format? */
export function isAllowedLogoMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(MIME_EXT, mime);
}

/** True when a logo has been uploaded. */
export function hasLogo(): boolean {
  const m = readMeta();
  return Boolean(m.logo && fs.existsSync(path.join(BRANDING_DIR, `logo.${m.logo.ext}`)));
}

/** The stored logo's bytes + MIME, or null if none set. */
export function getLogo(): { buf: Buffer; mime: string; ext: string } | null {
  const m = readMeta();
  if (!m.logo) return null;
  try {
    const buf = fs.readFileSync(path.join(BRANDING_DIR, `logo.${m.logo.ext}`));
    return { buf, mime: m.logo.mime, ext: m.logo.ext };
  } catch {
    return null;
  }
}

/**
 * The stored logo's pixel dimensions, or null if there is no logo or its header
 * can't be read. Used to size the logo in emails with exact width/height
 * attributes — Outlook ignores max-width/max-height, so an aspect-correct fit has
 * to be computed rather than delegated to CSS (notify/email.ts `logoTag`).
 */
export function getLogoSize(): { width: number; height: number } | null {
  const logo = getLogo();
  return logo ? imageSize(logo.buf, logo.mime) : null;
}

/** Persist a new logo (replacing any previous one). Caller validates size + MIME. */
export function saveLogo(buf: Buffer, mime: string): void {
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error('Unsupported logo format.');
  ensureDir(BRANDING_DIR);
  // Drop any previous logo file first so a format change can't leave two behind.
  for (const e of Object.values(MIME_EXT)) {
    fs.rmSync(path.join(BRANDING_DIR, `logo.${e}`), { force: true });
  }
  const file = path.join(BRANDING_DIR, `logo.${ext}`);
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
  writeJson(META_PATH, { logo: { ext, mime } } satisfies BrandingMeta);
}

/** Remove the logo, if any. */
export function removeLogo(): void {
  for (const e of Object.values(MIME_EXT)) {
    fs.rmSync(path.join(BRANDING_DIR, `logo.${e}`), { force: true });
  }
  writeJson(META_PATH, {} satisfies BrandingMeta);
}
