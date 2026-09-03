# 知识库工作台 · Knowledge Workbench

> 一个链接 + 一个凭证，把分散在多处的知识与经验，收敛到**一处**、**三端可用**、**本地或云上**统一检索。
> 支持 ShowDoc / GitHub / Gitee / 禅道 / 印象笔记 / 腾讯文档，也支持 **MCP 方式** 与 **通用 HTTP** 接入任意系统。

## 为什么是它

- **接入极简**：每个数据源只需要 `baseUrl`（一个链接）+ `credential`（一个凭证），其余参数都有默认值。
- **六 + 多平台**：六大平台内置适配器，外加 MCP 客户端、本地目录、通用 OpenAPI 兜底。
- **双向 MCP**：
  - 作为 **MCP 客户端** —— 把任意暴露 MCP 的服务器当成知识源接入；
  - 作为 **MCP 服务端** —— 让 Claude Desktop / 各类 IDE / Agent 直接检索与阅读你的知识库。
- **四端一致**：Web / 移动（PWA，可加到主屏）/ 桌面（Electron）/ Android（Capacitor APK）共用**同一套前端代码**与同一份数据。
- **双运行时**：Node 版（`server/`）与 **Python 版（`server_py/`）** 接口完全兼容，任选其一；Python 版用标准库即可运行。
- **本地优先，云上可选**：服务端零第三方依赖，不联网也能跑；一条 `docker compose up` 即可上云。
- **凭据不裸奔**：落地的凭证一律加密（AES-256-GCM，无 cryptography 时自动回退标准库实现），API 永不回显明文。

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
| 本地部署 | ✅ `python server_py/main.py serve` 或 `node server/src/index.js` |
| 云上部署 | ✅ Docker / Compose / 云托管 / GHCR（Node 与 Python 双镜像） |
| 四端可用 | ✅ Web / 移动 PWA / 桌面 Electron / Android APK |
| 检索 | ✅ 中英文混合分词 + BM25 倒排 |
| 定时同步 | ✅ 增量、失败隔离 |

## 快速开始（Python，推荐）

```bash
cd server_py
python main.py serve                # 默认 127.0.0.1:8787
python main.py serve --host 0.0.0.0 # 局域网 / 公网可访问
# 浏览器打开 http://127.0.0.1:8787 —— 这就是网页端
```

- Python ≥ 3.9，**无需 pip install 任何包**
- 装了 `cryptography` 则启用 AES-256-GCM，与 Node 版密文互通、数据目录可共用

## 快速开始（Node，等价可选）

```bash
node server/src/index.js            # Node ≥ 18，零依赖
```

## 快速开始（Docker / 云）

```bash
docker compose up -d --build
# 打开 http://<host>:8787
```

镜像构建与推送已在 `.github/workflows/ci.yml` 配置，推送 `main` 即自动构建并推送至
`ghcr.io/zhangshifa/knowledge-workbench`。

## 三端怎么用

| 端 | 怎么起 | 说明 |
|---|---|---|
| **Web（网页）** | 双击 `start-windows.bat`（或 `./start.sh`），浏览器自动打开 `http://127.0.0.1:8787` | 一键启动器：优先 Python，没装 Python 自动回退 Node |
| **桌面（Electron）** | `cd desktop && npm i && npm run desktop` | 自动拉起本地服务（默认 Python，可用 `KB_RUNTIME=node` 切换）并开窗口 |
| **移动（Android APK）** | `cd mobile && npm i && npm run build:debug`，或直接用 Actions 产出的 APK | Capacitor 封装 `web/`，首次打开点 ⚙ 填服务地址即可 |

三端共用**同一份前端代码**（`web/`）与**同一份数据**（`data/`），功能不会漂移。

### 一键启动器

- Windows：双击 `start-windows.bat`
- Linux / macOS：`./start.sh`

启动器会自动：设置数据目录 → 选择运行时（Python 优先）→ 3 秒后打开浏览器 → 前台运行服务（Ctrl+C 停止）。

### 方便整合：接入配置导入 / 导出

换机器或团队协作时不必重填一遍数据源：

- 侧边栏「**导出接入配置**」→ 得到 `kb-sources-config.json`（**不含明文凭证**）
- 新环境「**导入接入配置**」→ 一次性创建全部数据源，再逐个补凭证、点同步

对应接口：`GET /api/sources/export`、`POST /api/sources/import`。

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
      "command": "python",
      "args": ["server_py/main.py", "mcp"],
      "env": { "KB_DATA_DIR": "./data" }
    }
  }
}
```

> Node 版等价配置为 `["server/scripts/mcp-stdio.js"]`。

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
| 本地（Python） | `python server_py/main.py serve` | 默认绑定 127.0.0.1，数据落 `./data` |
| 本地（Node） | `node server/src/index.js` | 与 Python 版接口、数据格式兼容 |
| 网页 | 启动上述任一服务，浏览器直接打开 | Python 服务内置静态托管，网页端即同源站点 |
| 桌面 | `cd desktop && npm i && npm run desktop` | Electron 拉起本地服务 + 窗口 |
| 移动 | 手机浏览器打开同一地址 → 加到主屏 | PWA，离线可访问外壳 |
| Android APK | `cd mobile && npm i && npm run build:debug` | Capacitor 封装 `web/`，启动时配置服务地址 |
| 云（容器） | `docker compose up -d` | 挂载 `kb-data` 卷持久化；Python 镜像见 `deploy/Dockerfile.python` |
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
- [`docs/07-Python运行手册.md`](docs/07-Python运行手册.md) — 本地 / 网页用 Python 运行
- [`docs/08-APK打包指南.md`](docs/08-APK打包指南.md) — Capacitor 封装网页为 Android APK
- [`docs/09-需求补充-Python与APK.md`](docs/09-需求补充-Python与APK.md) — 第 2 轮需求（原文存档）与验收标准

## 许可证

MIT © zhangshifa
