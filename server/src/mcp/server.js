import { createStore } from '../store.js';
import { runSync } from '../connectors/index.js';
import { makeSnippet } from '../search.js';
import { config } from '../config.js';
import { maskSecret } from '../lib/util.js';

/**
 * 入站 MCP 服务端（stdio, JSON-RPC 2.0）。
 * 让任意支持 MCP 的客户端（Claude Desktop、各类 IDE / Agent）检索与阅读本平台知识库。
 *
 * 暴露：
 *   tools:    kb_search / kb_get_document / kb_list_sources / kb_list_documents / kb_sync_source
 *   resources: kb://doc/{id}
 *   templates: kb://doc/{id}
 */

const TOOLS = [
  {
    name: 'kb_search',
    description: '跨所有数据源检索知识库，返回相关文档摘要与原文链接',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词（支持中英文）' },
        limit: { type: 'number', default: 10, description: '返回数量上限' },
        platform: { type: 'string', description: '按平台过滤：github/gitee/showdoc/zentao/evernote/tencent-docs/mcp/local/generic' },
        sourceId: { type: 'string', description: '按数据源 ID 过滤' },
        type: { type: 'string', description: '按文档类型过滤：doc/story/task/bug/note/sheet' }
      },
      required: ['query']
    }
  },
  {
    name: 'kb_get_document',
    description: '根据文档 ID 获取完整正文与元数据',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '文档 ID' } },
      required: ['id']
    }
  },
  {
    name: 'kb_list_sources',
    description: '列出已配置的知识源及其同步状态',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'kb_list_documents',
    description: '列出知识库文档（可按数据源过滤）',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string' },
        limit: { type: 'number', default: 30 },
        offset: { type: 'number', default: 0 }
      }
    }
  },
  {
    name: 'kb_sync_source',
    description: '触发指定数据源的立即同步（需要可写权限）',
    inputSchema: {
      type: 'object',
      properties: { sourceId: { type: 'string', description: '数据源 ID' } },
      required: ['sourceId']
    }
  }
];

function textBlock(text) {
  return { type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) };
}

function searchTool(store, args) {
  const ranked = store.index.score(args.query || '', {
    sourceId: args.sourceId,
    platform: args.platform,
    type: args.type
  });
  const limit = Math.min(Number(args.limit || 10), 100);
  const items = [];
  for (const r of ranked.slice(0, limit)) {
    const d = store.getDoc(r.id);
    if (!d) continue;
    items.push({
      id: d.id,
      title: d.title,
      platform: d.platform,
      type: d.type,
      url: d.url,
      tags: d.tags,
      updatedAt: d.updatedAt,
      snippet: makeSnippet(d.plainText || d.summary, args.query || ''),
      score: Number(r.score.toFixed(4))
    });
  }
  return { content: [textBlock({ total: ranked.length, items })], isError: false };
}

function getDocTool(store, args) {
  const d = store.getDoc(args.id);
  if (!d) return { content: [textBlock(`文档不存在：${args.id}`)], isError: true };
  return { content: [textBlock({ id: d.id, title: d.title, platform: d.platform, type: d.type, url: d.url, tags: d.tags, updatedAt: d.updatedAt, content: d.content })], isError: false };
}

function listSourcesTool(store) {
  return { content: [textBlock(store.listSources())], isError: false };
}

function listDocsTool(store, args) {
  const page = store.listDocs({
    sourceId: args.sourceId,
    limit: Math.min(Number(args.limit || 30), 100),
    offset: Number(args.offset || 0)
  });
  const slim = page.items.map((d) => ({ id: d.id, title: d.title, platform: d.platform, type: d.type, url: d.url, updatedAt: d.updatedAt }));
  return { content: [textBlock({ total: page.total, items: slim })], isError: false };
}

async function syncTool(store, args) {
  const rec = store.getSource(args.sourceId);
  if (!rec) return { content: [textBlock(`数据源不存在：${args.sourceId}`)], isError: true };
  try {
    const result = await runSync(store, rec);
    return { content: [textBlock({ ok: true, ...result })], isError: false };
  } catch (e) {
    return { content: [textBlock({ ok: false, error: e.message })], isError: true };
  }
}

function resourcesList(store, cap = 200) {
  const docs = store.allDocs().slice(0, cap);
  return docs.map((d) => ({ uri: `kb://doc/${d.id}`, name: d.title, mimeType: 'text/markdown', description: `${d.platform}/${d.type}` }));
}

function resourceRead(store, uri) {
  const id = uri.replace(/^kb:\/\/doc\//, '');
  const d = store.getDoc(id);
  if (!d) return [{ type: 'text', text: `文档不存在：${uri}` }];
  return [{ type: 'text', text: `# ${d.title}\n\n来源：${d.platform} | 类型：${d.type}\n链接：${d.url || '—'}\n\n${d.content}` }];
}

export function buildHandler(store) {
  return async function handle(method, params = {}, id = null) {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'knowledge-workbench', version: config.version }
        };
      case 'notifications/initialized':
        return null;
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        const name = params.name;
        try {
          if (name === 'kb_search') return searchTool(store, params.arguments || {});
          if (name === 'kb_get_document') return getDocTool(store, params.arguments || {});
          if (name === 'kb_list_sources') return listSourcesTool(store);
          if (name === 'kb_list_documents') return listDocsTool(store, params.arguments || {});
          if (name === 'kb_sync_source') return await syncTool(store, params.arguments || {});
          return { content: [textBlock(`未知工具：${name}`)], isError: true };
        } catch (e) {
          return { content: [textBlock(`工具执行失败：${e.message}`)], isError: true };
        }
      }
      case 'resources/list':
        return { resources: resourcesList(store) };
      case 'resources/templates/list':
        return { resourceTemplates: [{ uriTemplate: 'kb://doc/{id}', name: '知识库文档', mimeType: 'text/markdown' }] };
      case 'resources/read':
        return { contents: resourceRead(store, params.uri) };
      default:
        throw new Error(`不支持的方法：${method}`);
    }
  };
}

/** 以 stdio 方式运行 MCP 服务端 */
export function runStdio() {
  const dataDir = process.env.KB_DATA_DIR || config.dataDir;
  const store = createStore();
  const handle = buildHandler(store);
  process.stdout.write(''); // 确保 stdout 已打开
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        const result = await handle(msg.method, msg.params || {}, msg.id);
        if (msg.id !== undefined && result !== null) {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
        }
      } catch (e) {
        if (msg.id !== undefined) {
          process.stdout.write(
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: e.message } }) + '\n'
          );
        }
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return store;
}
