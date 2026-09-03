"""HTTP 服务：REST API + 静态站点托管（Web/移动/PWA 同源）。"""

from __future__ import annotations

import json
import mimetypes
import re
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .connectors import get_connector, list_platforms, run_sync
from .core import CONFIG, VERSION, clamp, now_iso
from .search import make_snippet

MIME_FALLBACK = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
}

SRC_ONE = re.compile(r"^/api/sources/([^/]+)$")
SRC_SYNC = re.compile(r"^/api/sources/([^/]+)/sync$")
DOC_ONE = re.compile(r"^/api/docs/([^/]+)$")


class Handler(BaseHTTPRequestHandler):
    server_version = f"KnowledgeWorkbenchPy/{VERSION}"
    store = None
    scheduler = None

    # ------------------------------------------------------------ 基础工具
    def log_message(self, fmt, *args):
        if CONFIG.get("log_requests", True):
            print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

    def _send(self, status: int, obj=None, headers: dict | None = None, raw: bytes | None = None):
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization,Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        body = raw if raw is not None else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        if raw is None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def _authorized(self) -> bool:
        token = CONFIG.get("api_token") or ""
        if not token:
            return True
        return (self.headers.get("Authorization") or "") == f"Bearer {token}"

    def _static(self, rel: str):
        web_dir = Path(CONFIG["web_dir"])
        rel_path = "/index.html" if rel in ("", "/") else rel
        file_path = (web_dir / rel_path.lstrip("/")).resolve()
        try:
            file_path.relative_to(web_dir.resolve())
        except ValueError:
            self._send(403, {"error": "Forbidden"})
            return
        if not file_path.exists() or file_path.is_dir():
            self._send(404, {"error": "Not Found"})
            return
        ctype = MIME_FALLBACK.get(file_path.suffix.lower()) or mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self._send(200, headers={"Content-Type": ctype}, raw=file_path.read_bytes())

    # ------------------------------------------------------------ 路由
    def _route(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        qs = urllib.parse.parse_qs(parsed.query)
        method = self.command

        if path.startswith("/api"):
            if not self._authorized():
                return self._send(401, {"error": "未授权，请在 Authorization 头携带 Bearer Token"})
        else:
            return self._static(path)

        store = self.store
        try:
            if path == "/api/health":
                return self._send(200, {"status": "ok", "runtime": "python", "version": VERSION, "time": now_iso()})

            if path == "/api/platforms":
                return self._send(200, {"platforms": list_platforms()})

            if path == "/api/stats":
                return self._send(200, store.stats())

            if path == "/api/sources" and method == "GET":
                return self._send(200, {"sources": store.list_sources()})

            if path == "/api/sources" and method == "POST":
                body = self._body()
                if not body.get("platform") or not get_connector(body["platform"]):
                    return self._send(400, {"error": "缺少或未知的 platform"})
                return self._send(201, store.mask_source(store.create_source(body)))

            # 配置导出 / 导入：方便在多台机器之间复用同一套接入配置
            # 同样必须先于 /api/sources/{id} 匹配
            if path == "/api/sources/export" and method == "GET":
                cfg = [{
                    "name": s.get("name"), "platform": s.get("platform"), "baseUrl": s.get("baseUrl"),
                    "options": s.get("options") or {}, "enabled": s.get("enabled", True),
                    "syncIntervalMinutes": s.get("syncIntervalMinutes"),
                    "credentialMasked": s.get("credentialMasked") or "",
                } for s in store.sources.values()]
                return self._send(200, {"sources": cfg})

            if path == "/api/sources/import" and method == "POST":
                body = self._body()
                created, skipped = [], []
                for item in body.get("sources") or []:
                    if not item.get("platform") or not get_connector(item["platform"]):
                        skipped.append({"name": item.get("name"), "reason": "未知平台"})
                        continue
                    created.append(store.mask_source(store.create_source(item)))
                return self._send(200, {"ok": True, "created": len(created), "skipped": skipped, "sources": created})

            # 注意：/api/sources/test 必须先于 /api/sources/{id} 匹配，否则会被当作 id="test"
            if path == "/api/sources/test" and method == "POST":
                body = self._body()
                connector = get_connector(body.get("platform"))
                if not connector:
                    return self._send(400, {"error": "未知平台"})
                try:
                    r = connector.test(body.get("baseUrl"), body.get("credential"), body.get("options") or {})
                    return self._send(200, {"ok": True, **r})
                except Exception as e:  # noqa: BLE001
                    return self._send(400, {"ok": False, "error": str(e)})

            m = SRC_ONE.match(path)
            if m:
                rec = store.get_source(m.group(1))
                if not rec:
                    return self._send(404, {"error": "数据源不存在"})
                if method == "GET":
                    return self._send(200, store.mask_source(rec))
                if method == "PUT":
                    return self._send(200, store.mask_source(store.update_source(m.group(1), self._body())))
                if method == "DELETE":
                    store.delete_source(m.group(1))
                    return self._send(200, {"ok": True})

            m = SRC_SYNC.match(path)
            if m and method == "POST":
                rec = store.get_source(m.group(1))
                if not rec:
                    return self._send(404, {"error": "数据源不存在"})
                try:
                    result = run_sync(store, rec, int(qs["max"][0]) if qs.get("max") else None)
                    return self._send(200, {"ok": True, **result})
                except Exception as e:  # noqa: BLE001
                    store.record_sync(m.group(1), {"status": "failed", "startedAt": now_iso(),
                                                   "finishedAt": now_iso(), "durationMs": 0, "count": 0, "error": str(e)})
                    return self._send(502, {"ok": False, "error": str(e)})

            if path == "/api/docs" and method == "GET":
                q = (qs.get("q") or [""])[0]
                limit = clamp(int((qs.get("limit") or ["30"])[0]), 1, 100)
                offset = int((qs.get("offset") or ["0"])[0])
                source_id = (qs.get("source") or [None])[0]
                platform = (qs.get("platform") or [None])[0]
                type_ = (qs.get("type") or [None])[0]

                if q:
                    ranked = store.index.score(q, platform=platform, source_id=source_id, type_=type_)
                    items = []
                    for r in ranked[offset: offset + limit]:
                        d = store.get_doc(r["id"])
                        if not d:
                            continue
                        items.append({
                            "id": d["id"], "title": d["title"], "path": d.get("path"), "type": d.get("type"),
                            "platform": d.get("platform"), "sourceId": d.get("sourceId"), "url": d.get("url"),
                            "tags": d.get("tags") or [], "updatedAt": d.get("updatedAt"),
                            "snippet": make_snippet(d.get("plainText") or d.get("summary"), q),
                            "score": round(r["score"], 4), "matched": r["matched"],
                        })
                    return self._send(200, {"query": q, "total": len(ranked), "items": items})

                return self._send(200, store.list_docs(
                    source_id=source_id, platform=platform, type_=type_, limit=limit, offset=offset,
                    sort=(qs.get("sort") or ["updated"])[0]))

            m = DOC_ONE.match(path)
            if m and method == "GET":
                d = store.get_doc(m.group(1))
                if not d:
                    return self._send(404, {"error": "文档不存在"})
                return self._send(200, d)

            if path == "/api/export" and method == "GET":
                source_id = (qs.get("source") or [None])[0]
                bundle = store.export_bundle(source_id)
                name = f"kb-{source_id}.json" if source_id else "kb-export.json"
                self._send(200, headers={"Content-Type": "application/json; charset=utf-8",
                                         "Content-Disposition": f'attachment; filename="{name}"'},
                           raw=json.dumps(bundle, ensure_ascii=False).encode("utf-8"))

            return self._send(404, {"error": "Not Found"})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e)})

    # ------------------------------------------------------------ HTTP 方法
    def do_GET(self):
        self._route()

    def do_HEAD(self):
        self._route()

    def do_POST(self):
        self._route()

    def do_PUT(self):
        self._route()

    def do_DELETE(self):
        self._route()

    def do_OPTIONS(self):
        self._send(204, raw=b"")


def create_server(store, scheduler=None, host: str | None = None, port: int | None = None):
    handler = type("BoundHandler", (Handler,), {"store": store, "scheduler": scheduler})
    httpd = ThreadingHTTPServer((host or CONFIG["host"], port or CONFIG["port"]), handler)
    httpd.daemon_threads = True
    return httpd


def serve(store, scheduler=None, host=None, port=None) -> None:
    httpd = create_server(store, scheduler, host, port)
    actual_host, actual_port = httpd.server_address[0], httpd.server_address[1]
    from .core import crypto_mode

    print("────────────────────────────────────────────")
    print(" 知识库工作台 (Python) 已启动")
    print("────────────────────────────────────────────")
    print(f" 数据目录   : {CONFIG['data_dir']}")
    print(f" 监听地址   : {actual_host}:{actual_port}")
    print(f" 接口鉴权   : {'已启用 (Bearer Token)' if CONFIG['api_token'] else '未启用（仅限本地信任环境）'}")
    print(f" 凭证加密   : {crypto_mode()}")
    interval = CONFIG["sync_interval_minutes"]
    sync_desc = "关闭（仅手动）" if interval == 0 else f"每 {interval} 分钟"
    print(f" 定时同步   : {sync_desc}")
    print(f" 工作台地址 : http://{actual_host}:{actual_port}")
    print(f" 已索引文档 : {len(store.all_docs())}，数据源：{len(store.list_sources())}")
    print("────────────────────────────────────────────")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭…")
        if scheduler:
            scheduler.stop()
        httpd.server_close()
