// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Sandboxed file manager. Everything is confined to the data directory; path
 * traversal (../) and symlink-escape are both rejected, so the browser can
 * never reach outside /data (CLAUDE.md §15 — validate all external input).
 *
 * **Staying inside /data is not enough on its own** [OPENMASJIDOS-004]. The data
 * dir is also where the platform keeps its own control plane, so a sandbox that
 * allowed everything under it handed the dashboard two things it must never have:
 *
 *   1. **Every platform secret.** `config/` holds the admin password hash, the SMTP
 *      password / Resend key, the Stripe keys, the Cloudflare tunnel token and the
 *      TLS private key. The rest of the product deliberately never returns these to
 *      the client (the settings API reports only "is set" flags), and this read them
 *      out wholesale.
 *   2. **Host root, via the compose gate.** Every start/update path runs
 *      `docker compose -f apps/<id>/compose.yml up`, reading that file *from disk*.
 *      Rewriting it and pressing Start launches an arbitrary container — with
 *      `privileged: true` or the Docker socket mounted — without ever passing
 *      `apps/compose-validate.ts`, which `CLAUDE.md §15` designates the SOLE
 *      install-time gate. `meta.json` is the same class of problem: it carries each
 *      app's `ssoSecret` and its Fabric capability grants.
 *
 * So the rule is narrower than "inside /data": the explorer is for the masjid's
 * files, never for the platform's own state. `protectedReason()` is the single place
 * that decides, and EVERY entry point below asks it.
 *
 * Backup and restore are deliberately unaffected — they archive `config/` and
 * `apps/` directly (`system/backup.ts`, `system/restore.ts`) and import nothing from
 * this module, so the guard cannot reach them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, CONFIG_DIR, APPS_DIR } from '../config';

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
  /** True for platform-owned state the explorer won't open or change. The UI shows
   *  it as locked rather than offering actions that would fail. */
  protected?: boolean;
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
      | 'BINARY'
      | 'PROTECTED',
  ) {
    super(message);
  }
}

const ROOT = path.resolve(DATA_DIR);
const CONFIG_ROOT = path.resolve(CONFIG_DIR);
const APPS_ROOT = path.resolve(APPS_DIR);
/** Where system/backup.ts stages volume archives while a backup runs. */
const STAGING_ROOT = path.join(ROOT, '.backup-staging');

/**
 * Files the platform itself owns inside each `apps/<id>/`. Names are matched
 * case-insensitively: only the exact lowercase spellings are load-bearing on Linux,
 * but a case-insensitive filesystem (a dev Mac or Windows box) would resolve
 * `Compose.yml` to the same file, and being stricter here costs nothing.
 *
 * Only these exact names — an app's own `.env.example` or `docker-compose.yml` stays
 * browsable, because `composeUp` is invoked with an explicit `-f .../compose.yml`
 * and `--env-file .../.env`, so no other spelling is ever read.
 */
const PLATFORM_APP_FILES = new Set(['compose.yml', '.env', 'meta.json']);

/**
 * The CORE's own compose, which lives at the sandbox root rather than under apps/.
 *
 * This is the same class of hole as OPENMASJIDOS-004 and it was left open by the fix
 * for it: `apps/<id>/compose.yml` was protected, and `<DATA_DIR>/docker-compose.yml`
 * — the file that defines the container running as root with the Docker socket and
 * the whole data directory mounted — was not. The installer's Repair rewrites it and
 * Update recreates from it, so an edit here is executed with full host privilege,
 * and it never passes `apps/compose-validate.ts` because that gate only ever sees
 * app composes.
 */
const CORE_COMPOSE = path.join(ROOT, 'docker-compose.yml').toLowerCase();

function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

/** Why the explorer must not touch this absolute path, or null if it's fair game. */
function classifyProtected(full: string): string | null {
  if (isInside(CONFIG_ROOT, full)) {
    return "This folder holds OpenMasjidOS's own settings and keys, so it's kept private. You can change these in Settings.";
  }
  if (isInside(STAGING_ROOT, full)) {
    return 'This folder is used while a backup is being prepared. It clears itself when the backup finishes.';
  }
  if (full.toLowerCase() === CORE_COMPOSE) {
    return "This file is how OpenMasjidOS itself runs, so it's kept private. Use the installer to update or repair.";
  }
  const rel = path.relative(APPS_ROOT, full);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const parts = rel.split(path.sep);
    // Exactly apps/<id>/<name> — the platform's own file for that app. Anything
    // deeper is the app's own data and stays browsable.
    if (parts.length === 2 && PLATFORM_APP_FILES.has(parts[1]!.toLowerCase())) {
      return "This file is how OpenMasjidOS runs this app, so it's kept private. Manage the app from its own page instead.";
    }
    // Exactly apps/<id> — the app's own folder. It stays BROWSABLE (that is the
    // point of the explorer, and its data lives under here), but it must not be
    // deleted or renamed: doing either takes compose.yml, .env and meta.json with
    // it, which is precisely the three files the branch above refuses to touch one
    // at a time. Refusing each file while allowing their parent to be removed
    // wholesale is not a sandbox. Enforced only for the destructive verbs — see
    // assertNotPlatformDir.
    if (parts.length === 1) return APP_DIR_SENTINEL;
  }
  return null;
}

/**
 * Marker returned by classifyProtected for an `apps/<id>` directory.
 *
 * It is not a plain refusal because listing and opening inside the folder must keep
 * working; only remove and rename are refused. `protectedReason` filters it out so
 * every read path behaves exactly as before.
 */
const APP_DIR_SENTINEL = '\u0000app-dir';

/** Refuse remove/rename on an `apps/<id>` folder. Read paths never call this. */
function assertNotPlatformDir(full: string): void {
  if (classifyProtected(full) === APP_DIR_SENTINEL) {
    throw new FileError(
      "This is an app's own folder, so it can't be removed or renamed here. Uninstall the app from its own page instead.",
      'PROTECTED',
    );
  }
}

/**
 * Same question, but for every spelling that could reach the same bytes.
 *
 * The realpath check is the load-bearing half: a symlink at `apps/x/data/link` →
 * `/data/config/stripe.json` stays *within* the sandbox, so `resolve()` is perfectly
 * happy with it, and a guard that only looked at the requested path would hand over
 * the file the symlink points at. Checking the target as well as the request is the
 * same lesson as the raw-vs-decoded path guards in `system/via-tunnel.ts`: compare
 * every spelling the consumer might follow, and fail closed.
 */
function protectedReason(full: string): string | null {
  // The app-folder sentinel is not a refusal for reads — see assertNotPlatformDir.
  const real0 = classifyProtected(full);
  const direct = real0 === APP_DIR_SENTINEL ? null : real0;
  if (direct) return direct;
  try {
    const real = fs.realpathSync(full);
    if (real !== full) {
      const via = classifyProtected(real);
      return via === APP_DIR_SENTINEL ? null : via;
    }
  } catch {
    /* doesn't exist yet — the lexical check above is the one that matters */
  }
  return null;
}

/** Refuse any operation on platform-owned state. Every entry point calls this. */
function assertAllowed(full: string): void {
  const why = protectedReason(full);
  if (why) throw new FileError(why, 'PROTECTED');
}

/** Largest file we'll load into the in-browser text editor (2 MiB). */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function within(p: string): boolean {
  return isInside(ROOT, p);
}

/** Resolve a relative path inside the sandbox. Containment is always enforced;
 *  symlink targets are re-checked when the path exists.
 *
 *  This is also the choke point for the protected-path guard, so no operation can
 *  reach platform state by forgetting to ask. Constructed *targets* (a new name, an
 *  upload destination) don't pass through here, so those call `assertAllowed`
 *  themselves — see each caller. */
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
  assertAllowed(full);
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
      // lstat (not stat) so a symlink reports ITSELF, never the metadata of an
      // out-of-sandbox target. Navigating into it still goes through resolve(),
      // whose realpath check blocks any escape.
      const child = path.join(full, name);
      const s = fs.lstatSync(child);
      // Lexical check only for the listing marker: it decides whether to draw a
      // lock, and resolving every entry's symlink target would add a syscall per
      // file in folders that can hold thousands. Enforcement on actual access uses
      // the full realpath-aware check.
      const locked = classifyProtected(child) !== null;
      entries.push({
        name,
        isDir: s.isDirectory(),
        size: s.size,
        modified: s.mtime.toISOString(),
        ...(locked ? { protected: true } : {}),
      });
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
  assertAllowed(target);
  if (fs.existsSync(target)) throw new FileError('Something with that name already exists.', 'EXISTS');
  fs.mkdirSync(target);
}

export function renameEntry(rel: string, newName: string): void {
  const full = resolve(rel);
  if (full === ROOT) throw new FileError('That item cannot be renamed.', 'BAD_NAME');
  if (full === APPS_ROOT) throw new FileError('That folder cannot be renamed — your apps are stored in it.', 'PROTECTED');
  assertNotPlatformDir(full);
  if (!fs.existsSync(full)) throw new FileError('That item does not exist.', 'NOT_FOUND');
  const target = path.join(path.dirname(full), safeName(newName));
  if (!within(target)) throw new FileError('Path is outside the allowed area.', 'OUTSIDE');
  // The TARGET matters as much as the source: renaming a harmless file in an app's
  // folder to `compose.yml` would plant a compose the platform then runs.
  assertAllowed(target);
  if (fs.existsSync(target)) throw new FileError('Something with that name already exists.', 'EXISTS');
  fs.renameSync(full, target);
}

export function removeEntry(rel: string): void {
  const full = resolve(rel);
  if (full === ROOT) throw new FileError('The root folder cannot be deleted.', 'BAD_NAME');
  if (full === APPS_ROOT) throw new FileError('That folder cannot be deleted — your apps are stored in it.', 'PROTECTED');
  assertNotPlatformDir(full);
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
function resolveUploadDir(relDir: string): string {
  const dir = resolve(relDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new FileError('That folder does not exist.', 'NOT_FOUND');
  }
  return dir;
}

export function uploadPath(relDir: string, name: string): string {
  const dest = path.join(resolveUploadDir(relDir), safeName(name));
  // An upload is the easiest way to plant a compose.yml (no 2 MiB text limit, any
  // bytes), so the destination is checked as well as the folder.
  assertAllowed(dest);
  return dest;
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
  // resolve() guarded the parent; this is the constructed leaf, so it needs its own
  // check — the parent (apps/<id>/) is legitimately writable, the leaf may not be.
  assertAllowed(full);

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
