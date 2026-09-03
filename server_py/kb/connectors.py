"""九类数据源适配器 + 同步执行入口。

- 六大内置平台：ShowDoc / GitHub / Gitee / 禅道 / 印象笔记 / 腾讯文档
- MCP 客户端接入：把任意暴露 MCP 协议的服务器当作知识源
- 本地目录 / 通用 OpenAPI：兜底方案
"""

from __future__ import annotations

import base64
import json
import re
import urllib.parse
from pathlib import Path

from .core import CONFIG, build_doc, deep_get, html_to_text, map_limit, now_iso, request, sanitize_text
from .files import first_heading, office_to_text, parse_enex, parse_front_matter
from .mcp import MCPClient

# ---------------------------------------------------------------- 公共工具


def parse_credential(credential, keys=("token",)) -> dict:
    """支持多种书写习惯，降低"一个凭证"的接入门槛。"""
    raw = str(credential or "").strip()
    if not raw:
        return {}
    if raw.startswith("{"):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
    low = raw.lower()
    if low.startswith("cookie:"):
        return {"cookie": raw[7:].strip()}
    if low.startswith("bearer "):
        return {"token": raw[7:].strip(), "bearer": raw[7:].strip()}
    if ":" in raw and not re.match(r"^https?://", raw, re.I):
        head, tail = raw.split(":", 1)
        return {keys[0]: head, keys[1] if len(keys) > 1 else "secret": tail}
    return {keys[0]: raw}


def join_url(base: str, p: str = "") -> str:
    if not p:
        return base
    if re.match(r"^https?://", p, re.I):
        return p
    return f"{base.rstrip('/')}/{p.lstrip('/')}"


DEFAULT_EXCLUDE_DIR = re.compile(
    r"(^|/)(node_modules|\.git|\.svn|vendor|dist|build|out|target|coverage|\.next|\.nuxt|__pycache__|\.idea|\.vscode)(/|$)",
    re.I,
)
DEFAULT_TEXT_EXT = re.compile(r"\.(md|mdx|markdown|mkd|rst|txt|adoc|org)$", re.I)


def should_include(rel_path: str, options: dict | None = None) -> bool:
    options = options or {}
    p = str(rel_path).replace("\\", "/")
    if DEFAULT_EXCLUDE_DIR.search(p):
        return False
    if options.get("exclude") and re.search(options["exclude"], p, re.I):
        return False
    if options.get("include"):
        return bool(re.search(options["include"], p, re.I))
    return bool(DEFAULT_TEXT_EXT.search(p))


def file_url(abs_path: str) -> str:
    p = str(Path(abs_path).resolve()).replace("\\", "/")
    return "file:///" + p.lstrip("/")


def to_docs(source: dict, raws: list, max_: int | None = None) -> list[dict]:
    docs = []
    for raw in raws:
        if not raw or not raw.get("title"):
            continue
        docs.append(build_doc(source, raw))
        if max_ and len(docs) >= max_:
            break
    return docs


def _as_list(v, default):
    if isinstance(v, list):
        return v
    if v:
        return [v]
    return default


# ---------------------------------------------------------------- ShowDoc


class ShowDoc:
    platform = "showdoc"
    label = "ShowDoc"
    description = "ShowDoc 文档站：项目 → 目录 → 页面正文，支持开放 API 与 Cookie 两种凭证"
    default_base_url = "https://doc.example.com"
    credential_hint = '开放 API 的 api_key + api_token，写法：{"api_key":"...","api_token":"..."} 或 key:token'
    credential_type = "api_key / api_token（或 Cookie）"
    fields = [
        {"key": "itemId", "label": "只同步指定项目 ID（留空=全部）", "placeholder": "如 12"},
        {"key": "endpoints.itemList", "label": "项目列表接口（可选覆盖）", "placeholder": "/server/index.php?s=/api/item/list"},
        {"key": "endpoints.pageList", "label": "页面列表接口（可选覆盖）", "placeholder": "/server/index.php?s=/api/page/list"},
        {"key": "endpoints.pageInfo", "label": "页面详情接口（可选覆盖）", "placeholder": "/server/index.php?s=/api/page/info"},
    ]

    ENDPOINTS = {
        "itemList": ["/server/index.php?s=/api/item/list", "/api/item/list", "/server/index.php?s=/api/openapi/itemList"],
        "pageList": ["/server/index.php?s=/api/page/list", "/api/page/list", "/server/index.php?s=/api/catalogue/list", "/api/catalogue/list"],
        "pageInfo": ["/server/index.php?s=/api/page/info", "/api/page/info", "/server/index.php?s=/api/openapi/pageInfo"],
    }

    @staticmethod
    def _post(base_url, paths, form, cred, timeout_ms=20000):
        auth = {}
        if cred.get("api_key"):
            auth["api_key"] = cred["api_key"]
        if cred.get("api_token"):
            auth["api_token"] = cred["api_token"]
        if cred.get("token") and not cred.get("api_token"):
            auth["api_token"] = cred["token"]
        headers = {"Cookie": cred["cookie"]} if cred.get("cookie") else {}
        last = None
        for p in paths:
            try:
                resp = request(join_url(base_url, p), method="POST",
                               form={**form, **auth}, headers=headers,
                               timeout=timeout_ms, retries=1)
                if resp.status == 404:
                    continue
                data = resp.json()
                if data and int(data.get("error_code", 0) or 0) == 0:
                    return data.get("data")
                if data and data.get("data") is not None:
                    return data.get("data")
                last = RuntimeError(data.get("error_message") or f"error_code={data.get('error_code')}")
            except Exception as e:  # noqa: BLE001
                last = e
        raise RuntimeError(f"ShowDoc 接口调用失败：{last}")

    @classmethod
    def fetch_all(cls, source, credential, options=None, max_=None):
        options = options or {}
        max_ = max_ or CONFIG["max_docs_per_source"]
        cred = parse_credential(credential, ("api_key", "api_token"))
        ep = {**cls.ENDPOINTS, **(options.get("endpoints") or {})}

        if options.get("itemId"):
            items = [{"item_id": str(options["itemId"]), "item_name": options.get("itemName") or "指定项目"}]
        else:
            data = cls._post(source["baseUrl"], _as_list(ep.get("itemList"), cls.ENDPOINTS["itemList"]), {}, cred)
            items = [{"item_id": i.get("item_id") or i.get("id"),
                      "item_name": i.get("item_name") or i.get("name") or i.get("item_domain")}
                     for i in (data.get("items") if isinstance(data, dict) else data) or []]
        if not items:
            raise RuntimeError("未获取到任何 ShowDoc 项目，请检查凭证与接口地址")

        pages = {}
        for item in items:
            data = cls._post(source["baseUrl"], _as_list(ep.get("pageList"), cls.ENDPOINTS["pageList"]),
                             {"item_id": item["item_id"]}, cred)
            arr = data if isinstance(data, list) else ((data or {}).get("pages") if isinstance(data, dict) else []) or []
            for p in arr or []:
                pid = p.get("page_id") or p.get("id") or p.get("pageId")
                if not pid:
                    continue
                pages[str(pid)] = {
                    "page_id": pid,
                    "page_title": p.get("page_title") or p.get("title") or p.get("page_name") or p.get("cat_name"),
                    "item_name": item.get("item_name"),
                }

        raws = []
        for pid, p in list(pages.items())[:max_]:
            try:
                data = cls._post(source["baseUrl"], _as_list(ep.get("pageInfo"), cls.ENDPOINTS["pageInfo"]),
                                 {"page_id": p["page_id"]}, cred)
                info = data[0] if isinstance(data, list) else data
                if not info:
                    continue
                content = info.get("page_content") or info.get("content") or info.get("page_md") or ""
                raws.append({
                    "externalId": f"page:{pid}",
                    "title": info.get("page_title") or info.get("title") or p.get("page_title") or "(无标题)",
                    "path": "/".join(x for x in (p.get("item_name"), info.get("cat_name")) if x),
                    "url": join_url(source["baseUrl"], f"/web/#/{info.get('item_id') or ''}/{pid}"),
                    "content": str(content),
                    "format": "markdown",
                    "author": info.get("author_username") or info.get("author") or "",
                    "updatedAt": int(info["page_addtime"]) * 1000 if info.get("page_addtime") else None,
                    "meta": {"item_id": p.get("item_id"), "page_id": pid, "item_name": p.get("item_name")},
                })
            except Exception:  # noqa: BLE001
                continue
            if len(raws) >= max_:
                break
        return to_docs(source, raws, max_)

    @classmethod
    def test(cls, base_url, credential, options=None):
        options = options or {}
        cred = parse_credential(credential, ("api_key", "api_token"))
        ep = {**cls.ENDPOINTS, **(options.get("endpoints") or {})}
        data = cls._post(base_url, _as_list(ep.get("itemList"), cls.ENDPOINTS["itemList"]), {}, cred, timeout_ms=12000)
        arr = (data.get("items") if isinstance(data, dict) else data) or []
        return {"ok": True, "message": f"连接成功，可访问 {len(arr)} 个项目",
                "sample": [i.get("item_name") or i.get("name") or str(i.get("item_id")) for i in arr[:5]]}


# ---------------------------------------------------------------- GitHub / Gitee

_GH_HEADERS = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}


class GitHub:
    platform = "github"
    label = "GitHub"
    description = "拉取仓库中的 Markdown / 文本文档，支持 GitHub.com 与自部署 GHE"
    default_base_url = "https://api.github.com"
    credential_hint = "Personal Access Token（PAT），建议仅授予只读权限；裸串即可"
    credential_type = "Personal Access Token"
    fields = [
        {"key": "repos", "label": "指定仓库（逗号分隔，留空=自动发现）", "placeholder": "owner/repo,owner/repo2"},
        {"key": "owner", "label": "只同步某用户/组织的仓库（可选）", "placeholder": "zhangshifa"},
        {"key": "org", "label": "只同步某组织（可选）", "placeholder": "my-org"},
        {"key": "branch", "label": "分支（默认仓库默认分支）", "placeholder": "main"},
        {"key": "include", "label": "文件包含正则", "placeholder": r"\.(md|mdx|markdown|rst|txt)$"},
        {"key": "exclude", "label": "文件排除正则", "placeholder": "node_modules|dist"},
        {"key": "maxFilesPerRepo", "label": "单仓库最多文件数", "placeholder": "200"},
    ]

    @classmethod
    def _headers(cls, token):
        return {**_GH_HEADERS, "Authorization": f"Bearer {token}"}

    @classmethod
    def _api(cls, base_url, path, token, accept=None, timeout_ms=25000):
        headers = cls._headers(token)
        if accept:
            headers["Accept"] = accept
        resp = request(join_url(base_url, path), headers=headers, timeout=timeout_ms, retries=2)
        if resp.status in (401, 403):
            raise RuntimeError(f"GitHub 认证失败或触发限流 (HTTP {resp.status})，请检查 Token 权限与速率限制")
        if resp.status == 404:
            raise RuntimeError(f"资源不存在: {path}")
        if resp.status >= 400:
            raise RuntimeError(f"GitHub 请求失败 HTTP {resp.status}")
        return resp

    @classmethod
    def _list_repos(cls, base_url, token, options):
        if options.get("repos"):
            return [{"full_name": s.strip(), "default_branch": options.get("branch") or "main"}
                    for s in re.split(r"[,\s]+", str(options["repos"])) if s.strip()]
        out, per_page = [], 100
        for page in range(1, int(options.get("maxRepoPages") or 10) + 1):
            if options.get("org"):
                p = f"/orgs/{urllib.parse.quote(str(options['org']))}/repos?per_page={per_page}&page={page}&sort=pushed"
            elif options.get("owner"):
                p = f"/users/{urllib.parse.quote(str(options['owner']))}/repos?per_page={per_page}&page={page}&sort=pushed"
            else:
                p = f"/user/repos?per_page={per_page}&page={page}&sort=pushed&affiliation=owner,collaborator,organization_member"
            try:
                arr = cls._api(base_url, p, token).json()
            except Exception as e:  # noqa: BLE001
                if page == 1:
                    raise
                break
            if not isinstance(arr, list) or not arr:
                break
            out.extend({"full_name": r["full_name"], "default_branch": options.get("branch") or r.get("default_branch") or "main",
                        "description": r.get("description") or "", "private": r.get("private")} for r in arr)
            if len(arr) < per_page:
                break
        return out

    @staticmethod
    def _web_base(base_url, options):
        if options.get("webBaseUrl"):
            return options["webBaseUrl"].rstrip("/")
        return re.sub(r"^https?://api\.", "https://", re.sub(r"/api/v3$", "", base_url))

    @classmethod
    def fetch_all(cls, source, credential, options=None, max_=None):
        options = options or {}
        max_ = max_ or CONFIG["max_docs_per_source"]
        token = parse_credential(credential, ("token",)).get("token")
        if not token:
            raise RuntimeError("缺少 GitHub Token")
        repos = cls._list_repos(source["baseUrl"], token, options)
        if not repos:
            raise RuntimeError("未发现可访问的仓库，请检查 Token 权限或使用 repos 明确指定")

        max_files = int(options.get("maxFilesPerRepo") or 200)
        max_size = int(options.get("maxFileSize") or 512 * 1024)
        base = cls._web_base(source["baseUrl"], options)

        all_raws: list[dict] = []

        def handle_repo(repo):
            if len(all_raws) >= max_:
                return
            try:
                tree = cls._api(source["baseUrl"],
                                f"/repos/{repo['full_name']}/git/trees/{urllib.parse.quote(str(repo['default_branch']))}?recursive=1",
                                token).json()
            except Exception:  # noqa: BLE001
                return
            files = [n for n in (tree.get("tree") or [])
                     if n.get("type") == "blob"
                     and should_include(n.get("path", ""), options)
                     and (not n.get("size") or n["size"] <= max_size)][:max_files]

            def handle_file(f):
                path = f["path"]
                text = ""
                try:
                    text = cls._api(source["baseUrl"],
                                    f"/repos/{repo['full_name']}/contents/{urllib.parse.quote(path)}?ref={urllib.parse.quote(str(repo['default_branch']))}",
                                    token, accept="application/vnd.github.raw").text
                except Exception:  # noqa: BLE001
                    try:
                        j = cls._api(source["baseUrl"],
                                     f"/repos/{repo['full_name']}/contents/{urllib.parse.quote(path)}?ref={urllib.parse.quote(str(repo['default_branch']))}",
                                     token).json()
                        if j.get("encoding") == "base64" and j.get("content"):
                            text = base64.b64decode(re.sub(r"\s", "", j["content"])).decode("utf-8", "replace")
                    except Exception:  # noqa: BLE001
                        return None
                if not text:
                    return None
                meta, body = parse_front_matter(text)
                return {
                    "externalId": f"{repo['full_name']}:{repo['default_branch']}:{path}",
                    "title": meta.get("title") or first_heading(body, path.split("/")[-1]),
                    "path": f"{repo['full_name']}/{path}",
                    "url": f"{base}/{repo['full_name']}/blob/{repo['default_branch']}/{path}",
                    "content": body,
                    "format": "markdown" if re.search(r"\.(md|mdx|markdown)$", path, re.I) else "text",
                    "tags": list(meta.get("tags") or meta.get("keywords") or []) + [repo["full_name"].split("/")[-1]],
                    "meta": {"repo": repo["full_name"], "branch": repo["default_branch"], "filePath": path, "private": repo.get("private")},
                }

            for d in map_limit(files, 4, handle_file):
                if d and len(all_raws) < max_:
                    all_raws.append(d)

        for repo in repos:
            if len(all_raws) >= max_:
                break
            handle_repo(repo)
        return to_docs(source, all_raws, max_)

    @classmethod
    def test(cls, base_url, credential, options=None):
        options = options or {}
        token = parse_credential(credential, ("token",)).get("token")
        base_url = base_url or "https://api.github.com"
        me = cls._api(base_url, "/user", token, timeout_ms=12000).json()
        repos = cls._list_repos(base_url, token, {**options, "maxRepoPages": 1})
        return {"ok": True, "message": f"已认证为 {me.get('login')}，可访问 {len(repos)}+ 个仓库",
                "sample": [r["full_name"] for r in repos[:5]]}


class Gitee:
    platform = "gitee"
    label = "Gitee"
    description = "拉取 Gitee（含企业版）仓库中的文档文件"
    default_base_url = "https://gitee.com/api/v5"
    credential_hint = "Gitee 私人令牌（Access Token），裸串即可"
    credential_type = "Access Token"
    fields = list(GitHub.fields)

    @staticmethod
    def _with_token(p, token):
        sep = "&" if "?" in p else "?"
        return f"{p}{sep}access_token={urllib.parse.quote(str(token))}"

    @classmethod
    def _api(cls, base_url, p, token, timeout_ms=25000):
        resp = request(join_url(base_url, cls._with_token(p, token)), headers={"Accept": "application/json"},
                       timeout=timeout_ms, retries=2)
        if resp.status in (401, 403):
            raise RuntimeError(f"Gitee 认证失败 (HTTP {resp.status})，请检查 Access Token")
        if resp.status >= 400:
            raise RuntimeError(f"Gitee 请求失败 HTTP {resp.status}")
        return resp.json()

    @classmethod
    def _list_repos(cls, base_url, token, options):
        if options.get("repos"):
            return [{"full_name": s.strip(), "default_branch": options.get("branch") or "master"}
                    for s in re.split(r"[,\s]+", str(options["repos"])) if s.strip()]
        out, per_page = [], 100
        for page in range(1, int(options.get("maxRepoPages") or 10) + 1):
            if options.get("org"):
                p = f"/orgs/{urllib.parse.quote(str(options['org']))}/repos?per_page={per_page}&page={page}&type=all"
            elif options.get("owner"):
                p = f"/users/{urllib.parse.quote(str(options['owner']))}/repos?per_page={per_page}&page={page}&type=all&sort=pushed"
            else:
                p = f"/user/repos?per_page={per_page}&page={page}&type=all&sort=pushed"
            try:
                arr = cls._api(base_url, p, token)
            except Exception as e:  # noqa: BLE001
                if page == 1:
                    raise
                break
            if not isinstance(arr, list) or not arr:
                break
            out.extend({"full_name": r["full_name"], "default_branch": options.get("branch") or r.get("default_branch") or "master"}
                       for r in arr)
            if len(arr) < per_page:
                break
        return out

    @classmethod
    def fetch_all(cls, source, credential, options=None, max_=None):
        options = options or {}
        max_ = max_ or CONFIG["max_docs_per_source"]
        token = parse_credential(credential, ("token",)).get("token")
        if not token:
            raise RuntimeError("缺少 Gitee Access Token")
        repos = cls._list_repos(source["baseUrl"], token, options)
        if not repos:
            raise RuntimeError("未发现可访问的仓库")
        web_base = (options.get("webBaseUrl") or re.sub(r"/api/v5/?$", "", source["baseUrl"])).rstrip("/")
        max_files = int(options.get("maxFilesPerRepo") or 200)
        raws: list[dict] = []

        def handle_file(repo, f):
            path = f["path"]
            try:
                j = cls._api(source["baseUrl"],
                             f"/repos/{repo['full_name']}/contents/{urllib.parse.quote(path)}?ref={urllib.parse.quote(str(repo['default_branch']))}",
                             token)
            except Exception:  # noqa: BLE001
                return None
            text = ""
            if j.get("encoding") == "base64" and j.get("content"):
                text = base64.b64decode(re.sub(r"\s", "", j["content"])).decode("utf-8", "replace")
            elif isinstance(j.get("content"), str):
                text = j["content"]
            if not text:
                return None
            meta, body = parse_front_matter(text)
            return {
                "externalId": f"{repo['full_name']}:{repo['default_branch']}:{path}",
                "title": meta.get("title") or first_heading(body, path.split("/")[-1]),
                "path": f"{repo['full_name']}/{path}",
                "url": f"{web_base}/{repo['full_name']}/blob/{repo['default_branch']}/{path}",
                "content": body,
                "format": "markdown" if re.search(r"\.(md|markdown)$", path, re.I) else "text",
                "tags": list(meta.get("tags") or []) + [repo["full_name"].split("/")[-1]],
                "meta": {"repo": repo["full_name"], "branch": repo["default_branch"], "filePath": path},
            }

        for repo in repos:
            if len(raws) >= max_:
                break
            try:
                tree = cls._api(source["baseUrl"],
                                f"/repos/{repo['full_name']}/git/trees/{urllib.parse.quote(str(repo['default_branch']))}?recursive=1",
                                token)
            except Exception:  # noqa: BLE001
                continue
            files = [n for n in (tree.get("tree") or [])
                     if n.get("type") == "blob" and should_include(n.get("path", ""), options)][:max_files]
            for d in map_limit(files, 4, lambda f, r=repo: handle_file(r, f)):
                if d and len(raws) < max_:
                    raws.append(d)
        return to_docs(source, raws, max_)

    @classmethod
    def test(cls, base_url, credential, options=None):
        options = options or {}
        token = parse_credential(credential, ("token",)).get("token")
        base_url = base_url or "https://gitee.com/api/v5"
        me = cls._api(base_url, "/user", token, timeout_ms=12000)
        repos = cls._list_repos(base_url, token, {**options, "maxRepoPages": 1})
        return {"ok": True, "message": f"已认证为 {me.get('login') or me.get('name')}，可访问 {len(repos)}+ 个仓库",
                "sample": [r["full_name"] for r in repos[:5]]}


# ---------------------------------------------------------------- 禅道


class ZenTao:
    platform = "zentao"
    label = "禅道 ZenTao"
    description = "禅道需求 / 任务 / Bug / 文档统一接入（REST v1 与老版本 session 双通道）"
    default_base_url = "https://zentao.example.com"
    credential_hint = '账号+密码换取 token，写法：{"account":"admin","password":"xxx"} 或 admin:password'
    credential_type = "账号密码 / Token"
    fields = [
        {"key": "authMode", "label": "认证模式：v1(默认) / token / legacy", "placeholder": "v1"},
        {"key": "modules", "label": "同步模块（逗号：product,story,task,bug,doc）", "placeholder": "story,task,bug,doc"},
        {"key": "productId", "label": "只同步指定产品 ID（可选）", "placeholder": "1"},
    ]
    URL_MAP = {"story": "/story-view-{id}.html", "task": "/task-view-{id}.html",
               "bug": "/bug-view-{id}.html", "product": "/product-view-{id}.html", "doc": "/doc-view-{id}.html"}

    @staticmethod
    def _headers(token):
        return {"Token": token, "Authorization": f"token {token}", "Accept": "application/json"}

    @classmethod
    def _get_token(cls, base_url, credential):
        cred = parse_credential(credential, ("account", "password"))
        basic = base64.b64encode(f"{cred.get('account','')}:{cred.get('password','')}".encode()).decode()
        resp = request(join_url(base_url, "/api.php/v1/tokens"), method="POST",
                       headers={"Authorization": f"Basic {basic}", "Content-Type": "application/json", "Accept": "application/json"},
                       data="{}", timeout=15000)
        if resp.status != 200:
            raise RuntimeError(f"禅道获取 token 失败 HTTP {resp.status}")
        data = resp.json()
        token = (data or {}).get("token") or ((data or {}).get("data") or {}).get("token")
        if not token:
            raise RuntimeError("禅道未返回 token，请确认账号密码或接口版本")
        return token

    @classmethod
    def _paged(cls, base_url, path, token, max_pages=10, size=50):
        out = []
        for page in range(1, max_pages + 1):
            sep = "&" if "?" in path else "?"
            url = join_url(base_url, f"{path}{sep}page={page}&limit={size}")
            try:
                data = request(url, headers=cls._headers(token), timeout=25000, retries=1).json()
            except Exception as e:  # noqa: BLE001
                if page == 1:
                    raise
                break
            arr = None
            for k in ("products", "executions", "stories", "tasks", "bugs", "docs", "data"):
                if isinstance(data, dict) and isinstance(data.get(k), list):
                    arr = data[k]
                    break
            if arr is None and isinstance(data, list):
                arr = data
            if not arr:
                break
            out.extend(arr)
            if len(arr) < size:
                break
        return out

    @classmethod
    def _map_item(cls, it, base):
        itype = it.get("_type") or "doc"
        iid = it.get("id")
        title = it.get("title") or it.get("name") or it.get("subject") or it.get("key") or f"(禅道{itype}#{iid})"
        body = it.get("spec") or it.get("desc") or it.get("description") or it.get("content") or it.get("summary") or ""
        tpl = cls.URL_MAP.get(itype)
        return {
            "externalId": f"{itype}:{iid}",
            "title": title,
            "path": "/".join(x for x in (it.get("product"), it.get("execution"), title) if x),
            "url": join_url(base, tpl.format(id=iid) if tpl else f"/index.php?m={itype}&f=view&id={iid}"),
            "content": body if isinstance(body, str) else json.dumps(body, ensure_ascii=False),
            "format": "html",
            "type": itype,
            "author": it.get("openedBy") or it.get("addedBy") or "",
            "createdAt": it.get("openedDate") or it.get("addedDate"),
            "tags": [x for x in (itype, it.get("product"), it.get("execution")) if x],
            "meta": {"zentaoType": itype, "id": iid, "status": it.get("status")},
        }

    @classmethod
    def fetch_all(cls, source, credential, options=None, max_=None):
        options = options or {}
        max_ = max_ or CONFIG["max_docs_per_source"]
        modules = [m.strip() for m in str(options.get("modules") or "product,story,task,bug,doc").split(",") if m.strip()]
        base = source["baseUrl"]

        if options.get("authMode") == "legacy":
            return cls._legacy(base, credential, modules, source, max_)
        token = credential if options.get("authMode") == "token" and not str(credential).startswith("{") else cls._get_token(base, credential)
        if options.get("authMode") == "token" and str(credential).startswith("{"):
            token = parse_credential(credential, ("token",)).get("token") or credential

        raws = []

        def push(arr, t, **extra):
            for it in arr:
                raws.append({**it, "_type": t, **extra})

        if "product" in modules:
            products = cls._paged(base, "/api.php/v1/products", token)
            push(products, "product")
            for p in products:
                if options.get("productId") and str(p.get("id")) != str(options["productId"]):
                    continue
                if "story" in modules:
                    push(cls._paged(base, f"/api.php/v1/products/{p['id']}/stories", token), "story", product=p.get("name"))
                if "bug" in modules:
                    push(cls._paged(base, f"/api.php/v1/products/{p['id']}/bugs", token), "bug", product=p.get("name"))
                if len(raws) >= max_:
                    break
        if "execution" in modules or "task" in modules:
            execs = cls._paged(base, "/api.php/v1/executions", token)
            if "task" in modules:
                for e in execs:
                    push(cls._paged(base, f"/api.php/v1/executions/{e['id']}/tasks", token), "task", execution=e.get("name"))
                    if len(raws) >= max_:
                        break
        if "doc" in modules:
            push(cls._paged(base, "/api.php/v1/docs", token), "doc")

        return to_docs(source, [cls._map_item(it, base) for it in raws[:max_]], max_)

    @classmethod
    def _legacy(cls, base, credential, modules, source, max_):
        cred = parse_credential(credential, ("account", "password"))
        url = join_url(base, f"/api.php?m=api&f=getSessionID&account={urllib.parse.quote(str(cred.get('account','')))}&password={urllib.parse.quote(str(cred.get('password','')))}")
        resp = request(url, timeout=15000, retries=1)
        sid = None
        try:
            j = resp.json()
            sid = (j.get("data") or {}).get("sessionID") or j.get("sessionID")
        except Exception:  # noqa: BLE001
            sid = resp.text.strip()
        if not sid:
            raise RuntimeError("禅道老版本接口：获取 sessionID 失败")

        def call_model(module, method):
            u = join_url(base, f"/index.php?m=api&f=getModel&module={module}&methodName={method}&params=&t=json&sessionID={sid}")
            try:
                return (request(u, timeout=20000, retries=1).json() or {}).get("data") or []
            except Exception:  # noqa: BLE001
                return []

        raws = []
        for mod, method in (("story", "getList"), ("task", "getList"), ("bug", "getList")):
            if mod in modules:
                for it in call_model(mod, method):
                    raws.append({**it, "_type": mod})
        return to_docs(source, [cls._map_item(it, base) for it in raws[:max_]], max_)

    @classmethod
    def test(cls, base_url, credential, options=None):
        options = options or {}
        if options.get("authMode") in ("token", "legacy"):
            return {"ok": True, "message": "token/legacy 模式：建源后将在首次同步验证", "sample": []}
        token = cls._get_token(base_url, credential)
        products = cls._paged(base_url, "/api.php/v1/products", token, max_pages=1)
        return {"ok": True, "message": f"token 获取成功，可访问 {len(products)}+ 个产品",
                "sample": [p.get("name") for p in products[:5]]}


# ---------------------------------------------------------------- 印象笔记


class Evernote:
    platform = "evernote"
    label = "印象笔记 / Evernote"
    description = "通过 ENEX 导出包（默认）或 Evernote Cloud API 接入笔记"
    default_base_url = ""
    credential_hint = "默认无需凭证；如用 Cloud API：devToken"
    credential_type = "无 / Evernote Dev Token"
    fields = [
        {"key": "enexPath", "label": "ENEX 文件或目录路径 / URL（默认模式）", "placeholder": "/path/to/notes.enex"},
        {"key": "mode", "label": "模式：enex(默认) / api", "placeholder": "enex"},
    ]

    @staticmethod
    def _read_enex(location) -> str:
        if re.match(r"^https?://", str(location), re.I):
            return request(location, timeout=30000, retries=1).text
        p = Path(location)
        if p.is_file():
            return p.read_text(encoding="utf-8", errors="replace")
        return "\n".join(f.read_text(encoding="utf-8", errors="replace")
                         for f in sorted(p.glob("*.enex")) + sorted(p.glob("*.ENEX")))

    @classmethod
    def fetch_all(cls, source, credential, options=None, max_=None):
        options = options or {}
        max_ = max_ or CONFIG["max_docs_per_source"]
        if options.get("mode") == "api":
            return cls._via_api(source, credential, options, max_)
        if not options.get("enexPath"):
            raise RuntimeError("请在 options.enexPath 指定 ENEX 文件 / 目录 / URL")
        notes = parse_enex(cls._read_enex(options["enexPath"]))
        raws = [{
            "externalId": f"note:{n.get('notebook') or ''}:{n.get('title')}:{i}",
            "title": n.get("title") or "(无标题笔记)",
            "path": f"{n.get('notebook') or '笔记本'}/{n.get('title') or i}",
            "content": n.get("html") or "",
            "format": "html",
            "createdAt": n.get("created"),
            "updatedAt": n.get("updated"),
            "tags": n.get("tags") or [],
            "meta": {"notebook": n.get("notebook"), "source": "enex"},
        } for i, n in enumerate(notes[:max_])]
        return to_docs(source, raws, max_)

    @classmethod
    def test(cls, base_url, credential, options=None):
        options = options or {}
        if options.get("mode") == "api":
            return {"ok": True, "message": "Cloud API 模式：将在首次同步检查可选依赖", "sample": []}
        if not options.get("enexPath"):
            raise RuntimeError("缺少 enexPath")
        count = len(parse_enex(cls._read_enex(options["enexPath"])))
        return {"ok": True, "message": f"ENEX 可读取，共 {count} 条笔记", "sample": []}

    @staticmethod
    def _via_api(source, credential, options, max_):
        try:
            from evernote3.edam.notestore import NoteStore  # type: ignore  # noqa: F401
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError("Cloud API 模式需要安装可选依赖：pip install evernote3（建议改用 ENEX 导出模式，零依赖更稳）") from exc
        token = (parse_credential(credential, ("devToken",)).get("devToken")
                 if str(credential or "").startswith("{") else credential) or options.get("devToken")
        if not token:
            raise RuntimeError("缺少 Evernote dev token")
        raise RuntimeError("已检测到 evernote3，但为保持零依赖定位，请优先使用 ENEX 导出模式（options.mode 留空）")


# ---------------------------------------------------------------- 本地目录


class LocalFolder:
    platform = "local"
    label = "本地文件 / 目录"
    description = "导入本地目录或文件（支持 Markdown / 文本 / HTML / CSV / ENEX / Word / Excel）"
    default_base_url = ""
    credential_hint = "无需凭证"
    credential_type = "无"
    fields = [
        {"key": "dir", "label": "目录或文件路径（必填，也支持 http(s) 直链）", "placeholder": "/data/my-docs"},
        {"key": "include", "label": "路径包含正则", "placeholder": r"\.(md|txt)$"},
        {"key": "exclude", "label": "路径排除正则", "placeholder": "node_modules|dist"},
        {"key": "recursive", "label": "是否递归子目录（默认 true）", "placeholder": "true"},
    ]
    TEXT_EXT = re.compile(r"\.(md|mdx|markdown|mkd|rst|txt|adoc|org|csv|tsv|json|html|htm|xml)$", re.I)
    OFFICE_EXT = re.compile(r"\.(docx|xlsx)$", re.I)

    @staticmethod
    def _walk(root: Path, options) -> list[Path]:
        recursive = str(options.get("recursive", "true")).lower() != "false"
        out: list[Path] = []
        if root.is_file():
            return [root]
        for p in root.rglob("*") if recursive else root.glob("*"):
            if p.is_file() and should_include(str(p), options):
                out.append(p)
        return out

    @classmethod
    def read_file(cls, file_path: Path, platform="local") -> list[dict]:
        ext = file_path.suffix.lower()
        data = file_path.read_bytes()
        if ext == ".enex":
            notes = parse_enex(data.decode("utf-8", errors="replace"))
            return [{
                "externalId": f"local:{file_path}:{i}",
                "title": n.get("title") or file_path.name,
                "path": str(file_path),
                "url": file_url(str(file_path)),
                "content": n.get("html") or "",
                "format": "html",
                "tags": n.get("tags") or [],
                "createdAt": n.get("created"),
                "updatedAt": n.get("updated"),
                "meta": {"file": str(file_path)},
            } for i, n in enumerate(notes)]

        content = office_to_text(ext, data)
        if not content:
            return []
        fmt = "html" if re.match(r"\.html?$", ext, re.I) else ("markdown" if re.match(r"\.(md|mdx|markdown)$", ext, re.I) else "text")
        meta, body = parse_front_matter(content)
        stat = file_path.stat()
        return [{
            "externalId": f"local:{file_path}",
            "title": meta.get("title") or first_heading(body, file_path.name),
            "path": str(file_path),
            "url": file_url(str(file_path)),
            "content": body,
            "format": fmt,
            "tags": list(meta.get("tags") or []),
            "author": meta.get("author") or "",
            "createdAt": meta.get("date") or now_iso(),
            "updatedAt": now_iso(),
            "meta": {"file": str(file_path), "platform": platform, "mtime": int(stat.st_mtime)},
        }]

    @classmethod
    def fetch_all(cls, source, credential=None, options=None, max_=None):
        options = options or {}
        max_ = max_ or CONFIG["max_docs_per_source"]
        loc = options.get("dir")
        if not loc:
            raise RuntimeError("缺少 options.dir")
        if re.match(r"^https?://", str(loc), re.I):
            text = request(loc, timeout=30000, retries=1).text
            tmp_dir = Path(CONFIG["data_dir"]).parent / ".tmp-import"
            tmp_dir.mkdir(parents=True, exist_ok=True)
            tmp = tmp_dir / (loc.split("/")[-1] or "import.txt")
            tmp.write_text(text, encoding="utf-8")
            files = [tmp]
        else:
            p = Path(loc).expanduser()
            if not p.exists():
                raise RuntimeError("目录或文件不存在")
            files = cls._walk(p, options)
        raws: list[dict] = []
        for f in files[:max_]:
            try:
                raws.extend(cls.read_file(f))
            except Exception:  # noqa: BLE001
                continue
        return to_docs(source, raws, max_)

    @classmethod
    def test(cls, base_url, credential=None, options=None):
        options = options or {}
        loc = options.get("dir")
        if not loc:
            raise RuntimeError("缺少 options.dir")
        if re.match(r"^https?://", str(loc), re.I):
            return {"ok": True, "message": f"远程文件可读取（{len(request(loc, timeout=15000, retries=1).text)} 字符）", "sample": []}
        p = Path(loc).expanduser()
        if not p.exists():
            raise RuntimeError("目录或文件不存在")
        count = len(cls._walk(p, options))
        return {"ok": True, "message": f"可读取 {count} 个文件", "sample": []}


# ---------------------------------------------------------------- 腾讯文档


class TencentDocs:
    platform = "tencent-docs"
    label = "腾讯文档"
    description = '通过开放平台 API 或"导出文件 + 本地目录"接入腾讯文档'
    default_base_url = "https://docs.qq.com"
    credential_hint = '开放平台 access_token（裸串或 {"access_token":"..."}）；本地导出模式无需凭证'
    credential_type = "Access Token / 无"
    fields = [
        {"key": "mode", "label": "模式：local(默认导出) / openapi", "placeholder": "local"},
        {"key": "dir", "label": "（local 模式）导出文件所在目录", "placeholder": "/data/tencent-docs"},
        {"key": "endpoints.list", "label": "（openapi 模式）文件列表端点", "placeholder": "/openapi/v2/files"},
        {"key": "endpoints.content", "label": "（openapi 模式）文件内容端点", "placeholder": "/openapi/v2/files/{id}/content"},
    ]
    ENDPOINTS = {"list": "/openapi/v2/files", "content": "/openapi/v2/files/{id}/content"}

    @classmethod
    def fetch_all(cls, source, credential, options=None, max_=None):
        options = options or {}
        max_ = max_ or CONFIG["max_docs_per_source"]
        if options.get("mode") != "openapi":
            if not options.get("dir"):
                raise RuntimeError('请在 options.dir 指定"腾讯文档导出文件"所在目录')
            return LocalFolder.fetch_all(source, credential, options, max_)

        token = parse_credential(credential, ("access_token",)).get("access_token")
        if not token:
            raise RuntimeError("openapi 模式缺少 access_token")
        base = source["baseUrl"] or "https://docs.qq.com"
        ep = {**cls.ENDPOINTS, **(options.get("endpoints") or {})}
        field = options.get("authField") or "access_token"
        list_url = join_url(base, ep["list"]) + ("&" if "?" in ep["list"] else "?") + f"{field}={urllib.parse.quote(str(token))}"
        files = deep_get(request(list_url, timeout=20000, retries=1).json(), "data.files") or []

        raws = []
        for f in files[:max_]:
            fid = f.get("id") or f.get("fileId") or f.get("guid")
            c_url = join_url(base, ep["content"].replace("{id}", urllib.parse.quote(str(fid)))) + \
                    ("&" if "?" in ep["content"] else "?") + f"{field}={urllib.parse.quote(str(token))}"
            try:
                cj = request(c_url, timeout=20000, retries=1).json()
                body = deep_get(cj, "data.content") or deep_get(cj, "data") or ""
            except Exception:  # noqa: BLE001
                continue
            raws.append({
                "externalId": f"tdoc:{fid}",
                "title": f.get("title") or f.get("name") or str(fid),
                "path": f"{f.get('folderName')}/{f.get('title')}" if f.get("folderName") else (f.get("title") or str(fid)),
                "url": f.get("url") or f.get("webUrl") or "",
                "content": body if isinstance(body, str) else json.dumps(body, ensure_ascii=False),
                "format": "html" if re.search(r"<[a-z]+[\s>]", str(body), re.I) else "text",
                "updatedAt": int(f["updateTime"]) if f.get("updateTime") else None,
                "tags": [f.get("type")] if f.get("type") else [],
                "meta": {"type": f.get("type"), "id": fid},
            })
        return to_docs(source, raws, max_)

    @classmethod
    def test(cls, base_url, credential, options=None):
        options = options or {}
        if options.get("mode") != "openapi":
            return LocalFolder.test(base_url, credential, options)
        token = parse_credential(credential, ("access_token",)).get("access_token")
        base = base_url or "https://docs.qq.com"
        ep = {**cls.ENDPOINTS, **(options.get("endpoints") or {})}
        field = options.get("authField") or "access_token"
        url = join_url(base, ep["list"]) + ("&" if "?" in ep["list"] else "?") + f"{field}={urllib.parse.quote(str(token or ''))}"
        files = deep_get(request(url, timeout=12000, retries=0).json(), "data.files") or []
        return {"ok": True, "message": f"连接成功，可见 {len(files)} 个文件", "sample": [f.get("title") for f in files[:5]]}


# ---------------------------------------------------------------- MCP 客户端接入


class MCPSource:
    platform = "mcp"
    label = "MCP 服务器（客户端接入）"
    description = "把任意暴露 MCP 协议的服务器作为知识源接入：拉取 resources 或调用 tools"
    default_base_url = ""
    credential_hint = "由 options 提供 transport 与启动参数 / 地址；一般无需单独凭证"
    credential_type = "无 / 取决于外部服务"
    fields = [
        {"key": "transport", "label": "传输方式：stdio / sse / http", "placeholder": "stdio"},
        {"key": "command", "label": "（stdio）启动命令", "placeholder": "npx"},
        {"key": "args", "label": "（stdio）参数（JSON 数组）", "placeholder": '["-y","@some/mcp-server"]'},
        {"key": "url", "label": "（sse/http）地址", "placeholder": "http://localhost:3000/mcp"},
        {"key": "resourcePattern", "label": "只同步 URI 匹配此正则的资源（留空=全部）", "placeholder": "docs"},
        {"key": "toolName", "label": "改用 tools/call 获取内容（可选）", "placeholder": "search_docs"},
    ]

    @classmethod
    def fetch_all(cls, source, credential=None, options=None, max_=None):
        options = options or {}
        max_ = max_ or min(CONFIG["max_docs_per_source"], 2000)
        client = MCPClient.from_options(options)
        try:
            client.initialize()
            raws: list[dict] = []
            if options.get("toolName"):
                for c in client.call_tool(options["toolName"], options.get("toolArgs") or {}):
                    text = c.get("text") or ""
                    if not text:
                        continue
                    raws.append({
                        "externalId": f"mcp:tool:{options['toolName']}",
                        "title": options.get("toolTitle") or options["toolName"],
                        "path": f"tool/{options['toolName']}",
                        "content": text, "format": "text", "tags": ["mcp-tool"],
                        "meta": {"toolName": options["toolName"]},
                    })
            else:
                resources = client.list_resources()
                pattern = re.compile(options["resourcePattern"], re.I) if options.get("resourcePattern") else None
                targets = [r for r in resources if not pattern or pattern.search(r.get("uri", ""))][:max_]
                for r in targets:
                    try:
                        for c in client.read_resource(r["uri"]):
                            text = c.get("text") or ""
                            if not text:
                                continue
                            mime = r.get("mimeType") or c.get("mimeType") or ""
                            raws.append({
                                "externalId": f"mcp:{r['uri']}",
                                "title": r.get("name") or r["uri"].split("/")[-1] or r["uri"],
                                "path": r["uri"], "url": r["uri"], "content": text,
                                "format": "html" if "/html" in mime else ("markdown" if "/markdown" in mime else "text"),
                                "tags": [], "meta": {"uri": r["uri"], "mimeType": mime},
                            })
                    except Exception:  # noqa: BLE001
                        continue
            return to_docs(source, raws, max_)
        finally:
            client.kill()

    @classmethod
    def test(cls, base_url, credential=None, options=None):
        client = MCPClient.from_options(options or {})
        try:
            client.initialize()
            res = client.list_resources()
            return {"ok": True, "message": f"MCP 握手成功，可见 {len(res)} 个资源", "sample": [r.get("uri") for r in res[:5]]}
        finally:
            client.kill()


# ---------------------------------------------------------------- 通用 HTTP


class GenericHTTP:
    platform = "generic"
    label = "通用 OpenAPI / HTTP"
    description = "通过可配置的 JSON 列表接口接入任意系统，作为兜底方案"
    default_base_url = "https://api.example.com"
    credential_hint = "对方 API Token；字段映射在 options 里配置"
    credential_type = "Token / API Key"
    fields = [
        {"key": "listPath", "label": "列表接口路径", "placeholder": "/api/v1/documents"},
        {"key": "listRoot", "label": "列表数据所在 JSON 路径", "placeholder": "data.items"},
        {"key": "itemMapping", "label": "字段映射（JSON）", "placeholder": '{"id":"id","title":"name","content":"body"}'},
        {"key": "authHeader", "label": "鉴权头：bearer/token/basic/query:xxx", "placeholder": "bearer"},
    ]

    @staticmethod
    def _headers(options, token):
        h = dict(options.get("headers") or {})
        mode = str(options.get("authHeader") or "bearer").lower()
        if mode == "bearer":
            h["Authorization"] = f"Bearer {token}"
        elif mode == "token":
            h["Authorization"] = token
        elif mode == "basic":
            h["Authorization"] = f"Basic {base64.b64encode(str(token).encode()).decode()}"
        return h

    @classmethod
    def _fetch_list(cls, base_url, options, token):
        out, size = [], int((options.get("pagination") or {}).get("size") or 100)
        max_pages = int((options.get("pagination") or {}).get("maxPages") or 10)
        for page in range(1, max_pages + 1):
            url = join_url(base_url, options.get("listPath") or "/items")
            pag = options.get("pagination") or {}
            if pag.get("type") == "page":
                url += ("&" if "?" in url else "?") + f"{pag.get('param') or 'page'}={page}&{pag.get('sizeParam') or 'per_page'}={size}"
            elif pag.get("type") == "offset":
                url += ("&" if "?" in url else "?") + f"{pag.get('param') or 'offset'}={(page-1)*size}&{pag.get('sizeParam') or 'limit'}={size}"
            arr = deep_get(request(url, headers=cls._headers(options, token), timeout=20000, retries=1).json(),
                           options.get("listRoot") or "data")
            if not isinstance(arr, list):
                raise RuntimeError("列表响应不是数组，请检查 listRoot 配置")
            out.extend(arr)
            if len(arr) < size:
                break
        return out

    @classmethod
    def fetch_all(cls, source, credential, options=None, max_=None):
        options = options or {}
        max_ = max_ or CONFIG["max_docs_per_source"]
        token = parse_credential(credential, ("token",)).get("token")
        items = cls._fetch_list(source["baseUrl"], options, token)[:max_]
        mapping = options.get("itemMapping") or {"id": "id", "title": "title", "content": "content"}
        if isinstance(mapping, str):
            mapping = json.loads(mapping)
        raws = []
        for it in items:
            iid = deep_get(it, mapping.get("id") or "id")
            if not iid:
                continue
            content = deep_get(it, mapping.get("content") or mapping.get("body"))
            if not content and options.get("contentPath"):
                try:
                    cj = request(join_url(source["baseUrl"], options["contentPath"].replace("{id}", urllib.parse.quote(str(iid)))),
                                 headers=cls._headers(options, token), timeout=20000, retries=1).json()
                    content = deep_get(cj, mapping.get("content") or "body") or ""
                except Exception:  # noqa: BLE001
                    content = ""
            raws.append({
                "externalId": f"generic:{iid}",
                "title": deep_get(it, mapping.get("title") or "title") or str(iid),
                "path": deep_get(it, mapping.get("path") or "path") or str(iid),
                "url": deep_get(it, mapping.get("url") or "url") or "",
                "content": str(content or ""),
                "format": deep_get(it, mapping.get("format")) or "text",
                "author": deep_get(it, mapping.get("author")) or "",
                "createdAt": deep_get(it, mapping.get("createdAt")),
                "updatedAt": deep_get(it, mapping.get("updatedAt")),
                "tags": deep_get(it, mapping.get("tags")) or [],
                "meta": {"raw": it},
            })
        return to_docs(source, raws, max_)

    @classmethod
    def test(cls, base_url, credential, options=None):
        options = options or {}
        token = parse_credential(credential, ("token",)).get("token")
        items = cls._fetch_list(base_url, options, token)
        title_key = (options.get("itemMapping") or {}).get("title") if isinstance(options.get("itemMapping"), dict) else "title"
        return {"ok": True, "message": f"连接成功，列表返回 {len(items)} 项",
                "sample": [deep_get(i, title_key or "title") or i.get("id") for i in items[:5]]}


# ---------------------------------------------------------------- 注册表

CONNECTORS = {
    c.platform: c
    for c in (ShowDoc, GitHub, Gitee, ZenTao, Evernote, TencentDocs, MCPSource, LocalFolder, GenericHTTP)
}


def get_connector(platform: str):
    return CONNECTORS.get(platform)


def list_platforms() -> list[dict]:
    return [{
        "platform": c.platform, "label": c.label, "description": c.description,
        "defaultBaseUrl": c.default_base_url, "credentialHint": c.credential_hint,
        "credentialType": c.credential_type, "fields": c.fields,
    } for c in CONNECTORS.values()]


def run_sync(store, source: dict, max_: int | None = None) -> dict:
    """执行一次同步：拉取 → 归一化 → 落库 → 重建索引。"""
    connector = get_connector(source["platform"])
    if not connector:
        raise RuntimeError(f"未知平台：{source['platform']}")
    credential = store.get_credential(source)
    docs = connector.fetch_all(source, credential, source.get("options") or {}, max_)
    result = store.save_docs(source["id"], docs)
    return {**result, "total": len(docs)}
