#!/usr/bin/env python
"""知识库工作台 · Python 入口

用法：
    python server_py/main.py serve  [--host 127.0.0.1] [--port 8787]   # 本地 / 网页服务
    python server_py/main.py mcp                                       # 以 MCP 服务端运行（stdio）
    python server_py/main.py sync  <sourceId>                          # 命令行同步指定数据源
    python server_py/main.py sync-all                                  # 同步全部启用中的数据源
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from kb.core import CONFIG, crypto_mode, ensure_dirs  # noqa: E402
from kb.mcp import MCPServer  # noqa: E402
from kb.scheduler import Scheduler  # noqa: E402
from kb.server import serve  # noqa: E402
from kb.store import create_store  # noqa: E402


def cmd_serve(args):
    if args.host:
        CONFIG["host"] = args.host
    if args.port:
        CONFIG["port"] = args.port
    if args.data_dir:
        CONFIG["data_dir"] = os.path.abspath(args.data_dir)
    ensure_dirs()
    store = create_store()
    scheduler = Scheduler(store, CONFIG["sync_interval_minutes"], CONFIG["sync_on_boot"]).start()
    serve(store, scheduler, CONFIG["host"], CONFIG["port"])


def cmd_mcp(_args):
    store = create_store()
    MCPServer(store).serve_stdio()


def cmd_sync(args):
    store = create_store()
    rec = store.get_source(args.source_id)
    if not rec:
        print(f"数据源不存在：{args.source_id}")
        return 1
    from kb.connectors import run_sync

    try:
        result = run_sync(store, rec)
        print(f"同步完成：新增 {result['added']} / 更新 {result['updated']} / 归档 {result['archived']}，共 {result['total']} 篇")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"同步失败：{e}")
        return 2


def cmd_sync_all(_args):
    store = create_store()
    from kb.connectors import run_sync

    ok = fail = 0
    for s in store.sources.values():
        if not s.get("enabled"):
            continue
        try:
            r = run_sync(store, s)
            print(f"✓ {s['name']}: 共 {r['total']} 篇")
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"✗ {s['name']}: {e}")
            fail += 1
    print(f"完成：成功 {ok} 个，失败 {fail} 个")
    return 0 if fail == 0 else 2


def main():
    parser = argparse.ArgumentParser(description="知识库工作台 · Python 服务端")
    sub = parser.add_subparsers(dest="cmd")

    p_serve = sub.add_parser("serve", help="启动 HTTP 服务（本地 / 网页同源）")
    p_serve.add_argument("--host", default=None)
    p_serve.add_argument("--port", type=int, default=None)
    p_serve.add_argument("--data-dir", default=None)
    p_serve.set_defaults(func=cmd_serve)

    p_mcp = sub.add_parser("mcp", help="以 MCP 服务端运行（stdio, JSON-RPC 2.0）")
    p_mcp.set_defaults(func=cmd_mcp)

    p_sync = sub.add_parser("sync", help="同步指定数据源")
    p_sync.add_argument("source_id")
    p_sync.set_defaults(func=cmd_sync)

    p_all = sub.add_parser("sync-all", help="同步所有启用中的数据源")
    p_all.set_defaults(func=cmd_sync_all)

    args = parser.parse_args()
    if not args.cmd:
        parser.print_help()
        print(f"\n当前配置：数据目录={CONFIG['data_dir']}  监听={CONFIG['host']}:{CONFIG['port']}  加密={crypto_mode()}")
        return 0
    return args.func(args) or 0


if __name__ == "__main__":
    sys.exit(main())
