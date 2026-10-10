// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Server-side sessions. Tokens are long random strings set in an HTTP-only,
 * SameSite=Lax cookie (Lax so the cookie rides the top-level "Open app"
 * navigation, which is cross-scheme — HTTPS dashboard → HTTP app — and would drop
 * a Strict cookie). NOT Secure on the LAN, so HTTP apps still receive it for SSO.
 *
 * Each session also carries a CSRF token (the "dashboard key"). The cookie is
 * SHARED with any installed app on another port of the same host (cookies aren't
 * port-scoped), so a malicious app could capture and replay it. The defence: the
 * dashboard key is delivered ONLY in the auth response body and the dashboard UI
 * keeps it in its own origin's storage (localStorage / a header) — which an app
 * on a different origin (port) physically cannot read. Cookie-authenticated
 * routes require the key, so possessing the cookie alone is not enough to act as
 * the admin (security audit: Fabric/SSO session-replay).
 *
 * ── SESSIONS SURVIVE A RESTART, AND WHY THAT IS A BUG FIX ───────────────────
 *
 * This file used to say "Sessions reset on a daemon restart — the admin simply
 * signs in again", and keep them in a plain Map. That was true of the dashboard
 * and false of everything else. The browser holds the cookie for SEVEN DAYS
 * (`maxAge` in trpc/context.ts); the Map was emptied by every update, reboot and
 * crash. So after any restart the admin's open dashboard tab went on drawing the
 * signed-in shell while its cookie pointed at nothing — and pressing Open on an
 * app handed that app a dead cookie. The app's SSO check came back "not signed
 * in", and because the platform WAS reachable the app refused its own password
 * recovery too ("sign in through your dashboard"), which is exactly what the admin
 * had just done. A masjid reported it as "it randomly asks for the control panel
 * password". It was every restart.
 *
 * So they are persisted to `config/sessions.json` (0600 via `writeJson`, atomic
 * temp-and-rename; `config/**` is refused to the File Explorer by
 * `protectedReason`). Reads stay in memory — `getSessionUser` runs on every
 * authenticated request and must not touch the disk.
 *
 * ── REVOCATION IS BOUND TO THE PASSWORD, NOT TO THE FILE ────────────────────
 *
 * Every session records a fingerprint of the password hash it was created under,
 * and is honoured only while that still matches the current one. That single rule
 * is what makes persistence safe, and the first version of this file did without
 * it — using "this token is missing from the file" as the revocation signal
 * instead. An adversarial review found five ways that went wrong:
 *
 *  - The installer's Reset sign-in runs in a SEPARATE process and only restarts
 *    the core minutes later, after reinstalling every app. The daemon still holds
 *    the OLD password hash in memory until then, so a sign-in with the old
 *    password in that window was written to disk and survived the reset — handing
 *    a seven-day session to precisely the person the reset existed to lock out.
 *  - A failed write could not be told apart from a revocation: a session the disk
 *    had refused to save was "missing from the file", so the next successful write
 *    from any other device silently signed it out — the reported lockout, back.
 *  - A restore, a race with the reset tools, or a period on an older Stable build
 *    (which never touches this file) could each bring sessions back that should
 *    have died.
 *
 * Bound to the password instead, none of those depend on what the file happens to
 * contain. Whoever changes the password — this daemon, the reset tools, a restore
 * of a backup with a different password, an older build — changes the hash, and
 * every session created under the old one stops working the moment the daemon
 * holding the new hash reads it. A fresh argon2 hash has a new random salt, so
 * even re-setting the SAME password revokes, which is what a reset should do.
 *
 * Other rules, each from a specific failure:
 *  - A damaged file never stops boot; it starts empty, which is the old behaviour
 *    (CLAUDE.md §15, the TLS-cert lesson: degrade, never exit).
 *  - A failed write never fails a sign-in, and never evicts anything.
 *  - A sign-out that cannot be written REMOVES the file rather than leaving the
 *    revoked session on disk to come back at the next boot: unlink still works on
 *    a full disk, and a missing file boots empty, which fails closed.
 *  - Signing out a token that is not a live session does nothing at all. Logout is
 *    a public procedure, and with tRPC batching one unauthenticated request could
 *    otherwise force hundreds of synchronous disk rewrites.
 *
 * Backups leave this file out (`system/backup.ts`): a session is a bearer
 * credential and the archive is unencrypted.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config';
import { writeJson } from '../util/json-store';
import { getPasswordHash, isAuthStoreDamaged } from './store';
import { secondFactorEpoch } from './twofactor';
import { log } from '../logger';

export const COOKIE_NAME = 'omos_session';
/**
 * The cookie a REMOTE dashboard session lives in — on the admin hostname only
 * (system/remote-admin.ts), never on the masjid's network.
 *
 * A different name from the LAN cookie, and a `__Host-` one, for one reason: the
 * admin hostname is a sibling of the hostname the apps are served on, and a page
 * or backend on a sibling may set a cookie for the parent domain that the browser
 * then sends here too. A planted `omos_session` would shadow the real session on
 * every request it covers, signing the admin out in a loop. A browser refuses to
 * let anyone set a `__Host-` cookie with a Domain, so nothing outside the admin
 * hostname can plant or overwrite this one — and the server reads only this name
 * for a remote dashboard request.
 */
export const REMOTE_COOKIE_NAME = '__Host-omos_session';
/** Header the dashboard sends the key in (HTTP); raw WS/download routes use ?k=. */
export const CSRF_HEADER = 'x-omos-csrf';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Where sessions are kept. Excluded from backups by name — see the header. */
export const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');

interface Session {
  username: string;
  csrf: string;
  expiresAt: number;
  /** Fingerprint of the password hash this session was created under. */
  cred: string;
  /**
   * Created over the tunnel — which means it passed the second factor, because a
   * tunnel sign-in only ever becomes a session in `completeLogin`. The ONLY kind of
   * session honoured for a request that arrived through the tunnel: see
   * `getSessionUserFor`. Absent on everything created before this existed, and on
   * every LAN session, which reads as false.
   */
  remote?: boolean;
  /**
   * The second-factor epoch a remote session signed in under (auth/twofactor.ts
   * `secondFactorEpoch`). From OUTSIDE it stops counting the moment that changes — a
   * replaced authenticator, new backup codes, two-step sign-in turned off. On the
   * masjid's network it goes on working, because signing in there has only ever taken
   * the password: the epoch ends the remote privilege, and a password change is what
   * ends a session everywhere. '' for a configuration from before epochs existed.
   */
  tf?: string;
  /**
   * Made by the REMOTE DASHBOARD itself: its sign-in was handed over by the front door
   * (system/remote-admin.ts), so its token has only ever lived in `__Host-omos_session`
   * on the dashboard's own address, where no app can read it. Only such a session works
   * on the remote dashboard or yields an app's access token (`isRemoteSession`).
   *
   * A sign-in through a reverse proxy the masjid runs on its own network passes the
   * second factor too (the proxy sends `X-Forwarded-Proto: https`, so it looks like the
   * tunnel) and its session is `remote`, so it goes on working through that proxy. But
   * it lives in the LAN cookie, which every app opened from that page receives — and any
   * one of them could compute an access token for EVERY app from it and use it from the
   * internet, private apps included. A review proved exactly that.
   */
  handedOver?: boolean;
}

interface StoredSession extends Session {
  token: string;
}

interface SessionFile {
  v: 2;
  sessions: StoredSession[];
}

/**
 * The fingerprint of a given password hash. Not the hash: a session file must not
 * become a second copy of the thing an attacker would crack. Exported so sign-in
 * can bind to the hash it VERIFIED — see `freshCredential` and `createSession`.
 */
export function credentialFingerprint(hash: string | null): string {
  return crypto
    .createHash('sha256')
    .update(`omos-session-credential:${hash ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

// Memoized on the hash string, since it is consulted on every authenticated request.
let fpFor: string | null | undefined;
let fpValue = '';
function currentCred(): string {
  const hash = getPasswordHash();
  if (hash !== fpFor) {
    fpFor = hash;
    fpValue = credentialFingerprint(hash);
  }
  return fpValue;
}

/**
 * The fingerprint of the current password hash, as this process last read it.
 *
 * Cheap and throttled (auth/store.ts re-checks the file at most once a second), so
 * it is right for "is this session still live" and WRONG for "may this sign-in
 * finish" — use `freshCredential` for that.
 */
export function currentCredential(): string {
  return currentCred();
}

/**
 * The fingerprint of the current password hash, read from the file now.
 *
 * What a sign-in compares the hash it VERIFIED against, after argon2 or after
 * waiting for a second factor. A second review is why it is forced: the throttled
 * read could still be the old hash for up to a second after the installer's Reset
 * sign-in wrote a new one from another process, and the comparison passed for a
 * password that had already been replaced.
 */
export function freshCredential(): string {
  return credentialFingerprint(getPasswordHash({ fresh: true }));
}

function isLive(s: Session, nowMs: number): boolean {
  return s.expiresAt > nowMs && s.cred === currentCred();
}

/**
 * May this session be THROWN AWAY? Not the same question as "is it live".
 *
 * While the password file cannot be read, the current hash is unknown — so no
 * session is honoured (fail closed), but none is discarded either. Treating
 * "unreadable" as "the password changed" dropped every saved session after one
 * transient read error at boot, signing the admin and every app out: the very
 * symptom this file exists to fix. Once the file reads again, each session is
 * judged against the real hash.
 */
function isDead(s: Session, nowMs: number): boolean {
  if (s.expiresAt <= nowMs) return true;
  if (isAuthStoreDamaged()) return false;
  return s.cred !== currentCred();
}

/**
 * Left by a restore so the NEXT core to boot starts with no sessions — which is
 * what a restore always meant when sessions lived only in memory.
 *
 * A marker rather than `destroyAllSessions()` mid-restore, and a review is why. The
 * first fix signed everyone out as soon as config/ was replaced; the dashboard's
 * next sign-in check then dropped the admin to the sign-in screen part-way through
 * the restore, unmounting the window that reports whether it worked. The old core
 * keeps the admin signed in until it is replaced; the new one starts clean.
 */
export const SESSIONS_RESET_MARKER = path.join(CONFIG_DIR, 'sessions.reset');

/** Have the next boot start with no sessions. Never throws — a restore must not fail on it. */
export function endAllSessionsAtNextBoot(): void {
  try {
    fs.writeFileSync(SESSIONS_RESET_MARKER, 'Written by a restore; the next boot starts with no sessions.\n');
  } catch (err) {
    log.warn('Could not mark sessions to end after the restore.', err);
  }
}

function loadAtBoot(): Map<string, Session> {
  const out = new Map<string, Session>();
  if (fs.existsSync(SESSIONS_RESET_MARKER)) {
    // After a restore: start clean, and remove both files so this happens once.
    // If the sessions file cannot be removed, the marker stays and the next boot
    // tries again — it is never honoured "half".
    try {
      fs.rmSync(SESSIONS_FILE, { force: true });
      fs.rmSync(SESSIONS_RESET_MARKER, { force: true });
      log.info('Restored from a backup: everyone will need to sign in again.');
    } catch (err) {
      log.warn('Could not finish clearing sessions after a restore; will retry at the next start.', err);
    }
    return out;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('The saved sign-in sessions could not be read; everyone will need to sign in again.', err);
    }
    return out;
  }
  let parsed: Partial<SessionFile>;
  try {
    parsed = JSON.parse(raw) as Partial<SessionFile>;
  } catch {
    log.warn('The saved sign-in sessions were damaged; everyone will need to sign in again.');
    return out;
  }
  if (!parsed || !Array.isArray(parsed.sessions)) return out;
  const now = Date.now();
  // Ask the file now rather than trusting the throttled copy: if the store's own
  // boot read failed a moment ago, this is its retry (auth/store.ts NEVER_READ).
  getPasswordHash({ fresh: true });
  for (const s of parsed.sessions) {
    // Shape-check every field: a hand-edited or partially-restored file must not
    // be able to inject a session with no CSRF key — a cookie-only credential, the
    // exact thing the dashboard key exists to stop — or one with no credential
    // binding, which would outlive a password change.
    if (
      s &&
      typeof s.token === 'string' &&
      s.token.length >= 32 &&
      typeof s.username === 'string' &&
      s.username.length > 0 &&
      typeof s.csrf === 'string' &&
      s.csrf.length >= 32 &&
      typeof s.expiresAt === 'number' &&
      typeof s.cred === 'string' &&
      s.cred.length > 0
    ) {
      // `remote` only ever widens what a session may do, so only a literal `true`
      // counts — a hand-edited file cannot make a LAN session usable from outside
      // by writing "yes".
      const session: Session = { username: s.username, csrf: s.csrf, expiresAt: s.expiresAt, cred: s.cred };
      if ((s as { remote?: unknown }).remote === true) {
        session.remote = true;
        const tf = (s as { tf?: unknown }).tf;
        session.tf = typeof tf === 'string' ? tf : '';
        if ((s as { handedOver?: unknown }).handedOver === true) session.handedOver = true;
      }
      if (!isDead(session, now)) out.set(s.token, session);
    }
  }
  return out;
}

const sessions = loadAtBoot();
let writeFailureLogged = false;

/** Remove a leftover temp file: it would hold tokens, and backups must not carry them. */
function removeTemp(): void {
  try {
    fs.rmSync(`${SESSIONS_FILE}.tmp`, { force: true });
  } catch {
    /* best effort — it is excluded from backups regardless */
  }
}

/**
 * Write the live sessions to disk. Returns false if the disk refused.
 *
 * Memory is authoritative here and nothing is pruned on the strength of what the
 * file does or does not contain — that is the rule the first version broke (see
 * the header). Expired and superseded sessions are dropped first so they do not
 * accumulate on disk.
 */
function save(): boolean {
  const now = Date.now();
  for (const [token, s] of sessions) if (isDead(s, now)) sessions.delete(token);
  const file: SessionFile = { v: 2, sessions: [...sessions].map(([token, s]) => ({ token, ...s })) };
  try {
    writeJson(SESSIONS_FILE, file);
    writeFailureLogged = false;
    return true;
  } catch (err) {
    removeTemp();
    if (!writeFailureLogged) {
      writeFailureLogged = true;
      log.warn('Could not save sign-in sessions to disk.', err);
    }
    return false;
  }
}

/**
 * Make a removal durable even if the write failed: delete the file. Unlink works on
 * a full disk, and a missing file boots empty — so the revoked session cannot come
 * back, at the cost of everyone signing in again after the next restart.
 */
function saveRemoval(): void {
  if (save()) return;
  try {
    fs.rmSync(SESSIONS_FILE, { force: true });
    log.warn('Removed the saved sessions file so a signed-out session cannot return after a restart.');
  } catch (err) {
    log.error('A sign-out could not be saved, and the sessions file could not be removed either. Restarting OpenMasjidOS may bring it back until it expires.', err);
  }
}

export interface NewSession {
  token: string;
  /** The dashboard key — returned to the UI, never set in a cookie. */
  csrf: string;
}

/**
 * Mint a session, bound to `cred`: the fingerprint of the password the caller
 * actually proved (`credentialFingerprint(hash)` of the hash it verified, or set).
 *
 * Passed in, never re-read here. Reading the current hash at this point — which is
 * what this did — let a refresh landing between a sign-in's check and this call
 * bind the session to a password nobody had shown. If `cred` is already stale the
 * session is simply born dead, which is the right answer.
 *
 * REQUIRED, with no default, so `npm run lint` refuses a caller that leaves it out.
 * It had a default for tests at first, and the structural test standing in for the
 * compiler could be passed by a multi-line call with a trailing comma.
 *
 * A REMOTE session must say, the same way, which second factor it proved: `tf`, the
 * epoch the code was checked against (auth/twofactor.ts VerifyResult). The type
 * requires it with `remote: true`, for the reason `cred` is required — a binding read
 * at write time instead of at proof time lets a change landing in between bind the
 * session to something nobody showed. And whether the remote dashboard made it
 * (`handedOver`, `Session.handedOver`) — required too, so no caller forgets to decide.
 */
export function createSession(
  username: string,
  cred: string,
  opts: { remote?: false } | { remote: true; tf: string; handedOver: boolean } = {},
): NewSession {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const session: Session = { username, csrf, expiresAt: Date.now() + TTL_MS, cred };
  if (opts.remote === true) {
    session.remote = true;
    session.tf = opts.tf;
    if (opts.handedOver) session.handedOver = true;
  }
  sessions.set(token, session);
  // A failed save never fails the sign-in: the session works for the life of this
  // process, and the next successful save of anything writes it out with the rest.
  save();
  return { token, csrf };
}

/**
 * The username for a token, for a request that may have come through the tunnel.
 *
 * A request from the tunnel is honoured only by a REMOTE session — one that passed
 * the second factor. Every route the dashboard serves remotely asks this, rather than
 * `getSessionUser`, and that is the whole of what makes "everything works remotely"
 * safe to offer: the files, the terminals, the backups and every private app are
 * behind the password AND the second factor when reached from outside, and behind
 * the password on the masjid's own network, exactly as before.
 *
 * Without it a LAN session — password only — would work from the internet the moment
 * its cookie was presented there. Cookies are per-host, so a browser never sends one
 * across by itself; but every app on the LAN receives the admin's cookie (that is how
 * single sign-on works), so any app that kept it could have walked straight past the
 * second factor. The session is kept, not discarded: it still works on the LAN.
 *
 * `handedOver`: the request is the remote dashboard's (the front door handed it over),
 * which honours only a session it made itself (`Session.handedOver` says why).
 */
export function getSessionUserFor(
  token: string | undefined | null,
  opts: { viaTunnel: boolean; handedOver?: boolean },
): string | null {
  const user = getSessionUser(token);
  if (!user || !opts.viaTunnel) return user;
  const s = sessions.get(token!);
  // Remote, AND still under the second factor it proved (`Session.tf`).
  if (s?.remote !== true || (s.tf ?? '') !== secondFactorEpoch()) return null;
  return !opts.handedOver || s.handedOver === true ? user : null;
}

/**
 * Is this token a live session the REMOTE DASHBOARD may use — remote, under the current
 * second factor, and made by the remote dashboard itself? The question for everything
 * reached from the internet: the remote dashboard's routes and sockets, and the app
 * access tokens derived from its sessions.
 */
export function isRemoteSession(token: string | undefined | null): boolean {
  return getSessionUserFor(token, { viaTunnel: true, handedOver: true }) !== null;
}

/**
 * `isRemoteSession`, against a second-factor epoch the caller has already read: for a
 * sweep that checks many sockets in one pass and should read the factor's file once,
 * not once per socket (system/remote-sockets.ts).
 */
export function isRemoteSessionAt(token: string | undefined | null, epoch: string): boolean {
  if (!getSessionUser(token)) return false;
  const s = sessions.get(token!);
  return s?.remote === true && s.handedOver === true && (s.tf ?? '') === epoch;
}

/**
 * What a live remote session — the remote dashboard's, or one made through a reverse
 * proxy at the masjid — was granted, or null: the second-factor epoch it proved, and
 * whether the remote dashboard made it. Changing the password mints a replacement
 * session, and it must carry exactly these rather than read the current ones.
 */
export function remoteGrantOf(token: string | undefined | null): { tf: string; handedOver: boolean } | null {
  if (getSessionUserFor(token, { viaTunnel: true }) === null) return null;
  const s = sessions.get(token!)!;
  return { tf: s.tf ?? '', handedOver: s.handedOver === true };
}

/**
 * EVERY value of a cookie in a raw `Cookie` header, in the order sent.
 *
 * Not just the first. A browser sends one pair per matching cookie, and two
 * cookies may share a name when their paths or domains differ — which is how a
 * sibling hostname plants a cookie to shadow another. Code that has to find the
 * one that is VALID asks for all of them.
 */
export function cookieValues(header: string | string[] | undefined, name: string): string[] {
  const value = Array.isArray(header) ? header.join(';') : header;
  if (!value) return [];
  const out: string[] = [];
  for (const part of value.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1 || part.slice(0, idx).trim() !== name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      out.push(raw); // a malformed escape must not throw on every request
    }
  }
  return out;
}

/** The session token in a raw `Cookie` header, for code that sees only Node's request. */
export function sessionTokenFromCookieHeader(
  header: string | string[] | undefined,
  name: string = COOKIE_NAME,
): string | null {
  return cookieValues(header, name)[0] ?? null;
}

// ── Opening an app from outside: per-app access tokens ─────────────────────
//
// The remote dashboard lives on its own hostname so that no app page shares its
// origin (system/remote-admin.ts). So its cookie never reaches an app — and an app
// that is not shared online, or one that signs the admin in through the platform,
// needs SOMETHING from the admin's browser to go on. That is this: a token for ONE
// app, which the platform sets on the apps' hostname when the admin presses Open
// (system/app-access.ts) and which the app forwards for single sign-on exactly as it
// forwards the session cookie on the LAN.
//
// What it is NOT is the session. It is derived from one — an HMAC keyed by the
// session token over the app's id — so it is honoured only while that remote session
// is (signed out, password changed, second factor replaced: gone), and it cannot be
// turned back into the session or into another app's token. An app that receives it
// holds a key to itself and nothing else, which is all an app should ever hold.

const APP_TOKEN_RE = /^a1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

/**
 * A public handle for a session: names it without being able to use it.
 *
 * Memoised per token. `appAccessUser` runs on requests from the internet to every app
 * path, and without the memo each token-shaped cookie value cost one SHA-256 per stored
 * session — a review measured ~5 ms of a root daemon's single thread per request with
 * a 16 KB Cookie header. The memo is pruned to the live sessions whenever it outgrows
 * them, so it cannot grow without bound either.
 */
const handleMemo = new Map<string, string>();
function sessionHandle(token: string): string {
  let h = handleMemo.get(token);
  if (h === undefined) {
    h = crypto.createHash('sha256').update(`omos-session-handle:${token}`).digest('base64url').slice(0, 22);
    if (handleMemo.size > sessions.size * 2 + 32) {
      for (const t of handleMemo.keys()) if (!sessions.has(t)) handleMemo.delete(t);
    }
    handleMemo.set(token, h);
  }
  return h;
}

function appMac(token: string, appId: string): string {
  return crypto.createHmac('sha256', token).update(`omos-app-access:v1:${appId}`).digest('base64url');
}

/**
 * The access token for one app, derived from a live REMOTE session — or null when
 * the session is not one. Shaped to pass the cookie-value check every OpenMasjid app
 * applies before forwarding (`^[A-Za-z0-9._~%+/=-]{1,4096}$`).
 */
export function appAccessToken(sessionToken: string, appId: string): string | null {
  if (!isRemoteSession(sessionToken)) return null;
  return `a1.${sessionHandle(sessionToken)}.${appMac(sessionToken, appId)}`;
}

/**
 * Who an app access token belongs to, for THIS app — or null.
 *
 * Valid only while the session it came from is a live remote session under the
 * current password and second factor, and only for the app it was made for. Whether
 * remote administration is switched on at all is the caller's question
 * (system/app-access.ts), because this file must not depend on settings.
 */
export function appAccessUser(value: string | null | undefined, appId: string): string | null {
  if (!value) return null;
  const m = APP_TOKEN_RE.exec(value);
  if (!m) return null;
  for (const token of sessions.keys()) {
    // The handle is not a secret, so finding the session by it may take any time it
    // likes; the comparison that decides is the MAC, below, in constant time.
    if (sessionHandle(token) !== m[1]) continue;
    // Only a session the remote dashboard made: one signed in through a reverse proxy at
    // the masjid sits in a cookie every app on that page receives (`Session.handedOver`).
    const user = getSessionUserFor(token, { viaTunnel: true, handedOver: true });
    if (!user) return null;
    const want = Buffer.from(appMac(token, appId));
    const got = Buffer.from(m[2]!);
    return want.length === got.length && crypto.timingSafeEqual(want, got) ? user : null;
  }
  return null;
}

/**
 * Keep the CALLER's remote session through a change to the second factor it made
 * itself.
 *
 * Changing the factor shuts every session made under the old one out from outside —
 * that is the point of the epoch (auth/twofactor.ts). But the admin doing it from outside has just
 * proved the password and a current code to make the change, and is often reading
 * the result: a fresh set of backup codes, shown once. Signing them out at that moment
 * unmounts the codes before they are written down, and asking for new ones would sign
 * them out again. So the session that made the change moves to the new epoch — the
 * same thing a password change does for the session that made it — and every other
 * one stays shut out.
 */
export function rebindRemoteSession(token: string | null | undefined, epoch: string): void {
  if (!token) return;
  const s = sessions.get(token);
  if (!s || s.remote !== true || !isLive(s, Date.now())) return;
  s.tf = epoch;
  save();
}

/** When a session ends, in ms since the epoch, or null — for a cookie that should not outlive it. */
export function sessionExpiresAt(token: string | undefined | null): number | null {
  if (!token) return null;
  return sessions.get(token)?.expiresAt ?? null;
}

/** Resolve the username for a token, or null if missing, expired or superseded. Memory only. */
export function getSessionUser(token: string | undefined | null): string | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (!isLive(s, now)) {
    // Dropped from memory now (the next save drops it from disk) — unless it is only
    // unverifiable for the moment, in which case it is kept for when it can be.
    if (isDead(s, now)) sessions.delete(token);
    return null;
  }
  return s.username;
}

/**
 * Constant-time check that `provided` matches the session's dashboard key. A
 * cookie-authenticated request that can't present the key is treated as a
 * replay (e.g. from an app that captured the shared cookie) and rejected.
 */
export function verifyCsrf(token: string | undefined | null, provided: string | undefined | null): boolean {
  if (!token || !provided) return false;
  const s = sessions.get(token);
  if (!s || !isLive(s, Date.now())) return false;
  const a = Buffer.from(s.csrf);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function destroySession(token: string | undefined | null): void {
  // Nothing to do — and nothing written — for a token that is not a live session.
  // Logout is a public procedure: without this, any cookie value made it rewrite
  // the file, and a batched request could make it do so hundreds of times.
  if (!token || !sessions.has(token)) return;
  sessions.delete(token);
  saveRemoval();
}

/**
 * Drop every session — after a password change, and from the installer's Reset
 * sign-in. The password change itself is what revokes durably (every session is
 * bound to the old hash); clearing the file as well keeps it from holding dead
 * entries, and removing it outright is the fallback when the disk refuses.
 */
export function destroyAllSessions(): void {
  sessions.clear();
  saveRemoval();
}

/** How many sessions are live in memory — for tests and diagnostics only. */
export function sessionCount(): number {
  return sessions.size;
}

export const SESSION_TTL_MS = TTL_MS;
