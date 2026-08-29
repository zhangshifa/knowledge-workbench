import { spawn } from 'node:child_process';
import { request } from '../lib/http-client.js';

/**
 * MCP 客户端（零依赖）。
 * 支持两种 transport：
 *   - stdio：启动外部进程，通过 stdin/stdout 走 JSON-RPC 2.0（newline-delimited）
 *   - sse / streamable-http：向 URL POST JSON-RPC，解析 JSON 或 SSE 响应
 * 用于"通过 MCP 方式接入一个外部知识源"。
 */

const PROTOCOL = '2025-06-18';

class StdioTransport {
  constructor(command, args = [], env = {}) {
    this.proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    this.pending = new Map();
    this.idSeq = 1;
    this.queue = [];
    this.connected = false;
    this.buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this._ready = new Promise((resolve) => {
      this.proc.on('spawn', resolve);
      if (this.proc.pid) resolve();
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }

  async write(msg) {
    await this._ready;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params) {
    const id = this.idSeq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('MCP 调用超时'));
        }
      }, 30000);
      this.pending.get(id) && (this.pending.get(id).timer = timer);
      this.write({ jsonrpc: '2.0', id, method, params: params || {} }).catch(reject);
    });
  }

  kill() {
    try {
      this.proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

class HttpTransport {
  constructor(url, headers = {}) {
    this.url = url;
    this.headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers };
    this.idSeq = 1;
    this.pending = new Map();
  }

  async request(method, params) {
    const id = this.idSeq++;
    const payload = { jsonrpc: '2.0', id, method, params: params || {} };
    const res = await request(this.url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
      timeout: 30000,
      retries: 1
    });
    if (res.headers['content-type']?.includes('text/event-stream')) {
      return parseSse(res.text, id);
    }
    const msg = JSON.parse(res.text);
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg.result;
  }

  kill() {}
}

function parseSse(text, matchId) {
  let result = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    for (const l of lines) {
      const data = l.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const msg = JSON.parse(data);
        if (msg.id === matchId) {
          if (msg.error) throw new Error(msg.error.message);
          result = msg.result;
        }
      } catch {
        /* 跳过无法解析的 SSE 行 */
      }
    }
  }
  return result;
}

export class McpClient {
  constructor({ transport, command, args, env, url, headers }) {
    if (transport === 'stdio') {
      this.t = new StdioTransport(command, args, env);
    } else {
      this.t = new HttpTransport(url, headers);
    }
  }

  static fromOptions(opts) {
    if (opts.transport === 'sse' || opts.transport === 'http') {
      return new McpClient({ transport: 'http', url: opts.url, headers: opts.headers || {} });
    }
    return new McpClient({
      transport: 'stdio',
      command: opts.command,
      args: opts.args || [],
      env: opts.env || {}
    });
  }

  async initialize() {
    const res = await this.t.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: { resources: {}, tools: {} },
      clientInfo: { name: 'knowledge-workbench', version: '0.1.0' }
    });
    try {
      await this.t.request('notifications/initialized', {}).catch(() => {});
    } catch {
      /* 通知无需回执 */
    }
    return res;
  }

  async listResources() {
    const out = [];
    let cursor;
    do {
      const res = await this.t.request('resources/list', cursor ? { cursor } : {});
      out.push(...(res?.resources || []));
      cursor = res?.nextCursor;
    } while (cursor);
    return out;
  }

  async readResource(uri) {
    const res = await this.t.request('resources/read', { uri });
    return res?.contents || [];
  }

  async listTools() {
    const out = [];
    let cursor;
    do {
      const res = await this.t.request('tools/list', cursor ? { cursor } : {});
      out.push(...(res?.tools || []));
      cursor = res?.nextCursor;
    } while (cursor);
    return out;
  }

  async callTool(name, args = {}) {
    const res = await this.t.request('tools/call', { name, arguments: args });
    return res?.content || [];
  }

  kill() {
    this.t.kill();
  }
}
