#!/usr/bin/env node
/**
 * 自检脚本：不依赖任何外部服务，验证核心链路
 *  1. 本地目录适配器（含 Markdown / ENEX 解析）
 *  2. 通用 HTTP 适配器（内置一个临时 HTTP 服务）
 *  3. 中文分词与 BM25 检索
 *  4. MCP 服务端（进程内调用）
 *  5. MCP 客户端（真实启动子进程，走 stdio 协议）
 *  6. 导出（JSON / Markdown）
 *
 * 运行：node server/scripts/selftest.js
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-selftest-'));
process.env.KB_DATA_DIR = path.join(TMP, 'data');
process.env.KB_SYNC_INTERVAL_MINUTES = '0';
process.env.KB_LOG_LEVEL = 'error';

const { config } = await import('../src/config.js');
const { createStore } = await import('../src/store.js');
const { SyncEngine } = await import('../src/sync.js');
const { createMcpServer } = await import('../src/mcp/server.js');
const { connectMcp } = await import('../src/mcp/client.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

// ------------------------------------------------------------------ 准备素材
const docsDir = path.join(TMP, 'docs');
fs.mkdirSync(docsDir, { recursive: true });
fs.writeFileSync(
  path.join(docsDir, '部署指南.md'),
  '---\ntitle: 部署指南\ntags: [部署, 运维]\n---\n# 部署指南\n\n本项目支持本地部署与云上部署两种方式，使用 Docker 可以快速启动。\n',
  'utf8'
);
fs.writeFileSync(
  path.join(docsDir, '知识经验.md'),
  '# 知识经验沉淀\n\n把散落在各个系统的知识统一检索，是团队协作的关键。\n',
  'utf8'
);
fs.writeFileSync(
  path.join(docsDir, '笔记.enex'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export3.dtd">
<en-export>
<note><title>会议纪要</title><content><![CDATA[<?xml version="1.0"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>讨论了知识库的统一检索方案</div></en-note>]]></content><created>20260801T100000Z</created><updated>20260802T110000Z</updated><tag>会议</tag></note>
</en-export>`,
  'utf8'
);

// 临时 HTTP 服务，用于验证通用适配器
const fakeServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/docs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        data: {
          list: [
            { id: 1, title: '接口规范', url: 'http://x/1' },
            { id: 2, title: '排障手册', url: 'http://x/2' }
          ]
        }
      })
    );
    return;
  }
  if (/^\/api\/docs\/\d+$/.test(u.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { content: `这是 ${u.pathname} 的正文内容，包含关键词：统一检索。` } }));
    return;
  }
  res.writeHead(404).end('{}');
});
await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
const fakePort = fakeServer.address().port;
const fakeBase = `http://127.0.0.1:${fakePort}`;

// ------------------------------------------------------------------ 1. 本地目录 + ENEX
console.log('\n[1] 本地目录 / ENEX 适配器');
const store = createStore();
const engine = new SyncEngine(store, config);

const localSrc = store.createSource({
  platform: 'local',
  name: '自检-本地目录',
  baseUrl: `file:///${docsDir.replace(/\\/g, '/')}`,
  options: { dir: docsDir }
});
const r1 = await engine.syncSource(localSrc.id);
check('本地目录同步成功', r1.status === 'success', JSON.stringify(r1));
check('同步到 4 条文档（2 md + 1 enex 笔记 + 1 表格占位）', r1.count >= 3, `count=${r1.count}`);
const enexDoc = store.allDocs().find((d) => d.title === '会议纪要');
check('ENEX 笔记解析成功', Boolean(enexDoc), '未找到「会议纪要」');
check('ENEX 标签保留', (enexDoc?.tags || []).includes('会议'), JSON.stringify(enexDoc?.tags));

// ------------------------------------------------------------------ 2. 通用 HTTP 适配器
console.log('\n[2] 通用 HTTP / OpenAPI 适配器');
const httpSrc = store.createSource({
  platform: 'generic',
  name: '自检-通用接口',
  baseUrl: fakeBase,
  options: { listPath: '/api/docs', itemsPath: 'data.list', contentPath: '/api/docs/{id}' }
});
const r2 = await engine.syncSource(httpSrc.id);
check('通用接口同步成功', r2.status === 'success', JSON.stringify(r2));
check('通用接口拉到 2 条', r2.count === 2, `count=${r2.count}`);
const detail = store.allDocs().find((d) => d.title === '接口规范');
check('详情接口正文已填充', String(detail?.content || '').includes('统一检索'), JSON.stringify(detail?.content));

// ------------------------------------------------------------------ 3. 检索
console.log('\n[3] 中文分词与 BM25 检索');
const hits = store.index.score('统一检索');
check('中文查询命中', hits.length > 0, `hits=${hits.length}`);
const deploy = store.index.score('部署', { platform: 'local' });
check('平台过滤生效', deploy.length > 0 && deploy.every((h) => store.getDoc(h.id)?.platform === 'local'));
const eng = store.index.score('docker');
check('英文大小写不敏感', eng.length > 0, `hits=${eng.length}`);

// ------------------------------------------------------------------ 4. MCP 服务端
console.log('\n[4] MCP 服务端（进程内）');
const mcp = createMcpServer({ store, syncEngine: engine });
const initRes = await mcp.handle({ id: 1, method: 'initialize', params: {} });
check('initialize 返回 serverInfo', initRes?.result?.serverInfo?.name === 'knowledge-workbench');
const toolsRes = await mcp.handle({ id: 2, method: 'tools/list', params: {} });
check('tools/list 返回 6 个工具', toolsRes?.result?.tools?.length === 6, `count=${toolsRes?.result?.tools?.length}`);
const searchRes = await mcp.handle({
  id: 3,
  method: 'tools/call',
  params: { name: 'kb_search', arguments: { query: '统一检索', limit: 5 } }
});
const searchText = searchRes?.result?.content?.[0]?.text || '';
check('kb_search 有结果', searchText.includes('title') && !searchRes.result.isError, searchText.slice(0, 120));
const resList = await mcp.handle({ id: 4, method: 'resources/list', params: {} });
check('resources/list 返回资源', (resList?.result?.resources || []).length > 0);
const firstUri = resList.result.resources[0].uri;
const resRead = await mcp.handle({ id: 5, method: 'resources/read', params: { uri: firstUri } });
check('resources/read 返回正文', String(resRead?.result?.contents?.[0]?.text || '').length > 0);

// ------------------------------------------------------------------ 5. MCP 客户端（真实子进程）
console.log('\n[5] MCP 客户端（子进程 stdio 往返）');
store.persistIndex();
const nodeBin = process.execPath;
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'mcp-stdio.js');
let client = null;
try {
  client = await connectMcp({
    transport: 'stdio',
    command: nodeBin,
    args: [script],
    env: { KB_DATA_DIR: process.env.KB_DATA_DIR },
    shell: false
  });
  const resources = await client.listResources();
  check('客户端列出资源', resources.length > 0, `count=${resources.length}`);
  const contents = await client.readResource(resources[0].uri);
  check('客户端读取资源正文', String(contents?.[0]?.text || '').length > 0);
  const t = await client.callTool('kb_list_sources', {});
  check('客户端调用工具', String(t?.content?.[0]?.text || '').includes('自检-本地目录'));
} catch (e) {
  check('MCP 子进程往返', false, e.message);
} finally {
  client?.close();
}

// ------------------------------------------------------------------ 6. 导出
console.log('\n[6] 导出');
const bundle = store.exportBundle();
check('JSON 导出包含文档', (bundle.docs || []).length >= 5, `count=${bundle.docs?.length}`);
check('导出不含明文凭证', !JSON.stringify(bundle.sources).includes('credentialEnc'));

// ------------------------------------------------------------------ 清理
fakeServer.close();
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
