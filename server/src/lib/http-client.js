import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { URL } from 'node:url';
import { sleep, redact, errMessage } from './util.js';

const DEFAULT_UA = 'knowledge-workbench/0.1 (+https://github.com/zhangshifa/knowledge-workbench)';

/**
 * 极简 HTTP 客户端（零依赖）。
 * - 支持 gzip / deflate / br 解压
 * - 支持重定向、超时、指数退避重试
 * - 支持 HTTP 代理（KB_HTTP_PROXY / HTTPS_PROXY，含 https CONNECT 隧道）
 * 之所以不用全局 fetch：Node 内置 fetch 不读取系统代理，企业内网环境会直接失败。
 */

function proxyFor(targetUrl) {
  const raw =
    process.env.KB_HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  if (!raw) return null;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const host = new URL(targetUrl).hostname.toLowerCase();
  if (noProxy.some((p) => host === p || host.endsWith(p.startsWith('.') ? p : `.${p}`))) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function connectViaProxy(proxyUrl, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
      timeout: 15000
    });
    if (proxyUrl.username) {
      const auth = Buffer.from(
        `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
      ).toString('base64');
      req.setHeader('Proxy-Authorization', `Basic ${auth}`);
    }
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`代理 CONNECT 失败: ${res.statusCode}`));
        socket.destroy();
        return;
      }
      resolve(socket);
    });
    req.once('error', reject);
    req.end();
  });
}

function decodeBody(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer);
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer);
    if (enc.includes('deflate')) return zlib.inflateSync(buffer);
  } catch {
    /* 解压失败时退回原始字节 */
  }
  return buffer;
}

function once(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const proxy = proxyFor(url);
    const timeout = opts.timeout || 20000;

    const headers = Object.assign(
      {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate'
      },
      opts.headers || {}
    );

    let payload = null;
    if (opts.form) {
      payload = Buffer.from(new URLSearchParams(opts.form).toString(), 'utf8');
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (opts.body !== undefined) {
      payload = Buffer.isBuffer(opts.body)
        ? opts.body
        : typeof opts.body === 'string'
          ? Buffer.from(opts.body, 'utf8')
          : Buffer.from(JSON.stringify(opts.body), 'utf8');
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json; charset=utf-8';
    }
    if (payload) headers['Content-Length'] = String(payload.length);

    const finish = (socket) => {
      const options = {
        method: (opts.method || 'GET').toUpperCase(),
        headers,
        timeout
      };
      if (socket) {
        options.socket = socket;
        options.agent = false;
        options.path = u.pathname + u.search;
      } else {
        options.host = u.hostname;
        options.port = u.port || (isHttps ? 443 : 80);
        options.path = u.pathname + u.search;
      }
      if (isHttps && !socket) options.servername = u.hostname;

      const transport = isHttps ? https : http;
      const req = transport.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const buf = decodeBody(raw, res.headers['content-encoding']);
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: buf,
            text: buf.toString('utf8'),
            json: () => JSON.parse(buf.toString('utf8'))
          });
        });
        res.on('error', reject);
      });
      req.setTimeout(timeout, () => req.destroy(new Error(`请求超时 (${timeout}ms)`)));
      req.once('error', reject);
      if (payload) req.write(payload);
      req.end();
    };

    if (proxy) {
      if (isHttps) {
        connectViaProxy(proxy, u.hostname, u.port || 443)
          .then((socket) => {
            // CONNECT 隧道已建立，需在这条裸 TCP 上再完成一次 TLS 握手
            try {
              finish(
                tls.connect({ socket, servername: u.hostname, ALPNProtocols: ['http/1.1'] })
              );
            } catch {
              finish(socket);
            }
          })
          .catch(reject);
        return;
      }
      // http 明文：直接把绝对 URI 发给代理
      const pReq = http.request(
        {
          host: proxy.hostname,
          port: proxy.port || 80,
          method: (opts.method || 'GET').toUpperCase(),
          path: url,
          headers,
          timeout
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = decodeBody(Buffer.concat(chunks), res.headers['content-encoding']);
            resolve({
              status: res.statusCode || 0,
              headers: res.headers,
              body: buf,
              text: buf.toString('utf8'),
              json: () => JSON.parse(buf.toString('utf8'))
            });
          });
        }
      );
      pReq.once('error', reject);
      if (payload) pReq.write(payload);
      pReq.end();
      return;
    }

    finish(null);
  });
}

/**
 * 发起请求并处理重试与重定向。
 * @returns {Promise<{status:number, headers:object, body:Buffer, text:string, json:Function}>}
 */
export async function request(url, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? 3;
  const retries = opts.retries ?? 2;
  const timeout = opts.timeout ?? 20000;

  let current = url;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      let res = await once(current, { ...opts, timeout, redirect: 'manual' });
      let hops = 0;
      while (res.status >= 300 && res.status < 400 && res.headers.location && hops < maxRedirects) {
        const next = new URL(res.headers.location, current).toString();
        hops++;
        current = next;
        res = await once(current, { ...opts, timeout, redirect: 'manual' });
      }
      if (res.status >= 500 || res.status === 429) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await sleep(Math.min(8000, 500 * 2 ** attempt));
        continue;
      }
    }
  }
  throw new Error(`请求失败 ${redact(url)}: ${errMessage(lastErr)}`);
}

export async function requestJson(url, opts = {}) {
  const res = await request(url, opts);
  const text = res.text;
  // 部分平台（如禅道、ShowDoc）即使声明 json 也会偶发返回带 BOM 或前后空白
  const cleaned = text.replace(/^﻿/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`响应不是合法 JSON（前 200 字符）：${cleaned.slice(0, 200)}`);
  }
}

export const httpClient = { request, requestJson };
export default httpClient;
