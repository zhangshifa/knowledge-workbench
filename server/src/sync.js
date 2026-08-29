import { getConnector } from './connectors/index.js';
import { nowIso, errMessage, redact } from './lib/util.js';

/**
 * 同步引擎
 * - 单源串行锁，避免并发重复同步
 * - 任何异常都收敛为 lastSync 状态，不向外抛出
 * - 同步后重建该源的索引切片
 */
export class SyncEngine {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.running = new Set();
    this.log = [];
  }

  /**
   * @param {string} sourceId
   * @returns {Promise<{status:string, count:number, added:number, updated:number, archived:number, error?:string, durationMs:number}>}
   */
  async syncSource(sourceId) {
    const source = this.store.getSource(sourceId);
    if (!source) return { status: 'failed', count: 0, error: '数据源不存在', durationMs: 0 };
    if (this.running.has(sourceId)) {
      return { status: 'skipped', count: 0, error: '该数据源正在同步中', durationMs: 0 };
    }

    const startedAt = nowIso();
    const t0 = Date.now();
    this.running.add(sourceId);

    try {
      const connector = getConnector(source.platform);
      if (!connector) throw new Error(`未注册的平台类型：${source.platform}`);

      const credential = this.store.getCredential(source);
      if (!credential && !connector.noCredential && !connector.credentialOptional) {
        throw new Error('缺少凭证，请在数据源中填写凭证后重试');
      }

      const docs = await connector.fetchAll({
        source,
        credential,
        options: source.options || {},
        max: this.cfg.maxDocsPerSource
      });

      const { added, updated, archived } = this.store.saveDocs(sourceId, docs);
      const durationMs = Date.now() - t0;
      const result = {
        status: 'success',
        startedAt,
        finishedAt: nowIso(),
        durationMs,
        count: docs.length,
        added,
        updated,
        archived
      };
      this.store.recordSync(sourceId, result);
      this.#appendLog(source, result);
      return result;
    } catch (e) {
      const durationMs = Date.now() - t0;
      const result = {
        status: 'failed',
        startedAt,
        finishedAt: nowIso(),
        durationMs,
        count: 0,
        error: errMessage(e)
      };
      this.store.recordSync(sourceId, result);
      this.#appendLog(source, result);
      return result;
    } finally {
      this.running.delete(sourceId);
    }
  }

  async syncAll() {
    const ids = Array.from(this.store.sources.values())
      .filter((s) => s.enabled)
      .map((s) => s.id);
    const results = [];
    for (const id of ids) results.push({ sourceId: id, ...(await this.syncSource(id)) });
    return results;
  }

  /** 用临时凭证做连接测试，不落库 */
  async testConnection({ platform, baseUrl, credential, options }) {
    const connector = getConnector(platform);
    if (!connector) throw new Error(`未注册的平台类型：${platform}`);
    if (!connector.test) throw new Error('该平台不支持连接测试');
    return connector.test({
      baseUrl,
      credential,
      options: options || {}
    });
  }

  #appendLog(source, result) {
    this.log.unshift({
      at: nowIso(),
      sourceId: source.id,
      name: source.name,
      platform: source.platform,
      status: result.status,
      count: result.count || 0,
      durationMs: result.durationMs,
      error: result.error ? redact(result.error) : null
    });
    if (this.log.length > 200) this.log.length = 200;
  }
}

/** 定时调度：按各自 syncIntervalMinutes 扫描 */
export function startScheduler(engine, store, intervalMinutes) {
  if (!intervalMinutes || intervalMinutes <= 0) return null;
  const tick = async () => {
    const now = Date.now();
    for (const s of store.sources.values()) {
      if (!s.enabled) continue;
      const every = Number(s.syncIntervalMinutes || intervalMinutes);
      if (every <= 0) continue;
      const last = s.lastSync?.finishedAt ? new Date(s.lastSync.finishedAt).getTime() : 0;
      if (now - last >= every * 60 * 1000) {
        engine.syncSource(s.id).catch(() => {});
      }
    }
  };
  const timer = setInterval(tick, Math.max(1, intervalMinutes) * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}
