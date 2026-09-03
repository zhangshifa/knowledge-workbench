# 07 · Python 运行手册（本地 / 网页）

`server_py/` 是与 Node 版 **接口完全兼容** 的 Python 实现：
同一套 REST API、同一份前端（`web/`）、同一种数据格式。

> **双运行时设计**：Node 版（`server/`）与 Python 版（`server_py/`）任选其一。
> 若都安装了 `cryptography` 并使用相同 `KB_MASTER_KEY`，两者的凭证密文格式一致，**数据目录可通用**。

---

## 一、为什么再加一个 Python 版

- 本机/内网服务器大多自带 Python，开箱即用，无需装 Node；
- 标准库即可运行，供应链风险更低；
- 便于用 Python 生态做二次加工（脚本同步、离线分析、定时任务）。

## 二、环境要求

- Python ≥ 3.9
- 可选：`pip install cryptography`（启用 AES-256-GCM，与 Node 版密文互通）
  - 未安装时自动回退到**纯标准库**实现的 AES-256-CTR + HMAC-SHA256（先加密后认证），功能不受影响

## 三、启动

### 本地使用（只在本机访问）

```bash
cd server_py
python main.py serve                     # 默认 127.0.0.1:8787
python main.py serve --host 0.0.0.0 --port 9000   # 局域网 / 公网可访问
# 浏览器打开 http://127.0.0.1:8787
```

### 网页使用（同一份服务，浏览器即网页端）

Python 服务同时提供 **API** 与 **静态网页托管**，所以"网页用 Python 运行"就是直接启动它，
然后用任意浏览器（电脑 / 手机）访问该地址即可，无需额外 Web 服务器。

生产建议放在 Nginx/HTTPS 之后，见 `deploy/nginx.conf`。

## 四、命令行

```bash
python main.py sync  <sourceId>    # 同步指定数据源
python main.py sync-all            # 同步所有启用中的数据源
python main.py mcp                 # 以 MCP 服务端运行（stdio）
```

## 五、Docker 部署（Python 版）

```bash
docker build -f deploy/Dockerfile.python -t knowledge-workbench-py .
docker run -d -p 8787:8787 \
  -e KB_HOST=0.0.0.0 \
  -e KB_MASTER_KEY=$(openssl rand -hex 32) \
  -v kb-data:/app/data \
  knowledge-workbench-py
```

或直接使用 Compose（默认使用 Node 镜像，可把 `build.dockerfile` 改为 `deploy/Dockerfile.python`）。

## 六、与 Node 版的差异

| 项目 | Node 版 | Python 版 |
|---|---|---|
| 依赖 | 零依赖（内置模块） | 零依赖（标准库），可选 cryptography |
| 凭证加密 | AES-256-GCM | AES-256-GCM（有 cryptography 时，密文互通）/ AES-256-CTR+HMAC（回退） |
| 检索 | 中文 bigram + BM25 | 同算法，结果一致 |
| 适配器 | 9 类 | 9 类，参数一致 |
| MCP | 服务端 + 客户端 | 服务端 + 客户端 |
| 并发 | 异步 I/O | 线程池（map_limit） |
| HTTP 服务 | node:http | http.server（ThreadingHTTPServer） |

## 七、环境变量

与 Node 版完全一致：`KB_HOST` / `KB_PORT` / `KB_DATA_DIR` / `KB_API_TOKEN` /
`KB_MASTER_KEY` / `KB_SYNC_INTERVAL_MINUTES` / `KB_SYNC_ON_BOOT` / `KB_MAX_DOCS_PER_SOURCE`。

Python 版额外支持：`KB_INSECURE_TLS=1`（忽略自签名证书校验，便于内网禅道/ShowDoc）。

## 八、测试

```bash
cd server_py
python -m unittest discover -s tests -v
```

覆盖：凭证加解密（含纯标准库回退）、中文分词与 BM25 排序、front matter / ENEX 解析、
本地目录同步与幂等、MCP 工具与资源、平台注册表。
