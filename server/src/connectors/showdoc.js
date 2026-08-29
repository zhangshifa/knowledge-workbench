import { request, requestJson } from '../lib/http-client.js';
import { parseCredential, toDocs, joinUrl } from './helpers.js';
import { htmlToText } from '../lib/normalize.js';

/**
 * ShowDoc 适配器
 * ------------------------------------------------------------------
 * 认证：api_key + api_token（ShowDoc「开放 API」页面生成）
 * 凭证写法（任选其一）：
 *   {"api_key":"xxx","api_token":"yyy"}
 *   xxx:yyy
 *   cookie: xxx=yyy; zzz=www       （无开放 API 权限时的降级方案）
 * 可选配置项：
 *   options.itemId      只同步指定项目
 *   options.endpoints   覆盖默认接口路径，适配自部署版本差异
 */

const DEFAULT_ENDPOINTS = {
  itemList: [
    '/server/index.php?s=/api/item/list',
    '/api/item/list',
    '/server/index.php?s=/api/openapi/itemList'
  ],
  pageList: [
    '/server/index.php?s=/api/page/list',
    '/api/page/list',
    '/server/index.php?s=/api/catalogue/list',
    '/api/catalogue/list'
  ],
  pageInfo: [
    '/server/index.php?s=/api/page/info',
    '/api/page/info',
    '/server/index.php?s=/api/openapi/pageInfo'
  ]
};

function authForm(cred) {
  const form = {};
  if (cred.api_key) form.api_key = cred.api_key;
  if (cred.api_token) form.api_token = cred.api_token;
  if (cred.token && !cred.api_token) form.api_token = cred.token;
  return form;
}

function authHeaders(cred) {
  const h = {};
  if (cred.cookie) h.Cookie = cred.cookie;
  return h;
}

async function postApi(baseUrl, paths, form, cred, opts = {}) {
  let lastErr = null;
  for (const p of paths) {
    try {
      const res = await request(joinUrl(baseUrl, p), {
        method: 'POST',
        form: { ...form, ...authForm(cred) },
        headers: authHeaders(cred),
        timeout: opts.timeout || 20000,
        retries: 1
      });
      if (res.status === 404) continue;
      const data = JSON.parse(res.text.replace(/^﻿/, '').trim());
      if (data && Number(data.error_code) === 0) return data.data;
      if (data && data.data !== undefined) return data.data;
      lastErr = new Error(data?.error_message || `error_code=${data?.error_code}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`ShowDoc 接口调用失败：${lastErr?.message || '无可用端点'}`);
}

function normalizePage(p) {
  return {
    page_id: p.page_id ?? p.id ?? p.pageId,
    page_title: p.page_title ?? p.title ?? p.page_name ?? p.cat_name,
    item_id: p.item_id ?? p.itemId
  };
}

export default {
  platform: 'showdoc',
  label: 'ShowDoc',
  description: 'ShowDoc 文档站：项目 → 目录 → 页面正文，支持开放 API 与 Cookie 两种凭证',
  defaultBaseUrl: 'https://doc.example.com',
  credentialHint: '开放 API 的 api_key + api_token，写法：{"api_key":"...","api_token":"..."} 或 key:token',
  credentialType: 'api_key / api_token（或 Cookie）',
  fields: [
    { key: 'itemId', label: '只同步指定项目 ID（留空=全部）', placeholder: '如 12' },
    { key: 'endpoints.itemList', label: '项目列表接口（可选覆盖）', placeholder: '/server/index.php?s=/api/item/list' },
    { key: 'endpoints.pageList', label: '页面列表接口（可选覆盖）', placeholder: '/server/index.php?s=/api/page/list' },
    { key: 'endpoints.pageInfo', label: '页面详情接口（可选覆盖）', placeholder: '/server/index.php?s=/api/page/info' }
  ],

  async fetchAll({ source, credential, options = {}, max }) {
    const cred = parseCredential(credential, ['api_key', 'api_token']);
    const ep = { ...DEFAULT_ENDPOINTS, ...(options.endpoints || {}) };
    const list = (v, d) => (Array.isArray(v) ? v : v ? [v] : d);

    // 1. 项目
    let items = [];
    if (options.itemId) {
      items = [{ item_id: String(options.itemId), item_name: options.itemName || '指定项目' }];
    } else {
      const data = await postApi(source.baseUrl, list(ep.itemList, DEFAULT_ENDPOINTS.itemList), {}, cred);
      items = (Array.isArray(data) ? data : data?.items || []).map((it) => ({
        item_id: it.item_id ?? it.id,
        item_name: it.item_name ?? it.name ?? it.item_domain
      }));
    }
    if (!items.length) throw new Error('未获取到任何 ShowDoc 项目，请检查凭证与接口地址');

    // 2. 页面清单
    const pages = [];
    for (const item of items) {
      const data = await postApi(
        source.baseUrl,
        list(ep.pageList, DEFAULT_ENDPOINTS.pageList),
        { item_id: item.item_id },
        cred
      );
      const arr = Array.isArray(data) ? data : data?.pages || data?.list || [];
      for (const p of arr) {
        const np = normalizePage(p);
        if (!np.page_id) continue;
        pages.push({ ...np, item_name: item.item_name });
      }
    }

    const uniq = new Map();
    for (const p of pages) if (!uniq.has(String(p.page_id))) uniq.set(String(p.page_id), p);
    const targets = Array.from(uniq.values()).slice(0, max || 2000);

    // 3. 正文
    const rawDocs = [];
    for (const p of targets) {
      try {
        const data = await postApi(
          source.baseUrl,
          list(ep.pageInfo, DEFAULT_ENDPOINTS.pageInfo),
          { page_id: p.page_id },
          cred,
          { timeout: 20000 }
        );
        const info = Array.isArray(data) ? data[0] : data;
        if (!info) continue;
        const content = info.page_content ?? info.content ?? info.page_md ?? '';
        rawDocs.push({
          externalId: `page:${p.page_id}`,
          title: info.page_title || info.title || p.page_title || '(无标题)',
          path: `${p.item_name || ''}/${info.cat_name || ''}`.replace(/\/+/g, '/'),
          url: joinUrl(source.baseUrl, `/web/#/${info.item_id ?? ''}/${p.page_id}`),
          content: String(content),
          format: 'markdown',
          author: info.author_username || info.author || '',
          updatedAt: info.page_addtime ? new Date(Number(info.page_addtime) * 1000).toISOString() : null,
          meta: { item_id: p.item_id, page_id: p.page_id, item_name: p.item_name }
        });
      } catch {
        /* 单页失败不影响整体 */
      }
      if (rawDocs.length >= (max || 2000)) break;
    }

    return toDocs(source, rawDocs, (d) => ({
      ...d,
      plainText: htmlToText(d.content).slice(0, 20000)
    }));
  },

  async test({ baseUrl, credential, options = {} }) {
    const cred = parseCredential(credential, ['api_key', 'api_token']);
    const ep = { ...DEFAULT_ENDPOINTS, ...(options.endpoints || {}) };
    const data = await postApi(baseUrl, ep.itemList, {}, cred, { timeout: 12000 });
    const arr = Array.isArray(data) ? data : data?.items || [];
    return {
      ok: true,
      message: `连接成功，可访问 ${arr.length} 个项目`,
      sample: arr.slice(0, 5).map((i) => i.item_name || i.name || String(i.item_id))
    };
  }
};

export { requestJson };
