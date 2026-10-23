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
// Absent unless a test writes cgroup files into it (and removes them again).
const cgroupDir = path.join(procDir, 'cgroup');
process.env.HOST_CGROUP = cgroupDir;
process.env.OPENMASJID_DATA_DIR = '/data';

const req = createRequire(__filename);
const stats = req('../src/stats/collector') as typeof import('../src/stats/collector');

const KB = 1024;
const GiB = 1024 ** 3;
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

test('a small disk holds back a quarter, so its card and warning still work', () => {
  // This test used to pin a total of 0 for any disk under 16 GB. That was the bug: a
  // "16 GB" SD card (14.8 GiB) — the platform's main hardware — read "6 GB / 0 B" at 0%,
  // and the low-storage warning (which needs a total) could never fire on it. Below
  // 64 GB the reserve is now a quarter of the disk; never a negative, never zero.
  const eight = stats.__pickDiskForTests([{ mount: '/', size: 8 * GiB, used: 4 * GiB }]);
  assert.equal(eight.total, 6 * GiB, 'an 8 GB disk keeps 2 GB back');

  const sdCard = 15_931_539_456; // what a "16 GB" card really holds: 14.8 GiB
  const full = stats.__pickDiskForTests([{ mount: '/', size: sdCard, used: 10 * GiB }]);
  assert.equal(full.total, sdCard * 0.75);
  assert.ok(full.used / full.total >= 0.8, 'a nearly full SD card must be able to warn');

  // 64 GB is where the quarter reaches the full 16 GB reserve.
  assert.equal(stats.__pickDiskForTests([{ mount: '/', size: 64 * GiB, used: 1 }]).total, 48 * GiB);
  assert.equal(stats.__pickDiskForTests([{ mount: '/', size: 0, used: 0 }], '/data', 0).total, 0);
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

test('storage figures come from the filesystem the data is on; the drive is only carried', () => {
  // This test used to pin the opposite — the DEVICE's size as the total — because the
  // filesystem looked far smaller than the drive. But `used` was always the filesystem's,
  // so the card divided one disk's usage by another's size, and a full Ubuntu LVM volume
  // read about 40%. Both figures now come from the data's filesystem, as `df` gives them;
  // the drive travels alongside for display only, and never enters a percentage.
  const device = 256 * GiB;
  const d = stats.__pickDiskForTests([{ mount: '/', size: 40 * GiB, used: 12 * GiB }], '/data', device);
  assert.deepEqual(d, { used: 12 * GiB, total: 30 * GiB, device }, 'a quarter of 40 GB held back, from the filesystem');

  // df's own denominator: used + available, so ext4's 5% root reserve is not room.
  const ext4 = stats.__pickDiskForTests([{ mount: '/data', size: 200 * GiB, used: 150 * GiB, available: 40 * GiB }]);
  assert.equal(ext4.total, (150 + 40 - 16) * GiB);
});

test('the drive, known or not, never changes the figures', () => {
  // A non-Linux dev box has no /sys/block; the figures are the filesystem's either way.
  const RESERVE = 16 * 1024 ** 3;
  const list = [{ mount: '/', size: 100 * 1024 ** 3, used: 1 }];
  const d = stats.__pickDiskForTests(list, '/data', null);
  assert.equal(d.total, 100 * 1024 ** 3 - RESERVE);
  assert.deepEqual(stats.__pickDiskForTests(list, '/data', 4096 * GiB), { ...d, device: 4096 * GiB });
});

/** Percent used, as the dashboard (80% warning) and `!os stats` (90%) work it out. */
const pctUsed = (d: { used: number; total: number }): number => (d.used / d.total) * 100;

test('LVM: a full volume on a bigger disk reads as full', () => {
  // Ubuntu Server's default gives the root volume ~100 GB of a 256 GB disk. Divided by
  // the disk, this volume read 31% and neither warning fired.
  const volume = { size: 98 * GiB, used: 75 * GiB, available: 18 * GiB };
  const d = stats.__pickDiskForTests(
    [
      { mount: '/', ...volume }, // the core container's own overlay, on the same volume
      { mount: '/data', ...volume },
    ],
    '/data',
    256 * GiB,
  );
  assert.equal(d.total, (75 + 18 - 16) * GiB);
  assert.ok(pctUsed(d) >= 90, `${pctUsed(d)}%: the warning and "nearly full" must both fire`);
  assert.equal(d.device, 256 * GiB, 'the disk is still there to show');
});

test('a second disk does not make the data disk look empty', () => {
  // /sys/block adds up every real disk, so an unused 500 GB drive beside a nearly full
  // 256 GB one made the data disk read about 26%.
  const d = stats.__pickDiskForTests(
    [{ mount: '/data', size: 230 * GiB, used: 180 * GiB, available: 38 * GiB }],
    '/data',
    700 * GiB,
  );
  assert.equal(d.total, (180 + 38 - 16) * GiB);
  assert.ok(pctUsed(d) >= 80, `${pctUsed(d)}%: the low-storage warning must fire`);
});

test('a NAS-backed /data reads as the share, not as the local disk', () => {
  // Divided by a 32 GB local disk, a 3.5 TB share with 400 GB on it read 100%, for good.
  const d = stats.__pickDiskForTests(
    [
      { mount: '/', size: 29 * GiB, used: 9 * GiB, available: 18 * GiB },
      { mount: '/data', size: 3600 * GiB, used: 400 * GiB, available: 3200 * GiB },
    ],
    '/data',
    32 * GiB,
  );
  assert.equal(d.total, (3600 - 16) * GiB);
  assert.ok(pctUsed(d) < 20, `${pctUsed(d)}%: a mostly empty share is not full`);
});

test("in a Proxmox LXC the container's own volume is what fills up", () => {
  // Inside an LXC, /sys/block lists the NODE's disks: a 2 TB node made this full 32 GB
  // container read 1%, so the warning came only once nothing more could be written.
  const d = stats.__pickDiskForTests(
    [{ mount: '/data', size: 32 * GiB, used: 27 * GiB, available: 3 * GiB }],
    '/data',
    2048 * GiB,
  );
  assert.equal(d.total, 22.5 * GiB, 'a quarter of its 30 GB held back for the OS');
  assert.ok(pctUsed(d) >= 90, `${pctUsed(d)}%: the warning and "nearly full" must both fire`);
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

/** Put cgroup files under HOST_CGROUP for the length of `fn`. */
function withCgroup(files: Record<string, string>, fn: () => void): void {
  try {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(cgroupDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(cgroupDir, rel), body);
    }
    fn();
  } finally {
    fs.rmSync(cgroupDir, { recursive: true, force: true });
  }
}

test('a cgroup with no memory limit is not believed over `free` (bare metal)', () => {
  // On a cgroup v1/hybrid host (Ubuntu 20.04, Debian 10, RHEL 8) the mounted cgroup is the
  // machine's ROOT cgroup, and usage − inactive_file still counts the active page cache:
  // an idle box with a warm cache read nearly full while `free` said 1 GB. Its limit reads
  // as ~2^63 — none — and only an LXC has one, so /proc/meminfo answers instead.
  writeMeminfo({ MemTotal: 8 * 1024 * KB, MemFree: 1024 * KB, Buffers: 0, Cached: 6 * 1024 * KB, SReclaimable: 0 });
  withCgroup(
    {
      'memory/memory.limit_in_bytes': '9223372036854771712\n',
      'memory/memory.usage_in_bytes': `${7 * GiB}\n`,
      'memory/memory.stat': `cache ${6 * GiB}\ntotal_active_file ${5 * GiB}\ntotal_inactive_file ${GiB}\n`,
    },
    () => assert.equal(stats.__readHostMemoryForTests()?.used, GiB, 'free says 1 GB, not 6'),
  );
  withCgroup({ 'memory.max': 'max\n', 'memory.current': `${7 * GiB}\n`, 'memory.stat': `inactive_file ${GiB}\n` }, () =>
    assert.equal(stats.__readHostMemoryForTests()?.used, GiB, 'cgroup v2 with no limit is the same case'),
  );
});

test('an LXC with a memory limit is still read the way Proxmox reads it', () => {
  // lxcfs's meminfo can show most of an LXC's memory as free; its cgroup is authoritative.
  writeMeminfo({ MemTotal: 2 * 1024 * KB, MemFree: 1900 * KB, Buffers: 0, Cached: 0 });
  const expected = { used: GiB, total: 2 * GiB };
  withCgroup(
    {
      'memory/memory.limit_in_bytes': `${2 * GiB}\n`,
      'memory/memory.usage_in_bytes': `${1.5 * GiB}\n`,
      'memory/memory.stat': `total_inactive_file ${0.5 * GiB}\n`,
    },
    () => assert.deepEqual(stats.__readHostMemoryForTests(), expected, 'cgroup v1'),
  );
  withCgroup(
    { 'memory.max': `${2 * GiB}\n`, 'memory.current': `${1.5 * GiB}\n`, 'memory.stat': `inactive_file ${0.5 * GiB}\n` },
    () => assert.deepEqual(stats.__readHostMemoryForTests(), expected, 'cgroup v2'),
  );
});

test('the CPU figure is not frozen by the wall clock stepping back', async () => {
  // The sampler timed itself with Date.now(), so NTP correcting a fast clock back by an
  // hour held the last figure on screen for that whole hour.
  stats.__resetCpuSamplerForTests();
  writeStat(1000, 9000);
  stats.__readHostCpuPercentForTests(); // the baseline, on the sampler's own clock
  const realNow = Date.now;
  Date.now = () => realNow() - 3_600_000;
  try {
    await new Promise((resolve) => setTimeout(resolve, 950));
    writeStat(1100, 9900);
    assert.equal(stats.__readHostCpuPercentForTests(), 10, 'a new sample is taken');
  } finally {
    Date.now = realNow;
  }
});

test('a slow source answers in time with its last answer, and is never asked twice at once', async () => {
  // A wedged Docker daemon or a `df` stuck on a dead NFS mount froze every card, and each
  // tick started another stuck request.
  let asked = 0;
  let answer: (value: number) => void = () => {};
  const source = stats.boundedSource(
    () => {
      asked += 1;
      return new Promise<number>((resolve) => {
        answer = resolve;
      });
    },
    0,
    20,
  );
  assert.equal(await source(), 0, 'no answer yet: the starting value, after the wait');
  assert.equal(await source(), 0);
  assert.equal(asked, 1, 'the request already out is waited on, not repeated');

  const prompt = source();
  answer(4);
  assert.equal(await prompt, 4, 'an answer in time is used at once');

  assert.equal(await source(), 4, 'stuck again: the last answer, not the starting value');
  assert.equal(asked, 2);
});

test('callers share one collection instead of each running their own', async () => {
  // Each open tab's stream, stats.get and `!os stats` ran a full collection — shells, a
  // Docker call, a sysfs walk — every time. Now they share one, for no longer than the CPU
  // sampler's minimum, so every tab still gets a newer snapshot on each 2-second tick.
  const t = 1_000_000;
  const [a, b] = await Promise.all([stats.collectStats(t), stats.collectStats(t + 1)]);
  assert.equal(a, b, 'two callers at once share one collection');
  assert.equal(await stats.collectStats(t + 500), a, 'and one that started moments ago');
  assert.notEqual(await stats.collectStats(t + 2_000), a, 'a caller after that gets a new one');
});

test('systeminformation is asked only for what the host mounts cannot answer', async () => {
  // si.currentLoad() and si.mem() ran on every collection, and their answers were thrown
  // away whenever the host's own /proc had answered.
  const si = req('systeminformation') as Record<'mem' | 'currentLoad', (...args: unknown[]) => Promise<unknown>>;
  const real = { mem: si.mem, currentLoad: si.currentLoad };
  const asked = { mem: 0, load: 0 };
  si.mem = (...args) => {
    asked.mem += 1;
    return real.mem(...args);
  };
  si.currentLoad = (...args) => {
    asked.load += 1;
    return real.currentLoad(...args);
  };
  try {
    writeMeminfo({ MemTotal: 4 * 1024 * KB, MemFree: 1024 * KB, Buffers: 0, Cached: 0 });
    stats.__resetCpuSamplerForTests();
    writeStat(1000, 9000);
    stats.__readHostCpuPercentForTests(performance.now() - 1_000); // a baseline a second old
    writeStat(1100, 9900);
    await stats.collectStats(2_000_000);
    assert.deepEqual(asked, { mem: 0, load: 0 }, 'the host answered both');

    fs.rmSync(path.join(procDir, 'meminfo'));
    fs.rmSync(path.join(procDir, 'stat'));
    stats.__resetCpuSamplerForTests();
    await stats.collectStats(2_010_000);
    assert.deepEqual(asked, { mem: 1, load: 1 }, 'and are asked when it cannot');
  } finally {
    si.mem = real.mem;
    si.currentLoad = real.currentLoad;
  }
});

test('the snapshot carries the drive beside the storage figures', async () => {
  // For the card to mention the drive ("on a 256 GB drive"); no percentage reads it.
  const snap = await stats.collectStats(5_000_000);
  assert.equal(snap.diskDeviceBytes, stats.physicalDiskBytes());
});
