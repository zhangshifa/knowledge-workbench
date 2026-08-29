const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+/g;
const LATIN = /[a-zA-Z0-9_][a-zA-Z0-9_\-.+#]*/g;

const K1 = 1.5;
const B = 0.75;

/**
 * 中英文混合分词：
 * - 中文按 bigram（二字滑窗），兼顾召回与精度
 * - 英文 / 数字按词元，统一小写
 * - 单字中文单独保留，避免"短查询"完全失配
 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];

  for (const m of s.match(LATIN) || []) {
    if (m.length >= 2) out.push(m);
  }

  for (const run of s.match(CJK_RUN) || []) {
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    // 长词再补一个三元组，提升短语命中率
    if (run.length >= 4) {
      for (let i = 0; i < run.length - 2; i++) out.push(run.slice(i, i + 3));
    }
  }
  return out;
}

export function tokenizeWithFreq(text) {
  const map = new Map();
  for (const t of tokenize(text)) map.set(t, (map.get(t) || 0) + 1);
  return map;
}

export class SearchIndex {
  constructor() {
    /** token -> Map(docId -> tf) */
    this.postings = new Map();
    /** docId -> { len, sourceId, platform, type, tags, updatedAt, title } */
    this.meta = new Map();
    this.totalLen = 0;
    this.docCount = 0;
    this.dirty = false;
  }

  removeDoc(id) {
    const m = this.meta.get(id);
    if (!m) return;
    this.totalLen = Math.max(0, this.totalLen - m.len);
    this.docCount = Math.max(0, this.docCount - 1);
    this.meta.delete(id);
    for (const [token, pm] of this.postings) {
      if (pm.delete(id)) {
        if (pm.size === 0) this.postings.delete(token);
      }
    }
    this.dirty = true;
  }

  indexDoc(doc) {
    if (!doc || !doc.id) return;
    this.removeDoc(doc.id);

    const titleTokens = tokenizeWithFreq(doc.title || '');
    const bodyTokens = tokenizeWithFreq(doc.plainText || doc.content || '');
    const tagTokens = tokenizeWithFreq((doc.tags || []).join(' '));

    const combined = new Map();
    const merge = (map, weight) => {
      for (const [t, f] of map) combined.set(t, (combined.get(t) || 0) + f * weight);
    };
    merge(titleTokens, 3);
    merge(tagTokens, 2);
    merge(bodyTokens, 1);

    let len = 0;
    for (const [, f] of combined) len += f;

    for (const [t, f] of combined) {
      let pm = this.postings.get(t);
      if (!pm) {
        pm = new Map();
        this.postings.set(t, pm);
      }
      pm.set(doc.id, f);
    }

    this.meta.set(doc.id, {
      len,
      sourceId: doc.sourceId,
      platform: doc.platform,
      type: doc.type,
      tags: doc.tags || [],
      updatedAt: doc.updatedAt || doc.indexedAt || null,
      title: doc.title || ''
    });
    this.totalLen += len;
    this.docCount += 1;
    this.dirty = true;
  }

  /** 重建某个数据源的全部索引 */
  reindexSource(sourceId, docs) {
    for (const [id, m] of this.meta) {
      if (m.sourceId === sourceId) this.removeDoc(id);
    }
    for (const d of docs) this.indexDoc(d);
  }

  clear() {
    this.postings.clear();
    this.meta.clear();
    this.totalLen = 0;
    this.docCount = 0;
    this.dirty = true;
  }

  get avgLen() {
    return this.docCount > 0 ? this.totalLen / this.docCount : 0;
  }

  /**
   * BM25 检索。
   * @returns {Array<{id:string, score:number, matched:string[]}>}
   */
  score(query, { platform, sourceId, type, tags } = {}) {
    const qTokens = Array.from(new Set(tokenize(query)));
    if (qTokens.length === 0) return [];

    const scores = new Map();
    const matchedMap = new Map();
    const avgLen = this.avgLen;

    for (const qt of qTokens) {
      const pm = this.postings.get(qt);
      if (!pm || pm.size === 0) continue;
      const df = pm.size;
      const idf = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));

      for (const [docId, tf] of pm) {
        const m = this.meta.get(docId);
        if (!m) continue;
        if (platform && m.platform !== platform) continue;
        if (sourceId && m.sourceId !== sourceId) continue;
        if (type && m.type !== type) continue;
        if (tags && tags.length && !tags.some((t) => (m.tags || []).includes(t))) continue;

        const denom = tf + K1 * (1 - B + (B * m.len) / (avgLen || 1));
        const s = idf * ((tf * (K1 + 1)) / (denom || 1));
        scores.set(docId, (scores.get(docId) || 0) + s);
        const arr = matchedMap.get(docId) || [];
        arr.push(qt);
        matchedMap.set(docId, arr);
      }
    }

    return Array.from(scores.entries())
      .map(([id, score]) => ({ id, score, matched: Array.from(new Set(matchedMap.get(id) || [])) }))
      .sort((a, b) => b.score - a.score);
  }

  stats() {
    return {
      docCount: this.docCount,
      tokenCount: this.postings.size,
      avgLen: Number(this.avgLen.toFixed(2))
    };
  }

  toJSON() {
    const postings = {};
    for (const [t, pm] of this.postings) postings[t] = Array.from(pm.entries());
    return {
      version: 1,
      postings,
      meta: Array.from(this.meta.entries()),
      totalLen: this.totalLen,
      docCount: this.docCount
    };
  }

  static fromJSON(data) {
    const idx = new SearchIndex();
    if (!data) return idx;
    for (const [t, arr] of Object.entries(data.postings || {})) {
      idx.postings.set(t, new Map(arr));
    }
    idx.meta = new Map(data.meta || []);
    idx.totalLen = data.totalLen || 0;
    idx.docCount = data.docCount || idx.meta.size;
    return idx;
  }
}

/** 生成高亮片段：命中词附近开窗 */
export function makeSnippet(text, query, len = 160) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  let pos = -1;
  for (const t of tokenize(query)) {
    const p = lower.indexOf(t);
    if (p >= 0) {
      pos = p;
      break;
    }
  }
  if (pos < 0) return raw.slice(0, len) + (raw.length > len ? '…' : '');
  const start = Math.max(0, pos - Math.floor(len / 3));
  const end = Math.min(raw.length, start + len);
  return (start > 0 ? '…' : '') + raw.slice(start, end) + (end < raw.length ? '…' : '');
}

export function highlight(text, query) {
  let out = String(text || '');
  const terms = Array.from(new Set(tokenize(query)))
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const t of terms) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  }
  return out;
}
