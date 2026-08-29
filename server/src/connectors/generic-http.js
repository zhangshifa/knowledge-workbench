import { request } from '../lib/http-client.js';
import { parseCredential, toDocs, joinUrl, deepGet } from './helpers.js';
import { htmlToText } from '../lib/normalize.js';

/**
 * 通用 OpenAPI / HTTP 连接器（兜底：任何提供 JSON 列表接口的系统都能接）
 * ------------------------------------------------------------------
 * 通过 options 描述"如何在目标系统拿到一个文档清单"：
 *   options.listPath     列表接口路径（相对 baseUrl）
 *   options.itemMapping  字段映射（对方字段名 → 统一字段名）
 *   options.contentPath  详情接口（可选，{id} 占位）
 *   options.pagination   分页配置
 *   options.authHeader   鉴权头写法：'bearer' | 'token' | 'basic' | 'query:xxx'
 */

function buildAuthHeaders(options, token) {
  const h = { ...(options.headers || {}) };
  const mode = (options.authHeader || 'bearer').toLowerCase();
  if (mode === 'bearer') h.Authorization = `Bearer ${token}`;
  else if (mode === 'token') h.Authorization = token;
  else if (mode === 'basic') h.Authorization = `Basic ${Buffer.from(token).toString('base64')}`;
  return h;
}

async function fetchList(baseUrl, options, token) {
  const headers = buildAuthHeaders(options, token);
  const url = joinUrl(baseUrl, options.listPath || '/items');
  const out = [];
  const size = options.pagination?.size || 100;
  const maxPages = options.pagination?.maxPages || 10;

  for (let page = 1; page <= maxPages; page++) {
    let pageUrl = url;
    const pag = options.pagination;
    if (pag?.type === 'page') {
      const sep = pageUrl.includes('?') ? '&' : '?';
      pageUrl += `${sep}${pag.param || 'page'}=${page}&${pag.sizeParam || 'per_page'}=${size}`;
    } else if (pag?.type === 'offset') {
      const sep = pageUrl.includes('?') ? '&' : '?';
      pageUrl += `${sep}${pag.param || 'offset'}=${(page - 1) * size}&${pag.sizeParam || 'limit'}=${size}`;
    }
    const res = await request(pageUrl, { method: options.method || 'GET', headers, timeout: 20000, retries: 1 });
    const j = JSON.parse(res.text.replace(/^﻿/, '').trim());
    const arr = deepGet(j, options.listRoot || 'data') || (Array.isArray(j) ? j : []);
    if (!Array.isArray(arr)) throw new Error('列表响应不是数组，请检查 listRoot 配置');
    out.push(...arr);
    if (arr.length < size) break;
  }
  return out;
}

export default {
  platform: 'generic',
  label: '通用 OpenAPI / HTTP',
  description: '通过可配置的 JSON 列表接口接入任意系统，作为兜底方案',
  defaultBaseUrl: 'https://api.example.com',
  credentialHint: '对方 API Token；字段映射在 options 里配置',
  credentialType: 'Token / API Key',
  fields: [
    { key: 'listPath', label: '列表接口路径', placeholder: '/api/v1/documents' },
    { key: 'listRoot', label: '列表数据所在 JSON 路径', placeholder: 'data.items' },
    { key: 'itemMapping', label: '字段映射（JSON）', placeholder: '{"id":"id","title":"name","content":"body"}' },
    { key: 'authHeader', label: '鉴权头：bearer/token/basic/query:xxx', placeholder: 'bearer' }
  ],

  async fetchAll({ source, credential, options = {}, max = 5000 }) {
    const { token } = parseCredential(credential, ['token']);
    const items = (await fetchList(source.baseUrl, options, token)).slice(0, max);

    let mapping = options.itemMapping || { id: 'id', title: 'title', content: 'content' };
    if (typeof mapping === 'string') mapping = JSON.parse(mapping);

    const docs = [];
    for (const it of items) {
      const id = deepGet(it, mapping.id || 'id');
      if (!id) continue;
      let content = deepGet(it, mapping.content || mapping.body);
      if (!content && options.contentPath) {
        const headers = buildAuthHeaders(options, token);
        const cUrl = joinUrl(source.baseUrl, options.contentPath.replace('{id}', encodeURIComponent(id)));
        try {
          const cRes = await request(cUrl, { method: 'GET', headers, timeout: 20000, retries: 1 });
          const cj = JSON.parse(cRes.text.replace(/^﻿/, '').trim());
          content = deepGet(cj, mapping.content || 'body') || cRes.text;
        } catch {
          content = '';
        }
      }
      docs.push({
        externalId: `generic:${id}`,
        title: deepGet(it, mapping.title || 'title') || String(id),
        path: deepGet(it, mapping.path || 'path') || String(id),
        url: deepGet(it, mapping.url || 'url') || '',
        content: String(content || ''),
        format: deepGet(it, mapping.format) || 'text',
        author: deepGet(it, mapping.author) || '',
        updatedAt: deepGet(it, mapping.updatedAt) || null,
        createdAt: deepGet(it, mapping.createdAt) || null,
        tags: deepGet(it, mapping.tags) || [],
        meta: { raw: it }
      });
    }
    return toDocs(source, docs, (d) => ({ ...d, plainText: undefined }));
  },

  async test({ baseUrl, credential, options = {} }) {
    const { token } = parseCredential(credential, ['token']);
    const items = await fetchList(baseUrl, options, token);
    return { ok: true, message: `连接成功，列表返回 ${items.length} 项`, sample: items.slice(0, 5).map((i) => i[options.itemMapping?.title || 'title'] || i.id) };
  }
};

export { htmlToText };
