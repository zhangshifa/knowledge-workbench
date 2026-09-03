"""中英文混合分词 + BM25 倒排索引（与 Node 版算法一致，便于双端结果对齐）。"""

from __future__ import annotations

import math
import re
from collections import Counter

CJK_RUN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+")
LATIN = re.compile(r"[a-zA-Z0-9_][a-zA-Z0-9_\-.+#]*")

K1 = 1.5
B = 0.75


def tokenize(text) -> list[str]:
    s = str(text or "").lower()
    out: list[str] = []
    out.extend(m for m in LATIN.findall(s) if len(m) >= 2)
    for run in CJK_RUN.findall(s):
        if len(run) == 1:
            out.append(run)
            continue
        out.extend(run[i:i + 2] for i in range(len(run) - 1))
        if len(run) >= 4:  # 长词补三元组，提升短语命中率
            out.extend(run[i:i + 3] for i in range(len(run) - 2))
    return out


def tokenize_with_freq(text) -> dict[str, int]:
    return dict(Counter(tokenize(text)))


class SearchIndex:
    def __init__(self):
        self.postings: dict[str, dict[str, float]] = {}
        self.meta: dict[str, dict] = {}
        self.total_len = 0
        self.doc_count = 0

    # ---- 写入 ----
    def remove_doc(self, doc_id: str) -> None:
        m = self.meta.pop(doc_id, None)
        if not m:
            return
        self.total_len = max(0, self.total_len - m["len"])
        self.doc_count = max(0, self.doc_count - 1)
        for token, pm in list(self.postings.items()):
            if doc_id in pm:
                del pm[doc_id]
                if not pm:
                    del self.postings[token]

    def index_doc(self, doc: dict) -> None:
        if not doc or not doc.get("id"):
            return
        self.remove_doc(doc["id"])

        combined: dict[str, float] = {}

        def merge(freqs: dict[str, int], weight: float):
            for t, f in freqs.items():
                combined[t] = combined.get(t, 0) + f * weight

        merge(tokenize_with_freq(doc.get("title") or ""), 3)
        merge(tokenize_with_freq(" ".join(doc.get("tags") or [])), 2)
        merge(tokenize_with_freq(doc.get("plainText") or doc.get("content") or ""), 1)

        length = sum(combined.values())
        for t, f in combined.items():
            self.postings.setdefault(t, {})[doc["id"]] = f

        self.meta[doc["id"]] = {
            "len": length,
            "sourceId": doc.get("sourceId"),
            "platform": doc.get("platform"),
            "type": doc.get("type"),
            "tags": doc.get("tags") or [],
            "updatedAt": doc.get("updatedAt") or doc.get("indexedAt"),
            "title": doc.get("title") or "",
        }
        self.total_len += length
        self.doc_count += 1

    def reindex_source(self, source_id: str, docs: list[dict]) -> None:
        for doc_id in [d for d, m in self.meta.items() if m.get("sourceId") == source_id]:
            self.remove_doc(doc_id)
        for d in docs:
            self.index_doc(d)

    def clear(self) -> None:
        self.postings.clear()
        self.meta.clear()
        self.total_len = 0
        self.doc_count = 0

    @property
    def avg_len(self) -> float:
        return self.total_len / self.doc_count if self.doc_count else 0.0

    # ---- 检索 ----
    def score(self, query: str, platform: str = None, source_id: str = None,
              type_: str = None, tags: list = None) -> list[dict]:
        tokens = list(dict.fromkeys(tokenize(query)))
        if not tokens:
            return []
        scores: dict[str, float] = {}
        matched: dict[str, list] = {}
        avg = self.avg_len

        for qt in tokens:
            pm = self.postings.get(qt)
            if not pm:
                continue
            df = len(pm)
            idf = math.log(1 + (self.doc_count - df + 0.5) / (df + 0.5))
            for doc_id, tf in pm.items():
                m = self.meta.get(doc_id)
                if not m:
                    continue
                if platform and m["platform"] != platform:
                    continue
                if source_id and m["sourceId"] != source_id:
                    continue
                if type_ and m["type"] != type_:
                    continue
                if tags and not any(t in m["tags"] for t in tags):
                    continue
                denom = tf + K1 * (1 - B + B * m["len"] / (avg or 1))
                scores[doc_id] = scores.get(doc_id, 0) + idf * (tf * (K1 + 1) / (denom or 1))
                matched.setdefault(doc_id, []).append(qt)

        return sorted(
            ({"id": k, "score": v, "matched": sorted(set(matched.get(k, [])))} for k, v in scores.items()),
            key=lambda x: x["score"], reverse=True,
        )

    def stats(self) -> dict:
        return {"docCount": self.doc_count, "tokenCount": len(self.postings), "avgLen": round(self.avg_len, 2)}

    def to_dict(self) -> dict:
        return {
            "version": 1,
            "postings": {t: list(pm.items()) for t, pm in self.postings.items()},
            "meta": list(self.meta.items()),
            "totalLen": self.total_len,
            "docCount": self.doc_count,
        }

    @classmethod
    def from_dict(cls, data: dict | None):
        idx = cls()
        if not data:
            return idx
        for t, arr in (data.get("postings") or {}).items():
            idx.postings[t] = {k: float(v) for k, v in arr}
        idx.meta = {k: v for k, v in (data.get("meta") or [])}
        idx.total_len = data.get("totalLen", 0)
        idx.doc_count = data.get("docCount", len(idx.meta))
        return idx


def make_snippet(text, query, length: int = 160) -> str:
    raw = re.sub(r"\s+", " ", str(text or "")).strip()
    if not raw:
        return ""
    lower = raw.lower()
    pos = -1
    for t in tokenize(query):
        p = lower.find(t)
        if p >= 0:
            pos = p
            break
    if pos < 0:
        return raw[:length] + ("…" if len(raw) > length else "")
    start = max(0, pos - length // 3)
    end = min(len(raw), start + length)
    return ("…" if start > 0 else "") + raw[start:end] + ("…" if end < len(raw) else "")
