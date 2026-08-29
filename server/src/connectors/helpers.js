import path from 'node:path';
import { mapLimit } from '../lib/util.js';
import { buildDoc } from '../lib/normalize.js';

/**
 * 凭证解析：支持多种书写习惯，降低"一个凭证"的接入门槛。
 *  - JSON：{"api_key":"x","api_token":"y"} / {"account":"a","password":"p"}
 *  - 冒号分隔：api_key:api_token / account:password / user:token
 *  - 裸串：按 keys 顺序逐个填充
 */
export function parseCredential(credential, keys = ['token']) {
  const raw = String(credential || '').trim();
  if (!raw) return {};

  if (raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      /* 继续按分隔符解析 */
    }
  }

  const lower = raw.toLowerCase();
  if (lower.startsWith('cookie:')) {
    return { cookie: raw.slice(7).trim() };
  }
  if (lower.startsWith('bearer ')) {
    return { token: raw.slice(7).trim(), bearer: raw.slice(7).trim() };
  }

  if (raw.includes(':')) {
    const idx = raw.indexOf(':');
    const head = raw.slice(0, idx);
    const tail = raw.slice(idx + 1);
    // 形如 https://... 不做拆分
    if (!/^https?:\/\//i.test(raw)) {
      const out = {};
      out[keys[0]] = head;
      out[keys[1] || 'secret'] = tail;
      return out;
    }
  }

  const out = {};
  out[keys[0]] = raw;
  return out;
}

/** 统一构造文档并做数量上限保护 */
export function toDocs(source, items, mapper, max) {
  const docs = [];
  for (const raw of items) {
    let mapped;
    try {
      mapped = mapper(raw);
    } catch {
      continue;
    }
    if (!mapped || !mapped.title) continue;
    docs.push(buildDoc(source, mapped));
    if (max && docs.length >= max) break;
  }
  return docs;
}

export async function fetchDetailLimited(items, limit, mapper) {
  const results = await mapLimit(items, limit, async (it) => {
    try {
      return await mapper(it);
    } catch {
      return null;
    }
  });
  return results.filter(Boolean);
}

export const DEFAULT_TEXT_EXT = /\.(md|mdx|markdown|mkd|rst|txt|adoc|org)$/i;
export const DEFAULT_EXCLUDE_DIR =
  /(^|\/)(node_modules|\.git|\.svn|vendor|dist|build|out|target|coverage|\.next|\.nuxt|__pycache__|\.idea|\.vscode)(\/|$)/i;

export function shouldInclude(relPath, { include, exclude, extRegex = DEFAULT_TEXT_EXT } = {}) {
  const p = String(relPath).replace(/\\/g, '/');
  if (DEFAULT_EXCLUDE_DIR.test(p)) return false;
  if (exclude) {
    const re = new RegExp(exclude, 'i');
    if (re.test(p)) return false;
  }
  if (include) {
    return new RegExp(include, 'i').test(p);
  }
  return extRegex.test(p);
}

export function joinUrl(base, p = '') {
  if (!p) return base;
  if (/^https?:\/\//i.test(p)) return p;
  return `${base.replace(/\/+$/, '')}/${String(p).replace(/^\/+/, '')}`;
}

export function fileUrl(absPath) {
  return `file:///${path.resolve(absPath).replace(/\\/g, '/').replace(/^\//, '')}`;
}

export function titleFromPath(relPath) {
  return String(relPath).split(/[\\/]/).pop() || relPath;
}

/** 深层取值：deepGet(obj, 'a.b.0.c') */
export function deepGet(obj, path) {
  if (!obj) return undefined;
  const keys = String(path).split('.');
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}
