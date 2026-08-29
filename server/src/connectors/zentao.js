import { request } from '../lib/http-client.js';
import { parseCredential, toDocs, joinUrl } from './helpers.js';
import { htmlToText } from '../lib/normalize.js';

/**
 * 禅道（ZenTao）适配器
 * ------------------------------------------------------------------
 * 支持两种接口：
 *   1) REST v1（禅道 18+，默认）：用 账号+密码 换取 token，再带 token 拉取
 *   2) 老版本 session 接口（options.authMode='legacy'）：用 getSessionID + model API
 * 凭证写法：
 *   {"account":"admin","password":"xxx"}   （REST v1，默认）
 *   account:password
 *   {"token":"xxxx"}                       （options.authMode='token'，直接持有 token）
 */

function headersV1(token) {
  return { Token: token, Authorization: `token ${token}`, Accept: 'application/json' };
}

async function apiJson(url, { headers, timeout = 25000, retries = 1 } = {}) {
  const res = await request(url, { method: 'GET', headers, timeout, retries });
  if (res.status >= 400) throw new Error(`禅道请求失败 HTTP ${res.status}: ${url}`);
  const text = res.text.replace(/^﻿/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`禅道返回非 JSON：${text.slice(0, 160)}`);
  }
}

async function getV1Token(baseUrl, credential) {
  const { account, password } = parseCredential(credential, ['account', 'password']);
  const auth = 'Basic ' + Buffer.from(`${account}:${password}`).toString('base64');
  const res = await request(joinUrl(baseUrl, '/api.php/v1/tokens'), {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({}),
    timeout: 15000
  });
  if (res.status !== 200) throw new Error(`禅道获取 token 失败 HTTP ${res.status}`);
  const data = JSON.parse(res.text.replace(/^﻿/, '').trim());
  const token = data?.token || data?.data?.token;
  if (!token) throw new Error('禅道未返回 token，请确认账号密码或接口版本');
  return token;
}

async function listPaged(baseUrl, path, token, { maxPages = 10, size = 50 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const url = joinUrl(baseUrl, `${path}${sep}page=${page}&limit=${size}`);
    let data;
    try {
      data = await apiJson(url, { headers: headersV1(token) });
    } catch (e) {
      if (page === 1) throw e;
      break;
    }
    const arr = data?.products || data?.executions || data?.stories || data?.tasks || data?.bugs ||
      data?.docs || data?.data || (Array.isArray(data) ? data : []);
    if (!Array.isArray(arr) || arr.length === 0) break;
    out.push(...arr);
    if (arr.length < size) break;
  }
  return out;
}

export default {
  platform: 'zentao',
  label: '禅道 ZenTao',
  description: '禅道需求 / 任务 / Bug / 文档统一接入（REST v1 与老版本 session 双通道）',
  defaultBaseUrl: 'https://zentao.example.com',
  credentialHint: '账号+密码换取 token，写法：{"account":"admin","password":"xxx"} 或 admin:password',
  credentialType: '账号密码 / Token',
  fields: [
    { key: 'authMode', label: '认证模式：v1(默认) / token / legacy', placeholder: 'v1' },
    { key: 'modules', label: '同步模块（逗号：product,story,task,bug,doc）', placeholder: 'story,task,bug,doc' },
    { key: 'productId', label: '只同步指定产品 ID（可选）', placeholder: '1' }
  ],

  async fetchAll({ source, credential, options = {}, max = 5000 }) {
    const modules = (options.modules || 'product,story,task,bug,doc')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const base = source.baseUrl;

    let token = null;
    if (options.authMode === 'token') {
      token = parseCredential(credential, ['token']).token || credential;
    } else if (options.authMode === 'legacy') {
      return legacySync(base, credential, modules, options, source, max);
    } else {
      token = await getV1Token(base, credential);
    }

    const raw = [];
    const push = (arr, type, extra = {}) => {
      for (const it of arr) raw.push({ ...it, _type: type, ...extra });
    };

    // 产品
    if (modules.includes('product')) {
      const products = await listPaged(base, '/api.php/v1/products', token);
      push(products, 'product');
      if (modules.includes('story') || modules.includes('bug')) {
        for (const p of products) {
          if (options.productId && String(p.id) !== String(options.productId)) continue;
          if (modules.includes('story')) {
            const stories = await listPaged(base, `/api.php/v1/products/${p.id}/stories`, token);
            push(stories, 'story', { product: p.name });
          }
          if (modules.includes('bug')) {
            const bugs = await listPaged(base, `/api.php/v1/products/${p.id}/bugs`, token);
            push(bugs, 'bug', { product: p.name });
          }
          if (raw.length >= max) break;
        }
      }
    }

    // 执行（项目）与任务
    if (modules.includes('execution') || modules.includes('task')) {
      const execs = await listPaged(base, '/api.php/v1/executions', token);
      if (modules.includes('task')) {
        for (const e of execs) {
          const tasks = await listPaged(base, `/api.php/v1/executions/${e.id}/tasks`, token);
          push(tasks, 'task', { execution: e.name });
          if (raw.length >= max) break;
        }
      }
    }

    // 文档
    if (modules.includes('doc')) {
      const docs = await listPaged(base, '/api.php/v1/docs', token);
      push(docs, 'doc');
    }

    const items = raw.slice(0, max).map((it) => mapZentaoItem(it, base));
    return toDocs(source, items, (d) => d);
  },

  async test({ baseUrl, credential, options = {} }) {
    let token = null;
    if (options.authMode === 'token' || options.authMode === 'legacy') {
      return { ok: true, message: 'legacy/token 模式：建源后将在首次同步验证', sample: [] };
    }
    token = await getV1Token(baseUrl, credential);
    const products = await listPaged(baseUrl, '/api.php/v1/products', token, { maxPages: 1 });
    return {
      ok: true,
      message: `token 获取成功，可访问 ${products.length}+ 个产品`,
      sample: products.slice(0, 5).map((p) => p.name)
    };
  }
};

function mapZentaoItem(it, base) {
  const id = it.id;
  const type = it._type || 'doc';
  const title =
    it.title || it.name || it.subject || it.key || `(禅道${type}#${id})`;
  const body = it.spec || it.desc || it.description || it.content || it.summary || '';
  const urlMap = {
    story: `/story-view-${id}.html`,
    task: `/task-view-${id}.html`,
    bug: `/bug-view-${id}.html`,
    product: `/product-view-${id}.html`,
    doc: `/doc-view-${id}.html`
  };
  return {
    externalId: `${type}:${id}`,
    title,
    path: [it.product, it.execution, title].filter(Boolean).join('/'),
    url: joinUrl(base, urlMap[type] || `/index.php?m=${type}&f=view&id=${id}`),
    content: typeof body === 'string' ? body : JSON.stringify(body, null, 2),
    format: 'html',
    type,
    author: it.openedBy || it.addedBy || '',
    createdAt: it.openedDate || it.addedDate || null,
    updatedAt: it.lastEditedDate || it.editedDate || it.status ? null : null,
    tags: [it._type, it.product, it.execution].filter(Boolean),
    meta: { zentaoType: type, id, status: it.status }
  };
}

// ----- 老版本 session 接口 -----
async function legacySync(base, credential, modules, options, source, max) {
  const { account, password } = parseCredential(credential, ['account', 'password']);
  const sidUrl = joinUrl(base, `/api.php?m=api&f=getSessionID&account=${encodeURIComponent(account)}&password=${encodeURIComponent(password)}`);
  const sidRes = await request(sidUrl, { method: 'GET', timeout: 15000, retries: 1 });
  let sessionID;
  try {
    const j = JSON.parse(sidRes.text.replace(/^﻿/, '').trim());
    sessionID = j?.data?.sessionID || j?.sessionID;
  } catch {
    sessionID = sidRes.text.trim();
  }
  if (!sessionID) throw new Error('禅道老版本接口：获取 sessionID 失败');

  const callModel = async (module, method) => {
    const url = joinUrl(
      base,
      `/index.php?m=api&f=getModel&module=${module}&methodName=${method}&params=&t=json&sessionID=${sessionID}`
    );
    const res = await request(url, { method: 'GET', timeout: 20000, retries: 1 });
    try {
      const j = JSON.parse(res.text.replace(/^﻿/, '').trim());
      return j?.data || [];
    } catch {
      return [];
    }
  };

  const raw = [];
  if (modules.includes('story')) {
    const arr = await callModel('story', 'getList');
    for (const it of arr) raw.push({ ...it, _type: 'story' });
  }
  if (modules.includes('task')) {
    const arr = await callModel('task', 'getList');
    for (const it of arr) raw.push({ ...it, _type: 'task' });
  }
  if (modules.includes('bug')) {
    const arr = await callModel('bug', 'getList');
    for (const it of arr) raw.push({ ...it, _type: 'bug' });
  }
  const items = raw.slice(0, max).map((it) => mapZentaoItem(it, base));
  return toDocs(source, items, (d) => d);
}
