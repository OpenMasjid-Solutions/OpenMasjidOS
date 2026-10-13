// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Helpers for the file explorer's streaming endpoints (download/upload). */
import { getCsrf, withKey } from './session';
import { isRemoteSession } from './apps';
import { ShownError } from './errors';

/**
 * The largest request Cloudflare's free plan carries through the tunnel. From outside the
 * masjid nothing larger can be uploaded at all — Cloudflare answers with its own error
 * page — so the dashboard says so up front instead of "Something went wrong".
 */
export const REMOTE_UPLOAD_LIMIT = 100 * 1024 * 1024;

/** Thrown for a file that cannot be sent from outside the masjid. */
export class TooBigFromOutside extends Error {}

export function filesDownloadUrl(p: string): string {
  return withKey(`/api/files/download?path=${encodeURIComponent(p)}`);
}

/** Inline-viewable URL for images/video/audio (see /api/files/raw). */
export function filesRawUrl(p: string): string {
  return withKey(`/api/files/raw?path=${encodeURIComponent(p)}`);
}

export type FileKind = 'image' | 'video' | 'audio' | 'text';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg']);

/** How a file should be opened in the file manager (by extension). */
export function fileKind(name: string): FileKind {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'text';
}

export async function uploadFile(dir: string, file: File): Promise<void> {
  if (isRemoteSession() && file.size > REMOTE_UPLOAD_LIMIT) throw new TooBigFromOutside();
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`/api/files/upload?path=${encodeURIComponent(dir)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'x-omos-csrf': getCsrf() },
    body: fd,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    // Not our answer: Cloudflare's own page, almost always its size limit.
    if (!body && isRemoteSession() && res.status === 413) throw new TooBigFromOutside();
    // Our server's own words when it sent some; an empty message lets the caller say it
    // in the dashboard's own words. A connection that failed outright never gets here —
    // the caller shows its fallback for that (lib/errors.ts).
    throw new ShownError(body?.error ?? '');
  }
}

/** Join a directory path with a child name. */
export function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

