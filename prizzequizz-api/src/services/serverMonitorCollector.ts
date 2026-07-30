/* Built-in collector: records THIS host's real metrics (CPU%, RAM, disk, load,
 * uptime) into the 'self' monitor server every N seconds. CPU% is derived from
 * os.cpus() busy/idle deltas between samples; disk from fs.statfs('/'). */
import os from 'node:os';
import { statfs } from 'node:fs';
import { ensureSelfServer, recordMetric } from './serverMonitorService.js';
import { logger } from './logger.js';

let prev: { idle: number; total: number } | null = null;
function cpuSample(): { idle: number; total: number } {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const k of Object.keys(c.times) as (keyof typeof c.times)[]) total += c.times[k]; idle += c.times.idle; }
  return { idle, total };
}
function cpuPercent(): number {
  const s = cpuSample();
  if (!prev) { prev = s; return 0; }
  const idleDiff = s.idle - prev.idle, totalDiff = s.total - prev.total;
  prev = s;
  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)));
}
function diskUsage(path = '/'): Promise<{ used: number; total: number }> {
  return new Promise((resolve) => {
    try {
      statfs(path, (err, st: any) => {
        if (err || !st) return resolve({ used: 0, total: 0 });
        const bsize = Number(st.bsize || st.blocks && 4096 || 4096);
        const total = Number(st.blocks) * bsize;
        const free = Number(st.bavail) * bsize;
        resolve({ used: Math.max(0, total - free), total });
      });
    } catch { resolve({ used: 0, total: 0 }); }
  });
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startServerMonitorCollector(intervalMs = 15_000): void {
  if (timer) return;
  cpuSample(); prev = cpuSample(); // prime
  const tick = async () => {
    try {
      await ensureSelfServer();
      const load = os.loadavg();
      const memTotal = os.totalmem();
      const memUsed = memTotal - os.freemem();
      const disk = await diskUsage(process.env.MONITOR_DISK_PATH || '/');
      await recordMetric('self', {
        cpuPercent: cpuPercent(), memUsed, memTotal, diskUsed: disk.used, diskTotal: disk.total,
        load1: load[0] ?? 0, load5: load[1] ?? 0, load15: load[2] ?? 0, uptimeSec: Math.round(os.uptime()),
        extra: { cores: os.cpus().length, platform: os.platform(), hostname: os.hostname(), nodeMem: process.memoryUsage().rss }
      });
    } catch (e) { logger.warn('monitor_collect_failed', { message: (e as Error).message }); }
  };
  void tick();
  timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  logger.info('monitor_collector_started', { intervalMs });
}
export function stopServerMonitorCollector(): void { if (timer) { clearInterval(timer); timer = null; } }
