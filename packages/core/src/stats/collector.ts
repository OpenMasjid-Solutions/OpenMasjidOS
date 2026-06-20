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
 * Read memory from a mounted host /proc/meminfo. We report used = MemTotal −
 * MemFree, which equals the cgroup's memory.current under lxcfs and matches what
 * Proxmox/`free` show for a container (page cache counts as used). Using
 * MemAvailable instead would subtract reclaimable cache and badly under-report
 * (e.g. 65 MB when the box is really using ~940 MB).
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
    if (free != null) return { total, used: Math.max(0, total - free) };
    const avail = kb('MemAvailable') ?? 0;
    return { total, used: Math.max(0, total - avail) };
  } catch {
    return null;
  }
}

// CPU% is derived from successive /proc/stat readings (the jiffies delta between
// two collections), so it reflects the machine/LXC, not the core container.
let prevCpu: { total: number; idle: number } | null = null;
function readHostCpuPercent(): number | null {
  try {
    const txt = fs.readFileSync(`${HOST_PROC}/stat`, 'utf8');
    const line = txt.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return null;
    const nums = line.trim().split(/\s+/).slice(1).map((n) => Number.parseInt(n, 10));
    if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return null;
    const idle = (nums[3] ?? 0) + (nums[4] ?? 0); // idle + iowait
    const total = nums.reduce((a, b) => a + b, 0);
    const prev = prevCpu;
    prevCpu = { total, idle };
    if (!prev) return null; // need a baseline first
    const dt = total - prev.total;
    const di = idle - prev.idle;
    if (dt <= 0) return null;
    return Math.max(0, Math.min(100, Math.round(((dt - di) / dt) * 100)));
  } catch {
    return null;
  }
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
  const cg = readHostCgroupMemory();
  if (cg && cg.total > 0) return cg;

  const host = readHostMeminfo();
  if (host && host.total > 0) return host;

  const hostTotal = mem?.total ?? 0;
  const cg = readCgroupMemory();
  if (cg && Number.isFinite(cg.limit) && cg.limit > 0 && (hostTotal === 0 || cg.limit < hostTotal)) {
    return { used: cg.used, total: cg.limit };
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

function pickDisk(list: Systeminformation.FsSizeData[]): { used: number; total: number } {
  if (!list || list.length === 0) return { used: 0, total: 0 };
  const byData = list.find((d) => d.mount && DATA_DIR.startsWith(d.mount) && d.size > 0);
  const root = list.find((d) => d.mount === '/' && d.size > 0);
  const largest = [...list].sort((a, b) => (b.size || 0) - (a.size || 0))[0];
  const chosen = byData ?? root ?? largest;
  return { used: chosen?.used ?? 0, total: chosen?.size ?? 0 };
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
