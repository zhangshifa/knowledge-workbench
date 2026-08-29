import { Router, ok, fail } from './router.js';
import { listConnectors } from '../connectors/index.js';
import { makeSnippet, highlight } from '../search.js';
import { config } from '../config.js';
import { clamp, nowIso, redact } from '../lib/util.js';
import { renderMarkdown } from '../lib/normalize.js';

/**
 * 全部 API 路由。
 * ctx = { store, syncEngine, mcpEnabled }
 */
export function buildApiRouter(ctx) {
  const { store, syncEngine } = ctx;
  const r = new Router();

  // ---------------------------------------------------------------- 元信息
  r.get('/api/health', () =>
    ok({
      status: 'ok',
      version: config.version,
      time: nowIso(),
      docs: store.docs.size,
      sources: store.sources.size
    })
  );

  r.get('/api/meta', () =>
    ok({
      version: config.version,
      platforms: listConnectors(),
      stats: store.stats(),
      features: {
        mcpServer: true,
        mcpClient: true,
        localDeploy: true,
        cloudDeploy: true,
        credentialEncrypt: true
      }
    })
  );

  r.get('/api/stats', () => ok(store.stats()));

  // ---------------------------------------------------------------- 数据源
  r.get('/api/platforms', () => ok({ items: listConnectors() }));

  r.get('/api/sources', () => ok({ items: store.listSources() }));

  r.get('/api/sources/:id', ({ params }) => {
    const s = store.getSource(params.id);
    if (!s) return fail('数据源不存在', 404);
    return ok({ item: store.maskSource(s) });
  });

  r.post('/api/sources', async ({ body }) => {
    const { platform, baseUrl, name, options } = body || {};
    if (!platform) return fail('缺少 platform');
    if (!listConnectors().some((c) => c.platform === platform)) return fail(`不支持的平台：${platform}`);
    const connector = listConnectors().find((c) => c.platform === platform);
    const src = store.createSource({
      platform,
      name,
      baseUrl: baseUrl || connector.defaultBaseUrl,
      credential: body.credential,
      options,
      enabled: body.enabled,
      syncIntervalMinutes: body.syncIntervalMinutes
    });
    return ok({ item: store.maskSource(src) });
  });

  r.put('/api/sources/:id', ({ params, body }) => {
    const src = store.updateSource(params.id, body || {});
    if (!src) return fail('数据源不存在', 404);
    return ok({ item: store.maskSource(src) });
  });

  r.delete('/api/sources/:id', ({ params }) => {
    const done = store.deleteSource(params.id);
    if (!done) return fail('数据源不存在', 404);
    return ok({ deleted: true });
  });

  r.post('/api/sources/test', async ({ body }) => {
    const { platform, baseUrl, credential, options } = body || {};
    if (!platform) return fail('缺少 platform');
    try {
      const res = await syncEngine.testConnection({ platform, baseUrl, credential, options });
      return ok(res);
    } catch (e) {
      return fail(redact(e.message || String(e)), 400);
    }
  });

  r.post('/api/sources/:id/sync', async ({ params }) => {
    const s = store.getSource(params.id);
    if (!s) return fail('数据源不存在', 404);
    const result = await syncEngine.syncSource(params.id);
    return ok({ sourceId: params.id, ...result });
  });

  r.post('/api/sync/all', async () => {
    const results = await syncEngine.syncAll();
    return ok({ results });
  });

  r.get('/api/sync/logs', () => ok({ items: syncEngine.log.slice(0, 100) }));

  // ---------------------------------------------------------------- 文档
  r.get('/api/docs', ({ query }) => {
    const res = store.listDocs({
      sourceId: query.sourceId || undefined,
      platform: query.platform || undefined,
      type: query.type || undefined,
      limit: clamp(query.limit || 50, 1, 200),
      offset: Number(query.offset || 0),
      sort: query.sort || 'updated'
    });
    return ok({
      total: res.total,
      items: res.items.map((d) => ({ ...d, content: undefined }))
    });
  });

  r.get('/api/docs/:id', ({ params, query }) => {
    const d = store.getDoc(params.id);
    if (!d) return fail('文档不存在', 404);
    const withContent = query.content !== '0';
    return ok({
      item: {
        ...d,
        content: withContent ? d.content : undefined,
        html: withContent ? renderMarkdown(d.content) : undefined
      }
    });
  });

  r.post('/api/docs/:id/tags', ({ params, body }) => {
    const d = store.getDoc(params.id);
    if (!d) return fail('文档不存在', 404);
    d.tags = Array.from(new Set([...(d.tags || []), ...(body?.tags || [])])).slice(0, 30);
    if (body?.type === 'experience') d.type = 'experience';
    d.indexedAt = nowIso();
    store.index.indexDoc(d);
    store.persistDocs(d.sourceId);
    store.persistIndex();
    return ok({ item: { id: d.id, tags: d.tags, type: d.type } });
  });

  // ---------------------------------------------------------------- 检索
  r.get('/api/search', ({ query }) => {
    const q = String(query.q || '').trim();
    if (!q) return ok({ total: 0, items: [], query: q });
    const limit = clamp(query.limit || 20, 1, 100);
    const scored = store.index.score(q, {
      platform: query.platform || undefined,
      sourceId: query.sourceId || undefined,
      type: query.type || undefined
    });
    const items = scored.slice(0, limit).map((s) => {
      const d = store.getDoc(s.id);
      if (!d) return null;
      return {
        id: d.id,
        title: d.title,
        titleHtml: highlight(d.title, q),
        path: d.path,
        type: d.type,
        platform: d.platform,
        sourceId: d.sourceId,
        url: d.url,
        tags: d.tags,
        updatedAt: d.updatedAt,
        score: Number(s.score.toFixed(4)),
        snippetHtml: highlight(makeSnippet(d.plainText || d.content, q), q)
      };
    }).filter(Boolean);
    return ok({ total: scored.length, items, query: q });
  });

  r.get('/api/tags', () => {
    const counter = new Map();
    for (const d of store.docs.values()) {
      for (const t of d.tags || []) counter.set(t, (counter.get(t) || 0) + 1);
    }
    const items = Array.from(counter.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 200);
    return ok({ items });
  });

  // ---------------------------------------------------------------- 导出
  r.get('/api/export', ({ query }) => {
    const bundle = store.exportBundle({ sourceId: query.sourceId || undefined });
    return {
      __raw: {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="knowledge-${Date.now()}.json"`
        },
        body: JSON.stringify(bundle)
      }
    };
  });

  r.get('/api/export/markdown', ({ query }) => {
    const bundle = store.exportBundle({ sourceId: query.sourceId || undefined });
    const md = bundle.docs
      .map((d) => `# ${d.title}\n\n> 来源：${d.platform} · ${d.path || '-'} · ${d.url || '-'}\n\n${d.content || d.plainText || ''}\n`)
      .join('\n\n---\n\n');
    return {
      __raw: {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="knowledge-${Date.now()}.md"`
        },
        body: md
      }
    };
  });

  return r;
}
