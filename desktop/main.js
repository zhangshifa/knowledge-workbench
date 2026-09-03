// Electron 桌面端入口：在本地拉起服务进程，并用窗口加载工作台。
// 这样桌面端与服务端、Web 端共享同一套代码与数据（D:/.../knowledge-workbench/data）。
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.KB_PORT || 8787);
const ROOT = path.resolve(__dirname, '..'); // 仓库根
const DATA_DIR = path.join(ROOT, 'data');
const PYTHON_BIN = process.env.KB_PYTHON_BIN || 'python';
const NODE_BIN = process.env.KB_NODE_BIN || 'node';

let win = null;
let serverProc = null;
let starting = false;

/** 选择运行时：默认 Python，未装 Python 时回退 Node（可用 KB_RUNTIME 强制指定） */
function pickRuntime() {
  const forced = (process.env.KB_RUNTIME || '').toLowerCase();
  const { spawnSync } = require('child_process');
  const has = (bin, args) => {
    try {
      const r = spawnSync(bin, args, { stdio: 'ignore', timeout: 8000 });
      return r.status === 0;
    } catch {
      return false;
    }
  };
  if (forced === 'node') return { bin: NODE_BIN, args: [path.join(ROOT, 'server', 'src', 'index.js')], runtime: 'node' };
  if (forced === 'python') return { bin: PYTHON_BIN, args: [path.join(ROOT, 'server_py', 'main.py'), 'serve'], runtime: 'python' };
  if (has(PYTHON_BIN, ['--version'])) return { bin: PYTHON_BIN, args: [path.join(ROOT, 'server_py', 'main.py'), 'serve'], runtime: 'python' };
  return { bin: NODE_BIN, args: [path.join(ROOT, 'server', 'src', 'index.js')], runtime: 'node' };
}

function waitHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 1000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('服务启动超时'));
        else setTimeout(tick, 400);
      });
      req.on('timeout', () => req.destroy());
    };
    tick();
  });
}

async function startServer() {
  if (starting) return;
  starting = true;
  const rt = pickRuntime();
  console.log(`[desktop] runtime = ${rt.runtime} (${rt.bin})`);
  serverProc = spawn(
    rt.bin,
    rt.args,
    {
      env: {
        ...process.env,
        KB_PORT: String(PORT),
        KB_HOST: '127.0.0.1',
        KB_DATA_DIR: DATA_DIR,
        KB_SYNC_ON_BOOT: 'true'
      },
      stdio: ['ignore', 'inherit', 'inherit']
    }
  );
  serverProc.on('exit', (code) => {
    if (code && code !== 0) console.error('服务进程退出，码：', code);
  });
  try {
    await waitHealth();
  } catch (e) {
    console.error(e.message);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#0f1117',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.on('closed', () => (win = null));
}

app.whenReady().then(async () => {
  await startServer();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (serverProc) serverProc.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { if (serverProc) serverProc.kill(); });
