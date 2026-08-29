// Electron 桌面端入口：在本地拉起服务进程，并用窗口加载工作台。
// 这样桌面端与服务端、Web 端共享同一套代码与数据（D:/.../knowledge-workbench/data）。
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.KB_PORT || 8787);
const ROOT = path.resolve(__dirname, '..'); // 仓库根
const DATA_DIR = path.join(ROOT, 'data');
const NODE_BIN = process.env.KB_NODE_BIN || 'node'; // 需本机已安装 Node >= 18（加入 PATH）

let win = null;
let serverProc = null;
let starting = false;

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
  serverProc = spawn(
    NODE_BIN,
    [path.join(ROOT, 'server', 'src', 'index.js')],
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
