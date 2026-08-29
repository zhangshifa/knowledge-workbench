import { request } from '../lib/http-client.js';
import { parseCredential, toDocs, shouldInclude, joinUrl } from './helpers.js';
import { parseFrontMatter, firstHeading } from '../lib/frontmatter.js';
import { mapLimit } from '../lib/util.js';

/**
 * GitHub 适配器
 * ------------------------------------------------------------------
 * 认证：Personal Access Token（fine-grained 或 classic，建议只读最小权限）
 * 凭证写法：ghp_xxx / github_pat_xxx（裸串即可）
 * 可选配置：
 *   options.repos        指定仓库，逗号分隔，如 "owner/repo,owner/repo2"
 *   options.owner        只同步某用户/组织的公开仓库
 *   options.org          只同步某组织仓库
 *   options.branch       分支（默认仓库默认分支）
 *   options.include      文件路径包含正则（默认 .md/.mdx/.markdown/.rst/.txt）
 *   options.exclude      文件路径排除正则
 *   options.maxFilesPerRepo  单仓库最多文件数（默认 200）
 *   options.webBaseUrl   自部署 GHE 的网页地址（用于回跳原文）
 */

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function api(baseUrl, p, token, { timeout = 25000, accept } = {}) {
  const res = await request(joinUrl(baseUrl, p), {
    method: 'GET',
    headers: { ...authHeaders(token), ...(accept ? { Accept: accept } : {}) },
    timeout,
    retries: 2
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`GitHub 认证失败或触发限流 (HTTP ${res.status})，请检查 Token 权限与速率限制`);
  }
  if (res.status === 404) throw new Error(`资源不存在: ${p}`);
  if (res.status >= 400) throw new Error(`GitHub 请求失败 HTTP ${res.status}`);
  return res;
}

async function apiJson(baseUrl, p, token, opts = {}) {
  const res = await api(baseUrl, p, token, opts);
  return JSON.parse(res.text);
}

async function listRepos(baseUrl, token, options) {
  if (options.repos) {
    return String(options.repos)
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((full) => ({ full_name: full, default_branch: options.branch || 'main' }));
  }

  const out = [];
  const perPage = 100;
  for (let page = 1; page <= (options.maxRepoPages || 10); page++) {
    let p;
    if (options.org) p = `/orgs/${encodeURIComponent(options.org)}/repos?per_page=${perPage}&page=${page}&sort=pushed`;
    else if (options.owner) p = `/users/${encodeURIComponent(options.owner)}/repos?per_page=${perPage}&page=${page}&sort=pushed`;
    else p = `/user/repos?per_page=${perPage}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`;

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
        default_branch: options.branch || r.default_branch || 'main',
        description: r.description || '',
        private: r.private,
        pushed_at: r.pushed_at
      });
    }
    if (arr.length < perPage) break;
  }
  return out;
}

function webBase(baseUrl, options) {
  if (options.webBaseUrl) return options.webBaseUrl.replace(/\/+$/, '');
  return baseUrl.replace(/\/api\/v3$/, '').replace(/^https?:\/\/api\./, 'https://');
}

export default {
  platform: 'github',
  label: 'GitHub',
  description: '拉取仓库中的 Markdown / 文本文档，支持 GitHub.com 与自部署 GHE',
  defaultBaseUrl: 'https://api.github.com',
  credentialHint: 'Personal Access Token（PAT），建议仅授予只读权限；裸串即可',
  credentialType: 'Personal Access Token',
  fields: [
    { key: 'repos', label: '指定仓库（逗号分隔，留空=自动发现）', placeholder: 'owner/repo,owner/repo2' },
    { key: 'owner', label: '只同步某用户/组织的仓库（可选）', placeholder: 'zhangshifa' },
    { key: 'org', label: '只同步某组织（可选）', placeholder: 'my-org' },
    { key: 'branch', label: '分支（默认仓库默认分支）', placeholder: 'main' },
    { key: 'include', label: '文件包含正则', placeholder: '\\.(md|mdx|markdown|rst|txt)$' },
    { key: 'exclude', label: '文件排除正则', placeholder: 'node_modules|dist' },
    { key: 'maxFilesPerRepo', label: '单仓库最多文件数', placeholder: '200' }
  ],

  async fetchAll({ source, credential, options = {}, max = 5000 }) {
    const { token } = parseCredential(credential, ['token']);
    if (!token) throw new Error('缺少 GitHub Token');

    const repos = await listRepos(source.baseUrl, token, options);
    if (!repos.length) throw new Error('未发现可访问的仓库，请检查 Token 权限或使用 repos 明确指定');

    const maxFilesPerRepo = Number(options.maxFilesPerRepo || 200);
    const maxFileSize = Number(options.maxFileSize || 512 * 1024);
    const base = webBase(source.baseUrl, options);

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
        .filter((n) => !n.size || n.size <= maxFileSize)
        .slice(0, maxFilesPerRepo);

      const docs = await mapLimit(files, 4, async (f) => {
        if (all.length >= max) return null;
        let text = '';
        try {
          const res = await api(
            source.baseUrl,
            `/repos/${repo.full_name}/contents/${encodeURI(f.path)}?ref=${encodeURIComponent(repo.default_branch)}`,
            token,
            { accept: 'application/vnd.github.raw' }
          );
          text = res.text;
        } catch {
          try {
            const j = await apiJson(
              source.baseUrl,
              `/repos/${repo.full_name}/contents/${encodeURI(f.path)}?ref=${encodeURIComponent(repo.default_branch)}`,
              token
            );
            if (j?.encoding === 'base64' && j?.content) {
              text = Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8');
            }
          } catch {
            return null;
          }
        }
        if (!text) return null;
        const { data, body } = parseFrontMatter(text);
        return {
          externalId: `${repo.full_name}:${repo.default_branch}:${f.path}`,
          title: data.title || firstHeading(body, f.path.split('/').pop()),
          path: `${repo.full_name}/${f.path}`,
          url: `${base}/${repo.full_name}/blob/${repo.default_branch}/${f.path}`,
          content: body,
          format: f.path.match(/\.(md|mdx|markdown)$/i) ? 'markdown' : 'text',
          tags: [].concat(data.tags || data.keywords || []).concat([repo.full_name.split('/')[1]]),
          meta: { repo: repo.full_name, branch: repo.default_branch, filePath: f.path, private: repo.private }
        };
      });

      for (const d of docs) {
        if (d && all.length < max) all.push(d);
      }
    }

    return toDocs(source, all, (d) => d);
  },

  async test({ baseUrl, credential, options = {} }) {
    const { token } = parseCredential(credential, ['token']);
    const me = await apiJson(baseUrl || 'https://api.github.com', '/user', token, { timeout: 12000 });
    const repos = await listRepos(baseUrl || 'https://api.github.com', token, {
      ...options,
      maxRepoPages: 1
    });
    return {
      ok: true,
      message: `已认证为 ${me.login}，可访问 ${repos.length}+ 个仓库`,
      sample: repos.slice(0, 5).map((r) => r.full_name)
    };
  }
};
