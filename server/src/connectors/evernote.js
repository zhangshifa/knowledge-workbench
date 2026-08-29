import fs from 'node:fs';
import path from 'node:path';
import { request } from '../lib/http-client.js';
import { parseEnex } from '../lib/enex.js';
import { htmlToText } from '../lib/normalize.js';
import { toDocs, fileUrl } from './helpers.js';

/**
 * 印象笔记 / Evernote 适配器
 * ------------------------------------------------------------------
 * 出于零依赖与稳定性考虑，默认走 **ENEX 导出包**方式（最稳妥、最通用）：
 *   - options.enexPath：本地 .enex 文件或目录，或某个 .enex 的可访问 URL
 * 同时也支持 **Evernote Cloud API**（需 dev token）：
 *   - options.mode='api' 且已安装可选依赖 `evernote`
 *   - token 写法：{"devToken":"S=s1:..."} 或裸串
 * 提示：印象笔记（中国版 yinxiang.com）与 Evernote 均提供「导出为 ENEX」，
 *      这是把个人知识一次性并入工作台最省心的方式。
 */

async function readEnexText(location) {
  if (/^https?:\/\//i.test(location)) {
    const res = await request(location, { method: 'GET', timeout: 30000, retries: 1 });
    return res.text;
  }
  const stat = fs.statSync(location);
  if (stat.isFile()) return fs.readFileSync(location, 'utf8');
  // 目录：合并所有 .enex
  const files = fs
    .readdirSync(location)
    .filter((f) => f.toLowerCase().endsWith('.enex'))
    .map((f) => path.join(location, f));
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

export default {
  platform: 'evernote',
  label: '印象笔记 / Evernote',
  description: '通过 ENEX 导出包（默认）或 Evernote Cloud API 接入笔记',
  defaultBaseUrl: '',
  credentialHint: '默认无需凭证；如用 Cloud API：{"devToken":"S=..."}',
  credentialType: '无 / Evernote Dev Token',
  fields: [
    { key: 'enexPath', label: 'ENEX 文件或目录路径 / URL（默认模式）', placeholder: '/path/to/notes.enex 或 https://.../export.enex' },
    { key: 'mode', label: '模式：enex(默认) / api', placeholder: 'enex' }
  ],

  async fetchAll({ source, credential, options = {}, max = 5000 }) {
    if (options.mode === 'api') {
      return fetchViaApi(source, credential, options, max);
    }

    const loc = options.enexPath;
    if (!loc) throw new Error('请在 options.enexPath 指定 ENEX 文件 / 目录 / URL');
    const xml = await readEnexText(loc);
    const notes = parseEnex(xml);

    const items = notes.slice(0, max).map((n, i) => ({
      externalId: `note:${n.notebook || ''}:${n.title}:${i}`,
      title: n.title || '(无标题笔记)',
      path: `${n.notebook || '笔记本'}/${n.title || i}`,
      url: '',
      content: n.html,
      format: 'html',
      author: '',
      createdAt: n.created,
      updatedAt: n.updated,
      tags: n.tags || [],
      meta: { notebook: n.notebook, source: 'enex' }
    }));
    return toDocs(source, items, (d) => ({ ...d, plainText: undefined }));
  },

  async test({ options = {} }) {
    if (options.mode === 'api') {
      return { ok: true, message: 'Cloud API 模式：将在首次同步检查可选依赖 evernote', sample: [] };
    }
    if (!options.enexPath) throw new Error('缺少 enexPath');
    let count = 0;
    if (/^https?:\/\//i.test(options.enexPath)) {
      const res = await request(options.enexPath, { method: 'GET', timeout: 15000, retries: 1 });
      count = parseEnex(res.text).length;
    } else {
      const stat = fs.statSync(options.enexPath);
      const files = stat.isFile()
        ? [options.enexPath]
        : fs
            .readdirSync(options.enexPath)
            .filter((f) => f.toLowerCase().endsWith('.enex'))
            .map((f) => path.join(options.enexPath, f));
      count = files.reduce((acc, f) => acc + parseEnex(fs.readFileSync(f, 'utf8')).length, 0);
    }
    return { ok: true, message: `ENEX 可读取，共 ${count} 条笔记`, sample: [] };
  }
};

async function fetchViaApi(source, credential, options, max) {
  let mod;
  try {
    mod = await import('evernote');
  } catch {
    throw new Error('Cloud API 模式需要安装可选依赖：npm i evernote（建议改用 ENEX 导出模式，零依赖更稳）');
  }
  const devToken = credential
    ? JSON.parse(credential.startsWith('{') ? credential : `{"devToken":"${credential}"}`).devToken
    : options.devToken;
  if (!devToken) throw new Error('缺少 Evernote dev token');

  const client = new mod.Client({ token: devToken, sandbox: false });
  const noteStore = client.getNoteStore();
  const notebooks = await noteStore.listNotebooks();
  const items = [];
  for (const nb of notebooks) {
    const noteList = await noteStore.findNotesMetadata(
      devToken,
      { notebookGuid: nb.guid, ascending: true },
      0,
      max
    );
    for (const meta of noteList.notes || []) {
      const note = await noteStore.getNote(devToken, meta.guid, true, false, false, false);
      items.push({
        externalId: `note:${nb.name}:${meta.guid}`,
        title: note.title || '(无标题)',
        path: `${nb.name}/${note.title || ''}`,
        url: '',
        content: note.content || '',
        format: 'html',
        author: '',
        createdAt: note.created ? new Date(Number(note.created)).toISOString() : null,
        updatedAt: note.updated ? new Date(Number(note.updated)).toISOString() : null,
        tags: (note.tagNames || []).map(String),
        meta: { notebook: nb.name, source: 'cloud-api' }
      });
    }
  }
  return toDocs(source, items, (d) => ({ ...d, plainText: undefined }));
}
