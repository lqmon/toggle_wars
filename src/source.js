// Where read-only commands (report, watch, explain) get their data from:
//   1. --admin-key / FLAGSMITH_ADMIN_KEY + --api-url  → Admin API directly (works for Cloud and self-hosted, and in CI)
//   2. FlagKit state (flagkit up)                      → the local stack's master key
//   3. the official Flagsmith CLI (`flagsmith api`)    → whatever it is logged in to (e.g. `flagsmith login` for Cloud)
import { spawnSync } from 'node:child_process';
import { FlagsmithAdmin } from './api.js';
import { loadState } from './config.js';

const CLOUD = 'https://api.flagsmith.com';
const KEY = /^[A-Za-z0-9._:-]{1,200}$/;

export function resolveSource({ apiUrl, adminKey, envKey, envName = 'Development' } = {}) {
  const st = loadState();
  if (adminKey) {
    const base = apiUrl || process.env.FLAGSMITH_API_URL || CLOUD;
    if (!envKey) throw new Error('--env-key is required with an admin key');
    return { kind: 'admin', apiUrl: base, envKey, api: new FlagsmithAdmin({ apiUrl: base, masterKey: adminKey }), dashboard: dashboardOf(base) };
  }
  if (st && !(envKey && !st.environments.some((e) => e.api_key === envKey))) {
    const env = envKey ? st.environments.find((e) => e.api_key === envKey)
      : st.environments.find((e) => e.name.toLowerCase() === String(envName).toLowerCase());
    if (!env) throw new Error(`No environment "${envName}" in the local stack. Have: ${st.environments.map((e) => e.name).join(', ')}`);
    return { kind: 'state', apiUrl: st.apiUrl, envKey: env.api_key, envName: env.name, projectId: st.project.id, api: new FlagsmithAdmin({ apiUrl: st.apiUrl, masterKey: st.masterKey }), dashboard: st.apiUrl, state: st };
  }
  const key = envKey || process.env.FLAGSMITH_ENVIRONMENT;
  if (!key) throw new Error('No data source: run `flagkit up`, pass --env-key with `flagsmith login` done, or --admin-key + --env-key');
  return { kind: 'cli', apiUrl: process.env.FLAGSMITH_API_URL || CLOUD, envKey: key, projectId: process.env.FLAGSMITH_PROJECT, api: cliApi(), dashboard: dashboardOf(process.env.FLAGSMITH_API_URL || CLOUD) };
}

const dashboardOf = (apiUrl) => (new URL(apiUrl).origin === CLOUD ? 'https://app.flagsmith.com' : apiUrl.replace(/\/+$/, ''));

// Same get/post/list surface as FlagsmithAdmin, through the official CLI (no keys ever pass through us).
function cliApi() {
  const call = (method, p, body) => {
    const args = ['api', `api/v1/${p.replace(/^\/+/, '')}`];
    if (method !== 'GET') args.push('-X', method, '--yes');
    if (body !== undefined) args.push('--input', '-');
    const r = spawnSync('flagsmith', args, { encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), env: { ...process.env, FLAGSMITH_NO_INPUT: '1' } });
    if (r.error) throw new Error(`Could not run the Flagsmith CLI (${r.error.code}). Install it: brew install Flagsmith/tap/flagsmith`);
    if (r.status !== 0) {
      const err = new Error(`${method} ${p} failed: ${(r.stderr || r.stdout).trim().split('\n')[0].slice(0, 300)}`);
      err.status = /429/.test(r.stderr) ? 429 : /404/.test(r.stderr) ? 404 : undefined;
      throw err;
    }
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  return {
    get: async (p) => call('GET', p),
    post: async (p, b = {}) => call('POST', p, b),
    patch: async (p, b) => call('PATCH', p, b),
    async list(p) {
      const d = call('GET', p);
      return Array.isArray(d) ? d : d?.results || [];
    },
  };
}

export const validKey = (k) => KEY.test(String(k || ''));
