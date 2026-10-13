// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Masjid branding — the logo the admin uploads once in Settings, reused across the
 * masjid's outbound communications: OS-sent emails (alerts + the test message) and
 * notification webhooks (Slack/Discord) link it from /api/public/logo — only when
 * remote access is set up, since the mail or chat service fetches it from its own
 * network — and apps can pull it over the Fabric to brand their own receipts.
 *
 * We store the RAW bytes on disk (not a data URI in settings.json) because the public
 * endpoint serves them and emails size the logo from its header. Only raster formats
 * are accepted (PNG/JPG/WebP): email clients render those reliably, and refusing SVG
 * sidesteps SVG-borne script entirely.
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
export const MAX_LOGO_BYTES = 1024 * 1024; // 1 MB — plenty for a logo, keeps email light

interface BrandingMeta {
  logo?: { ext: string; mime: string };
}

interface Logo {
  buf: Buffer;
  mime: string;
  ext: string;
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
  return getLogo() !== null;
}

function readLogo(): Logo | null {
  const m = readMeta();
  if (!m.logo) return null;
  try {
    const buf = fs.readFileSync(path.join(BRANDING_DIR, `logo.${m.logo.ext}`));
    return { buf, mime: m.logo.mime, ext: m.logo.ext };
  } catch {
    return null;
  }
}

/** The logo as last read, with the identity of branding.json it was read under. */
let memo: { stamp: string; logo: Logo } | null = null;

/** Identity of branding.json on disk. A restore replaces config/, so it changes this. */
function stampOf(): string {
  try {
    const st = fs.statSync(META_PATH);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return 'unreadable';
  }
}

/**
 * The stored logo's bytes + MIME, or null if none set. A public route serves it (and the
 * root icons), so it costs one stat; the files are read again only when they changed.
 */
export function getLogo(): Logo | null {
  const stamp = stampOf();
  if (memo?.stamp === stamp) return memo.logo;
  const logo = readLogo();
  // Only a logo actually read is remembered: "none" or a failed read is asked again.
  memo = logo ? { stamp, logo } : null;
  return logo;
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

/** Write a private file through a temp file + rename, so a failed write leaves the old one. */
function writePrivateFile(file: string, buf: Buffer): void {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Persist a new logo (replacing any previous one). Caller validates size + MIME. */
export function saveLogo(buf: Buffer, mime: string): void {
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error('Unsupported logo format.');
  ensureDir(BRANDING_DIR);
  try {
    // The new file, then the record naming it, and only then the old file: a write that
    // fails part-way (a full SD card) leaves the previous logo working, not none at all.
    writePrivateFile(path.join(BRANDING_DIR, `logo.${ext}`), buf);
    writeJson(META_PATH, { logo: { ext, mime } } satisfies BrandingMeta);
    for (const e of Object.values(MIME_EXT)) {
      if (e !== ext) fs.rmSync(path.join(BRANDING_DIR, `logo.${e}`), { force: true });
    }
  } finally {
    memo = null;
  }
}

/** Remove the logo, if any. The record first, so a refused write removes nothing. */
export function removeLogo(): void {
  try {
    writeJson(META_PATH, {} satisfies BrandingMeta);
    for (const e of Object.values(MIME_EXT)) {
      fs.rmSync(path.join(BRANDING_DIR, `logo.${e}`), { force: true });
    }
  } finally {
    memo = null;
  }
}
