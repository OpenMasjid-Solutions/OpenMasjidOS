// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The backup download from outside answers before the backup is made, and sends the
 * file once it is (api/backup-download.ts) — Cloudflare gives up on an address that
 * has not started answering in 100 seconds, and copying app data can take longer.
 *
 * What these pin is the failure that design invited: a browser that LEAVES — before
 * the backup exists, or part-way through it — must end the backup. It used to leave
 * tar blocked on a full pipe for ever, with "a backup is already running" set, so
 * every later backup (the nightly off-site one included) was refused until a restart.
 * The last case runs the real backup, with real tar, to show the flag comes back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-remote-backup-'));
process.env.OPENMASJID_DATA_DIR = DATA;

const req = createRequire(__filename);
const { sendBackupEarly, sendBackup } = req('../src/api/backup-download') as typeof import('../src/api/backup-download');
const backup = req('../src/system/backup') as typeof import('../src/system/backup');
type StartBackup = import('../src/api/backup-download').StartBackup;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

/** A server whose one route is the early-answering download, fed by `start`. */
async function serve(start: StartBackup) {
  let serverSawClose = false;
  const server = http.createServer((_req, res) => {
    res.once('close', () => {
      serverSawClose = true;
    });
    sendBackupEarly(res, start);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    sawClose: () => serverSawClose,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** GET, resolving as soon as the response HEADERS arrive. */
function getHeaders(url: string): Promise<{ res: http.IncomingMessage; request: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (res) => {
      res.on('error', () => {}); // leaving part-way is the point of several cases
      resolve({ res, request });
    });
    request.on('error', reject);
  });
}

/** A source that never ends, and so can only stop by being destroyed. */
const endless = () =>
  new Readable({
    read() {
      this.push(Buffer.alloc(16 * 1024, 1));
    },
  });

/** A stand-in backup: these bytes, then this verdict from "tar". */
const made = (bytes: Buffer, ok: boolean) => ({
  stream: Readable.from([bytes]),
  done: new Promise<{ ok: boolean; message: string }>((r) => setTimeout(() => r({ ok, message: ok ? '' : 'tar exited 2' }), 50)),
});
/** A backup whose "tar" never finishes — only the browser leaving ends it. */
const never = (stream: Readable) => ({ stream, done: new Promise<{ ok: boolean; message: string }>(() => {}) });

// Each has a timeout: a regression here is a response that never comes, and it must
// fail the suite rather than hang it.
const LIMIT = { timeout: 15_000 };

test('the headers go before the backup exists, and the file follows once it does', LIMIT, async () => {
  let release!: () => void;
  const ready = new Promise<void>((r) => (release = r));
  const srv = await serve(async () => {
    await ready;
    return made(Buffer.from('ARCHIVE'), true);
  });
  try {
    const { res } = await getHeaders(srv.url); // answered while the backup is still being made
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/gzip');
    assert.match(String(res.headers['content-disposition']), /^attachment; filename="openmasjidos-backup-[\d-]+\.tar\.gz"$/);
    // Every secret on the box: never kept by the browser or Cloudflare.
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.equal(res.headers['cdn-cache-control'], 'no-store');
    assert.equal(res.headers['cloudflare-cdn-cache-control'], 'no-store');
    release();
    let body = '';
    for await (const chunk of res) body += String(chunk);
    assert.equal(body, 'ARCHIVE');
    assert.equal(res.complete, true);
  } finally {
    await srv.close();
  }
});

test('a browser that leaves BEFORE the backup exists ends it the moment it does', LIMIT, async () => {
  let release!: () => void;
  const ready = new Promise<void>((r) => (release = r));
  const source = endless();
  const srv = await serve(async () => {
    await ready;
    return never(source);
  });
  try {
    const { request } = await getHeaders(srv.url);
    request.destroy(); // e.g. cancelling a download stuck at 0 bytes while app data is copied
    assert.ok(await until(srv.sawClose), 'the server noticed');
    release(); // …and only then does the backup exist
    assert.ok(
      await until(() => source.destroyed),
      'the backup must be ended, not piped into a response nobody is reading',
    );
  } finally {
    await srv.close();
  }
});

test('a browser that leaves PART-WAY through ends the backup too', LIMIT, async () => {
  const source = endless();
  const srv = await serve(async () => never(source));
  try {
    const { res, request } = await getHeaders(srv.url);
    await new Promise((r) => res.once('data', r)); // the file is arriving
    request.destroy();
    assert.ok(await until(() => source.destroyed), 'the source goes when the browser does');
  } finally {
    await srv.close();
  }
});

test('a backup that cannot start breaks the download off — never a short file that looks whole', LIMIT, async () => {
  const srv = await serve(async () => {
    throw new Error("We couldn't ask Docker which app data to save");
  });
  try {
    const { res } = await getHeaders(srv.url);
    res.resume();
    await new Promise((r) => res.once('close', r));
    assert.equal(res.complete, false, 'the browser must see a failed download');
  } finally {
    await srv.close();
  }
});

test(
  'with the REAL backup and real tar, leaving early does not leave "a backup is already running" behind',
  { timeout: 30_000, skip: process.platform === 'win32' ? 'needs GNU tar and a POSIX shell — run the suite in WSL' : false },
  async () => {
    // Docker answers "no app volumes", so the backup is config/ only…
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-fake-docker-'));
    fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${PATH}`;
    // …and big enough that tar cannot finish into the pipe's buffer when nobody reads
    // (random bytes, so gzip cannot shrink them under it).
    fs.mkdirSync(path.join(DATA, 'config'), { recursive: true });
    fs.writeFileSync(path.join(DATA, 'config', 'filler.bin'), crypto.randomBytes(2 * 1024 * 1024));

    let release!: () => void;
    const left = new Promise<void>((r) => (release = r));
    // A box, not a `let`: assigned inside the callback, which narrowing cannot follow.
    const made: { handle: import('../src/system/backup').BackupHandle | null } = { handle: null };
    const srv = await serve(async () => {
      await left; // the browser leaves while the app data is "still being copied"
      made.handle = await backup.backupStream();
      return made.handle;
    });
    try {
      const { request } = await getHeaders(srv.url);
      request.destroy();
      assert.ok(await until(srv.sawClose));
      release();
      assert.ok(await until(() => made.handle !== null), 'the real backup started');
      const outcome = await Promise.race([made.handle!.done, sleep(10_000).then(() => null)]);
      assert.ok(
        outcome,
        'tar must be ended — otherwise every later backup is refused as "already running" until a restart',
      );
      assert.equal(outcome.ok, false, 'a download nobody received is not recorded as a good backup');
      assert.equal(backup.backupInProgress(), false);

      // The next backup — the nightly off-site one, say — simply runs.
      const next = await backup.backupStream();
      next.stream.resume();
      const result = await next.done;
      assert.equal(result.ok, true, result.message);
    } finally {
      process.env.PATH = PATH;
      await srv.close();
    }
  },
);


test('sendBackup into a response whose browser has ALREADY left ends the backup at once', LIMIT, async () => {
  // The download on the masjid's network makes the backup first and only then sends it.
  // A browser that left meanwhile has fired its 'close' already; piping into it would
  // leave tar blocked for ever, with every later backup refused as "already running".
  const source = endless();
  let left!: () => void;
  const browserLeft = new Promise<void>((r) => (left = r));
  const server = http.createServer(async (_req, res) => {
    res.once('close', () => left());
    await browserLeft;
    sendBackup(res, never(source));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as AddressInfo;
    const request = http.get(`http://127.0.0.1:${port}/`, () => {});
    request.on('error', () => {});
    await new Promise((r) => setTimeout(r, 100));
    request.destroy();
    assert.ok(await until(() => source.destroyed), 'the backup went on into a response nobody was reading');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  // And the route on the masjid's network listens for the browser leaving BEFORE it makes
  // the backup, not after.
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const route = index.slice(index.indexOf("server.get('/api/backup'"), index.indexOf('registerTerminals(server)'));
  assert.ok(route.indexOf("reply.raw.once('close'") > 0, 'the LAN route does not listen for the browser leaving');
  assert.ok(route.indexOf("reply.raw.once('close'") < route.indexOf('await backupStream()'), 'it listens only after making the backup');
});

test('A BACKUP TAR FAILED IS NEVER DELIVERED AS A WHOLE FILE — the download is broken off', { timeout: 15_000 }, async () => {
  // tar's output ends before tar says how it went, so a download ended with the output
  // arrived clean and complete for a backup missing a file tar could not read.
  for (const [ok, what] of [
    [false, 'tar failed'],
    [true, 'tar succeeded'],
  ] as const) {
    const srv = await serve(async () => made(Buffer.from('PART-OF-AN-ARCHIVE'), ok));
    try {
      const { res } = await getHeaders(srv.url);
      let body = '';
      res.on('data', (c) => (body += String(c)));
      await new Promise((r) => res.once('close', r));
      assert.equal(res.complete, ok, `${what}: the browser must see ${ok ? 'a whole file' : 'a failed download'}`);
      if (ok) assert.equal(body, 'PART-OF-AN-ARCHIVE');
    } finally {
      await srv.close();
    }
  }
  // The download on the masjid's network goes the same way, not through reply.send.
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const route = index.slice(index.indexOf("server.get('/api/backup'"), index.indexOf('registerTerminals(server)'));
  assert.match(route, /sendBackup\(reply\.raw, backup\)/);
  assert.doesNotMatch(route, /reply\.send\(backup\.stream\)/, 'the download on the LAN ends with tar’s output again');
});
