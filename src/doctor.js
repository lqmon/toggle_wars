// flagkit doctor — diagnose ANY self-hosted Flagsmith for the problems that silently break
// experimentation, the CLI, SDKs, or security. Works with zero credentials (public probes),
// gets deeper with an environment key and/or an Admin API key. Exit code 1 on failures (CI-friendly).
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline/promises';
import { FlagsmithAdmin } from './api.js';
import { cliKeyVar } from './config.js';

const ICON = { pass: '✔', warn: '⚠', fail: '✖', skip: '·' };
const COLOR = { pass: 32, warn: 33, fail: 31, skip: 90 };
const paint = (s, c) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);

const FLAGSMITH_DB = { source: 'flagsmith_database' };
const isCloud = (u) => /(^|\.)flagsmith\.com$/.test(new URL(u).hostname);
const isLoopback = (h) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(h);

async function probe(url, init = {}, timeoutMs = 4000) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, error: e.cause?.code || e.name };
  }
}

// fetch() refuses to override Host, so the spoof probe uses node:http directly.
function probeWithHost(url, hostHeader) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request(u, { headers: { Host: hostHeader }, timeout: 4000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

function dockerEnv() {
  const ps = spawnSync('docker', ['ps', '--format', '{{.ID}} {{.Image}} {{.Ports}}'], { encoding: 'utf8' });
  if (ps.status !== 0) return null;
  const rows = ps.stdout.trim().split('\n').filter((l) => /flagsmith\/flagsmith/.test(l));
  return rows.map((row) => {
    const [id] = row.split(' ');
    const insp = spawnSync('docker', ['inspect', '--format', '{{json .Config.Env}}', id], { encoding: 'utf8' });
    const env = Object.fromEntries((JSON.parse(insp.stdout || '[]')).map((kv) => [kv.split('=')[0], kv.slice(kv.indexOf('=') + 1)]));
    return { id, ports: row.split(' ').slice(2).join(' '), env };
  });
}

export async function runDoctor({ apiUrl, envKey, adminKey, fix = false, yes = false, json = false } = {}) {
  apiUrl = (apiUrl || process.env.FLAGSMITH_API_URL || 'http://localhost:8000').replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  envKey ||= process.env.FLAGSMITH_ENVIRONMENT || process.env.FLAGSMITH_ENVIRONMENT_KEY;
  adminKey ||= process.env[cliKeyVar(apiUrl)] || process.env.FLAGSMITH_API_KEY;
  const host = new URL(apiUrl).hostname;
  const results = [];
  const fixes = [];
  const add = (section, status, title, detail = '', fixText = '', apply = null) => {
    results.push({ section, status, title, detail, fix: fixText });
    if (apply && status !== 'pass') fixes.push({ title, apply });
  };

  // ── Reachability ─────────────────────────────────────────────────────────
  const health = await probe(`${apiUrl}/health`);
  if (health.status !== 200) {
    add('Reachability', 'fail', `Flagsmith not reachable at ${apiUrl}`, health.error || `HTTP ${health.status}`, 'Start it (`flagkit up`) or pass --api-url');
    return report(results, { json, apiUrl });
  }
  add('Reachability', 'pass', `API healthy at ${apiUrl}`);
  if (isCloud(apiUrl)) add('Reachability', 'skip', 'Flagsmith Cloud detected: self-hosting checks skipped');

  // ── Security (public probes, no credentials needed) ──────────────────────
  if (!isCloud(apiUrl)) {
    const signup = await probe(`${apiUrl}/api/v1/auth/users/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (signup.status === 400) add('Security', 'warn', 'Open sign-up: anyone who can reach this URL can create an account', '', 'Set PREVENT_SIGNUP=true on the API (flagkit does this after bootstrap)');
    else add('Security', 'pass', 'Sign-up is closed');

    const spoof = { status: await probeWithHost(`${apiUrl}/api/v1/organisations/`, 'evil.example') };
    if (spoof.status === 400) add('Security', 'pass', 'Host header is validated (DJANGO_ALLOWED_HOSTS is restricted)');
    else add('Security', 'warn', "DJANGO_ALLOWED_HOSTS accepts any Host header ('*')", `spoofed Host got HTTP ${spoof.status}`, 'Set DJANGO_ALLOWED_HOSTS to your real hostnames');

    if (isLoopback(host)) {
      const port = new URL(apiUrl).port || '80';
      const exposed = [];
      for (const ip of lanAddresses()) {
        for (const p of [port, '8001']) {
          const r = await probe(`http://${ip}:${p}/health`, {}, 1500);
          if (r.status === 200) exposed.push(`${ip}:${p}`);
        }
      }
      if (exposed.length) add('Security', 'fail', `Admin API is reachable from your network: ${exposed.join(', ')}`, 'You think it is local, but anyone on this network can reach the dashboard', "Bind the port to loopback in compose: '127.0.0.1:8000:8000' and drop the task-processor port");
      else add('Security', 'pass', 'Not reachable from your LAN addresses (loopback only)');
    }

    const containers = dockerEnv();
    if (containers?.length) {
      const weak = new Set();
      for (const c of containers) {
        if (['secret', 'changeme', ''].includes(c.env.DJANGO_SECRET_KEY ?? 'x')) weak.add('DJANGO_SECRET_KEY');
        if (c.env.WAREHOUSE_CREDENTIALS_SECRET === 'secret') weak.add('WAREHOUSE_CREDENTIALS_SECRET');
        if (/:password@/.test(c.env.DATABASE_URL || '')) weak.add('database password');
      }
      if (weak.size) add('Security', 'fail', `Default secrets in running containers: ${[...weak].join(', ')}`, 'The stock docker-compose.yml ships these; with them, session tokens can be forged', 'Generate random values (flagkit keeps them in .flagkit/stack.env)');
      else add('Security', 'pass', `Container secrets are not defaults (${containers.length} Flagsmith containers checked)`);
      const exp = containers.some((c) => c.env.EXPERIMENTATION_ENABLED === 'true');
      add('Experimentation', exp ? 'pass' : 'fail', exp ? 'EXPERIMENTATION_ENABLED=true on the API' : 'EXPERIMENTATION_ENABLED is not set: the Warehouse tab and experiments are hidden', '', exp ? '' : "Add EXPERIMENTATION_ENABLED: 'true' to the API environment and restart");
    }
  }

  // ── SDK & events (environment key) ───────────────────────────────────────
  if (envKey) {
    const flags = await probe(`${apiUrl}/api/v1/flags/`, { headers: { 'X-Environment-Key': envKey } });
    if (flags.status === 200) add('SDK', 'pass', `SDK flags endpoint works (${Array.isArray(flags.body) ? flags.body.length : '?'} flags)`, `SDK apiUrl: ${apiUrl}/api/v1/`);
    else add('SDK', 'fail', `SDK flags endpoint returned HTTP ${flags.status} for this environment key`, '', 'Use the client-side environment key from Environment Settings');

    if (!isCloud(apiUrl)) {
      const ev = await probe(`${apiUrl}/api/v1/events/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Environment-Key': envKey }, body: '{"events":[]}' });
      if (ev.status === 404) {
        add('Experimentation', 'fail', 'Events are being DROPPED: this environment does not store SDK events',
          'Every exposure and conversion your SDKs send gets a 404 and is discarded silently. Experiments will show no data.',
          `Warehouse must be postgres + {"source":"flagsmith_database"} (Environment Settings → Warehouse → Flagsmith database)${adminKey ? ' — `flagkit doctor --fix` can do this' : ''}`);
      } else if (ev.status === 400 || ev.status === 202) {
        add('Experimentation', 'pass', 'Events endpoint accepts SDK events', `SDK eventsApiUrl: ${apiUrl}/api/  (the SDK appends v1/events)`);
      } else add('Experimentation', 'warn', `Events endpoint returned HTTP ${ev.status}`);
    }
  } else add('SDK', 'skip', 'No environment key: SDK and events checks skipped', '', 'Pass --env-key or set FLAGSMITH_ENVIRONMENT');

  // ── CLI configuration (local env vars) ───────────────────────────────────
  const scoped = cliKeyVar(apiUrl);
  if (!isCloud(apiUrl)) {
    if (process.env.FLAGSMITH_API_KEY && !process.env[scoped]) {
      add('CLI', 'fail', 'FLAGSMITH_API_KEY is set, but the Flagsmith CLI ignores it for self-hosted hosts', '', `export ${scoped}=$FLAGSMITH_API_KEY && unset FLAGSMITH_API_KEY`);
    } else if (process.env[scoped]) add('CLI', 'pass', `CLI credential is host-scoped (${scoped})`);
    const sdkUrl = process.env.FLAGSMITH_SDK_API_URL;
    if (sdkUrl && /\/api\/v1\/?$/.test(sdkUrl)) add('CLI', 'fail', `FLAGSMITH_SDK_API_URL=${sdkUrl} makes \`flagsmith eval\` fail with 405`, '', `export FLAGSMITH_SDK_API_URL=${apiUrl}`);
    else if (sdkUrl) add('CLI', 'pass', 'FLAGSMITH_SDK_API_URL points at the host root');
    else add('CLI', 'warn', '`flagsmith eval` defaults to Flagsmith Cloud', '', `export FLAGSMITH_SDK_API_URL=${apiUrl}`);
  }

  // ── Deep checks with an Admin API key ────────────────────────────────────
  if (adminKey) {
    const api = new FlagsmithAdmin({ apiUrl, masterKey: adminKey });
    let projects = [];
    try { projects = await api.list('projects/'); } catch (e) {
      add('Admin', 'fail', 'Admin API key rejected', e.message.slice(0, 120));
    }
    for (const project of projects) {
      const envs = await api.list(`environments/?project=${project.id}`);
      for (const env of envs) {
        const where = `${project.name} / ${env.name}`;
        if (env.allow_client_traits !== false) {
          add('Admin', 'warn', `${where}: client-side traits are writable by anyone holding the public key`, '', 'PATCH allow_client_traits=false (if you do not set traits from the browser)',
            () => api.patch(`environments/${env.api_key}/`, { allow_client_traits: false }));
        }
        if (isCloud(apiUrl)) continue;
        let conns = [];
        try { conns = await api.list(`environments/${env.api_key}/warehouse-connections/`); } catch { continue; }
        const good = conns.find((c) => c.warehouse_type === 'postgres' && c.config?.source === FLAGSMITH_DB.source);
        const other = conns.find((c) => c !== good);
        if (!conns.length) {
          add('Experimentation', 'warn', `${where}: no warehouse, so experiments cannot be created`, '', 'Connect the Flagsmith database warehouse',
            () => api.post(`environments/${env.api_key}/warehouse-connections/`, { warehouse_type: 'postgres', name: 'Flagsmith database', config: FLAGSMITH_DB }));
        } else if (!good && other?.warehouse_type === 'flagsmith') {
          add('Experimentation', 'fail', `${where}: warehouse type "flagsmith" is the Cloud-only managed warehouse; self-hosted events get 404`, '', 'Replace it with postgres + {"source":"flagsmith_database"}',
            async () => {
              await api.del(`environments/${env.api_key}/warehouse-connections/${other.id}/`);
              await api.post(`environments/${env.api_key}/warehouse-connections/`, { warehouse_type: 'postgres', name: 'Flagsmith database', config: FLAGSMITH_DB });
            });
        } else if (good) {
          add('Experimentation', good.status === 'connected' ? 'pass' : 'warn', `${where}: warehouse ${good.status}${good.total_events_received != null ? `, ${good.total_events_received} events received` : ''}`, '', good.status === 'connected' ? '' : 'It connects on the first SDK event');
        }
        let exps = [];
        try { exps = await api.list(`environments/${env.api_key}/experiments/`); } catch { /* none */ }
        for (const x of exps.filter((e) => e.status === 'running')) {
          let r = null;
          try { r = await api.get(`environments/${env.api_key}/experiments/${x.id}/results/`); } catch { /* not computed */ }
          const p = r?.results?.payload;
          const n = p ? Object.values(p.metrics?.[0]?.variants || {}).reduce((a, v) => a + (v.n || 0), 0) : 0;
          if (!p) add('Experimentation', 'warn', `${where}: experiment #${x.id} "${x.name}" running, results not computed yet`, '', 'Refresh results in the dashboard (or `flagkit experiment results`)');
          else if (p.srm_p_value != null && p.srm_p_value < 0.01) add('Experimentation', 'fail', `${where}: experiment #${x.id} has a sample ratio mismatch`, `p=${p.srm_p_value.toExponential(1)}`, 'Traffic is not splitting as configured: check caching / identity handling before trusting results');
          else add('Experimentation', n ? 'pass' : 'warn', `${where}: experiment #${x.id} "${x.name}" running, ${n} users in last results`, '', n ? '' : 'No exposures yet: is getExperimentFlag() called with an identified user?');
        }
      }
    }
  } else add('Admin', 'skip', 'No Admin API key: warehouse, traits and experiment checks skipped', '', `Set ${scoped} (or source flagsmith.env)`);

  const code = report(results, { json, apiUrl });

  if (fix && fixes.length) {
    console.log(`\n${fixes.length} issue(s) can be fixed automatically:`);
    fixes.forEach((f, i) => console.log(`  ${i + 1}. ${f.title}`));
    let ok = yes;
    if (!ok && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      ok = /^y/i.test(await rl.question('Apply these changes? (y/N) '));
      rl.close();
    }
    if (!ok) { console.log('No changes made.'); return code; }
    for (const f of fixes) {
      try { await f.apply(); console.log(`  ✔ fixed: ${f.title}`); } catch (e) { console.log(`  ✖ ${f.title}: ${e.message.slice(0, 120)}`); }
    }
  } else if (fixes.length) console.log(`\nRun with --fix to repair ${fixes.length} issue(s) (asks before changing anything).`);
  return code;
}

function report(results, { json, apiUrl }) {
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  if (json) {
    console.log(JSON.stringify({ apiUrl, fails, warns, results }));
    return fails ? 1 : 0;
  }
  console.log(`\nflagkit doctor — ${apiUrl}\n`);
  const order = ['Reachability', 'Security', 'Experimentation', 'SDK', 'CLI', 'Admin'];
  let section = '';
  for (const r of [...results].sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section))) {
    if (r.section !== section) { section = r.section; console.log(paint(section.toUpperCase(), 1)); }
    console.log(`  ${paint(ICON[r.status], COLOR[r.status])} ${r.title}`);
    if (r.detail) console.log(paint(`      ${r.detail}`, 90));
    if (r.fix) console.log(`      ${paint('fix:', 36)} ${r.fix}`);
  }
  const summary = `${results.filter((r) => r.status === 'pass').length} passed, ${warns} warnings, ${fails} failures`;
  console.log(`\n${paint(summary, fails ? 31 : warns ? 33 : 32)}`);
  return fails ? 1 : 0;
}
