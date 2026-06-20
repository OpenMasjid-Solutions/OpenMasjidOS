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

/** Read MemTotal/MemAvailable from a mounted host /proc/meminfo. */
function readHostMeminfo(): { total: number; used: number } | null {
  try {
    const txt = fs.readFileSync(`${HOST_PROC}/meminfo`, 'utf8');
    const kb = (key: string): number | null => {
      const m = txt.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
      return m ? Number.parseInt(m[1], 10) * 1024 : null;
    };
    const total = kb('MemTotal');
    if (!total) return null;
    const avail = kb('MemAvailable');
    if (avail != null) return { total, used: Math.max(0, total - avail) };
    const free = kb('MemFree') ?? 0;
    return { total, used: Math.max(0, total - free) };
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

function resolveMemory(mem: Systeminformation.MemData | null): { used: number; total: number } {
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

  return {
    cpuPercent: load ? Math.max(0, Math.min(100, Math.round(load.currentLoad))) : 0,
    cpuCores: cpu.cores,
    cpuSpeedGHz: cpu.speedGHz,
    memUsed: memory.used,
    memTotal: memory.total,
    diskUsed: disk.used,
    diskTotal: disk.total,
    cpuTempC,
    uptimeSec: Math.round(si.time().uptime ?? 0),
    appsRunning,
  };
}
