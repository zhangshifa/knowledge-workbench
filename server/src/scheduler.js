import { runSync } from './connectors/index.js';
import { mapLimit } from './lib/util.js';

/**
 * 定时同步调度：每分钟巡检，对到点的启用数据源触发同步。
 * 不同源之间并发受控（mapLimit），单源失败不影响其他源。
 */
export function startScheduler(store, { syncOnBoot = false, syncIntervalMinutes = 120 } = {}) {
  if (syncIntervalMinutes === 0 && !syncOnBoot) {
    console.log('[scheduler] 定时同步已关闭（KB_SYNC_INTERVAL_MINUTES=0）');
    return { stop: () => {} };
  }

  const tick = async () => {
    const sources = store.listSources().filter((s) => s.enabled);
    const now = Date.now();
    const due = sources.filter((s) => {
      const interval = s.syncIntervalMinutes || syncIntervalMinutes;
      if (!interval || interval <= 0) return false;
      if (!s.lastSync?.finishedAt) return true;
      const elapsed = now - Date.parse(s.lastSync.finishedAt);
      return elapsed >= interval * 60 * 1000;
    });
    if (!due.length) return;
    console.log(`[scheduler] 触发 ${due.length} 个数据源同步`);
    await mapLimit(due, 3, async (s) => {
      try {
        const rec = store.getSource(s.id);
        await runSync(store, rec);
      } catch (e) {
        store.recordSync(s.id, {
          status: 'failed',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          count: 0,
          error: e.message
        });
        console.warn(`[scheduler] 同步失败 ${s.id}: ${e.message}`);
      }
    });
  };

  if (syncOnBoot) {
    setTimeout(tick, 1500);
  }
  const timer = setInterval(tick, 60 * 1000);
  if (timer.unref) timer.unref();

  return {
    stop: () => clearInterval(timer),
    tick
  };
}
