"""MCP 双向实现（零依赖）：

- MCPServer：把本知识库作为 MCP 服务端暴露（stdio, JSON-RPC 2.0），
  供 Claude Desktop / IDE / Agent 直接检索与阅读。
- MCPClient：把任意暴露 MCP 协议的服务器当作知识源接入（stdio 或 HTTP）。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading

from .core import VERSION, request as http_request
from .search import make_snippet

PROTOCOL = "2025-06-18"

TOOLS = [
    {
        "name": "kb_search",
        "description": "跨所有数据源检索知识库，返回相关文档摘要与原文链接",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索关键词（支持中英文）"},
                "limit": {"type": "number", "default": 10},
                "platform": {"type": "string"},
                "sourceId": {"type": "string"},
                "type": {"type": "string"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "kb_get_document",
        "description": "根据文档 ID 获取完整正文与元数据",
        "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
    },
    {"name": "kb_list_sources", "description": "列出已配置的知识源及同步状态", "inputSchema": {"type": "object", "properties": {}}},
    {
        "name": "kb_list_documents",
        "description": "列出知识库文档（可按数据源过滤）",
        "inputSchema": {"type": "object", "properties": {"sourceId": {"type": "string"}, "limit": {"type": "number", "default": 30}, "offset": {"type": "number", "default": 0}}},
    },
    {
        "name": "kb_sync_source",
        "description": "触发指定数据源的立即同步",
        "inputSchema": {"type": "object", "properties": {"sourceId": {"type": "string"}}, "required": ["sourceId"]},
    },
]


def _text(obj) -> dict:
    return {"type": "text", "text": obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, indent=2)}


class MCPServer:
    def __init__(self, store):
        self.store = store

    # ---- 工具实现 ----
    def _search(self, args):
        ranked = self.store.index.score(
            args.get("query") or "",
            platform=args.get("platform"),
            source_id=args.get("sourceId"),
            type_=args.get("type"),
        )
        limit = int(args.get("limit") or 10)
        items = []
        for r in ranked[:limit]:
            d = self.store.get_doc(r["id"])
            if not d:
                continue
            items.append({
                "id": d["id"], "title": d["title"], "platform": d["platform"], "type": d["type"],
                "url": d["url"], "tags": d.get("tags") or [], "updatedAt": d.get("updatedAt"),
                "snippet": make_snippet(d.get("plainText") or d.get("summary"), args.get("query") or ""),
                "score": round(r["score"], 4),
            })
        return {"content": [_text({"total": len(ranked), "items": items})], "isError": False}

    def _get_doc(self, args):
        d = self.store.get_doc(args.get("id"))
        if not d:
            return {"content": [_text(f"文档不存在：{args.get('id')}")], "isError": True}
        return {"content": [_text({k: d.get(k) for k in ("id", "title", "platform", "type", "url", "tags", "updatedAt", "content")})], "isError": False}

    def _list_sources(self, _args):
        return {"content": [_text(self.store.list_sources())], "isError": False}

    def _list_docs(self, args):
        page = self.store.list_docs(
            source_id=args.get("sourceId"),
            limit=int(args.get("limit") or 30),
            offset=int(args.get("offset") or 0),
        )
        slim = [{"id": d["id"], "title": d["title"], "platform": d["platform"], "type": d["type"], "url": d.get("url"), "updatedAt": d.get("updatedAt")} for d in page["items"]]
        return {"content": [_text({"total": page["total"], "items": slim})], "isError": False}

    def _sync(self, args):
        from .connectors import run_sync  # 延迟导入，避免与 connectors 循环依赖

        rec = self.store.get_source(args.get("sourceId"))
        if not rec:
            return {"content": [_text(f"数据源不存在：{args.get('sourceId')}")], "isError": True}
        try:
            result = run_sync(self.store, rec)
            return {"content": [_text({"ok": True, **result})], "isError": False}
        except Exception as e:  # noqa: BLE001
            return {"content": [_text({"ok": False, "error": str(e)})], "isError": True}

    # ---- 协议分发 ----
    def handle(self, method: str, params: dict | None = None):
        params = params or {}
        if method == "initialize":
            return {"protocolVersion": PROTOCOL, "capabilities": {"tools": {}, "resources": {}},
                    "serverInfo": {"name": "knowledge-workbench-py", "version": VERSION}}
        if method in ("notifications/initialized", "notifications/cancelled"):
            return None
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": TOOLS}
        if method == "tools/call":
            name = params.get("name")
            table = {
                "kb_search": self._search,
                "kb_get_document": self._get_doc,
                "kb_list_sources": self._list_sources,
                "kb_list_documents": self._list_docs,
                "kb_sync_source": self._sync,
            }
            fn = table.get(name)
            if not fn:
                return {"content": [_text(f"未知工具：{name}")], "isError": True}
            try:
                return fn(params.get("arguments") or {})
            except Exception as e:  # noqa: BLE001
                return {"content": [_text(f"工具执行失败：{e}")], "isError": True}
        if method == "resources/list":
            docs = self.store.all_docs()[:200]
            return {"resources": [{"uri": f"kb://doc/{d['id']}", "name": d["title"], "mimeType": "text/markdown", "description": f"{d['platform']}/{d['type']}"} for d in docs]}
        if method == "resources/templates/list":
            return {"resourceTemplates": [{"uriTemplate": "kb://doc/{id}", "name": "知识库文档", "mimeType": "text/markdown"}]}
        if method == "resources/read":
            uri = params.get("uri", "")
            doc_id = uri.replace("kb://doc/", "")
            d = self.store.get_doc(doc_id)
            if not d:
                return {"contents": [_text(f"文档不存在：{uri}")]}
            return {"contents": [_text(f"# {d['title']}\n\n来源：{d['platform']} | 类型：{d['type']}\n链接：{d.get('url') or '—'}\n\n{d.get('content')}")]}
        raise RuntimeError(f"不支持的方法：{method}")

    def serve_stdio(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            try:
                result = self.handle(msg.get("method"), msg.get("params") or {})
                if msg.get("id") is not None and result is not None:
                    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}, ensure_ascii=False) + "\n")
                    sys.stdout.flush()
            except Exception as e:  # noqa: BLE001
                if msg.get("id") is not None:
                    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": str(e)}}, ensure_ascii=False) + "\n")
                    sys.stdout.flush()


# ---------------------------------------------------------------- MCP 客户端


class StdioTransport:
    def __init__(self, command: str, args: list, env: dict | None = None):
        self.proc = subprocess.Popen(
            [command, *args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={**os.environ, **(env or {})}, text=True, encoding="utf-8", bufsize=1,
        )
        self._pending: dict[int, tuple] = {}
        self._seq = 0
        self._lock = threading.Lock()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        for line in self.proc.stdout:
            line = (line or "").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            mid = msg.get("id")
            if mid is not None and mid in self._pending:
                ev, box = self._pending.pop(mid)
                box["msg"] = msg
                ev.set()

    def request(self, method: str, params: dict | None = None, timeout: int = 30):
        with self._lock:
            self._seq += 1
            mid = self._seq
        ev = threading.Event()
        box: dict = {}
        self._pending[mid] = (ev, box)
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}}, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        if not ev.wait(timeout):
            raise RuntimeError("MCP 调用超时")
        msg = box["msg"]
        if "error" in msg:
            raise RuntimeError(msg["error"].get("message", str(msg["error"])))
        return msg.get("result")

    def kill(self):
        try:
            self.proc.terminate()
        except Exception:
            pass


class HttpTransport:
    def __init__(self, url: str, headers: dict | None = None):
        self.url = url
        self.headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", **(headers or {})}
        self._seq = 0

    def request(self, method: str, params: dict | None = None, timeout: int = 30):
        self._seq += 1
        mid = self._seq
        resp = http_request(self.url, method="POST", headers=self.headers,
                            data=json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}}),
                            timeout=timeout * 1000, retries=1)
        ctype = (resp.headers.get("Content-Type") or "").lower() if hasattr(resp.headers, "get") else ""
        if "text/event-stream" in ctype:
            return _parse_sse(resp.text, mid)
        msg = resp.json()
        if "error" in msg:
            raise RuntimeError(msg["error"].get("message", str(msg["error"])))
        return msg.get("result")

    def kill(self):
        pass


def _parse_sse(text: str, match_id: int):
    result = None
    for block in re_split_blocks(text):
        for line in block.splitlines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == match_id:
                if "error" in msg:
                    raise RuntimeError(msg["error"].get("message", str(msg["error"])))
                result = msg.get("result")
    return result


def re_split_blocks(text: str):
    import re as _re

    return _re.split(r"\r?\n\r?\n", text)


class MCPClient:
    def __init__(self, transport):
        self.t = transport

    @staticmethod
    def from_options(opts: dict):
        if (opts.get("transport") or "").lower() in ("sse", "http"):
            return MCPClient(HttpTransport(opts["url"], opts.get("headers") or {}))
        return MCPClient(StdioTransport(opts["command"], opts.get("args") or [], opts.get("env") or {}))

    def initialize(self):
        res = self.t.request("initialize", {
            "protocolVersion": PROTOCOL,
            "capabilities": {"resources": {}, "tools": {}},
            "clientInfo": {"name": "knowledge-workbench-py", "version": VERSION},
        })
        try:
            self.t.request("notifications/initialized", {})
        except Exception:
            pass
        return res

    def list_resources(self):
        out, cursor = [], None
        while True:
            res = self.t.request("resources/list", {"cursor": cursor} if cursor else {}) or {}
            out.extend(res.get("resources") or [])
            cursor = res.get("nextCursor")
            if not cursor:
                break
        return out

    def read_resource(self, uri):
        res = self.t.request("resources/read", {"uri": uri}) or {}
        return res.get("contents") or []

    def list_tools(self):
        res = self.t.request("tools/list", {}) or {}
        return res.get("tools") or []

    def call_tool(self, name, arguments=None):
        res = self.t.request("tools/call", {"name": name, "arguments": arguments or {}}) or {}
        return res.get("content") or []

    def kill(self):
        self.t.kill()
