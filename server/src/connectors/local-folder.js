import fs from 'node:fs';
import path from 'node:path';
import { request } from '../lib/http-client.js';
import { shouldInclude, toDocs, titleFromPath, fileUrl } from './helpers.js';
import { htmlToText } from '../lib/normalize.js';
import { parseFrontMatter, firstHeading } from '../lib/frontmatter.js';
import { officeToText } from '../lib/office.js';
import { parseEnex } from '../lib/enex.js';

/**
 * 本地目录 / 文件 适配器（通用兜底）
 * ------------------------------------------------------------------
 * 任何平台只要能"导出到本地"，就能用这种方式并入知识库。
 * 支持：.md/.markdown/.txt/.rst/.adoc/.org/.html/.csv/.enex/.docx/.xlsx
 * 可选配置：
 *   options.dir        目录或文件（必填）
 *   options.include    路径包含正则
 *   options.exclude    路径排除正则
 *   options.recursive  是否递归（默认 true）
 */

const TEXT_EXT = /\.(md|mdx|markdown|mkd|rst|txt|adoc|org|csv|tsv|json|html|htm|xml)$/i;
const OFFICE_EXT = /\.(docx|xlsx)$/i;
const ENEX_EXT = /\.enex$/i;

async function readLocation(location) {
  if (/^https?:\/\//i.test(location)) {
    const res = await request(location, { method: 'GET', timeout: 30000, retries: 1 });
    return { buf: Buffer.from(res.text, 'utf8'), name: location.split('/').pop() };
  }
  const abs = path.resolve(location);
  return { buf: fs.readFileSync(abs), name: path.basename(abs), abs };
}

function walk(dir, { recursive = true, include, exclude } = {}) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (recursive) stack.push(full);
        continue;
      }
      if (shouldInclude(full, { include, exclude })) out.push(full);
    }
  }
  return out;
}

export async function readFileAsDoc(fileAbs, platform = 'local', sourceId = '') {
  const ext = path.extname(fileAbs).toLowerCase();
  const rel = fileAbs;
  const stat = fs.existsSync(fileAbs) ? fs.statSync(fileAbs) : null;
  const buf = stat ? fs.readFileSync(fileAbs) : Buffer.from('', 'utf8');

  if (ENEX_EXT.test(ext)) {
    const notes = parseEnex(buf.toString('utf8'));
    return notes.map((n, i) => ({
      externalId: `local:${rel}:${i}`,
      title: n.title || titleFromPath(rel),
      path: rel,
      url: fileUrl(fileAbs),
      content: n.html,
      format: 'html',
      tags: n.tags || [],
      createdAt: n.created,
      updatedAt: n.updated,
      meta: { file: rel }
    }));
  }

  let content = '';
  let format = 'text';
  if (OFFICE_EXT.test(ext)) {
    content = officeToText(ext, buf);
    format = 'text';
  } else if (TEXT_EXT.test(ext) || /\.(json|xml)$/i.test(ext)) {
    content = buf.toString('utf8');
    format = /\.html?$/i.test(ext) ? 'html' : /\.(md|mdx|markdown)$/i.test(ext) ? 'markdown' : 'text';
  } else {
    // 兜底：当文本读出
    content = buf.toString('utf8');
    format = 'text';
  }
  if (!content) return [];

  const { data, body } = parseFrontMatter(content);
  const title = data.title || firstHeading(body, titleFromPath(rel));
  return [
    {
      externalId: `local:${rel}`,
      title,
      path: rel,
      url: fileUrl(fileAbs),
      content: body,
      format,
      tags: [].concat(data.tags || []),
      author: data.author || '',
      createdAt: data.date || (stat ? new Date(stat.birthtimeMs).toISOString() : null),
      updatedAt: stat ? new Date(stat.mtimeMs).toISOString() : null,
      meta: { file: rel, platform }
    }
  ];
}

export default {
  platform: 'local',
  label: '本地文件 / 目录',
  description: '导入本地目录或文件（支持 Markdown / 文本 / HTML / CSV / ENEX / Word / Excel）',
  defaultBaseUrl: '',
  credentialHint: '无需凭证',
  credentialType: '无',
  fields: [
    { key: 'dir', label: '目录或文件路径（必填，也支持 http(s) 直链）', placeholder: '/data/my-docs' },
    { key: 'include', label: '路径包含正则', placeholder: '\\.(md|txt)$' },
    { key: 'exclude', label: '路径排除正则', placeholder: 'node_modules|dist' },
    { key: 'recursive', label: '是否递归子目录（默认 true）', placeholder: 'true' }
  ],

  async fetchAll({ source, credential, options = {}, max = 5000 }) {
    const loc = options.dir;
    if (!loc) throw new Error('缺少 options.dir');

    let files = [];
    if (/^https?:\/\//i.test(loc)) {
      // 单个远程文件
      const r = await readLocation(loc);
      const tmp = path.join(process.cwd(), '.tmp-import', r.name);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, r.buf);
      files = [tmp];
    } else {
      const abs = path.resolve(loc);
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        files = walk(abs, {
          recursive: options.recursive === 'false' ? false : options.recursive !== false,
          include: options.include,
          exclude: options.exclude
        });
      } else {
        files = [abs];
      }
    }

    const items = [];
    for (const f of files.slice(0, max)) {
      try {
        items.push(...(await readFileAsDoc(f, 'local', source.id)));
      } catch {
        /* 跳过无法读取的文件 */
      }
    }
    return toDocs(source, items, (d) => d);
  },

  async test({ options = {} }) {
    const loc = options.dir;
    if (!loc || !/^https?:\/\//i.test(loc)) {
      const abs = path.resolve(loc || '');
      if (!fs.existsSync(abs)) throw new Error('目录或文件不存在');
      const st = fs.statSync(abs);
      const count = st.isDirectory()
        ? walk(abs, { include: options.include, exclude: options.exclude }).length
        : 1;
      return { ok: true, message: `可读取 ${count} 个文件`, sample: [] };
    }
    const r = await readLocation(loc);
    return { ok: true, message: `远程文件可读取（${r.buf.length} 字节）`, sample: [] };
  }
};

export { htmlToText };
