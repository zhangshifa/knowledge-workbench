# 04 · MCP 接入说明

平台对 MCP 是**双向**的：

- **① 本平台作为 MCP 服务端**：让任何支持 MCP 的客户端（Claude Desktop、各类 IDE、Agent 框架）检索与阅读你的知识库。
- **② 本平台作为 MCP 客户端**：把任意暴露 MCP 协议的服务器，当作一个"知识源"接入并统一检索。

---

## 一、把知识库暴露给 Agent（服务端）

启动器：`server/scripts/mcp-stdio.js`，通过 stdio 走 JSON-RPC 2.0。

### 配置示例（Claude Desktop / IDE）

```json
{
  "mcpServers": {
    "knowledge-workbench": {
      "command": "node",
      "args": ["server/scripts/mcp-stdio.js"],
      "env": { "KB_DATA_DIR": "./data" }
    }
  }
}
```

### 提供的工具

| 工具 | 入参 | 说明 |
|---|---|---|
| `kb_search` | `query`(必填), `limit`, `platform`, `sourceId`, `type` | 跨库检索，返回摘要 + 原文链接 |
| `kb_get_document` | `id` | 获取完整正文与元数据 |
| `kb_list_sources` | — | 列出数据源及同步状态 |
| `kb_list_documents` | `sourceId`, `limit`, `offset` | 列出文档 |
| `kb_sync_source` | `sourceId` | 触发指定源立即同步（需可写） |

### 提供的资源

- `kb://doc/{id}` —— 单篇文档全文（Markdown）
- 资源模板：`kb://doc/{id}`

---

## 二、把外部 MCP 服务器接入知识库（客户端）

新建数据源 → 平台选 **「MCP 服务器（客户端接入）」**。

### stdio 模式（最常见）

高级选项 JSON：

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@some/company-mcp-server"],
  "env": { "API_KEY": "xxx" }
}
```

### SSE / HTTP 模式

```json
{
  "transport": "sse",
  "url": "http://localhost:3000/mcp",
  "headers": { "Authorization": "Bearer xxx" }
}
```

### 用 tools/call 取数

```json
{ "toolName": "search_internal_wiki", "toolArgs": { "q": "部署规范" } }
```

### 工作原理

```
本平台 ──启动外部 MCP 进程──> initialize
      ──resources/list──> 拿到资源 URI 列表
      ──resources/read──> 逐篇取正文
      ──归一化(buildDoc)──> 统一索引
```

单源拉取数量受 `KB_MAX_DOCS_PER_SOURCE` 限制；读取失败的资源会被跳过，不影响其它。

---

## 三、实现要点

- **服务端**：`server/src/mcp/server.js`，无第三方 MCP SDK 依赖，纯手写 JSON-RPC 2.0 状态机。
- **客户端**：`server/src/mcp/client.js`，同时支持 stdio 与 streamable-http(SSE) 两种 transport。
- **协议版本**：`2025-06-18`，兼容主流 MCP 客户端。

> 设计原则：零依赖、可离线、可审计。即使没有 MCP SDK，也能与任意合规 MCP 端点互通。
