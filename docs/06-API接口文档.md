# 06 · API 接口文档

基础路径：`/api`
鉴权：若设置了 `KB_API_TOKEN`，除 `GET /api/health` 外所有 `/api/*` 需
`Authorization: Bearer <KB_API_TOKEN>`。

---

## 平台能力

### `GET /api/platforms`

返回可接入平台清单（含字段定义）。

```json
{ "platforms": [ { "platform": "github", "label": "GitHub", "fields": [ ... ] } ] }
```

---

## 统计与健康

### `GET /api/health`
```json
{ "status": "ok", "version": "0.1.0", "time": "2026-08-29T12:00:00.000Z" }
```

### `GET /api/stats`
```json
{
  "sources": 3, "enabledSources": 2, "docs": 512,
  "byPlatform": { "github": 300, "showdoc": 212 },
  "index": { "docCount": 512, "tokenCount": 8421, "avgLen": 243.1 },
  "dataDir": "/app/data", "lastSyncAt": "2026-08-29T11:00:00.000Z"
}
```

---

## 数据源（Sources）

### `GET /api/sources`
返回全部数据源（**不会**返回明文凭证）。

### `POST /api/sources`
请求体：
```json
{
  "name": "研发知识库",
  "platform": "github",
  "baseUrl": "https://api.github.com",
  "credential": "ghp_xxx",
  "options": { "repos": "zhangshifa/spark-collector" },
  "enabled": true,
  "syncIntervalMinutes": 120
}
```
成功返回 `201` + 掩码后的数据源。

### `GET /api/sources/:id`
### `PUT /api/sources/:id`
可更新 `name / baseUrl / enabled / options / syncIntervalMinutes / credential`。

### `DELETE /api/sources/:id`
删除数据源并移除其已同步文档。

### `POST /api/sources/test`
用临时参数测试连接（不落库）：
```json
{ "platform": "github", "baseUrl": "https://api.github.com", "credential": "ghp_xxx", "options": {} }
```
返回 `{ "ok": true, "message": "...", "sample": ["repo1","repo2"] }`。

### `POST /api/sources/:id/sync`
触发该数据源立即同步，返回 `{ "ok": true, "added": 12, "updated": 3, "archived": 0, "total": 300 }`。

---

## 文档（Docs）

### `GET /api/docs`
列表模式（无 `q`）：
- 查询：`source` / `platform` / `type` / `limit`(≤100) / `offset` / `sort`(updated|title)
- 返回 `{ "total": 512, "items": [ {id,title,path,type,platform,url,tags,updatedAt,summary} ] }`

检索模式（带 `q`）：
- `GET /api/docs?q=部署规范&platform=github&limit=30`
- 返回 `{ "query": "部署规范", "total": 7, "items": [ { id, title, snippet, score, matched, url } ] }`

### `GET /api/docs/:id`
返回完整文档（含 `content` 正文与 `meta`）。

### `GET /api/export?source=<id>`
下载知识库 JSON 包（可整体导出，避免平台锁定）。

---

## 统一文档模型（UnifiedDoc）

```ts
interface UnifiedDoc {
  id: string;            // sha1(sourceId + externalId)
  sourceId: string;
  platform: string;      // github|gitee|showdoc|zentao|evernote|tencent-docs|mcp|local|generic
  externalId: string;
  title: string;
  path: string;
  type: string;          // doc|page|note|story|task|bug|sheet|code|experience
  url: string;           // 回跳原文
  summary: string;       // 摘要
  content: string;       // 正文（Markdown 优先）
  plainText: string;     // 去标记纯文本（检索用）
  tags: string[];
  author: string;
  createdAt: string | null;
  updatedAt: string | null;
  meta: Record<string, unknown>;  // 平台原生字段
  indexedAt: string;
}
```

---

## MCP 协议（服务端）

通过 `server/scripts/mcp-stdio.js` 暴露，见 [`docs/04-MCP接入说明.md`](04-MCP接入说明.md)。
