/** Helpers for the file explorer's streaming endpoints (download/upload). */
import { getCsrf, withKey } from './session';

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
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`/api/files/upload?path=${encodeURIComponent(dir)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'x-omos-csrf': getCsrf() },
    body: fd,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: 'Upload failed' }))) as { error?: string };
    throw new Error(body.error ?? 'Upload failed');
  }
}

/** Join a directory path with a child name. */
export function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

/** Parent directory of a path ("/a/b" → "/a", "/a" → "/"). */
export function parentPath(p: string): string {
  if (p === '/' || !p.includes('/')) return '/';
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}
