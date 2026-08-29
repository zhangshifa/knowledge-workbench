import showdoc from './showdoc.js';
import github from './github.js';
import gitee from './gitee.js';
import zentao from './zentao.js';
import evernote from './evernote.js';
import tencentDocs from './tencent-docs.js';
import mcp from './mcp.js';
import localFolder from './local-folder.js';
import generic from './generic-http.js';

/** 平台标识符 → 适配器实例 */
export const connectors = {
  showdoc,
  github,
  gitee,
  zentao,
  evernote,
  'tencent-docs': tencentDocs,
  mcp,
  local: localFolder,
  generic
};

export function getConnector(platform) {
  return connectors[platform] || null;
}

export function listPlatforms() {
  return Object.keys(connectors).map((k) => {
    const c = connectors[k];
    return {
      platform: k,
      label: c.label,
      description: c.description,
      defaultBaseUrl: c.defaultBaseUrl,
      credentialHint: c.credentialHint,
      credentialType: c.credentialType,
      fields: c.fields || []
    };
  });
}

/** 运行一次同步：fetchAll → 落库 */
export async function runSync(store, source, opts = {}) {
  const connector = getConnector(source.platform);
  if (!connector) throw new Error(`未知平台：${source.platform}`);
  const credential = store.getCredential(source);
  const startedAt = new Date().toISOString();

  const raw = await connector.fetchAll({
    source,
    credential,
    options: source.options || {},
    max: opts.max || undefined
  });

  const result = store.saveDocs(source.id, raw);
  const finishedAt = new Date().toISOString();
  store.recordSync(source.id, {
    status: 'success',
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    count: raw.length,
    error: null
  });
  return { ...result, total: raw.length };
}
