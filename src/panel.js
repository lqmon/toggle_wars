// flagkit panel: a local admin panel for people who flip flags without touching code (PMs, support, on-call).
// Beyond a toggle grid:
//   - every change needs a name, Production needs a reason and a typed confirmation, all of it is audited
//   - one-click revert of any past change, from the audit log
//   - scheduled changes ("turn it on at 09:00 Monday"), run by this process
//   - promote: preview and copy Staging → Production (or any pair), flag by flag
//   - flags inside a running experiment are locked (changing them corrupts the result)
//   - lifecycle badges from the code: stale (remove it), unused (archive it), drift between environments
//   - "why does customer X see this?" lookup for support, using Flagsmith's own evaluation
//   - agent change requests (MCP) approved or rejected here, by a person
// Security: listens on 127.0.0.1 only; a random token (in the URL fragment, so never logged or sent as a
// Referer) must accompany every API call as a header, which also blocks cross-site requests; the Host header
// is checked against DNS rebinding; strict CSP; bodies are capped and validated.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { adminOf } from './experiment.js';
import { loadFlags, lifecycle, drift, scanCode } from './flags.js';
import { setFlag, revert, auditLog, promotePlan, promote, addSchedule, listSchedules, cancelSchedule, runDueSchedules } from './changes.js';
import { listChanges, approveChange, rejectChange, describeParams, isProduction } from './approvals.js';
import { explainData } from './explain.js';
import { summarise } from './results.js';
import { clean } from './sanitize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'panel');
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'] };

export function createPanel(state, { port = 4100, codeRoot = process.cwd(), token = crypto.randomBytes(18).toString('base64url') } = {}) {
  const api = adminOf(state);
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  let scanCache = { at: 0, data: null };

  async function flagsView() {
    const flags = await loadFlags(api, { projectId: state.project.id, environments: state.environments });
    if (Date.now() - scanCache.at > 30_000) {
      try { scanCache = { at: Date.now(), data: scanCode(codeRoot, flags.map((f) => f.name)) }; } catch { scanCache = { at: Date.now(), data: null }; }
    }
    const scan = scanCache.data;
    return {
      project: clean(state.project.name), apiUrl: state.apiUrl, environments: state.environments.map((e) => e.name), codeRoot: scan ? path.basename(codeRoot) : null,
      flags: flags.map((f) => {
        const refs = scan ? scan.refs[f.name] || [] : undefined;
        return { ...f, refs: refs?.slice(0, 20), refCount: refs?.length, lifecycle: lifecycle(f, { refs }), drift: drift(f) };
      }),
      unknownRefs: scan?.unknown.slice(0, 50) || [],
      pendingApprovals: listChanges('pending').length,
      pendingSchedules: listSchedules('pending').length,
    };
  }

  async function experimentsView() {
    const out = [];
    for (const env of state.environments) {
      let list = [];
      try { list = await api.list(`environments/${env.api_key}/experiments/`); } catch { continue; }
      for (const x of list.filter((e) => e.status !== 'completed').slice(0, 20)) {
        const r = await api.get(`environments/${env.api_key}/experiments/${x.id}/results/`).catch(() => null);
        out.push({ id: x.id, name: clean(x.name), status: x.status, env: env.name, flag: clean(x.feature?.name ?? ''), rows: summarise(r).rows });
      }
    }
    return out;
  }

  const routes = {
    'GET /api/flags': () => flagsView(),
    'GET /api/experiments': () => experimentsView(),
    'POST /api/flags/set': (b, ctx) => setFlag(state, { flag: b.flag, env: b.env, enabled: b.enabled, value: b.value }, { ...ctx, reason: b.reason, force: b.force === true }),
    'GET /api/audit': (_, __, q) => auditLog({ flag: q.get('flag') || undefined }),
    'POST /api/revert': (b, ctx) => revert(state, String(b.id), { ...ctx, reason: b.reason }),
    'GET /api/promote': (_, __, q) => promotePlan(state, { from: q.get('from'), to: q.get('to') }),
    'POST /api/promote': (b, ctx) => promote(state, { from: b.from, to: b.to, flags: Array.isArray(b.flags) ? b.flags.map(String) : undefined }, { ...ctx, reason: b.reason }),
    'GET /api/schedules': () => listSchedules().slice(-200).reverse(),
    'POST /api/schedules': (b, ctx) => addSchedule(state, { flag: b.flag, env: b.env, enabled: b.enabled, value: b.value, at: b.at }, { ...ctx, reason: b.reason }),
    'POST /api/schedules/cancel': (b, ctx) => cancelSchedule(String(b.id), ctx.actor),
    'GET /api/approvals': () => listChanges().slice(-100).reverse().map((c) => ({ ...c, describe: describeParams(c), production: isProduction(state, c) })),
    'POST /api/approvals/approve': (b) => {
      const shown = listChanges().find((c) => c.id === b.id && c.createdAt === b.createdAt);
      if (!shown) throw new Error('That request changed or no longer exists; reload');
      if (b.confirm !== shown.id) throw new Error('Type the change id to confirm');
      return approveChange(state, shown.id, shown);
    },
    'POST /api/approvals/reject': (b) => {
      const shown = listChanges().find((c) => c.id === b.id && c.createdAt === b.createdAt);
      if (!shown) throw new Error('That request changed or no longer exists; reload');
      return rejectChange(shown.id, String(b.note || '').slice(0, 300), shown);
    },
    'GET /api/explain': (_, __, q) => explainData(state, { identity: q.get('identity'), traits: q.get('traits') || undefined }),
  };

  const tokenBuf = Buffer.from(token);
  const authed = (req) => {
    const t = Buffer.from(String(req.headers['x-flagkit-token'] || ''));
    return t.length === tokenBuf.length && crypto.timingSafeEqual(t, tokenBuf);
  };
  const headers = (type) => ({
    'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });

  const server = http.createServer(async (req, res) => {
    const send = (code, data, type = 'application/json') => { res.writeHead(code, headers(type)); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
    try {
      if (!allowedHosts.has(String(req.headers.host))) return send(421, { error: 'wrong host' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const st = STATIC[url.pathname];
      if (st && req.method === 'GET') return send(200, fs.readFileSync(path.join(ROOT, st[0])), st[1]);
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(404, { error: 'not found' });
      if (!authed(req)) return send(401, { error: 'Open the panel with the link printed by `flagkit panel` (it carries the access token).' });
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(403, { error: 'cross-origin request refused' });
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(415, { error: 'JSON only' });
      }
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 65_536) return send(413, { error: 'too large' }); }
        body = raw ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'bad body' });
      }
      const actor = clean(String(req.headers['x-actor'] || '').slice(0, 80)).trim();
      if (req.method === 'POST' && !actor) return send(400, { error: 'Enter your name (top right) so changes are attributed' });
      send(200, await route(body, { actor, via: 'panel' }, url.searchParams));
    } catch (e) {
      send(400, { error: clean(e.message).slice(0, 400) });
    }
  });

  // The scheduler runs only once this panel is actually listening (a panel that lost its port runs nothing).
  let tick;
  server.on('listening', () => {
    tick = setInterval(() => runDueSchedules(state).then((ran) => {
      for (const s of ran) console.log(`  ⏰ schedule ${s.id}: ${s.flag} in ${s.env} → ${s.status} (${s.result})`);
    }).catch(() => {}), 15_000);
  });
  server.on('close', () => clearInterval(tick));
  return { server, token, url: `http://localhost:${port}/#t=${token}` };
}

export function runPanel(state, { port = 4100, codeRoot, tries = 0 } = {}) {
  const p = createPanel(state, { port, codeRoot });
  p.server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 10) { console.log(`  port ${port} is busy, trying ${port + 1}`); p.server.close(); runPanel(state, { port: port + 1, codeRoot, tries: tries + 1 }); return; }
    throw e;
  });
  p.server.listen(port, '127.0.0.1', () => {
    console.log(`✔ FlagKit admin panel: ${p.url}`);
    console.log('  Local only (127.0.0.1). The link carries a one-time access token; anyone with it can change flags.');
    console.log('  Scheduled changes run while this is open. Ctrl+C to stop.');
  });
  return p;
}
