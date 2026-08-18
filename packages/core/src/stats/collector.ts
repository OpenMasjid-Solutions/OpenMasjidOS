// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Live host system stats, with container-awareness so the numbers describe the
 * MACHINE, not the container (CLAUDE.md §5, §12).
 *
 * Memory is the tricky one: inside Docker (even inside an LXC), /proc/meminfo
 * reports the bare host's RAM. We therefore prefer, in order:
 *   1. the host/LXC's own /proc (bind-mounted read-only at HOST_PROC by the
 *      installer) — accurate for an LXC via lxcfs and for bare-metal alike;
 *   2. the cgroup memory limit (accurate when a container memory limit is set);
 *   3. systeminformation's host figures as a last resort.
 *
 * CPU temperature is reported "where available" (null otherwise).
 */
import fs from 'node:fs';
import si from 'systeminformation';
import type { Systeminformation } from 'systeminformation';
import { DATA_DIR } from '../config';
import { runningProjectCount } from '../docker/discovery';

const HOST_PROC = process.env.HOST_PROC ?? '/host/proc';
const HOST_CGROUP = process.env.HOST_CGROUP ?? '/host/sys/fs/cgroup';

export interface StatsSnapshot {
  cpuPercent: number;
  cpuCores: number;
  cpuSpeedGHz: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  cpuTempC: number | null;
  uptimeSec: number;
  appsRunning: number;
}

/**
 * Read memory from a mounted host /proc/meminfo.
 *
 * `used` is computed EXACTLY as `free` computes it:
 *
 *     used = MemTotal − MemFree − Buffers − (Cached + SReclaimable)
 *
 * because `free` and `htop` are what an admin compares this card against, and a number
 * that disagrees with them reads as the dashboard lying. It previously reported
 * `MemTotal − MemFree`, which counts the page cache as used — on an ordinary machine
 * that is most of RAM, so a box with plenty free showed as nearly full. Linux fills
 * otherwise-idle memory with cache on purpose; that is not consumption.
 *
 * MemAvailable is the fallback (same intent, kernel-computed) and `total − free` the last
 * resort. Note the LXC/Proxmox case does NOT come through here: `readHostCgroupMemory`
 * is tried first and is authoritative there, which is what the earlier "MemAvailable
 * under-reports" note was really about.
 */
function readHostMeminfo(): { total: number; used: number } | null {
  try {
    const txt = fs.readFileSync(`${HOST_PROC}/meminfo`, 'utf8');
    const kb = (key: string): number | null => {
      const m = txt.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
      return m ? Number.parseInt(m[1], 10) * 1024 : null;
    };
    const total = kb('MemTotal');
    if (!total) return null;
    const free = kb('MemFree');
    const buffers = kb('Buffers');
    const cached = kb('Cached');
    const sReclaimable = kb('SReclaimable') ?? 0;
    if (free != null && buffers != null && cached != null) {
      const used = total - free - buffers - (cached + sReclaimable);
      // Clamp: a torn read (the file is not atomic) can otherwise produce a negative.
      return { total, used: Math.max(0, Math.min(total, used)) };
    }
    const avail = kb('MemAvailable');
    if (avail != null) return { total, used: Math.max(0, total - avail) };
    return free != null ? { total, used: Math.max(0, total - free) } : null;
  } catch {
    return null;
  }
}

// CPU% is derived from successive /proc/stat readings (the jiffies delta between two
// collections), so it reflects the machine/LXC, not the core container.
let prevCpu: { total: number; idle: number; at: number } | null = null;
let lastCpuPercent: number | null = null;

/**
 * The shortest gap that gives a meaningful average.
 *
 * THIS IS THE FIX FOR A CPU FIGURE THAT JUMPED AROUND. The baseline is module-level, but
 * the callers are not: `stats.get` polls, the `stats.stream` subscription polls every 2s,
 * and EVERY open tab runs its own subscription loop. Whoever called last replaced the
 * baseline, so the next reading measured whatever fraction of a second had passed since
 * some other caller — and a jiffies delta over a few milliseconds is nearly random, which
 * is exactly the wild number an admin sees and calls a lie.
 *
 * So a sample is only taken when enough time has passed; in between, every caller gets
 * the last computed value. One shared, honest figure, however many pollers there are.
 */
const MIN_CPU_SAMPLE_MS = 900;

function readHostCpuPercent(now = Date.now()): number | null {
  // Too soon to measure again — reuse the last real answer rather than computing a
  // meaningless one and, crucially, WITHOUT moving the baseline.
  if (prevCpu && now - prevCpu.at < MIN_CPU_SAMPLE_MS) return lastCpuPercent;
  try {
    const txt = fs.readFileSync(`${HOST_PROC}/stat`, 'utf8');
    const line = txt.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return null;
    const nums = line.trim().split(/\s+/).slice(1).map((n) => Number.parseInt(n, 10));
    if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return null;
    const idle = (nums[3] ?? 0) + (nums[4] ?? 0); // idle + iowait
    const total = nums.reduce((a, b) => a + b, 0);
    const prev = prevCpu;
    prevCpu = { total, idle, at: now };
    if (!prev) return null; // need a baseline first
    const dt = total - prev.total;
    const di = idle - prev.idle;
    if (dt <= 0) return lastCpuPercent;
    lastCpuPercent = Math.max(0, Math.min(100, Math.round(((dt - di) / dt) * 100)));
    return lastCpuPercent;
  } catch {
    return null;
  }
}

/** Test seams. These three are the numbers a masjid checks against `free` and `htop`,
 *  so they are tested directly rather than through a live `collectStats()`. */
export function __resetCpuSamplerForTests(): void {
  prevCpu = null;
  lastCpuPercent = null;
}
export function __readHostCpuPercentForTests(now: number): number | null {
  return readHostCpuPercent(now);
}

/** Machine/LXC uptime from the mounted host /proc/uptime (os.uptime() would
 *  report the bare host kernel's uptime, not the container's). */
function readHostUptime(): number | null {
  try {
    const secs = Number.parseFloat(
      fs.readFileSync(`${HOST_PROC}/uptime`, 'utf8').trim().split(/\s+/)[0],
    );
    return Number.isFinite(secs) ? Math.round(secs) : null;
  } catch {
    return null;
  }
}

/** Count CPUs from a mounted host /proc/cpuinfo. */
function readHostCpuCount(): number | null {
  try {
    const txt = fs.readFileSync(`${HOST_PROC}/cpuinfo`, 'utf8');
    const n = (txt.match(/^processor\s*:/gm) ?? []).length;
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Read the cgroup memory limit + usage (v2, then v1). null if unreadable. */
function readCgroupMemory(): { used: number; limit: number } | null {
  try {
    const max = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    const cur = Number.parseInt(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim(), 10);
    if (Number.isFinite(cur)) {
      return { used: cur, limit: max === 'max' ? Infinity : Number.parseInt(max, 10) };
    }
  } catch {
    /* not cgroup v2 */
  }
  try {
    const limit = Number.parseInt(
      fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim(),
      10,
    );
    const used = Number.parseInt(
      fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim(),
      10,
    );
    if (Number.isFinite(used)) return { used, limit };
  } catch {
    /* not cgroup v1 */
  }
  return null;
}

/** Parse a "key value\n" cgroup file (e.g. memory.stat) into a map. */
function readCgroupKv(file: string): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const [k, v] = line.trim().split(/\s+/);
      if (k && v != null) {
        const n = Number.parseInt(v, 10);
        if (Number.isFinite(n)) out[k] = n;
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Read the machine/LXC memory from the host cgroup the SAME way Proxmox does:
 * used = memory.current − inactive_file (the reclaimable page cache). This is the
 * authoritative source; lxcfs's /proc/meminfo can badly disagree (reporting most
 * memory as free). Requires the host cgroup mounted at HOST_CGROUP (installer).
 * Total comes from /proc/meminfo (the LXC limit), falling back to the cgroup max.
 */
function readHostCgroupMemory(): { used: number; total: number } | null {
  const meminfoTotal = readHostMeminfo()?.total ?? 0;
  // cgroup v2
  try {
    const current = Number.parseInt(fs.readFileSync(`${HOST_CGROUP}/memory.current`, 'utf8').trim(), 10);
    if (Number.isFinite(current)) {
      const inactiveFile = readCgroupKv(`${HOST_CGROUP}/memory.stat`)['inactive_file'] ?? 0;
      const used = Math.max(0, current - inactiveFile);
      const maxRaw = fs.readFileSync(`${HOST_CGROUP}/memory.max`, 'utf8').trim();
      const total = meminfoTotal > 0 ? meminfoTotal : maxRaw === 'max' ? 0 : Number.parseInt(maxRaw, 10);
      if (total > 0) return { used: Math.min(used, total), total };
    }
  } catch {
    /* not cgroup v2 / not mounted */
  }
  // cgroup v1
  try {
    const usage = Number.parseInt(
      fs.readFileSync(`${HOST_CGROUP}/memory/memory.usage_in_bytes`, 'utf8').trim(),
      10,
    );
    if (Number.isFinite(usage)) {
      const stat = readCgroupKv(`${HOST_CGROUP}/memory/memory.stat`);
      const cache = stat['total_inactive_file'] ?? stat['inactive_file'] ?? 0;
      const used = Math.max(0, usage - cache);
      const limit = Number.parseInt(
        fs.readFileSync(`${HOST_CGROUP}/memory/memory.limit_in_bytes`, 'utf8').trim(),
        10,
      );
      const total = meminfoTotal > 0 ? meminfoTotal : limit;
      if (total > 0) return { used: Math.min(used, total), total };
    }
  } catch {
    /* not cgroup v1 / not mounted */
  }
  return null;
}

function resolveMemory(mem: Systeminformation.MemData | null): { used: number; total: number } {
  // The LXC/host cgroup is authoritative and matches Proxmox; prefer it.
  const hostCg = readHostCgroupMemory();
  if (hostCg && hostCg.total > 0) return hostCg;

  const host = readHostMeminfo();
  if (host && host.total > 0) return host;

  const hostTotal = mem?.total ?? 0;
  const selfCg = readCgroupMemory();
  if (selfCg && Number.isFinite(selfCg.limit) && selfCg.limit > 0 && (hostTotal === 0 || selfCg.limit < hostTotal)) {
    return { used: selfCg.used, total: selfCg.limit };
  }
  return { used: mem ? (mem.active ?? mem.used) : 0, total: hostTotal };
}

// CPU model details (cores, speed) are mostly static — fetch once and cache.
let cpuInfo: { cores: number; speedGHz: number } | null = null;
async function getCpuInfo(): Promise<{ cores: number; speedGHz: number }> {
  if (cpuInfo) return cpuInfo;
  let cores = readHostCpuCount() ?? 0;
  let speedGHz = 0;
  try {
    const c = await si.cpu();
    if (!cores) cores = c.cores || c.physicalCores || 1;
    speedGHz = c.speed || 0;
  } catch {
    /* keep host count */
  }
  cpuInfo = { cores: cores || 1, speedGHz };
  return cpuInfo;
}

/**
 * Storage kept back for the host operating system, and never offered to the masjid.
 *
 * A machine whose disk is genuinely 100% full does not just stop installing apps — it
 * stops being able to write logs, journal, or update itself, and recovering it needs
 * someone at a terminal in the masjid. So the dashboard treats the last 16 GB as not
 * ours: the Storage card counts down to "full" 16 GB early, and the low-storage warning
 * fires while there is still room to fix things.
 *
 * This is a floor for the OS, not a quota on apps — nothing prevents an app writing into
 * the reserve; the platform simply stops telling the masjid that space is theirs.
 */
const HOST_OS_RESERVE_BYTES = 16 * 1024 ** 3;

/**
 * Total capacity of the machine's real disks, read from sysfs.
 *
 * WHY NOT THE FILESYSTEM: the card was reporting a figure far smaller than the machine's
 * actual disk. Inside the core container `si.fsSize()` sees the container's mounts, and
 * which of them best represents "this masjid's storage" is a guess that goes wrong on
 * partitioned disks, on overlay filesystems, and wherever the data directory sits on
 * something small. The device is the thing an admin can actually look up on an invoice.
 *
 * `/sys/block` is readable from inside the container (Docker mounts /sys, and block
 * devices are not namespaced), and `size` is in 512-byte sectors regardless of the
 * device's own sector size — that is the kernel's fixed unit for this file.
 *
 * Excluded, all for the same reason — they are not additional capacity:
 *   loop/ram/zram/fd/sr : virtual, in-memory, or optical
 *   dm-* and md*        : device-mapper and RAID sit ON TOP of real disks, so counting
 *                         them as well would double the total
 *   removable           : a USB stick plugged in today is not the masjid's storage
 *
 * Returns null when sysfs tells us nothing, so the caller can fall back rather than
 * reporting zero — a Storage card reading "0" is worse than one reading conservatively.
 */
const VIRTUAL_BLOCK = /^(loop|ram|zram|fd|sr|dm-|md|nbd)/;
const SECTOR_BYTES = 512;

export function physicalDiskBytes(sysBlock = '/sys/block'): number | null {
  let names: string[];
  try {
    names = fs.readdirSync(sysBlock);
  } catch {
    return null; // no sysfs (a non-Linux dev box) — the caller falls back
  }
  let total = 0;
  let found = 0;
  for (const name of names) {
    if (VIRTUAL_BLOCK.test(name)) continue;
    try {
      if (fs.readFileSync(`${sysBlock}/${name}/removable`, 'utf8').trim() === '1') continue;
      const sectors = Number.parseInt(fs.readFileSync(`${sysBlock}/${name}/size`, 'utf8').trim(), 10);
      if (!Number.isFinite(sectors) || sectors <= 0) continue;
      total += sectors * SECTOR_BYTES;
      found += 1;
    } catch {
      // A device that vanished mid-read, or one without these attributes. Skip it
      // rather than abandoning the whole total.
    }
  }
  return found > 0 ? total : null;
}

/** Does this mount contain `p`? A boundary check, so `/da` never matches `/data`. */
function mountContains(mount: string, p: string): boolean {
  if (!mount) return false;
  if (mount === '/') return true;
  return p === mount || p.startsWith(mount.endsWith('/') ? mount : `${mount}/`);
}

function pickDisk(
  list: Systeminformation.FsSizeData[],
  // A parameter rather than reading DATA_DIR directly, so the choice can be tested on any
  // platform: DATA_DIR is path-resolved, and on Windows `/data` becomes `C:\data`.
  dataDir: string = DATA_DIR,
  // Injectable so the device-vs-filesystem precedence is testable without a real /sys.
  deviceBytes: number | null = physicalDiskBytes(),
): { used: number; total: number } {
  if (!list || list.length === 0) return { used: 0, total: 0 };
  // Prefer the filesystem the masjid's data actually lives on, and among candidates the
  // most specific mount — `/` contains everything, so a plain "contains" test would pick
  // it over the dedicated volume that /data is really on.
  const candidates = list.filter((d) => d.size > 0 && mountContains(d.mount, dataDir));
  const byData = candidates.sort((a, b) => b.mount.length - a.mount.length)[0];
  const root = list.find((d) => d.mount === '/' && d.size > 0);
  const largest = [...list].sort((a, b) => (b.size || 0) - (a.size || 0))[0];
  const chosen = byData ?? root ?? largest;
  // The DEVICE's capacity is the headline figure: it is what an admin can look up, and
  // it does not depend on guessing which of a container's mounts represents the masjid's
  // storage. The filesystem is the fallback when sysfs tells us nothing.
  //
  // Known limit, stated rather than hidden: in a Proxmox LXC, /sys/block shows the HOST
  // NODE's disks, which can be far larger than the container's allotted storage. That
  // over-reports, and over-reporting means the low-storage warning arrives too late. If a
  // masjid sees a total that matches their Proxmox host rather than their container,
  // that is this, and the fix is to prefer the filesystem there.
  const size = deviceBytes ?? chosen?.size ?? 0;
  return {
    used: chosen?.used ?? 0,
    // Less the host OS's reserve. Never negative: on a disk smaller than the reserve
    // there is simply nothing spare, and a negative total renders as a nonsense
    // percentage.
    total: Math.max(0, size - HOST_OS_RESERVE_BYTES),
  };
}

export async function collectStats(): Promise<StatsSnapshot> {
  const [load, mem, disks, temp, appsRunning, cpu] = await Promise.all([
    si.currentLoad().catch(() => null),
    si.mem().catch(() => null),
    si.fsSize().catch(() => [] as Systeminformation.FsSizeData[]),
    si.cpuTemperature().catch(() => null),
    runningProjectCount().catch(() => 0),
    getCpuInfo(),
  ]);

  const disk = pickDisk(disks);
  const memory = resolveMemory(mem);
  const tempMain = temp?.main;
  const cpuTempC = typeof tempMain === 'number' && tempMain > 0 ? Math.round(tempMain) : null;

  // Prefer the host /proc/stat delta; fall back to systeminformation's figure.
  const hostCpu = readHostCpuPercent();
  const cpuPercent =
    hostCpu ?? (load ? Math.max(0, Math.min(100, Math.round(load.currentLoad))) : 0);

  return {
    cpuPercent,
    cpuCores: cpu.cores,
    cpuSpeedGHz: cpu.speedGHz,
    memUsed: memory.used,
    memTotal: memory.total,
    diskUsed: disk.used,
    diskTotal: disk.total,
    cpuTempC,
    uptimeSec: readHostUptime() ?? Math.round(si.time().uptime ?? 0),
    appsRunning,
  };
}

export function __readHostMeminfoForTests(): { total: number; used: number } | null {
  return readHostMeminfo();
}
export function __pickDiskForTests(
  list: { mount: string; size: number; used: number }[],
  dataDir = '/data',
  deviceBytes: number | null = null,
): { used: number; total: number } {
  return pickDisk(list as unknown as Systeminformation.FsSizeData[], dataDir, deviceBytes);
}
