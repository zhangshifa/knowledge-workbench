import { McpClient } from '../mcp/client.js';
import { toDocs } from './helpers.js';

/**
 * MCP 客户端连接器（"通过 MCP 方式整合"）
 * ------------------------------------------------------------------
 * 把任意一个对外暴露 MCP 协议的服务器，当作一个"知识源"接入本平台：
 *   - 拉取对端 resources/list → resources/read 拿到正文
 *   - 或调用对端 tools/call（options.toolName 指定）
 * 配置（options）：
 *   transport: 'stdio' | 'sse' | 'http'
 *   command / args / env         stdio 模式启动命令
 *   url / headers               sse / http 模式地址
 *   resourcePattern             只同步 URI 匹配此正则的资源（可选）
 *   maxResources                最多拉取资源数
 *   toolName / toolArgs         改为调用某工具获取内容（可选）
 */

function resourceToDoc(r, c, source) {
  const text = c?.text != null ? c.text : '';
  const mime = r.mimeType || c?.mimeType || '';
  const format = /\/json/.test(mime) ? 'text' : /\/html/.test(mime) ? 'html' : /\/markdown|\.md$/.test(mime + r.uri) ? 'markdown' : 'text';
  const title = r.name || r.uri.split('/').pop() || r.uri;
  return {
    externalId: `mcp:${r.uri}`,
    title,
    path: r.uri,
    url: r.uri,
    content: text,
    format,
    type: 'doc',
    tags: [],
    meta: { uri: r.uri, mimeType: mime }
  };
}

export default {
  platform: 'mcp',
  label: 'MCP 服务器（客户端接入）',
  description: '把任意暴露 MCP 协议的服务器作为知识源接入：拉取 resources 或调用 tools',
  defaultBaseUrl: '',
  credentialHint: '由 options 提供 transport 与启动参数 / 地址；一般无需单独凭证',
  credentialType: '无 / 取决于外部服务',
  fields: [
    { key: 'transport', label: '传输方式：stdio / sse / http', placeholder: 'stdio' },
    { key: 'command', label: '（stdio）启动命令', placeholder: 'npx' },
    { key: 'args', label: '（stdio）参数（JSON 数组）', placeholder: '["-y","@some/mcp-server"]' },
    { key: 'url', label: '（sse/http）地址', placeholder: 'http://localhost:3000/mcp' },
    { key: 'resourcePattern', label: '只同步 URI 匹配此正则的资源（留空=全部）', placeholder: 'docs' },
    { key: 'toolName', label: '改用 tools/call 获取内容（可选）', placeholder: 'search_docs' }
  ],

  async fetchAll({ source, options = {}, max = 2000 }) {
    const client = McpClient.fromOptions(options);
    try {
      await client.initialize();
      const docs = [];

      if (options.toolName) {
        const contents = await client.callTool(options.toolName, options.toolArgs || {});
        for (const c of contents) {
          const text = c?.text || '';
          if (!text) continue;
          docs.push({
            externalId: `mcp:tool:${options.toolName}`,
            title: options.toolTitle || options.toolName,
            path: `tool/${options.toolName}`,
            url: '',
            content: text,
            format: 'text',
            tags: ['mcp-tool'],
            meta: { toolName: options.toolName }
          });
        }
      } else {
        const resources = await client.listResources();
        const pattern = options.resourcePattern ? new RegExp(options.resourcePattern, 'i') : null;
        const targets = (pattern ? resources.filter((r) => pattern.test(r.uri)) : resources).slice(0, max);
        for (const r of targets) {
          try {
            const contents = await client.readResource(r.uri);
            for (const c of contents) docs.push(resourceToDoc(r, c, source));
          } catch {
            /* 单资源失败跳过 */
          }
        }
      }
      return toDocs(source, docs, (d) => d);
    } finally {
      client.kill();
    }
  },

  async test({ options = {} }) {
    const client = McpClient.fromOptions(options);
    try {
      await client.initialize();
      const res = await client.listResources();
      return { ok: true, message: `MCP 握手成功，可见 ${res.length} 个资源`, sample: res.slice(0, 5).map((r) => r.uri) };
    } finally {
      client.kill();
    }
  }
};
