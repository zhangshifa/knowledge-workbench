# 知识库工作台 · Knowledge Workbench

> 一个链接 + 一个凭证，把分散在多处的知识与经验，收敛到**一处**、**三端可用**、**本地或云上**统一检索。
> 支持 ShowDoc / GitHub / Gitee / 禅道 / 印象笔记 / 腾讯文档，也支持 **MCP 方式** 与 **通用 HTTP** 接入任意系统。

## 为什么是它

- **接入极简**：每个数据源只需要 `baseUrl`（一个链接）+ `credential`（一个凭证），其余参数都有默认值。
- **六 + 多平台**：六大平台内置适配器，外加 MCP 客户端、本地目录、通用 OpenAPI 兜底。
- **双向 MCP**：
  - 作为 **MCP 客户端** —— 把任意暴露 MCP 的服务器当成知识源接入；
  - 作为 **MCP 服务端** —— 让 Claude Desktop / 各类 IDE / Agent 直接检索与阅读你的知识库。
- **三端一致**：Web / 移动（PWA，可加到主屏）/ 桌面（Electron）共用同一套前端与同一份后端数据。
- **本地优先，云上可选**：服务端**零第三方依赖**（仅 Node ≥ 18 内置模块），不联网也能跑；一条 `docker compose up` 即可上云。
- **凭据不裸奔**：数据库落地的凭证一律 `AES-256-GCM` 加密，API 永不回显明文。

## 功能矩阵

| 能力 | 支持 |
|---|---|
| ShowDoc 接入 | ✅ 开放 API + Cookie |
| GitHub 接入 | ✅ 仓库 Markdown/文本 |
| Gitee 接入 | ✅ 含企业版 |
| 禅道接入 | ✅ REST v1 + 老版本 session，需求/任务/Bug/文档 |
| 印象笔记接入 | ✅ ENEX 导出（默认）/ Evernote Cloud API（可选依赖） |
| 腾讯文档接入 | ✅ 开放平台 API / 导出文件目录 |
| MCP 方式整合 | ✅ 客户端 + 服务端 |
| 通用 HTTP 接入 | ✅ 可配置字段映射 |
| 本地部署 | ✅ `node server/src/index.js` |
| 云上部署 | ✅ Docker / Compose / 云托管 / GHCR |
| 三端可用 | ✅ Web / 移动 PWA / 桌面 Electron |
| 检索 | ✅ 中英文混合分词 + BM25 倒排 |
| 定时同步 | ✅ 增量、断点续传、失败隔离 |

## 快速开始（本地）

```bash
# 需要 Node.js ≥ 18
node server/src/index.js
# 浏览器打开 http://127.0.0.1:8787
```

无需 `npm install` —— 服务端零依赖。

## 快速开始（Docker / 云）

```bash
docker compose up -d --build
# 打开 http://<host>:8787
```

镜像构建与推送已在 `.github/workflows/ci.yml` 配置，推送 `main` 即自动构建并推送至
`ghcr.io/zhangshifa/knowledge-workbench`。

## 添加第一个数据源

1. 点击左上角 **＋**，选择平台（如 GitHub）。
2. 填写：
   - **链接**：`https://api.github.com`（GitHub.com）或自部署 GHE 地址
   - **凭证**：Personal Access Token（裸串即可）
   - **高级选项(JSON)**（可选）：`{"repos":"owner/repo","include":"\\.(md|txt)$"}`
3. 点「测试连接」→「保存并同步」。
4. 回到顶部搜索框，跨库检索。

更详细的各平台参数见 [`docs/05-数据源接入手册.md`](docs/05-数据源接入手册.md)。

## MCP 双向

### 让 Agent 检索你的知识库（服务端 → 外部）

在支持 MCP 的客户端里这样配置：

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

提供工具：`kb_search` / `kb_get_document` / `kb_list_sources` / `kb_list_documents` / `kb_sync_source`；
资源：`kb://doc/{id}`。

### 把外部 MCP 服务器当作知识源（客户端 ← 外部）

新建数据源，平台选 **MCP 服务器（客户端接入）**，高级选项填：

```json
{ "transport": "stdio", "command": "npx", "args": ["-y", "@some/mcp-server"] }
```

详情见 [`docs/04-MCP接入说明.md`](docs/04-MCP接入说明.md)。

## 部署

| 形态 | 方式 | 说明 |
|---|---|---|
| 本地 | `node server/src/index.js` | 默认绑定 127.0.0.1，数据落 `./data` |
| 桌面 | `cd desktop && npm i && npm run desktop` | Electron 拉起本地服务 + 窗口 |
| 移动 | 浏览器打开同一地址 → 加到主屏 | PWA，离线可访问外壳 |
| 云（容器） | `docker compose up -d` | 挂载 `kb-data` 卷持久化 |
| 云（托管） | `deploy/cloudbase/cloudbaserc.json` | 腾讯云 CloudBase 云托管 |

详见 [`docs/03-部署指南.md`](docs/03-部署指南.md)。

## 安全说明

- 凭证落地采用 `AES-256-GCM` 加密，主密钥来自 `KB_MASTER_KEY` 或数据目录随机密钥文件。
- 启用 `KB_API_TOKEN` 后，所有 `/api/*` 需 `Authorization: Bearer`。
- 对外暴露服务时，请置于 HTTPS 反向代理之后（示例见 `deploy/nginx.conf`），并将 `KB_MASTER_KEY` 设为强随机值。

## 文档索引

- [`docs/00-需求原文.md`](docs/00-需求原文.md) — 需求方原始表述（原封不动存档）
- [`docs/01-需求规格说明书.md`](docs/01-需求规格说明书.md) — 工程化拆解
- [`docs/02-架构设计.md`](docs/02-架构设计.md) — 架构、统一模型、检索、同步、凭证安全
- [`docs/03-部署指南.md`](docs/03-部署指南.md) — 本地 / 桌面 / 移动 / 云
- [`docs/04-MCP接入说明.md`](docs/04-MCP接入说明.md) — MCP 双向
- [`docs/05-数据源接入手册.md`](docs/05-数据源接入手册.md) — 六平台 + 通用接入参数
- [`docs/06-API接口文档.md`](docs/06-API接口文档.md) — REST API

## 许可证

MIT © zhangshifa
