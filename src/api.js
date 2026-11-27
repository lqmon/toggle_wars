// Minimal Flagsmith Admin API client (works against self-hosted or Cloud).
export class FlagsmithAdmin {
  constructor({ apiUrl = 'http://localhost:8000', token, masterKey } = {}) {
    this.base = apiUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
    this.token = token;
    this.masterKey = masterKey;
  }

  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.masterKey) h.Authorization = `Api-Key ${this.masterKey}`;
    else if (this.token) h.Authorization = `Token ${this.token}`;
    return h;
  }

  async req(method, path, body) {
    const url = `${this.base}/api/v1/${path.replace(/^\/+/, '')}`;
    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data)}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  patch(p, b) { return this.req('PATCH', p, b); }
  put(p, b) { return this.req('PUT', p, b); }
  del(p) { return this.req('DELETE', p); }

  // Lists may be paginated ({results}) or plain arrays.
  async list(p) {
    const out = [];
    let next = p;
    while (next) {
      const data = await this.get(next);
      if (Array.isArray(data)) return data;
      out.push(...(data.results || []));
      next = data.next ? data.next.replace(/^.*\/api\/v1\//, '') : null;
    }
    return out;
  }
}

export async function waitForHealthy(apiUrl, { timeoutMs = 300_000, onTick } = {}) {
  const base = apiUrl.replace(/\/+$/, '');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    onTick?.(Math.round((Date.now() - start) / 1000));
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Flagsmith at ${base} did not become healthy in ${timeoutMs / 1000}s`);
}
