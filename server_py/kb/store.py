"""知识库存储层：数据源、文档、倒排索引的持久化（JSON 文件，原子写入）。"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import datetime
from pathlib import Path

from .core import CONFIG, decrypt, encrypt, ensure_dirs, mask_secret, now_iso, short_id
from .search import SearchIndex

SOURCES_FILE = "sources.json"
INDEX_FILE = "index.json"
DOCS_DIR = "docs"


def atomic_write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, indent=2)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


class Store:
    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or CONFIG
        self.data_dir = Path(self.cfg["data_dir"])
        ensure_dirs()
        self._lock = threading.RLock()
        self.sources: dict[str, dict] = {}
        self.docs: dict[str, dict] = {}
        self.by_source: dict[str, set] = {}
        self.index = SearchIndex()
        self._timer = None

    # ---------------------------------------------------------------- 载入
    def load(self) -> "Store":
        sf = self.data_dir / SOURCES_FILE
        if sf.exists():
            try:
                for s in json.loads(sf.read_text(encoding="utf-8")):
                    self.sources[s["id"]] = s
            except Exception as e:  # noqa: BLE001
                print(f"[store] sources.json 解析失败，已忽略：{e}")

        docs_dir = self.data_dir / DOCS_DIR
        docs_dir.mkdir(parents=True, exist_ok=True)
        for f in docs_dir.glob("*.json"):
            try:
                arr = json.loads(f.read_text(encoding="utf-8"))
                ids = set()
                for d in arr:
                    self.docs[d["id"]] = d
                    ids.add(d["id"])
                self.by_source[f.stem] = ids
            except Exception as e:  # noqa: BLE001
                print(f"[store] {f.name} 解析失败，已忽略：{e}")

        idxf = self.data_dir / INDEX_FILE
        if idxf.exists():
            try:
                self.index = SearchIndex.from_dict(json.loads(idxf.read_text(encoding="utf-8")))
            except Exception:  # noqa: BLE001
                self.rebuild_index()
        else:
            self.rebuild_index()

        if len(self.index.meta) != len(self.docs):
            self.rebuild_index()
        return self

    def rebuild_index(self) -> None:
        self.index.clear()
        for d in self.docs.values():
            self.index.index_doc(d)
        self.persist_index()

    # ---------------------------------------------------------------- 持久化
    def persist_sources(self) -> None:
        with self._lock:
            atomic_write(self.data_dir / SOURCES_FILE, list(self.sources.values()))

    def persist_docs(self, source_id: str) -> None:
        with self._lock:
            ids = self.by_source.get(source_id, set())
            arr = [self.docs[i] for i in ids if i in self.docs]
            atomic_write(self.data_dir / DOCS_DIR / f"{source_id}.json", arr)

    def persist_index(self) -> None:
        with self._lock:
            atomic_write(self.data_dir / INDEX_FILE, self.index.to_dict())

    def schedule_persist(self, delay: float = 0.8) -> None:
        """合并写盘，避免同步过程中频繁 IO。"""
        if self._timer:
            return

        def _run():
            self._timer = None
            self.persist_index()

        t = threading.Timer(delay, _run)
        t.daemon = True
        self._timer = t
        t.start()

    # ---------------------------------------------------------------- 数据源
    def list_sources(self) -> list[dict]:
        return [self.mask_source(s) for s in self.sources.values()]

    @staticmethod
    def mask_source(s: dict) -> dict:
        out = dict(s)
        out.pop("credential", None)
        out.pop("credentialEnc", None)
        out["credentialMasked"] = s.get("credentialMasked", "")
        out["hasCredential"] = bool(s.get("credentialEnc"))
        return out

    def get_source(self, source_id: str):
        return self.sources.get(source_id)

    def get_credential(self, source: dict) -> str:
        if not source or not source.get("credentialEnc"):
            return ""
        return decrypt(source["credentialEnc"], str(self.data_dir))

    def create_source(self, data: dict) -> dict:
        sid = short_id("src")
        rec = {
            "id": sid,
            "name": data.get("name") or data.get("platform"),
            "platform": data["platform"],
            "baseUrl": str(data.get("baseUrl") or "").rstrip("/"),
            "credentialEnc": encrypt(data["credential"], str(self.data_dir)) if data.get("credential") else "",
            "credentialMasked": mask_secret(data.get("credential") or ""),
            "options": data.get("options") or {},
            "enabled": data.get("enabled") is not False,
            "syncIntervalMinutes": data.get("syncIntervalMinutes", self.cfg["sync_interval_minutes"]),
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "lastSync": None,
            "docCount": 0,
        }
        self.sources[sid] = rec
        self.by_source[sid] = set()
        self.persist_sources()
        return rec

    def update_source(self, source_id: str, patch: dict):
        rec = self.sources.get(source_id)
        if not rec:
            return None
        for key in ("name", "enabled", "syncIntervalMinutes"):
            if key in patch and patch[key] is not None:
                rec[key] = patch[key]
        if "baseUrl" in patch and patch["baseUrl"] is not None:
            rec["baseUrl"] = str(patch["baseUrl"]).rstrip("/")
        if "options" in patch and patch["options"] is not None:
            rec["options"] = {**rec.get("options", {}), **patch["options"]}
        if patch.get("credential"):
            rec["credentialEnc"] = encrypt(patch["credential"], str(self.data_dir))
            rec["credentialMasked"] = mask_secret(patch["credential"])
        rec["updatedAt"] = now_iso()
        self.persist_sources()
        return rec

    def delete_source(self, source_id: str) -> bool:
        if source_id not in self.sources:
            return False
        with self._lock:
            for doc_id in list(self.by_source.get(source_id, set())):
                self.docs.pop(doc_id, None)
                self.index.remove_doc(doc_id)
            self.by_source.pop(source_id, None)
            self.sources.pop(source_id, None)
        f = self.data_dir / DOCS_DIR / f"{source_id}.json"
        if f.exists():
            f.unlink()
        self.persist_sources()
        self.persist_index()
        return True

    def record_sync(self, source_id: str, result: dict) -> None:
        rec = self.sources.get(source_id)
        if not rec:
            return
        rec["lastSync"] = {
            "status": result.get("status"),
            "startedAt": result.get("startedAt"),
            "finishedAt": result.get("finishedAt"),
            "durationMs": result.get("durationMs"),
            "count": result.get("count"),
            "error": result.get("error"),
        }
        rec["updatedAt"] = now_iso()
        self.persist_sources()

    # ---------------------------------------------------------------- 文档
    def save_docs(self, source_id: str, docs: list[dict]) -> dict:
        with self._lock:
            prev = self.by_source.get(source_id, set())
            nxt = set()
            added = updated = 0
            for d in docs:
                nxt.add(d["id"])
                if d["id"] in prev:
                    updated += 1
                else:
                    added += 1
                self.docs[d["id"]] = d
                self.index.index_doc(d)
            archived = 0
            for old in prev - nxt:
                self.docs.pop(old, None)
                self.index.remove_doc(old)
                archived += 1
            self.by_source[source_id] = nxt
            rec = self.sources.get(source_id)
            if rec:
                rec["docCount"] = len(nxt)
        self.persist_docs(source_id)
        self.persist_sources()
        self.schedule_persist()
        return {"added": added, "updated": updated, "archived": archived}

    def get_doc(self, doc_id: str):
        return self.docs.get(doc_id)

    def all_docs(self) -> list[dict]:
        return list(self.docs.values())

    def list_docs(self, source_id=None, platform=None, type_=None,
                  limit=50, offset=0, sort="updated") -> dict:
        arr = self.all_docs()
        if source_id:
            arr = [d for d in arr if d.get("sourceId") == source_id]
        if platform:
            arr = [d for d in arr if d.get("platform") == platform]
        if type_:
            arr = [d for d in arr if d.get("type") == type_]

        def key(d):
            if sort == "title":
                return str(d.get("title") or "")
            return d.get("updatedAt") or d.get("indexedAt") or ""

        arr.sort(key=key, reverse=(sort != "title"))
        total = len(arr)
        return {"total": total, "items": arr[offset: offset + limit]}

    def stats(self) -> dict:
        by_platform: dict[str, int] = {}
        for d in self.docs.values():
            by_platform[d["platform"]] = by_platform.get(d["platform"], 0) + 1
        last = [s.get("lastSync", {}).get("finishedAt") for s in self.sources.values() if s.get("lastSync")]
        last = [x for x in last if x]
        return {
            "sources": len(self.sources),
            "enabledSources": sum(1 for s in self.sources.values() if s.get("enabled")),
            "docs": len(self.docs),
            "byPlatform": by_platform,
            "index": self.index.stats(),
            "dataDir": str(self.data_dir),
            "lastSyncAt": max(last) if last else None,
            "runtime": "python",
        }

    def export_bundle(self, source_id: str = None) -> dict:
        if source_id:
            docs = [self.docs[i] for i in self.by_source.get(source_id, set()) if i in self.docs]
        else:
            docs = self.all_docs()
        return {"exportedAt": now_iso(), "version": CONFIG["version"], "runtime": "python",
                "sources": self.list_sources(), "docs": docs}


def create_store() -> Store:
    return Store().load()
