import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from './config.js';
import { encrypt, decrypt } from './lib/crypto.js';
import { shortId, nowIso, maskSecret, clamp } from './lib/util.js';
import { SearchIndex } from './search.js';

const SOURCES_FILE = 'sources.json';
const INDEX_FILE = 'index.json';
const DOCS_DIR = 'docs';

function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

export class Store {
  constructor(cfg = config) {
    this.cfg = cfg;
    this.dataDir = cfg.dataDir;
    ensureDirs();
    /** Map<sourceId, SourceRecord> */
    this.sources = new Map();
    /** Map<docId, UnifiedDoc> */
    this.docs = new Map();
    /** Map<sourceId, Set<docId>> */
    this.bySource = new Map();
    this.index = new SearchIndex();
    this._saveTimer = null;
  }

  // ---------------------------------------------------------------- 载入

  load() {
    const sourcesFile = path.join(this.dataDir, SOURCES_FILE);
    if (fs.existsSync(sourcesFile)) {
      try {
        const arr = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'));
        for (const s of arr) this.sources.set(s.id, s);
      } catch (e) {
        console.warn(`[store] sources.json 解析失败，已忽略：${e.message}`);
      }
    }

    const docsDir = path.join(this.dataDir, DOCS_DIR);
    fs.mkdirSync(docsDir, { recursive: true });
    for (const file of fs.readdirSync(docsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const arr = JSON.parse(fs.readFileSync(path.join(docsDir, file), 'utf8'));
        const sourceId = file.replace(/\.json$/, '');
        const set = new Set();
        for (const d of arr) {
          this.docs.set(d.id, d);
          set.add(d.id);
        }
        this.bySource.set(sourceId, set);
      } catch (e) {
        console.warn(`[store] ${file} 解析失败，已忽略：${e.message}`);
      }
    }

    const indexFile = path.join(this.dataDir, INDEX_FILE);
    if (fs.existsSync(indexFile)) {
      try {
        this.index = SearchIndex.fromJSON(JSON.parse(fs.readFileSync(indexFile, 'utf8')));
      } catch {
        this.rebuildIndex();
      }
    } else {
      this.rebuildIndex();
    }

    const stale = this.index.meta.size !== this.docs.size;
    if (stale) this.rebuildIndex();

    return this;
  }

  rebuildIndex() {
    this.index.clear();
    for (const d of this.docs.values()) this.index.indexDoc(d);
    this.persistIndex();
  }

  // ---------------------------------------------------------------- 持久化

  persistSources() {
    atomicWrite(
      path.join(this.dataDir, SOURCES_FILE),
      JSON.stringify(Array.from(this.sources.values()), null, 2)
    );
  }

  persistDocs(sourceId) {
    const ids = this.bySource.get(sourceId) || new Set();
    const arr = [];
    for (const id of ids) {
      const d = this.docs.get(id);
      if (d) arr.push(d);
    }
    atomicWrite(path.join(this.dataDir, DOCS_DIR, `${sourceId}.json`), JSON.stringify(arr, null, 2));
  }

  persistIndex() {
    atomicWrite(path.join(this.dataDir, INDEX_FILE), JSON.stringify(this.index.toJSON()));
  }

  /** 合并写盘，避免同步过程中频繁 IO */
  schedulePersist() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.persistIndex();
    }, 800);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  // ---------------------------------------------------------------- 数据源

  listSources() {
    return Array.from(this.sources.values()).map((s) => this.maskSource(s));
  }

  maskSource(s) {
    return {
      ...s,
      credential: undefined,
      credentialEnc: undefined,
      credentialMasked: s.credentialMasked || '',
      hasCredential: Boolean(s.credentialEnc)
    };
  }

  getSource(id) {
    return this.sources.get(id) || null;
  }

  /** 取出明文凭证（仅内部使用，绝不回显到 API） */
  getCredential(source) {
    if (!source || !source.credentialEnc) return '';
    return decrypt(source.credentialEnc, this.dataDir);
  }

  createSource(input) {
    const id = shortId('src');
    const rec = {
      id,
      name: input.name || input.platform,
      platform: input.platform,
      baseUrl: String(input.baseUrl || '').replace(/\/+$/, ''),
      credentialEnc: input.credential ? encrypt(input.credential, this.dataDir) : '',
      credentialMasked: maskSecret(input.credential || ''),
      options: input.options || {},
      enabled: input.enabled !== false,
      syncIntervalMinutes: input.syncIntervalMinutes ?? this.cfg.syncIntervalMinutes,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastSync: null,
      docCount: 0
    };
    this.sources.set(id, rec);
    this.bySource.set(id, new Set());
    this.persistSources();
    return rec;
  }

  updateSource(id, patch) {
    const rec = this.sources.get(id);
    if (!rec) return null;
    if (patch.name !== undefined) rec.name = patch.name;
    if (patch.baseUrl !== undefined) rec.baseUrl = String(patch.baseUrl).replace(/\/+$/, '');
    if (patch.enabled !== undefined) rec.enabled = Boolean(patch.enabled);
    if (patch.options !== undefined) rec.options = { ...rec.options, ...patch.options };
    if (patch.syncIntervalMinutes !== undefined) {
      rec.syncIntervalMinutes = Number(patch.syncIntervalMinutes);
    }
    if (patch.credential) {
      rec.credentialEnc = encrypt(patch.credential, this.dataDir);
      rec.credentialMasked = maskSecret(patch.credential);
    }
    rec.updatedAt = nowIso();
    this.persistSources();
    return rec;
  }

  deleteSource(id) {
    const rec = this.sources.get(id);
    if (!rec) return false;
    for (const docId of this.bySource.get(id) || []) {
      this.docs.delete(docId);
      this.index.removeDoc(docId);
    }
    this.bySource.delete(id);
    this.sources.delete(id);
    const f = path.join(this.dataDir, DOCS_DIR, `${id}.json`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    this.persistSources();
    this.persistIndex();
    return true;
  }

  recordSync(id, result) {
    const rec = this.sources.get(id);
    if (!rec) return;
    rec.lastSync = {
      status: result.status,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      count: result.count,
      error: result.error || null
    };
    rec.updatedAt = nowIso();
    this.persistSources();
  }

  // ---------------------------------------------------------------- 文档

  /**
   * 幂等写入某数据源的文档集合，并归档源端已删除的条目。
   * @returns {{added:number, updated:number, archived:number}}
   */
  saveDocs(sourceId, docs) {
    const prev = this.bySource.get(sourceId) || new Set();
    const next = new Set();
    let added = 0;
    let updated = 0;

    for (const d of docs) {
      next.add(d.id);
      if (prev.has(d.id)) updated++;
      else added++;
      this.docs.set(d.id, d);
      this.index.indexDoc(d);
    }

    let archived = 0;
    for (const oldId of prev) {
      if (!next.has(oldId)) {
        this.docs.delete(oldId);
        this.index.removeDoc(oldId);
        archived++;
      }
    }

    this.bySource.set(sourceId, next);
    const rec = this.sources.get(sourceId);
    if (rec) rec.docCount = next.size;

    this.persistDocs(sourceId);
    this.persistSources();
    this.schedulePersist();
    return { added, updated, archived };
  }

  getDoc(id) {
    return this.docs.get(id) || null;
  }

  allDocs() {
    return Array.from(this.docs.values());
  }

  listDocs({ sourceId, platform, type, limit = 50, offset = 0, sort = 'updated' } = {}) {
    let arr = this.allDocs();
    if (sourceId) arr = arr.filter((d) => d.sourceId === sourceId);
    if (platform) arr = arr.filter((d) => d.platform === platform);
    if (type) arr = arr.filter((d) => d.type === type);

    arr.sort((a, b) => {
      if (sort === 'title') return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
      const ta = new Date(a.updatedAt || a.indexedAt || 0).getTime();
      const tb = new Date(b.updatedAt || b.indexedAt || 0).getTime();
      return tb - ta;
    });

    const total = arr.length;
    const page = arr.slice(clamp(offset, 0, total), clamp(offset, 0, total) + clamp(limit, 1, 500));
    return { total, items: page };
  }

  stats() {
    const byPlatform = {};
    for (const d of this.docs.values()) {
      byPlatform[d.platform] = (byPlatform[d.platform] || 0) + 1;
    }
    return {
      sources: this.sources.size,
      enabledSources: Array.from(this.sources.values()).filter((s) => s.enabled).length,
      docs: this.docs.size,
      byPlatform,
      index: this.index.stats(),
      dataDir: this.dataDir,
      lastSyncAt:
        Array.from(this.sources.values())
          .map((s) => s.lastSync?.finishedAt)
          .filter(Boolean)
          .sort()
          .pop() || null
    };
  }

  /** 导出知识库为 JSON 包（避免平台锁定） */
  exportBundle({ sourceId } = {}) {
    const docs = sourceId
      ? Array.from(this.bySource.get(sourceId) || []).map((id) => this.docs.get(id))
      : this.allDocs();
    return {
      exportedAt: nowIso(),
      version: '0.1.0',
      sources: this.listSources(),
      docs: docs.filter(Boolean)
    };
  }
}

export function createStore() {
  return new Store().load();
}
