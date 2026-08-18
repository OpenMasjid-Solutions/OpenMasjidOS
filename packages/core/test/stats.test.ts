// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The dashboard's system stats.
 *
 * These numbers are checked against `free`, `htop` and the provider's own console, so a
 * figure that disagrees with those does not read as a rounding difference — it reads as
 * the dashboard lying, and it costs the masjid their trust in every other number on the
 * page. All three defects below were reported from a real install.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// The collector reads its host paths from the environment at import time.
const procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-proc-'));
process.env.HOST_PROC = procDir;
process.env.HOST_CGROUP = path.join(procDir, 'no-cgroup');
process.env.OPENMASJID_DATA_DIR = '/data';

const req = createRequire(__filename);
const stats = req('../src/stats/collector') as typeof import('../src/stats/collector');

const KB = 1024;
function writeMeminfo(fields: Record<string, number>): void {
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}:${String(v).padStart(15)} kB`)
    .join('\n');
  fs.writeFileSync(path.join(procDir, 'meminfo'), `${body}\n`);
}

/** One `/proc/stat` cpu line from jiffy counts. */
function writeStat(user: number, idle: number): void {
  fs.writeFileSync(path.join(procDir, 'stat'), `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 2 3 4\n`);
}

test('memory does not count the page cache as used', () => {
  // The bug: used was MemTotal − MemFree, so cache counted as consumption. Linux fills
  // idle memory with cache deliberately — on this box that is 6 GB of an 8 GB machine,
  // which showed as ~88% used while `free` said 12%.
  writeMeminfo({
    MemTotal: 8 * 1024 * KB, // 8 GiB
    MemFree: 1 * 1024 * KB,
    MemAvailable: 7 * 1024 * KB,
    Buffers: 256 * KB,
    Cached: 6 * 1024 * KB - 256 * KB,
    SReclaimable: 0,
  });
  const m = stats.__readHostMeminfoForTests();
  assert.ok(m, 'meminfo must parse');
  assert.equal(m.total, 8 * 1024 ** 3);
  // free's own arithmetic: total − free − buffers − (cached + sreclaimable) = 1 GiB.
  assert.equal(m.used, 1 * 1024 ** 3, `expected 1 GiB used, got ${m.used}`);
});

test('memory falls back sensibly when the kernel reports less detail', () => {
  writeMeminfo({ MemTotal: 4 * 1024 * KB, MemFree: 1 * 1024 * KB, MemAvailable: 3 * 1024 * KB });
  const m = stats.__readHostMeminfoForTests();
  // No Buffers/Cached, so MemAvailable carries the same meaning.
  assert.equal(m?.used, 1 * 1024 ** 3);
});

test('a torn read never produces a negative or an impossible figure', () => {
  // /proc/meminfo is not read atomically, so the parts can disagree.
  writeMeminfo({ MemTotal: 1024 * KB, MemFree: 900 * KB, Buffers: 400 * KB, Cached: 400 * KB });
  const m = stats.__readHostMeminfoForTests();
  assert.ok(m && m.used >= 0 && m.used <= m.total, `used out of range: ${m?.used}/${m?.total}`);
});

test('CPU is not resampled faster than it can be measured', () => {
  // THE BUG: one module-level baseline, many callers — `stats.get`, and one `stats.stream`
  // loop per open tab. Whoever called last moved the baseline, so the next reading
  // measured a few milliseconds of jiffies, which is nearly random. That is the CPU
  // number jumping around for no reason.
  stats.__resetCpuSamplerForTests();
  writeStat(1000, 9000);
  assert.equal(stats.__readHostCpuPercentForTests(0), null, 'the first call only sets a baseline');

  // A full second later: 100 jiffies busy, 900 idle => 10%.
  writeStat(1100, 9900);
  assert.equal(stats.__readHostCpuPercentForTests(1000), 10);

  // A second caller 10 ms later must NOT resample. Before the fix this measured a
  // 10 ms window; now it repeats the last real answer.
  writeStat(1101, 9900); // would look like 100% busy over that sliver
  assert.equal(stats.__readHostCpuPercentForTests(1010), 10, 'too soon to measure again');

  // And the baseline it kept must still be the one from 1000ms, so the next real sample
  // covers the whole interval rather than starting from the skipped reading.
  writeStat(1200, 10800); // from t=1000: 100 busy, 900 idle => 10%
  assert.equal(stats.__readHostCpuPercentForTests(2000), 10, 'the skipped call must not have moved the baseline');
});

test('storage holds back 16 GB for the host operating system', () => {
  // A machine at a genuine 100% cannot write logs or update itself, and recovering it
  // needs someone at a terminal in the masjid. The card counts down to "full" early.
  const RESERVE = 16 * 1024 ** 3;
  const total = 100 * 1024 ** 3;
  const d = stats.__pickDiskForTests([{ mount: '/', size: total, used: 20 * 1024 ** 3 }]);
  assert.equal(d.total, total - RESERVE);
  assert.equal(d.used, 20 * 1024 ** 3, 'used is still what is really used');
});

test('a disk smaller than the reserve reports no spare room, never a negative', () => {
  const d = stats.__pickDiskForTests([{ mount: '/', size: 8 * 1024 ** 3, used: 4 * 1024 ** 3 }]);
  assert.equal(d.total, 0);
});

test('the most specific mount containing the data dir wins', () => {
  // `/` contains everything, so a plain prefix test picked the root filesystem over the
  // dedicated volume the masjid's data is actually on — reporting the wrong disk entirely.
  const d = stats.__pickDiskForTests([
    { mount: '/', size: 50 * 1024 ** 3, used: 10 * 1024 ** 3 },
    { mount: '/data', size: 500 * 1024 ** 3, used: 100 * 1024 ** 3 },
  ]);
  assert.equal(d.used, 100 * 1024 ** 3, 'must pick /data, not /');
});

test('a mount is matched on a path boundary, not a string prefix', () => {
  // `/da` is not a parent of `/data`.
  const d = stats.__pickDiskForTests([
    { mount: '/da', size: 500 * 1024 ** 3, used: 400 * 1024 ** 3 },
    { mount: '/', size: 50 * 1024 ** 3, used: 10 * 1024 ** 3 },
  ]);
  assert.equal(d.used, 10 * 1024 ** 3, 'must fall back to /, not match /da');
});

test('storage reports the DEVICE, not whichever filesystem the data landed on', () => {
  // The card was reading far smaller than the machine's actual disk: inside the container
  // `si.fsSize()` sees the container's mounts, and picking the one that best represents
  // "this masjid's storage" is a guess that goes wrong on partitioned disks and overlays.
  // The device is what an admin can look up on an invoice.
  const RESERVE = 16 * 1024 ** 3;
  const device = 256 * 1024 ** 3;
  const d = stats.__pickDiskForTests(
    [{ mount: '/', size: 40 * 1024 ** 3, used: 12 * 1024 ** 3 }],
    '/data',
    device,
  );
  assert.equal(d.total, device - RESERVE, 'the total comes from the device');
  assert.equal(d.used, 12 * 1024 ** 3, 'used is still what is really used');
});

test('with no device reading, the filesystem is still used', () => {
  // A non-Linux dev box has no /sys/block. Falling back beats reporting zero.
  const RESERVE = 16 * 1024 ** 3;
  const d = stats.__pickDiskForTests([{ mount: '/', size: 100 * 1024 ** 3, used: 1 }], '/data', null);
  assert.equal(d.total, 100 * 1024 ** 3 - RESERVE);
});

test('only real disks count towards the device total', () => {
  // Virtual and stacked devices are not extra capacity: loop/ram are fake, and dm-*/md*
  // sit ON TOP of real disks — counting them too would double the machine's storage.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-sysblock-'));
  const mk = (name: string, sectors: number, removable = 0) => {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'size'), `${sectors}\n`);
    fs.writeFileSync(path.join(dir, name, 'removable'), `${removable}\n`);
  };
  const GB = (1024 ** 3) / 512; // sectors per GB
  mk('nvme0n1', 256 * GB);
  mk('sda', 500 * GB);
  mk('loop0', 4 * GB); // a snap/squashfs mount
  mk('dm-0', 256 * GB); // LUKS/LVM over nvme0n1 — would double it
  mk('md0', 756 * GB); // RAID over the two real disks — would double it again
  mk('sdb', 64 * GB, 1); // a USB stick someone left in

  assert.equal(stats.physicalDiskBytes(dir), (256 + 500) * 1024 ** 3, 'only the two real disks');
  // No sysfs at all reads as "unknown", not as zero.
  assert.equal(stats.physicalDiskBytes(path.join(dir, 'nope')), null);
});
