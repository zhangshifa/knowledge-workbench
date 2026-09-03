"""文件格式解析：Markdown front matter、Word/Excel 文本抽取、Evernote ENEX 解析。

全部基于 Python 标准库（zipfile + xml.etree + re），无需第三方依赖。
"""

from __future__ import annotations

import io
import re
import zipfile
from xml.etree import ElementTree as ET

from .core import html_to_text

_W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_S_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


# ---------------------------------------------------------------- Markdown


def parse_front_matter(md) -> tuple[dict, str]:
    """返回 (元数据 dict, 正文)。解析失败时原样返回。"""
    text = str(md or "")
    m = re.match(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?", text)
    if not m:
        return {}, text
    data: dict = {}
    for line in m.group(1).splitlines():
        kv = re.match(r"^\s*([A-Za-z0-9_\-.]+)\s*:\s*(.*)$", line)
        if not kv:
            continue
        v = kv.group(2).strip()
        if v.startswith("[") and v.endswith("]"):
            data[kv.group(1)] = [x.strip().strip("\"'") for x in v[1:-1].split(",") if x.strip()]
        else:
            data[kv.group(1)] = v.strip("\"'")
    return data, text[m.end():]


def first_heading(md, fallback: str = "") -> str:
    m = re.search(r"^\s*#\s+(.+)$", str(md or ""), re.M)
    if m:
        return m.group(1).strip().rstrip("#").strip()
    return fallback


# ---------------------------------------------------------------- Office


def _xml_text(node) -> str:
    return "".join(node.itertext())


def docx_to_text(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        xml = z.read("word/document.xml")
    root = ET.fromstring(xml)
    lines: list[str] = []
    for para in root.iter(f"{_W_NS}p"):
        parts = [t.text or "" for t in para.iter(f"{_W_NS}t")]
        lines.append("".join(parts))
    return "\n".join(lines).strip()


def _shared_strings(z: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    out = []
    for si in root.iter(f"{_S_NS}si"):
        out.append("".join(t.text or "" for t in si.iter(f"{_S_NS}t")))
    return out


def xlsx_to_text(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        shared = _shared_strings(z)
        sheet_name = next(
            (n for n in z.namelist() if re.match(r"^xl/worksheets/sheet\d*\.xml$", n)), None
        )
        if not sheet_name:
            return "\n".join(shared)
        root = ET.fromstring(z.read(sheet_name))

    rows: list[str] = []
    for row in root.iter(f"{_S_NS}row"):
        cells: list[str] = []
        for c in row.iter(f"{_S_NS}c"):
            t = c.get("t")
            v = c.find(f"{_S_NS}v")
            if t == "inlineStr":
                is_node = c.find(f"{_S_NS}is")
                cells.append("".join(x.text or "" for x in is_node.iter(f"{_S_NS}t")) if is_node is not None else "")
            elif v is None:
                cells.append("")
            elif t == "s":
                try:
                    cells.append(shared[int(v.text)])
                except (ValueError, IndexError, TypeError):
                    cells.append(v.text or "")
            else:
                cells.append(v.text or "")
        if any(x.strip() for x in cells):
            rows.append(" | ".join(cells))
    return "\n".join(rows).strip()


def office_to_text(ext: str, data: bytes) -> str:
    e = (ext or "").lower()
    try:
        if e == ".docx":
            return docx_to_text(data)
        if e == ".xlsx":
            return xlsx_to_text(data)
    except Exception:  # noqa: BLE001
        pass
    if e in (".html", ".htm"):
        return html_to_text(data.decode("utf-8", errors="replace"))
    return data.decode("utf-8", errors="replace")


# ---------------------------------------------------------------- ENEX

_NOTE_RE = re.compile(r"<note>([\s\S]*?)</note>", re.I)
_TITLE_RE = re.compile(r"<title>([\s\S]*?)</title>", re.I)
_CONTENT_RE = re.compile(r"<content>([\s\S]*?)</content>", re.I)
_CREATED_RE = re.compile(r"<created>([\s\S]*?)</created>", re.I)
_UPDATED_RE = re.compile(r"<updated>([\s\S]*?)</updated>", re.I)
_TAG_RE = re.compile(r"<tag>([\s\S]*?)</tag>", re.I)
_NOTEBOOK_RE = re.compile(r"<notebook>([\s\S]*?)</notebook>", re.I)
_EN_NOTE_RE = re.compile(r"<en-note[^>]*>([\s\S]*?)</en-note>", re.I)


def _unescape(s: str) -> str:
    for a, b in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'"), ("&amp;", "&")):
        s = s.replace(a, b)
    return s


def _enex_time(s: str):
    m = re.match(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$", (s or "").strip())
    if not m:
        return None
    from datetime import datetime, timezone

    return datetime(
        int(m.group(1)), int(m.group(2)), int(m.group(3)),
        int(m.group(4)), int(m.group(5)), int(m.group(6)), tzinfo=timezone.utc,
    ).isoformat().replace("+00:00", "Z")


def parse_enex(text: str) -> list[dict]:
    """解析 Evernote 导出文件（ENEX），返回笔记列表。"""
    xml = str(text or "")
    notes = []
    for block in _NOTE_RE.findall(xml):
        title_m = _TITLE_RE.search(block)
        content_m = _CONTENT_RE.search(block)
        raw = content_m.group(1) if content_m else ""
        raw = re.sub(r"^<!\[CDATA\[|\]\]>$", "", raw.strip())
        raw = _unescape(raw)
        en = _EN_NOTE_RE.search(raw)
        html = en.group(1) if en else raw
        created_m = _CREATED_RE.search(block)
        updated_m = _UPDATED_RE.search(block)
        nb_m = _NOTEBOOK_RE.search(block)
        notes.append({
            "title": _unescape(title_m.group(1)).strip() if title_m else "(无标题)",
            "html": html,
            "created": _enex_time(created_m.group(1)) if created_m else None,
            "updated": _enex_time(updated_m.group(1)) if updated_m else None,
            "tags": [_unescape(t).strip() for t in _TAG_RE.findall(block) if t.strip()],
            "notebook": _unescape(nb_m.group(1)).strip() if nb_m else "",
        })
    return notes
