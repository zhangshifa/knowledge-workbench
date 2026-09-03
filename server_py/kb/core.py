"""知识库工作台 · Python 服务端核心层

包含：运行配置、凭证加密、HTTP 客户端、内容归一化。

设计原则：
1. 以 Python 标准库为主，零第三方依赖即可运行；
2. 若环境已安装 `cryptography`，优先使用 AES-256-GCM，
   且密文布局与 Node 版完全一致（iv | tag | ciphertext），数据目录可互通；
3. 未安装时自动回退到纯标准库实现的 AES-256-CTR + HMAC-SHA256（先加密后认证）。
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import hmac
import json
import os
import re
import secrets
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent.parent  # .../knowledge-workbench
VERSION = "0.2.0"

# ---------------------------------------------------------------- 配置


def _num(v, default):
    try:
        return int(str(v).strip())
    except Exception:
        return default


def _bool(v, default=False):
    if v is None or v == "":
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def load_dotenv(path: Path | None = None) -> None:
    """极简 .env 载入；已存在的环境变量优先级更高。"""
    p = path or (ROOT_DIR / ".env")
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, v = t.split("=", 1)
        k, v = k.strip(), v.strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        if os.environ.get(k) is None:
            os.environ[k] = v


load_dotenv()


def build_config() -> dict:
    return {
        "root_dir": str(ROOT_DIR),
        "host": os.environ.get("KB_HOST", "127.0.0.1"),
        "port": _num(os.environ.get("KB_PORT"), 8787),
        "data_dir": os.path.abspath(os.environ.get("KB_DATA_DIR", str(ROOT_DIR / "data"))),
        "web_dir": os.path.abspath(os.environ.get("KB_WEB_DIR", str(ROOT_DIR / "web"))),
        "api_token": os.environ.get("KB_API_TOKEN", ""),
        "master_key": os.environ.get("KB_MASTER_KEY", ""),
        "sync_interval_minutes": _num(os.environ.get("KB_SYNC_INTERVAL_MINUTES"), 120),
        "sync_on_boot": _bool(os.environ.get("KB_SYNC_ON_BOOT"), False),
        "max_docs_per_source": _num(os.environ.get("KB_MAX_DOCS_PER_SOURCE"), 5000),
        "http_timeout_ms": _num(os.environ.get("KB_HTTP_TIMEOUT_MS"), 20000),
        "http_retries": _num(os.environ.get("KB_HTTP_RETRIES"), 2),
        "insecure_tls": _bool(os.environ.get("KB_INSECURE_TLS"), False),
        "version": VERSION,
    }


CONFIG = build_config()


def ensure_dirs() -> None:
    Path(CONFIG["data_dir"]).mkdir(parents=True, exist_ok=True)
    Path(CONFIG["data_dir"], "docs").mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------- 工具


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha1(text: str) -> str:
    return hashlib.sha1(str(text).encode("utf-8")).hexdigest()


def short_id(prefix: str = "src") -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def mask_secret(s: str) -> str:
    s = str(s or "")
    if not s:
        return ""
    if len(s) <= 8:
        return "*" * len(s)
    return f"{s[:4]}{'*' * min(8, len(s) - 8)}{s[-4:]}"


def clamp(n, lo, hi):
    return max(lo, min(hi, n))


def deep_get(obj, path, default=None):
    cur = obj
    for key in str(path).split("."):
        try:
            idx = int(key)
            cur = cur[idx]
        except (ValueError, TypeError):
            if isinstance(cur, dict):
                cur = cur.get(key)
            else:
                return default
        except (IndexError, KeyError):
            return default
        if cur is None:
            return default
    return cur


def sanitize_text(s) -> str:
    s = "" if s is None else str(s)
    # 去除不可见控制字符（保留 \n \t）
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", s)


def map_limit(items, limit, fn):
    if not items:
        return []
    workers = max(1, min(limit, len(items)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return [r for r in pool.map(fn, items) if r is not None]


# ---------------------------------------------------------------- 凭证加密

try:  # 优先使用 AES-256-GCM（与 Node 版密文布局一致）
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # type: ignore

    _HAS_AESGCM = True
except Exception:  # pragma: no cover - 环境未安装 cryptography
    _HAS_AESGCM = False

_key_cache: dict[str, bytes] = {}
_key_lock = threading.Lock()

# 纯标准库 AES（仅在无 cryptography 时使用）
_SBOX = None
_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36, 0x6C, 0xD8, 0xAB, 0x4D]


def _gen_sbox() -> list[int]:
    sbox = [0] * 256
    p = q = 1
    while True:
        p = p ^ ((p << 1) & 0xFF) ^ (0x1B if p & 0x80 else 0)
        q ^= (q << 1) & 0xFF
        q ^= (q << 2) & 0xFF
        q ^= (q << 4) & 0xFF
        if q & 0x80:
            q ^= 0x09
        x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4))
        sbox[p] = (x ^ 0x63) & 0xFF
        if p == 1:
            break
    sbox[0] = 0x63
    return sbox


def _sbox() -> list[int]:
    global _SBOX
    if _SBOX is None:
        _SBOX = _gen_sbox()
    return _SBOX


def _xtime(a: int) -> int:
    a <<= 1
    if a & 0x100:
        a = (a ^ 0x1B) & 0xFF
    return a


def _mul(a: int, b: int) -> int:
    r = 0
    for _ in range(8):
        if b & 1:
            r ^= a
        b >>= 1
        a = _xtime(a)
    return r & 0xFF


def _key_expansion(key: bytes) -> list[list[int]]:
    nk = len(key) // 4  # 4/6/8
    nr = nk + 6
    w = [list(key[4 * i: 4 * i + 4]) for i in range(nk)]
    sbox = _sbox()
    for i in range(nk, 4 * (nr + 1)):
        temp = list(w[i - 1])
        if i % nk == 0:
            temp = temp[1:] + temp[:1]
            temp = [sbox[b] for b in temp]
            temp[0] ^= _RCON[i // nk - 1]
        elif nk > 6 and i % nk == 4:
            temp = [sbox[b] for b in temp]
        w.append([w[i - nk][j] ^ temp[j] for j in range(4)])
    return w


def _aes_encrypt_block(block: bytes, round_keys: list[list[int]]) -> bytes:
    sbox = _sbox()
    nr = len(round_keys) // 4 - 1
    s = [block[i] ^ round_keys[i // 4][i % 4] for i in range(16)]
    for rnd in range(1, nr + 1):
        s = [sbox[b] for b in s]  # SubBytes
        # ShiftRows（列优先存储：state[r + 4c]）
        s = [
            s[0], s[5], s[10], s[15],
            s[4], s[9], s[14], s[3],
            s[8], s[13], s[2], s[7],
            s[12], s[1], s[6], s[11],
        ]
        if rnd != nr:  # MixColumns
            ns = [0] * 16
            for c in range(4):
                col = s[4 * c: 4 * c + 4]
                ns[4 * c + 0] = _mul(col[0], 2) ^ _mul(col[1], 3) ^ col[2] ^ col[3]
                ns[4 * c + 1] = col[0] ^ _mul(col[1], 2) ^ _mul(col[2], 3) ^ col[3]
                ns[4 * c + 2] = col[0] ^ col[1] ^ _mul(col[2], 2) ^ _mul(col[3], 3)
                ns[4 * c + 3] = _mul(col[0], 3) ^ col[1] ^ col[2] ^ _mul(col[3], 2)
            s = ns
        s = [s[i] ^ round_keys[rnd * 4 + i // 4][i % 4] for i in range(16)]
    return bytes(s)


def _aes_ctr_keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    rk = _key_expansion(key)
    out = bytearray()
    counter = int.from_bytes(nonce, "big")
    while len(out) < length:
        ctr_block = counter.to_bytes(16, "big")
        out += _aes_encrypt_block(ctr_block, rk)
        counter = (counter + 1) & ((1 << 128) - 1)
    return bytes(out[:length])


def get_master_key(data_dir: str) -> bytes:
    with _key_lock:
        if data_dir in _key_cache:
            return _key_cache[data_dir]
        raw = os.environ.get("KB_MASTER_KEY", CONFIG.get("master_key", ""))
        if raw:
            key = hashlib.scrypt(
                raw.encode("utf-8"),
                salt=b"knowledge-workbench/v1",
                n=16384, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024,
            )
        else:
            key_file = Path(data_dir) / ".master-key"
            if key_file.exists():
                seed = key_file.read_text(encoding="utf-8").strip().encode("utf-8")
            else:
                Path(data_dir).mkdir(parents=True, exist_ok=True)
                seed = secrets.token_hex(32).encode("utf-8")
                key_file.write_text(seed.decode("utf-8"), encoding="utf-8")
            key = hashlib.scrypt(
                seed, salt=b"knowledge-workbench/v1",
                n=16384, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024,
            )
        _key_cache[data_dir] = key
        return key


def encrypt(plain, data_dir: str) -> str:
    if plain is None or plain == "":
        return ""
    data = str(plain).encode("utf-8")
    key = get_master_key(data_dir)
    if _HAS_AESGCM:
        iv = os.urandom(12)
        blob = AESGCM(key).encrypt(iv, data, None)  # ct || tag(16)
        ct, tag = blob[:-16], blob[-16:]
        return base64.b64encode(iv + tag + ct).decode("ascii")
    # 回退：AES-256-CTR + HMAC-SHA256（先加密后认证）
    enc_key = hashlib.sha256(key + b"|enc").digest()
    mac_key = hashlib.sha256(key + b"|mac").digest()
    nonce = os.urandom(12)
    ct = bytes(a ^ b for a, b in zip(data, _aes_ctr_keystream(enc_key, nonce, len(data))))
    mac = hmac.new(mac_key, nonce + ct, hashlib.sha256).digest()
    return base64.b64encode(nonce + mac + ct).decode("ascii")


def decrypt(payload: str, data_dir: str) -> str:
    if not payload:
        return ""
    raw = base64.b64decode(payload)
    key = get_master_key(data_dir)
    try:
        if _HAS_AESGCM:
            iv, tag, ct = raw[:12], raw[12:28], raw[28:]
            return AESGCM(key).decrypt(iv, ct + tag, None).decode("utf-8")
        enc_key = hashlib.sha256(key + b"|enc").digest()
        mac_key = hashlib.sha256(key + b"|mac").digest()
        nonce, mac, ct = raw[:12], raw[12:44], raw[44:]
        if not hmac.compare_digest(hmac.new(mac_key, nonce + ct, hashlib.sha256).digest(), mac):
            raise ValueError("HMAC 校验失败")
        ks = _aes_ctr_keystream(enc_key, nonce, len(ct))
        return bytes(a ^ b for a, b in zip(ct, ks)).decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            "凭证解密失败：主密钥与加密时不一致（请检查 KB_MASTER_KEY 或 data/.master-key）"
        ) from exc


def crypto_mode() -> str:
    return "AES-256-GCM (cryptography)" if _HAS_AESGCM else "AES-256-CTR + HMAC-SHA256 (pure stdlib)"


# ---------------------------------------------------------------- HTTP 客户端

_SSL_CTX = None


def _ssl_context():
    global _SSL_CTX
    if _SSL_CTX is None:
        ctx = ssl.create_default_context()
        if CONFIG.get("insecure_tls"):
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        _SSL_CTX = ctx
    return _SSL_CTX


_opener = urllib.request.build_opener(
    urllib.request.ProxyHandler(),  # 自动读取 HTTP_PROXY / HTTPS_PROXY / NO_PROXY
    urllib.request.HTTPSHandler(context=_ssl_context()),
)


class Response:
    def __init__(self, status: int, headers, body: bytes):
        self.status = status
        self.headers = headers
        self.body = body

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self):
        t = self.text.replace("\ufeff", "").strip()
        return json.loads(t)


def _decode(body: bytes, encoding: str) -> bytes:
    enc = (encoding or "").lower()
    try:
        if "br" in enc:
            import brotli  # type: ignore

            return brotli.decompress(body)
        if "gzip" in enc:
            return gzip.decompress(body)
        if "deflate" in enc:
            try:
                return zlib.decompress(body)
            except zlib.error:
                return zlib.decompress(body, -zlib.MAX_WBITS)
    except Exception:
        return body
    return body


def request(url: str, method: str = "GET", headers: dict | None = None,
            json_body=None, form: dict | None = None, data=None,
            timeout: int | None = None, retries: int | None = None) -> Response:
    """带重试/超时/解压/代理的 HTTP 请求（urllib 实现，自动遵循系统代理设置）。"""
    timeout_s = (timeout if timeout is not None else CONFIG["http_timeout_ms"]) / 1000.0
    tries = (retries if retries is not None else CONFIG["http_retries"]) + 1

    hdrs = {"User-Agent": f"knowledge-workbench-py/{VERSION}", "Accept": "*/*"}
    hdrs.update(headers or {})

    payload = None
    if form is not None:
        payload = urllib.parse.urlencode(form).encode("utf-8")
        hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    elif json_body is not None:
        payload = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        hdrs["Content-Type"] = "application/json; charset=utf-8"
    elif data is not None:
        payload = data.encode("utf-8") if isinstance(data, str) else data
    if payload is not None:
        hdrs["Content-Length"] = str(len(payload))

    last_err = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=payload, headers=hdrs, method=method.upper())
            with _opener.open(req, timeout=timeout_s) as resp:
                body = _decode(resp.read(), resp.headers.get("Content-Encoding", ""))
                return Response(resp.status, resp.headers, body)
        except urllib.error.HTTPError as e:
            body = b""
            try:
                body = e.read()
            except Exception:
                pass
            if e.code >= 500 or e.code == 429:
                last_err = RuntimeError(f"HTTP {e.code}")
            else:
                return Response(e.code, e.headers, body)
        except Exception as e:  # noqa: BLE001
            last_err = e
        if attempt < tries - 1:
            time.sleep(min(8.0, 0.5 * (2 ** attempt)))
    raise RuntimeError(f"请求失败 {url}: {last_err}")


def request_json(url: str, **kw) -> dict | list:
    return request(url, **kw).json()


http_client = {"request": request, "request_json": request_json}


# ---------------------------------------------------------------- 内容归一化

_TAG_RE = re.compile(r"<[^>]+>")


def html_to_text(html) -> str:
    if not html:
        return ""
    t = sanitize_text(str(html))
    t = re.sub(r"<script[\s\S]*?</script>", " ", t, flags=re.I)
    t = re.sub(r"<style[\s\S]*?</style>", " ", t, flags=re.I)
    t = re.sub(r"<!--[\s\S]*?-->", " ", t)
    t = re.sub(r"</(p|div|h[1-6]|li|tr|blockquote)>", "\n", t, flags=re.I)
    t = re.sub(r"<br\s*/?>", "\n", t, flags=re.I)
    t = _TAG_RE.sub(" ", t)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        t = t.replace(a, b)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def md_to_text(md) -> str:
    if not md:
        return ""
    t = sanitize_text(str(md))
    t = re.sub(r"```[\s\S]*?```", " ", t)
    t = re.sub(r"`([^`]+)`", r"\1", t)
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"^#{1,6}\s+", "", t, flags=re.M)
    t = re.sub(r"^\s*[-*+]\s+", "", t, flags=re.M)
    t = re.sub(r"^\s*>\s?", "", t, flags=re.M)
    t = re.sub(r"[*_~]{1,3}", "", t)
    t = t.replace("|", " ")
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def to_plain_text(content, fmt: str = "auto") -> str:
    if not content:
        return ""
    if fmt == "html":
        return html_to_text(content)
    if fmt in ("markdown", "md"):
        return md_to_text(content)
    if fmt == "text":
        return sanitize_text(content).strip()
    if re.search(r"<(p|div|br|h[1-6]|li|table|span)\b[^>]*>", str(content), re.I):
        return html_to_text(content)
    return md_to_text(content)


def make_summary(text, length: int = 200) -> str:
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    return t[:length] + "…" if len(t) > length else t


DOC_TYPES = ("doc", "page", "note", "story", "task", "bug", "sheet", "code", "experience")


def build_doc(source: dict, raw: dict) -> dict:
    """生成统一文档对象 UnifiedDoc（与 Node 版字段完全一致）。"""
    external_id = str(raw.get("externalId") or raw.get("id") or raw.get("url") or "")[:512]
    doc_id = sha1(f"{source.get('id')}|{external_id or raw.get('title') or now_iso()}")
    content = sanitize_text(raw.get("content") or "").strip()
    plain = raw.get("plainText")
    plain = sanitize_text(plain).strip() if plain else to_plain_text(content, raw.get("format", "auto"))

    tags = raw.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    tags = [str(t).strip() for t in tags if str(t).strip()][:30]

    dtype = raw.get("type") or "doc"
    return {
        "id": doc_id,
        "sourceId": source.get("id"),
        "platform": source.get("platform"),
        "externalId": external_id,
        "title": sanitize_text(raw.get("title") or "(无标题)")[:300],
        "path": sanitize_text(raw.get("path") or "")[:1000],
        "type": dtype if dtype in DOC_TYPES else "doc",
        "url": str(raw.get("url") or "")[:2000],
        "summary": make_summary(raw.get("summary")) if raw.get("summary") else make_summary(plain),
        "content": content,
        "plainText": plain,
        "tags": tags,
        "author": sanitize_text(raw.get("author") or "")[:120],
        "createdAt": _iso(raw.get("createdAt")),
        "updatedAt": _iso(raw.get("updatedAt")),
        "meta": raw.get("meta") or {},
        "indexedAt": now_iso(),
    }


def _iso(v):
    if not v:
        return None
    try:
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(float(v), tz=timezone.utc).isoformat().replace("+00:00", "Z")
        s = str(v)
        if re.match(r"^\d{4}-\d{2}-\d{2}[T ]", s):
            return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return None
    except Exception:
        return None
