// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A terminal is started with two Docker round trips, and the browser does not wait:
 * it sends its first resize as soon as the socket opens, and may close it at any time.
 * What arrives meanwhile must reach the shell once it exists, and a browser that left
 * meanwhile must not leave a started shell running for ever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

process.env.OPENMASJID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-terminal-'));
const req = createRequire(__filename);
const { bridge, holdUntilBridged } = req('../src/api/terminals') as typeof import('../src/api/terminals');

type Socket = Parameters<typeof bridge>[0];
type Session = Parameters<typeof bridge>[1];

function fakeSocket() {
  const s = new EventEmitter() as EventEmitter & { OPEN: number; readyState: number; sent: unknown[]; send: (d: unknown) => void; close: () => void };
  s.OPEN = 1;
  s.readyState = 1;
  s.sent = [];
  s.send = (d) => s.sent.push(d);
  s.close = () => {
    s.readyState = 3;
    s.emit('close');
  };
  return s;
}

function fakeSession() {
  const stream = new PassThrough();
  const written: string[] = [];
  stream.write = ((d: Buffer | string) => {
    written.push(String(d));
    return true;
  }) as typeof stream.write;
  const calls = { resized: [] as Array<[number, number]>, closed: 0, written };
  const session = {
    stream,
    resize: (c: number, r: number) => calls.resized.push([c, r]),
    close: () => {
      calls.closed++;
    },
  };
  return { session: session as unknown as Session, calls };
}

test('WHAT THE BROWSER SENT WHILE THE SHELL STARTED REACHES IT, in order', () => {
  const socket = fakeSocket();
  holdUntilBridged(socket as unknown as Socket);
  socket.emit('message', Buffer.from('{"__resize":[120,40]}'));
  socket.emit('message', Buffer.from('ls\r'));
  const { session, calls } = fakeSession();
  bridge(socket as unknown as Socket, session, () => true);
  assert.deepEqual(calls.resized, [[120, 40]], 'the first resize was dropped — the shell starts the wrong size');
  assert.deepEqual(calls.written, ['ls\r']);
  // Only the bridge's own listeners remain.
  assert.equal(socket.listenerCount('message'), 1);
  assert.equal(socket.listenerCount('close'), 1);
  // And it goes on working.
  socket.emit('message', Buffer.from('pwd\r'));
  assert.deepEqual(calls.written, ['ls\r', 'pwd\r']);
});

test('A BROWSER THAT LEFT WHILE THE SHELL STARTED DOES NOT LEAVE THE SHELL RUNNING', () => {
  const socket = fakeSocket();
  holdUntilBridged(socket as unknown as Socket);
  socket.close();
  const { session, calls } = fakeSession();
  bridge(socket as unknown as Socket, session, () => true);
  assert.equal(calls.closed, 1, 'the exec’d shell leaked');
  assert.equal(socket.listenerCount('message'), 0);
});

test('a held message is still refused once the sign-in has ended', () => {
  const socket = fakeSocket();
  holdUntilBridged(socket as unknown as Socket);
  socket.emit('message', Buffer.from('rm -rf /tmp/x\r'));
  const { session, calls } = fakeSession();
  bridge(socket as unknown as Socket, session, () => false);
  assert.deepEqual(calls.written, [], 'a keystroke reached the shell after the sign-in ended');
});
