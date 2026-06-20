/**
 * Sandboxed file manager. Everything is confined to the data directory; path
 * traversal (../) and symlink-escape are both rejected, so the browser can
 * never reach outside /data (CLAUDE.md §15 — validate all external input).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config';

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

export class FileError extends Error {
  constructor(
    message: string,
    public code:
      | 'OUTSIDE'
      | 'NOT_FOUND'
      | 'IS_DIR'
      | 'NOT_DIR'
      | 'EXISTS'
      | 'BAD_NAME'
      | 'TOO_LARGE'
      | 'BINARY',
  ) {
    super(message);
  }
}

const ROOT = path.resolve(DATA_DIR);

/** Largest file we'll load into the in-browser text editor (2 MiB). */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function within(p: string): boolean {
  return p === ROOT || p.startsWith(ROOT + path.sep);
}

/** Resolve a relative path inside the sandbox. Containment is always enforced;
 *  symlink targets are re-checked when the path exists. */
function resolve(rel: string): string {
  const cleaned = path.posix.normalize('/' + String(rel ?? '').replace(/\\/g, '/'));
  const full = path.join(ROOT, cleaned);
  if (!within(full)) throw new FileError('Path is outside the allowed area.', 'OUTSIDE');
  try {
    const real = fs.realpathSync(full);
    if (!within(real)) throw new FileError('Path is outside the allowed area.', 'OUTSIDE');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return full;
}

/** A safe single path segment (no separators, no traversal). */
function safeName(name: string): string {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/').trim());
  if (!base || base === '.' || base === '..' || base.includes('/')) {
    throw new FileError('That name is not allowed.', 'BAD_NAME');
  }
  return base;
}

/** The relative path (for display), always starting with "/". */
function relOf(full: string): string {
  const rel = path.relative(ROOT, full).split(path.sep).join('/');
  return '/' + rel;
}

export function listDir(rel: string): { path: string; entries: FileEntry[] } {
  const full = resolve(rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    throw new FileError('That folder does not exist.', 'NOT_FOUND');
  }
  if (!stat.isDirectory()) throw new FileError('That is a file, not a folder.', 'NOT_DIR');

  const entries: FileEntry[] = [];
  for (const name of fs.readdirSync(full)) {
    try {
      const s = fs.statSync(path.join(full, name));
      entries.push({ name, isDir: s.isDirectory(), size: s.size, modified: s.mtime.toISOString() });
    } catch {
      /* skip entries we can't stat */
    }
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { path: relOf(full) === '/.' ? '/' : relOf(full), entries };
}

export function makeDir(relDir: string, name: string): void {
  const dir = resolve(relDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new FileError('That folder does not exist.', 'NOT_FOUND');
  }
  const target = path.join(dir, safeName(name));
  if (!within(target)) throw new FileError('Path is outside the allowed area.', 'OUTSIDE');
  if (fs.existsSync(target)) throw new FileError('Something with that name already exists.', 'EXISTS');
  fs.mkdirSync(target);
}

export function renameEntry(rel: string, newName: string): void {
  const full = resolve(rel);
  if (full === ROOT) throw new FileError('That item cannot be renamed.', 'BAD_NAME');
  if (!fs.existsSync(full)) throw new FileError('That item does not exist.', 'NOT_FOUND');
  const target = path.join(path.dirname(full), safeName(newName));
  if (!within(target)) throw new FileError('Path is outside the allowed area.', 'OUTSIDE');
  if (fs.existsSync(target)) throw new FileError('Something with that name already exists.', 'EXISTS');
  fs.renameSync(full, target);
}

export function removeEntry(rel: string): void {
  const full = resolve(rel);
  if (full === ROOT) throw new FileError('The root folder cannot be deleted.', 'BAD_NAME');
  if (!fs.existsSync(full)) throw new FileError('That item does not exist.', 'NOT_FOUND');
  fs.rmSync(full, { recursive: true, force: true });
}

/** Resolve a file for download (must exist and be a regular file). */
export function resolveFile(rel: string): { full: string; name: string } {
  const full = resolve(rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    throw new FileError('That file does not exist.', 'NOT_FOUND');
  }
  if (stat.isDirectory()) throw new FileError('That is a folder, not a file.', 'IS_DIR');
  return { full, name: path.basename(full) };
}

/** Resolve a directory to upload into (must exist and be a directory). */
export function resolveUploadDir(relDir: string): string {
  const dir = resolve(relDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new FileError('That folder does not exist.', 'NOT_FOUND');
  }
  return dir;
}

export function uploadPath(relDir: string, name: string): string {
  return path.join(resolveUploadDir(relDir), safeName(name));
}

/** Read a small text file for the in-browser editor. Rejects directories,
 *  oversized files, and binary content (NUL bytes). */
export function readTextFile(rel: string): { content: string } {
  const full = resolve(rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    throw new FileError('That file does not exist.', 'NOT_FOUND');
  }
  if (stat.isDirectory()) throw new FileError('That is a folder, not a file.', 'IS_DIR');
  if (stat.size > MAX_TEXT_BYTES) {
    throw new FileError('That file is too large to open in the editor.', 'TOO_LARGE');
  }
  const buf = fs.readFileSync(full);
  if (buf.includes(0)) {
    throw new FileError("That looks like a binary file, so it can't be edited as text.", 'BINARY');
  }
  return { content: buf.toString('utf8') };
}

/** Save text back to a file. The parent folder must already exist; the path is
 *  always confined to the sandbox.
 *
 *  Security: we resolve the PARENT directory (which exists, so resolve() applies
 *  the realpath/symlink check), then attach the safe basename. Resolving the
 *  file path directly would skip the symlink check for a not-yet-existing file,
 *  letting a symlinked parent (e.g. planted by a malicious app/backup) redirect
 *  the write outside the sandbox. We also refuse to follow a symlink target that
 *  escapes, and never overwrite a directory. */
export function writeTextFile(rel: string, content: string): void {
  if (typeof content !== 'string') throw new FileError('Nothing to save.', 'BAD_NAME');
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) {
    throw new FileError('That file is too large to save from the editor.', 'TOO_LARGE');
  }

  const cleaned = path.posix.normalize('/' + String(rel ?? '').replace(/\\/g, '/'));
  const base = path.posix.basename(cleaned);
  if (!base || base === '.' || base === '..') throw new FileError('That item cannot be edited.', 'BAD_NAME');

  // resolve() the parent: it exists, so its realpath is verified inside ROOT.
  const dir = resolve(path.posix.dirname(cleaned));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new FileError('That folder does not exist.', 'NOT_FOUND');
  }

  const full = path.join(dir, safeName(base));
  if (!within(full)) throw new FileError('Path is outside the allowed area.', 'OUTSIDE');

  if (fs.existsSync(full)) {
    const st = fs.lstatSync(full);
    if (st.isDirectory()) throw new FileError('That is a folder, not a file.', 'IS_DIR');
    if (st.isSymbolicLink()) {
      // Don't write through a symlink that points outside the sandbox.
      const real = fs.realpathSync(full);
      if (!within(real)) throw new FileError('Path is outside the allowed area.', 'OUTSIDE');
    }
  }

  fs.writeFileSync(full, content, 'utf8');
}

/** Content-type for inline viewing of known media. Anything not listed is
 *  served as a safe download type by the caller. */
const RAW_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
};

export function rawMime(name: string): string | null {
  return RAW_MIME[path.extname(name).toLowerCase()] ?? null;
}
