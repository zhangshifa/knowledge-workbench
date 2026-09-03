// 知识库工作台 前端（零构建，原生 ES Module）
// 服务地址可配置：同源（默认）或远程服务（供 Android APK / 跨域场景使用）
const API_BASE_KEY = 'kb.apiBase';   // 例如 http://192.168.1.10:8787，留空 = 同源
const TOKEN_KEY = 'kb.apiToken';     // 对应服务端的 KB_API_TOKEN

function apiBase() {
  return (localStorage.getItem(API_BASE_KEY) || '').replace(/\/+$/, '');
}
function apiToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

const $ = (sel) => document.querySelector(sel);
const state = { sources: [], current: null, query: '', doc: null };

async function api(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const token = apiToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(apiBase() + '/api' + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.borderColor = isError ? 'var(--bad)' : 'var(--border)';
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- 极简 Markdown 渲染（与后端逻辑保持一致） ----
function renderMarkdown(md) {
  let text = String(md || '');
  const codeBlocks = [];
  text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/^\w+\n/, ''))}</code></pre>`);
    return ` CODEBLOCK${codeBlocks.length - 1} `;
  });
  text = escapeHtml(text)
    .replace(/^######\s+(.*)$/gm, '<h6>$1</h6>')
    .replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>')
    .replace(/^####\s+(.*)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>')
    .replace(/^\s*&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" loading="lazy" style="max-width:100%"/>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^\s*[-*+]\s+(.*)$/gm, '<li>$1</li>')
    .replace(/^\s*\d+\.\s+(.*)$/gm, '<li>$1</li>')
    .replace(/^---+$/gm, '<hr/>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br/>');
  text = `<p>${text}</p>`
    .replace(/<p><\/p>/g, '')
    .replace(/<p>(<h[1-6]>)/g, '$1')
    .replace(/(<\/h[1-6]>)<\/p>/g, '$1')
    .replace(/<p>(<li>)/g, '<ul>$1')
    .replace(/(<\/li>)<\/p>/g, '$1</ul>')
    .replace(/<p>(<blockquote>)/g, '$1')
    .replace(/(<\/blockquote>)<\/p>/g, '$1')
    .replace(/<p>(<pre>)/g, '$1')
    .replace(/(<\/pre>)<\/p>/g, '$1')
    .replace(/<p>(<hr\/>)<\/p>/g, '$1');
  return text.replace(/ CODEBLOCK(\d+) /g, (_, i) => codeBlocks[Number(i)] || '');
}

function highlight(text, q) {
  if (!q) return escapeHtml(text || '');
  const terms = Array.from(new Set(q.toLowerCase().match(/[一-龥]{1,3}|[a-z0-9_]{2,}/g) || [])).sort((a, b) => b.length - a.length);
  let out = escapeHtml(text || '');
  for (const t of terms) {
    out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  }
  return out;
}

// ---- 数据源列表 ----
async function loadSources() {
  const { sources } = await api('/sources');
  state.sources = sources;
  const list = $('#sourceList');
  list.innerHTML = sources.length
    ? sources.map((s) => {
        const st = s.lastSync?.status;
        const dot = st === 'success' ? 'ok' : st === 'failed' ? 'fail' : 'idle';
        return `<li data-id="${s.id}">
          <div class="source-name">${escapeHtml(s.name)} <span class="badge">${s.platform}</span></div>
          <div class="source-meta"><span class="dot ${dot}"></span>${s.docCount || 0} 篇 · ${s.lastSync ? new Date(s.lastSync.finishedAt).toLocaleString('zh-CN') : '未同步'}</div>
        </li>`;
      }).join('')
    : '<li class="muted" style="padding:12px">暂无数据源，点击右上角 ＋ 添加</li>';

  list.querySelectorAll('li[data-id]').forEach((li) =>
    li.addEventListener('click', () => openSource(li.dataset.id))
  );
  refreshStat();
}

function refreshStat() {
  const docs = state.sources.reduce((a, s) => a + (s.docCount || 0), 0);
  $('#statBadge').textContent = `${state.sources.length} 源 · ${docs} 篇`;
}

// ---- 打开数据源 ----
async function openSource(id) {
  state.current = id;
  document.querySelectorAll('#sourceList li').forEach((li) => li.classList.toggle('active', li.dataset.id === id));
  const src = state.sources.find((s) => s.id === id);
  $('#placeholder').classList.add('hidden');
  const view = $('#resultView');
  view.classList.remove('hidden');

  const { items, total } = await api(`/docs?source=${id}&limit=50&sort=updated`);
  view.innerHTML = `
    <div class="src-toolbar">
      <b>${escapeHtml(src.name)}</b><span class="muted">${src.platform}${src.baseUrl ? ' · ' + escapeHtml(src.baseUrl) : ''}</span>
      <span class="spacer" style="flex:1"></span>
      <button class="btn ghost" id="syncBtn">立即同步</button>
      <button class="btn ghost" id="delBtn">删除</button>
    </div>
    <div class="result-meta">共 ${total} 篇文档</div>
    ${items.map(renderDocCard).join('') || '<p class="muted">还没有同步到内容，点击「立即同步」试试。</p>'}`;
  $('#syncBtn').onclick = () => syncSource(id);
  $('#delBtn').onclick = () => deleteSource(id);
  $('#sidebar').classList.remove('open');
}

function renderDocCard(d) {
  return `<div class="doc-card" data-id="${d.id}">
    <div class="doc-title">${escapeHtml(d.title)}</div>
    <div class="doc-path">${escapeHtml(d.path || '')} ${d.tags && d.tags.length ? '· ' + d.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('') : ''}</div>
    <div class="doc-snippet">${escapeHtml((d.summary || '').slice(0, 160))}</div>
  </div>`;
}

// ---- 检索 ----
async function doSearch(q) {
  state.query = q;
  $('#placeholder').classList.add('hidden');
  const view = $('#resultView');
  view.classList.remove('hidden');
  if (!q) { view.innerHTML = ''; return; }
  const data = await api(`/docs?q=${encodeURIComponent(q)}&limit=50`);
  view.innerHTML = `<div class="result-meta">检索「${escapeHtml(q)}」命中 ${data.total} 篇</div>${
    data.items.map((d) => `<div class="doc-card" data-id="${d.id}">
      <div class="doc-title">${highlight(d.title, q)}</div>
      <div class="doc-path">${escapeHtml(d.platform)}/${escapeHtml(d.type)} ${d.tags ? d.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('') : ''}</div>
      <div class="doc-snippet">${highlight(d.snippet || '', q)}</div>
    </div>`).join('') || '<p class="muted">没有命中，换个关键词试试。</p>'
  }`;
  view.querySelectorAll('.doc-card').forEach((c) => c.addEventListener('click', () => openDoc(c.dataset.id)));
}

// ---- 文档详情 ----
async function openDoc(id) {
  const d = await api(`/docs/${id}`);
  $('#placeholder').classList.add('hidden');
  const view = $('#resultView');
  view.classList.remove('hidden');
  const html = renderMarkdown(d.content);
  view.innerHTML = `<div class="doc-view">
    <button class="back-btn" id="backBtn">← 返回</button>
    <div class="doc-actions">
      ${d.url ? `<a class="btn ghost" href="${escapeHtml(d.url)}" target="_blank" rel="noopener">打开原文</a>` : ''}
      <button class="btn ghost" id="copyBtn">复制正文</button>
    </div>
    <h1>${escapeHtml(d.title)}</h1>
    <div class="doc-path">${escapeHtml(d.platform)} / ${escapeHtml(d.type)} · ${d.tags ? d.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('') : ''}</div>
    ${html}
  </div>`;
  $('#backBtn').onclick = () => (state.current ? openSource(state.current) : (view.innerHTML = ''));
  $('#copyBtn').onclick = () => { navigator.clipboard.writeText(d.content); toast('已复制正文'); };
}

// ---- 同步 / 删除 ----
async function syncSource(id) {
  const btn = $('#syncBtn');
  if (btn) btn.disabled = true;
  toast('正在同步…');
  try {
    const r = await api(`/sources/${id}/sync`, { method: 'POST' });
    toast(`同步完成：新增 ${r.added ?? 0} / 更新 ${r.updated ?? 0}，共 ${r.total ?? 0} 篇`);
    await loadSources();
    if (state.current === id) openSource(id);
  } catch (e) {
    toast('同步失败：' + e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteSource(id) {
  if (!confirm('确认删除该数据源？已同步的文档将被移除。')) return;
  await api(`/sources/${id}`, { method: 'DELETE' });
  toast('已删除');
  state.current = null;
  await loadSources();
  $('#resultView').classList.add('hidden');
  $('#placeholder').classList.remove('hidden');
}

// ---- 新增数据源弹窗 ----
async function openModal() {
  const { platforms } = await api('/platforms');
  const sel = $('#fPlatform');
  sel.innerHTML = platforms.map((p) => `<option value="${p.platform}">${escapeHtml(p.label)}</option>`).join('');
  sel.onchange = () => updatePlatformHint(platforms, sel.value);
  updatePlatformHint(platforms, sel.value);
  $('#sourceForm').reset();
  $('#fInterval').value = 120;
  $('#testMsg').textContent = '';
  $('#sourceModal').classList.remove('hidden');
}

function updatePlatformHint(platforms, platform) {
  const p = platforms.find((x) => x.platform === platform);
  $('#fBaseUrl').placeholder = p?.defaultBaseUrl || 'https://';
  $('#fCredential').placeholder = p?.credentialHint || '一个凭证即可接入';
}

$('#addSourceBtn').onclick = openModal;
$('#modalClose').onclick = () => $('#sourceModal').classList.add('hidden');
$('#cancelBtn').onclick = () => $('#sourceModal').classList.add('hidden');

$('#testBtn').onclick = async () => {
  const platform = $('#fPlatform').value;
  const body = {
    platform,
    baseUrl: $('#fBaseUrl').value.trim(),
    credential: $('#fCredential').value,
    options: parseOptions()
  };
  $('#testMsg').textContent = '测试中…';
  try {
    const r = await api('/sources/test', { method: 'POST', body });
    $('#testMsg').textContent = `✓ ${r.message}${r.sample && r.sample.length ? '（' + r.sample.slice(0, 3).join('、') + '…）' : ''}`;
    $('#testMsg').style.color = 'var(--ok)';
  } catch (e) {
    $('#testMsg').textContent = '✗ ' + e.message;
    $('#testMsg').style.color = 'var(--bad)';
  }
};

function parseOptions() {
  const raw = $('#fOptions').value.trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { toast('高级选项不是合法 JSON', true); return {}; }
}

$('#sourceForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    name: $('#fName').value.trim() || $('#fPlatform').selectedOptions[0].textContent,
    platform: $('#fPlatform').value,
    baseUrl: $('#fBaseUrl').value.trim(),
    credential: $('#fCredential').value,
    syncIntervalMinutes: Number($('#fInterval').value || 0),
    enabled: true,
    options: parseOptions()
  };
  try {
    const src = await api('/sources', { method: 'POST', body });
    toast('已创建，开始首次同步…');
    $('#sourceModal').classList.add('hidden');
    await loadSources();
    syncSource(src.id);
  } catch (e) {
    toast('创建失败：' + e.message, true);
  }
};

$('#exportBtn').onclick = () => {
  window.open(apiBase() + '/api/export', '_blank');
};

// ---- 接入配置 导入/导出（换机器或团队协作时复用同一套数据源配置） ----
function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('#exportCfgBtn').onclick = async () => {
  try {
    const data = await api('/sources/export');
    download('kb-sources-config.json', JSON.stringify({ sources: data.sources }, null, 2));
    toast(`已导出 ${data.sources.length} 个数据源配置（不含明文凭证）`);
  } catch (e) {
    toast('导出失败：' + e.message, true);
  }
};

$('#importCfgBtn').onclick = () => $('#cfgFile').click();

$('#cfgFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const r = await api('/sources/import', { method: 'POST', body: payload });
    toast(`已导入 ${r.created} 个数据源${r.skipped && r.skipped.length ? `，跳过 ${r.skipped.length} 个` : ''}；请补充凭证后同步`);
    await loadSources();
  } catch (err) {
    toast('导入失败：' + err.message, true);
  } finally {
    e.target.value = '';
  }
});

// ---- 服务设置（远程服务 / 接口 Token） ----
function openSettings() {
  $('#sApiBase').value = apiBase();
  $('#sToken').value = apiToken();
  $('#sHint').textContent = apiBase()
    ? `当前：${apiBase()}${apiToken() ? '（已启用 Token 鉴权）' : '（无鉴权）'}`
    : '当前：与网页同源（浏览器 / Electron / Docker 部署常用）';
  $('#settingsModal').classList.remove('hidden');
}

$('#settingsBtn').onclick = openSettings;
$('#settingsClose').onclick = () => $('#settingsModal').classList.add('hidden');
$('#settingsCancel').onclick = () => $('#settingsModal').classList.add('hidden');
$('#settingsReset').onclick = () => {
  localStorage.removeItem(API_BASE_KEY);
  localStorage.removeItem(TOKEN_KEY);
  toast('已恢复同源模式');
  location.reload();
};

$('#settingsTest').onclick = async () => {
  const base = $('#sApiBase').value.trim().replace(/\/+$/, '');
  const token = $('#sToken').value.trim();
  $('#sHint').textContent = '测试中…';
  try {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + '/api/health', { headers, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    $('#sHint').textContent = `✓ 连通（${j.runtime || 'server'} v${j.version || '-'}）`;
    $('#sHint').style.color = 'var(--ok)';
  } catch (e) {
    $('#sHint').textContent = '✗ 无法连接：' + e.message;
    $('#sHint').style.color = 'var(--bad)';
  }
};

$('#settingsForm').onsubmit = (e) => {
  e.preventDefault();
  const base = $('#sApiBase').value.trim().replace(/\/+$/, '');
  const token = $('#sToken').value.trim();
  if (base) localStorage.setItem(API_BASE_KEY, base);
  else localStorage.removeItem(API_BASE_KEY);
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  toast('已保存，正在重新载入…');
  setTimeout(() => location.reload(), 500);
};

// ---- 搜索框 ----
$('#searchForm').onsubmit = (e) => { e.preventDefault(); doSearch($('#searchInput').value.trim()); };
let searchTimer;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => doSearch(e.target.value.trim()), 300);
});

$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');

// 文档卡片点击委托
$('#resultView').addEventListener('click', (e) => {
  const card = e.target.closest('.doc-card');
  if (card) openDoc(card.dataset.id);
});

// ---- 启动 ----
(async function init() {
  // APK / 本地文件方式打开时，没有同源后端，必须先配置服务地址
  if (!apiBase() && !/^https?:$/.test(location.protocol)) {
    openSettings();
    toast('请先配置知识库服务地址');
    return;
  }
  try {
    await loadSources();
  } catch (e) {
    toast('服务未启动或不可达：' + e.message, true);
  }
  if (/^https?:$/.test(location.protocol) && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
