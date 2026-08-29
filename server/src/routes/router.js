export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp(
      `^${pattern
        .replace(/:([A-Za-z0-9_]+)/g, (_m, k) => {
          keys.push(k);
          return '([^/]+)';
        })
        .replace(/\//g, '\\/')}$`
    );
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  get(p, h) {
    return this.add('GET', p, h);
  }

  post(p, h) {
    return this.add('POST', p, h);
  }

  put(p, h) {
    return this.add('PUT', p, h);
  }

  delete(p, h) {
    return this.add('DELETE', p, h);
  }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return null;
  }
}

export function ok(data = {}) {
  return { ok: true, ...data };
}

export function fail(message, code = 400, extra = {}) {
  return { ok: false, error: message, code, ...extra };
}
