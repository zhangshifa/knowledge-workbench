"""知识库工作台 · Python 运行时冒烟测试

运行：
    cd server_py && python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kb import core  # noqa: E402
from kb.connectors import list_platforms, run_sync  # noqa: E402
from kb.core import CONFIG, encrypt, decrypt  # noqa: E402
from kb.files import parse_front_matter, first_heading, parse_enex  # noqa: E402
from kb.mcp import MCPServer  # noqa: E402
from kb.search import SearchIndex, tokenize  # noqa: E402
from kb.store import Store  # noqa: E402

SAMPLE_MD = """---
title: 部署规范
tags: [部署, Docker]
---

# 部署规范

生产环境使用 Docker 部署知识库工作台，数据挂载到数据卷。
凭证使用 AES-256-GCM 加密存储。
"""

SAMPLE_MD2 = "# 需求：统一检索\n把 ShowDoc、GitHub、Gitee、禅道、印象笔记、腾讯文档整合到一处。\n"

SAMPLE_ENEX = """<?xml version="1.0" encoding="UTF-8"?>
<en-export export-date="20260830T120000Z" application="Evernote">
<note>
<title>灵感：知识整合</title>
<content><![CDATA[<?xml version="1.0"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note><div>希望把分散的知识收敛到一处</div></en-note>]]></content>
<created>20260829T120000Z</created>
<updated>20260830T120000Z</updated>
<tag>灵感</tag>
<notebook>个人</notebook>
</note>
</en-export>
"""


def make_store(tmp: str) -> Store:
    cfg = {**CONFIG, "data_dir": tmp}
    Path(tmp).mkdir(parents=True, exist_ok=True)
    return Store(cfg).load()


class TestCrypto(unittest.TestCase):
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = encrypt("ghp_secret_token_123", tmp)
            self.assertNotEqual(c, "")
            self.assertNotIn("ghp_secret_token_123", c)
            self.assertEqual(decrypt(c, tmp), "ghp_secret_token_123")

    def test_pure_stdlib_fallback(self):
        """强制走纯标准库实现（模拟未安装 cryptography 的环境）。"""
        with tempfile.TemporaryDirectory() as tmp:
            origin = core._HAS_AESGCM
            core._key_cache.pop(tmp, None)
            try:
                core._HAS_AESGCM = False
                c = encrypt("another-secret", tmp)
                self.assertEqual(decrypt(c, tmp), "another-secret")
            finally:
                core._HAS_AESGCM = origin
                core._key_cache.pop(tmp, None)


class TestSearch(unittest.TestCase):
    def test_tokenize(self):
        tokens = tokenize("部署 deploy-ops Docker")
        self.assertIn("部署", tokens)
        self.assertIn("deploy-ops", tokens)
        self.assertIn("docker", [t.lower() for t in tokens])

    def test_bm25_ranking(self):
        idx = SearchIndex()
        idx.index_doc({"id": "a", "title": "部署规范", "plainText": "Docker 部署 数据卷", "tags": [], "platform": "local", "type": "doc"})
        idx.index_doc({"id": "b", "title": "需求", "plainText": "整合 知识", "tags": [], "platform": "local", "type": "doc"})
        ranked = idx.score("部署")
        self.assertEqual(ranked[0]["id"], "a")
        self.assertGreater(ranked[0]["score"], 0)


class TestFiles(unittest.TestCase):
    def test_front_matter(self):
        meta, body = parse_front_matter(SAMPLE_MD)
        self.assertEqual(meta["title"], "部署规范")
        self.assertIn("部署", meta["tags"])
        self.assertTrue(body.startswith("\n# 部署规范"))

    def test_first_heading(self):
        self.assertEqual(first_heading(SAMPLE_MD2, "fallback"), "需求：统一检索")
        self.assertEqual(first_heading("no heading", "fallback"), "fallback")

    def test_enex(self):
        notes = parse_enex(SAMPLE_ENEX)
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["title"], "灵感：知识整合")
        self.assertEqual(notes[0]["tags"], ["灵感"])
        self.assertIn("收敛到一处", notes[0]["html"])


class TestStoreAndSync(unittest.TestCase):
    def test_local_folder_sync_and_search(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs_dir = Path(tmp) / "docs"
            docs_dir.mkdir()
            (docs_dir / "deploy.md").write_text(SAMPLE_MD, encoding="utf-8")
            (docs_dir / "req.md").write_text(SAMPLE_MD2, encoding="utf-8")

            store = make_store(str(Path(tmp) / "kb-data"))
            src = store.create_source({
                "name": "本地文档", "platform": "local", "baseUrl": "",
                "credential": "", "options": {"dir": str(docs_dir)}, "enabled": True,
            })
            result = run_sync(store, store.get_source(src["id"]))
            self.assertEqual(result["total"], 2)
            self.assertEqual(result["added"], 2)

            ranked = store.index.score("Docker")
            self.assertEqual(len(ranked), 1)
            self.assertEqual(store.get_doc(ranked[0]["id"])["title"], "部署规范")

            stats = store.stats()
            self.assertEqual(stats["docs"], 2)
            self.assertEqual(stats["runtime"], "python")

            # 重复同步应幂等
            again = run_sync(store, store.get_source(src["id"]))
            self.assertEqual(again["added"], 0)
            self.assertEqual(again["updated"], 2)

    def test_platforms_registry(self):
        names = {p["platform"] for p in list_platforms()}
        for expect in ("showdoc", "github", "gitee", "zentao", "evernote", "tencent-docs", "mcp", "local", "generic"):
            self.assertIn(expect, names)


class TestMCPServer(unittest.TestCase):
    def test_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs_dir = Path(tmp) / "docs"
            docs_dir.mkdir()
            (docs_dir / "deploy.md").write_text(SAMPLE_MD, encoding="utf-8")
            store = make_store(str(Path(tmp) / "kb-data"))
            src = store.create_source({"name": "本地", "platform": "local", "credential": "",
                                       "options": {"dir": str(docs_dir)}})
            run_sync(store, store.get_source(src["id"]))

            server = MCPServer(store)
            self.assertIn("serverInfo", server.handle("initialize"))
            self.assertEqual(len(server.handle("tools/list")["tools"]), 5)

            r = server.handle("tools/call", {"name": "kb_search", "arguments": {"query": "Docker"}})
            payload = json.loads(r["content"][0]["text"])
            self.assertEqual(payload["total"], 1)
            self.assertEqual(payload["items"][0]["title"], "部署规范")

            r = server.handle("tools/call", {"name": "kb_list_sources"})
            self.assertEqual(len(json.loads(r["content"][0]["text"])), 1)

            res = server.handle("resources/list")
            self.assertEqual(len(res["resources"]), 1)
            self.assertTrue(res["resources"][0]["uri"].startswith("kb://doc/"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
