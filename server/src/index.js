import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureDirs, printConfigBanner } from './config.js';
import { createStore } from './store.js';
import { getConnector, listPlatforms, runSync } from './connectors/index.js';
import { startScheduler } from './scheduler.js';
import { makeSnippet } from './search.js';
import { mapLimit, errMessage } from './lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = config.webDir;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json'
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const t = await readBody(req);
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function sendFile(res, file) {
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

export function createServer(store, scheduler) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method.toUpperCase();

    // ---- 鉴权 ----
    if (config.apiToken && pathname.startsWith('/api') && pathname !== '/api/health') {
      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${config.apiToken}`) {
        send(res, 401, { error: '未授权，请在 Authorization 头携带 Bearer Token' });
        return;
      }
    }

    // ---- 静态资源 ----
    if (method === 'GET' && !pathname.startsWith('/api')) {
      const rel = pathname === '/' ? '/index.html' : pathname;
      const file = path.join(WEB_DIR, rel);
      if (!file.startsWith(WEB_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      sendFile(res, file);
      return;
    }

    try {
      // ---- 健康检查 ----
      if (pathname === '/api/health' && method === 'GET') {
        return send(res, 200, { status: 'ok', version: config.version, time: new Date().toISOString() });
      }

      // ---- 平台能力 ----
      if (pathname === '/api/platforms' && method === 'GET') {
        return send(res, 200, { platforms: listPlatforms() });
      }

      // ---- 统计 ----
      if (pathname === '/api/stats' && method === 'GET') {
        return send(res, 200, store.stats());
      }

      // ---- 数据源 CRUD ----
      const srcList = /^\/api\/sources$/;
      const srcOne = /^\/api\/sources\/([^/]+)$/;
      const srcSync = /^\/api\/sources\/([^/]+)\/sync$/;

      if (srcList.test(pathname)) {
        if (method === 'GET') return send(res, 200, { sources: store.listSources() });
        if (method === 'POST') {
          const body = await readJson(req);
          if (!body.platform || !getConnector(body.platform)) {
            return send(res, 400, { error: '缺少或未知的 platform' });
          }
          const rec = store.createSource(body);
          return send(res, 201, store.maskSource(rec));
        }
      }

      let m;
      if ((m = srcOne.exec(pathname))) {
        const id = m[1];
        const rec = store.getSource(id);
        if (!rec) return send(res, 404, { error: '数据源不存在' });
        if (method === 'GET') return send(res, 200, store.maskSource(rec));
        if (method === 'PUT') {
          const body = await readJson(req);
          const updated = store.updateSource(id, body);
          return send(res, 200, store.maskSource(updated));
        }
        if (method === 'DELETE') {
          store.deleteSource(id);
          return send(res, 200, { ok: true });
        }
      }

      if ((m = srcSync.exec(pathname)) && method === 'POST') {
        const rec = store.getSource(m[1]);
        if (!rec) return send(res, 404, { error: '数据源不存在' });
        try {
          const result = await runSync(store, rec, {
            max: url.searchParams.get('max') ? Number(url.searchParams.get('max')) : undefined
          });
          return send(res, 200, { ok: true, ...result });
        } catch (e) {
          store.recordSync(m[1], {
            status: 'failed',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 0,
            count: 0,
            error: errMessage(e)
          });
          return send(res, 502, { ok: false, error: errMessage(e) });
        }
      }

      // ---- 连接测试（不落库） ----
      if (pathname === '/api/sources/test' && method === 'POST') {
        const body = await readJson(req);
        const connector = getConnector(body.platform);
        if (!connector) return send(res, 400, { error: '未知平台' });
        try {
          const r = await connector.test({
            baseUrl: body.baseUrl,
            credential: body.credential,
            options: body.options || {}
          });
          return send(res, 200, { ok: true, ...r });
        } catch (e) {
          return send(res, 400, { ok: false, error: errMessage(e) });
        }
      }

      // ---- 文档检索 / 列表 ----
      if (pathname === '/api/docs' && method === 'GET') {
        const q = url.searchParams.get('q');
        const source = url.searchParams.get('source');
        const platform = url.searchParams.get('platform');
        const type = url.searchParams.get('type');
        const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);
        const offset = Number(url.searchParams.get('offset') || 0);
        const sort = url.searchParams.get('sort') || 'updated';

        if (q) {
          const ranked = store.index.score(q, { sourceId: source, platform, type });
          const total = ranked.length;
          const slice = ranked.slice(offset, offset + limit);
          const items = [];
          for (const r of slice) {
            const d = store.getDoc(r.id);
            if (!d) continue;
            items.push({
              id: d.id,
              title: d.title,
              path: d.path,
              type: d.type,
              platform: d.platform,
              sourceId: d.sourceId,
              url: d.url,
              tags: d.tags,
              updatedAt: d.updatedAt,
              snippet: makeSnippet(d.plainText || d.summary, q),
              score: Number(r.score.toFixed(4)),
              matched: r.matched
            });
          }
          return send(res, 200, { query: q, total, items });
        }

        const page = store.listDocs({ sourceId: source, platform, type, limit, offset, sort });
        return send(res, 200, page);
      }

      // ---- 单文档 ----
      const docOne = /^\/api\/docs\/([^/]+)$/;
      if ((m = docOne.exec(pathname)) && method === 'GET') {
        const d = store.getDoc(m[1]);
        if (!d) return send(res, 404, { error: '文档不存在' });
        return send(res, 200, d);
      }

      // ---- 导出 ----
      if (pathname === '/api/export' && method === 'GET') {
        const sourceId = url.searchParams.get('source');
        const bundle = store.exportBundle({ sourceId });
        const name = sourceId ? `kb-${sourceId}.json` : 'kb-export.json';
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}"`
        });
        return res.end(JSON.stringify(bundle, null, 2));
      }

      return send(res, 404, { error: 'Not Found' });
    } catch (e) {
      return send(res, 500, { error: errMessage(e) });
    }
  });

  return server;
}

export async function main() {
  ensureDirs();
  const store = createStore();
  const scheduler = startScheduler(store, {
    syncOnBoot: config.syncOnBoot,
    syncIntervalMinutes: config.syncIntervalMinutes
  });

  const server = createServer(store, scheduler);
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));

  console.log('────────────────────────────────────────────');
  console.log(' 知识库工作台 (knowledge-workbench) 已启动');
  console.log('────────────────────────────────────────────');
  console.log(printConfigBanner());
  console.log(` 工作台地址 : http://${config.host}:${config.port}`);
  console.log(` 数据源数量 : ${store.listSources().length}，已索引文档 : ${store.allDocs().length}`);
  console.log('────────────────────────────────────────────');

  const shutdown = () => {
    console.log('\n正在关闭…');
    scheduler.stop?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, store, scheduler };
}

// 直接运行（node server/src/index.js）
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error('启动失败：', e);
    process.exit(1);
  });
}
