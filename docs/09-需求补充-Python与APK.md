# 09 · 需求补充：Python 运行时与 APK 打包

> 本文件记录第 2 轮需求（原文原封不动存档），并映射到实现。
> 第 1 轮需求原文见 `docs/00-需求原文.md`。

---

## 一、补充需求原文（原封不动）

本地使用python 网页使用python运行，apk使用capa 封装网页运行

---

## 二、需求拆解与实现映射

| 原文片段 | 需求编号 | 实现 | 位置 |
|---|---|---|---|
| 本地使用 python | FR-19 | 用 Python 启动本地服务，标准库即可运行，零第三方依赖 | `server_py/` |
| 网页使用 python 运行 | FR-20 | Python 服务同时提供 REST API 与静态网页托管，浏览器直接访问即为网页端 | `server_py/kb/server.py` |
| apk 使用 capa 封装网页运行 | FR-21 | Capacitor 把 `web/` 前端打包为 Android APK，运行时连接 Python 服务 | `mobile/` |

---

## 三、FR-19 本地使用 Python

```bash
cd server_py
python main.py serve            # 默认 127.0.0.1:8787
```

- Python ≥ 3.9；不装任何包也能跑
- 装了 `cryptography` 则启用 AES-256-GCM，**与 Node 版密文互通，数据目录可共用**
- 未装则回退纯标准库 AES-256-CTR + HMAC-SHA256（先加密后认证）

## 四、FR-20 网页使用 Python 运行

Python 服务内置静态站点托管，直接打开 `http://<host>:8787` 即网页端：

- 电脑浏览器：完整三栏工作台
- 手机浏览器：响应式 + PWA（可添加到主屏）
- 生产：置于 Nginx/HTTPS 之后（见 `deploy/nginx.conf`），或 `docker build -f deploy/Dockerfile.python`

## 五、FR-21 APK 使用 Capacitor 封装网页

```
APK（内嵌 web/，运行于 https://localhost）
   └─ ⚙ 服务设置 → 填入 Python 服务地址 + Token
        └─ 数据源同步 / BM25 检索 / MCP
```

关键设计：**前端代码只有一份**（`web/`），Web / PWA / Electron / APK 四端复用；
APK 只是壳，数据与能力全部来自 Python 服务，因此 APK 体积很小且无需重新实现检索。

构建步骤见 `docs/08-APK打包指南.md`。

---

## 六、验收标准（补充）

1. `python main.py serve` 启动后，浏览器可访问工作台，能建源、同步、检索。
2. `python -m unittest discover -s tests -v` 全部通过（含纯标准库加密回退路径）。
3. `cd mobile && npm install && npm run add:android && npm run sync` 能生成安卓工程并同步前端。
4. 构建出的 APK 安装后，配置服务地址即可加载数据源并检索。
