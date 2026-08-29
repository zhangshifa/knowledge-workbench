import { request } from '../lib/http-client.js';
import { parseCredential, toDocs, joinUrl, deepGet } from './helpers.js';
import { htmlToText } from '../lib/normalize.js';
import localFolder from './local-folder.js';

/**
 * 腾讯文档 适配器
 * ------------------------------------------------------------------
 * 两种接入方式：
 *   1) 开放平台 API（options.mode='openapi'）：用 OAuth 获取的 access_token
 *      - 默认端点 /openapi/v2/files 与 /openapi/v2/files/{id}/content
 *      - 端点、鉴权字段均可在 options.endpoints / options.authField 覆盖
 *   2) 本地导出目录（默认，零依赖最稳）：
 *      - 在腾讯文档「更多 → 导出为」选择 Word/Excel/Markdown，落到本地目录
 *      - 由本地目录适配器解析 docx/xlsx/md 等
 * 凭证写法（openapi 模式）：{"access_token":"xxx"}
 */

const DEFAULT_ENDPOINTS = {
  list: '/openapi/v2/files',
  content: '/openapi/v2/files/{id}/content'
};

export default {
  platform: 'tencent-docs',
  label: '腾讯文档',
  description: '通过开放平台 API 或「导出文件 + 本地目录」接入腾讯文档',
  defaultBaseUrl: 'https://docs.qq.com',
  credentialHint: '开放平台 access_token（裸串或 {"access_token":"..."}）；本地导出模式无需凭证',
  credentialType: 'Access Token / 无',
  fields: [
    { key: 'mode', label: '模式：local(默认导出) / openapi', placeholder: 'local' },
    { key: 'dir', label: '（local 模式）导出文件所在目录', placeholder: '/data/tencent-docs' },
    { key: 'endpoints.list', label: '（openapi 模式）文件列表端点', placeholder: '/openapi/v2/files' },
    { key: 'endpoints.content', label: '（openapi 模式）文件内容端点', placeholder: '/openapi/v2/files/{id}/content' }
  ],

  async fetchAll({ source, credential, options = {}, max = 5000 }) {
    if (options.mode !== 'openapi') {
      // 默认：本地导出目录 → 复用本地目录适配器
      if (!options.dir) throw new Error('请在 options.dir 指定「腾讯文档导出文件」所在目录');
      return localFolder.fetchAll({ source, credential, options, max });
    }

    const { access_token: token } = parseCredential(credential, ['access_token']);
    if (!token) throw new Error('openapi 模式缺少 access_token');

    const base = source.baseUrl || 'https://docs.qq.com';
    const ep = { ...DEFAULT_ENDPOINTS, ...(options.endpoints || {}) };
    const authField = options.authField || 'access_token';

    const listUrl = `${joinUrl(base, ep.list)}${ep.list.includes('?') ? '&' : '?'}${authField}=${encodeURIComponent(token)}`;
    const listRes = await request(listUrl, { method: 'GET', timeout: 20000, retries: 1 });
    const listJson = JSON.parse(listRes.text.replace(/^﻿/, '').trim());
    const files = deepGet(listJson, 'data.files') || [];

    const items = [];
    for (const f of files.slice(0, max)) {
      const id = f.id || f.fileId || f.guid;
      const contentUrl = `${joinUrl(base, ep.content.replace('{id}', encodeURIComponent(id)))}${ep.content.includes('?') ? '&' : '?'}${authField}=${encodeURIComponent(token)}`;
      try {
        const cRes = await request(contentUrl, { method: 'GET', timeout: 20000, retries: 1 });
        const cJson = JSON.parse(cRes.text.replace(/^﻿/, '').trim());
        const body = deepGet(cJson, 'data.content') || deepGet(cJson, 'data') || cRes.text;
        items.push({
          externalId: `tdoc:${id}`,
          title: f.title || f.name || id,
          path: f.folderName ? `${f.folderName}/${f.title}` : f.title || id,
          url: f.url || f.webUrl || '',
          content: typeof body === 'string' ? body : JSON.stringify(body),
          format: /<[a-z]+[\s>]/i.test(String(body)) ? 'html' : 'text',
          author: f.creator || '',
          updatedAt: f.updateTime ? new Date(Number(f.updateTime) * 1000).toISOString() : null,
          tags: [f.type].filter(Boolean),
          meta: { type: f.type, id }
        });
      } catch {
        /* 单文件失败不影响整体 */
      }
    }
    return toDocs(source, items, (d) => ({ ...d, plainText: undefined }));
  },

  async test({ baseUrl, credential, options = {} }) {
    if (options.mode !== 'openapi') {
      return localFolder.test({ options });
    }
    const { access_token: token } = parseCredential(credential, ['access_token']);
    const base = baseUrl || 'https://docs.qq.com';
    const ep = { ...DEFAULT_ENDPOINTS, ...(options.endpoints || {}) };
    const authField = options.authField || 'access_token';
    const url = `${joinUrl(base, ep.list)}${ep.list.includes('?') ? '&' : '?'}${authField}=${encodeURIComponent(token || '')}`;
    const res = await request(url, { method: 'GET', timeout: 12000, retries: 0 });
    const j = JSON.parse(res.text.replace(/^﻿/, '').trim());
    const files = deepGet(j, 'data.files') || [];
    return { ok: true, message: `连接成功，可见 ${files.length} 个文件`, sample: files.slice(0, 5).map((f) => f.title) };
  }
};

export { htmlToText };
