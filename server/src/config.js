import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { maskSecret } from './lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录：server/src -> ../.. */
export const ROOT_DIR = path.resolve(__dirname, '..', '..');

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}

/**
 * 载入 .env（若存在）。保持零依赖，手写极简解析器。
 * 已存在的环境变量优先级更高，不被 .env 覆盖。
 */
export function loadDotEnv(file = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

export const config = {
  rootDir: ROOT_DIR,
  port: num(process.env.KB_PORT, 8787),
  host: process.env.KB_HOST || '127.0.0.1',
  dataDir: path.resolve(process.env.KB_DATA_DIR || path.join(ROOT_DIR, 'data')),
  webDir: path.resolve(process.env.KB_WEB_DIR || path.join(ROOT_DIR, 'web')),
  /** 启用后所有 /api/* 需携带 Authorization: Bearer <KB_API_TOKEN> */
  apiToken: process.env.KB_API_TOKEN || '',
  /** 凭证加密主密钥；未设置时使用数据目录下的随机密钥文件 */
  masterKey: process.env.KB_MASTER_KEY || '',
  /** 定时同步周期（分钟），0 表示仅手动同步 */
  syncIntervalMinutes: num(process.env.KB_SYNC_INTERVAL_MINUTES, 120),
  /** 启动时是否自动对已启用数据源做一次同步 */
  syncOnBoot: bool(process.env.KB_SYNC_ON_BOOT, false),
  /** 单次同步单源最多拉取条目数，防止误配导致爆炸 */
  maxDocsPerSource: num(process.env.KB_MAX_DOCS_PER_SOURCE, 5000),
  /** 外部 HTTP 请求超时（毫秒） */
  httpTimeoutMs: num(process.env.KB_HTTP_TIMEOUT_MS, 20000),
  /** 外部 HTTP 重试次数 */
  httpRetries: num(process.env.KB_HTTP_RETRIES, 2),
  /** 允许的外部请求并发度 */
  httpConcurrency: num(process.env.KB_HTTP_CONCURRENCY, 4),
  logLevel: (process.env.KB_LOG_LEVEL || 'info').toLowerCase(),
  version: '0.1.0'
};

export function ensureDirs() {
  for (const d of [config.dataDir, path.join(config.dataDir, 'docs')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function printConfigBanner() {
  const lines = [
    `数据目录   : ${config.dataDir}`,
    `监听地址   : ${config.host}:${config.port}`,
    `接口鉴权   : ${config.apiToken ? '已启用 (Bearer Token)' : '未启用（仅限本地信任环境）'}`,
    `主密钥     : ${config.masterKey ? '来自环境变量 KB_MASTER_KEY' : '来自数据目录随机密钥文件'}`,
    `定时同步   : ${config.syncIntervalMinutes === 0 ? '关闭（仅手动）' : `每 ${config.syncIntervalMinutes} 分钟`}`
  ];
  return lines.join('\n');
}

export { maskSecret };
