import { request } from '../lib/http-client.js';
import { parseCredential, toDocs, shouldInclude, joinUrl } from './helpers.js';
import { parseFrontMatter, firstHeading } from '../lib/frontmatter.js';
import { mapLimit } from '../lib/util.js';

/**
 * Gitee 适配器
 * ------------------------------------------------------------------
 * 认证：个人设置 → 私人令牌（Access Token）
 * 凭证写法：裸串 token，或 {"access_token":"xxx"}
 * 可选配置：与 GitHub 适配器一致（repos / owner / org / branch / include / exclude / maxFilesPerRepo）
 */

function withToken(p, token) {
  const sep = p.includes('?') ? '&' : '?';
  return `${p}${sep}access_token=${encodeURIComponent(token)}`;
}

async function apiJson(baseUrl, p, token, { timeout = 25000 } = {}) {
  const res = await request(joinUrl(baseUrl, withToken(p, token)), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeout,
    retries: 2
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Gitee 认证失败 (HTTP ${res.status})，请检查 Access Token`);
  }
  if (res.status >= 400) throw new Error(`Gitee 请求失败 HTTP ${res.status}`);
  const text = res.text.replace(/^﻿/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gitee 返回非 JSON：${text.slice(0, 200)}`);
  }
}

async function listRepos(baseUrl, token, options) {
  if (options.repos) {
    return String(options.repos)
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((full) => ({ full_name: full, default_branch: options.branch || 'master' }));
  }
  const out = [];
  const perPage = 100;
  for (let page = 1; page <= (options.maxRepoPages || 10); page++) {
    let p;
    if (options.org) p = `/orgs/${encodeURIComponent(options.org)}/repos?per_page=${perPage}&page=${page}&type=all`;
    else if (options.owner) p = `/users/${encodeURIComponent(options.owner)}/repos?per_page=${perPage}&page=${page}&type=all&sort=pushed`;
    else p = `/user/repos?per_page=${perPage}&page=${page}&type=all&sort=pushed`;

    let arr;
    try {
      arr = await apiJson(baseUrl, p, token);
    } catch (e) {
      if (page === 1) throw e;
      break;
    }
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const r of arr) {
      out.push({
        full_name: r.full_name,
        default_branch: options.branch || r.default_branch || 'master',
        description: r.description || ''
      });
    }
    if (arr.length < perPage) break;
  }
  return out;
}

export default {
  platform: 'gitee',
  label: 'Gitee',
  description: '拉取 Gitee（含企业版）仓库中的文档文件',
  defaultBaseUrl: 'https://gitee.com/api/v5',
  credentialHint: 'Gitee 私人令牌（Access Token），裸串即可',
  credentialType: 'Access Token',
  fields: [
    { key: 'repos', label: '指定仓库（逗号分隔，留空=自动发现）', placeholder: 'owner/repo' },
    { key: 'owner', label: '只同步某用户仓库（可选）', placeholder: 'username' },
    { key: 'org', label: '只同步某企业/组织（可选）', placeholder: 'org-name' },
    { key: 'branch', label: '分支（默认 master）', placeholder: 'master' },
    { key: 'include', label: '文件包含正则', placeholder: '\\.(md|markdown|rst|txt)$' },
    { key: 'exclude', label: '文件排除正则', placeholder: 'node_modules|dist' },
    { key: 'maxFilesPerRepo', label: '单仓库最多文件数', placeholder: '200' }
  ],

  async fetchAll({ source, credential, options = {}, max = 5000 }) {
    const { token } = parseCredential(credential, ['token']);
    if (!token) throw new Error('缺少 Gitee Access Token');

    const repos = await listRepos(source.baseUrl, token, options);
    if (!repos.length) throw new Error('未发现可访问的仓库');

    const maxFilesPerRepo = Number(options.maxFilesPerRepo || 200);
    const webBase = (options.webBaseUrl || source.baseUrl.replace(/\/api\/v5\/?$/, '')).replace(/\/+$/, '');

    const all = [];
    for (const repo of repos) {
      if (all.length >= max) break;
      let tree;
      try {
        tree = await apiJson(
          source.baseUrl,
          `/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`,
          token
        );
      } catch {
        continue;
      }
      const files = (tree.tree || [])
        .filter((n) => n.type === 'blob')
        .filter((n) => shouldInclude(n.path, options))
        .slice(0, maxFilesPerRepo);

      const docs = await mapLimit(files, 4, async (f) => {
        if (all.length >= max) return null;
        try {
          const j = await apiJson(
            source.baseUrl,
            `/repos/${repo.full_name}/contents/${encodeURI(f.path)}?ref=${encodeURIComponent(repo.default_branch)}`,
            token
          );
          let text = '';
          if (j?.encoding === 'base64' && j?.content) {
            text = Buffer.from(j.content.replace(/\s/g, ''), 'base64').toString('utf8');
          } else if (typeof j?.content === 'string') {
            text = j.content;
          }
          if (!text) return null;
          const { data, body } = parseFrontMatter(text);
          return {
            externalId: `${repo.full_name}:${repo.default_branch}:${f.path}`,
            title: data.title || firstHeading(body, f.path.split('/').pop()),
            path: `${repo.full_name}/${f.path}`,
            url: `${webBase}/${repo.full_name}/blob/${repo.default_branch}/${f.path}`,
            content: body,
            format: f.path.match(/\.(md|markdown)$/i) ? 'markdown' : 'text',
            tags: [].concat(data.tags || []).concat([repo.full_name.split('/')[1]]),
            meta: { repo: repo.full_name, branch: repo.default_branch, filePath: f.path }
          };
        } catch {
          return null;
        }
      });
      for (const d of docs) if (d && all.length < max) all.push(d);
    }

    return toDocs(source, all, (d) => d);
  },

  async test({ baseUrl, credential, options = {} }) {
    const { token } = parseCredential(credential, ['token']);
    const me = await apiJson(baseUrl || 'https://gitee.com/api/v5', '/user', token, { timeout: 12000 });
    const repos = await listRepos(baseUrl || 'https://gitee.com/api/v5', token, {
      ...options,
      maxRepoPages: 1
    });
    return {
      ok: true,
      message: `已认证为 ${me.login || me.name}，可访问 ${repos.length}+ 个仓库`,
      sample: repos.slice(0, 5).map((r) => r.full_name)
    };
  }
};
