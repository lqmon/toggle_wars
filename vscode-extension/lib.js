// Pure logic for the FlagKit VS Code extension (no `vscode` import, so it is unit-testable with node).
'use strict';

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (v) => String(v ?? '').replace(CONTROL, '');
// Markdown-safe text for hovers: no control chars, no markdown/HTML metacharacters, no command: links.
const md = (v) => clean(v).replace(/[\\`*_[\]<>|#!()]/g, (c) => `\\${c}`);
const valueOf = (v) => (v && typeof v === 'object' ? v.string_value ?? v.integer_value ?? v.boolean_value : v);
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

// Every string literal in the text whose content is a known flag name.
function findFlagRefs(text, names) {
  const out = [];
  const re = /(['"`])([A-Za-z0-9_.-]{1,100})\1/g;
  let m;
  while ((m = re.exec(text))) if (names.has(m[2])) out.push({ flag: m[2], start: m.index + 1, end: m.index + 1 + m[2].length, after: m.index + m[0].length });
  return out;
}

// SDK calls whose first argument is a flag name (same rules as `flagkit lint`). Generic method names only count
// on a receiver that names flags, so a form library's getValue('email') is never reported.
const CALL = /(?:\b(hasFeature|isFeatureEnabled|is_feature_enabled|getFeatureValue|get_feature_value|useFlag|useVariant|getVariant|getExperimentFlag|useExperiment|feature_enabled|GetFeatureValue|IsFeatureEnabled)|\b(?:[Ff]lag\w*|FLAGS?)\s*\.\s*(getValue|getFlag|get|variant|isOn|value))\s*\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?(['"`])([^'"`\s]{0,100})\3/g;
function findFlagCalls(text) {
  const out = [];
  CALL.lastIndex = 0;
  let m;
  while ((m = CALL.exec(text))) {
    const start = m.index + m[0].length - 1 - m[4].length;
    out.push({ name: m[4], call: m[1] || m[2], start, end: start + m[4].length });
  }
  return out;
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1)); diag = t; }
  }
  return prev[b.length];
}
function suggest(name, names) {
  let best = null, dist = Infinity;
  for (const k of names) { const d = levenshtein(name.toLowerCase(), k.toLowerCase()); if (d < dist) { dist = d; best = k; } }
  return best && dist <= Math.max(2, Math.floor(name.length / 4)) ? best : null;
}

// stale: identical in every environment, no overrides, no experiment, untouched for staleDays.
function lifecycleOf(f, { staleDays = 14, now = Date.now() } = {}) {
  if (f.experiments.some((x) => x.status === 'running')) return { status: 'experiment' };
  const same = f.envs.length > 0 && new Set(f.envs.map((e) => `${e.enabled}|${e.value}|${e.weights}`)).size === 1;
  const days = Math.floor((now - new Date(f.lastModified || 0).getTime()) / 86400000);
  if (same && !f.segmentOverrides && !f.identityOverrides && days >= staleDays) {
    const e = f.envs[0];
    return { status: 'stale', days, enabled: e.enabled, value: e.value, advice: `${clean(f.name)} is ${e.enabled ? 'ON' : 'OFF'}${e.value != null && e.value !== '' ? ` = ${JSON.stringify(clean(e.value))}` : ''} in every environment and unchanged for ${days} days. Hard-code that and delete the flag.` };
  }
  return { status: 'live' };
}

class Client {
  constructor({ apiUrl, key, fetchImpl = fetch }) {
    this.base = String(apiUrl || 'https://api.flagsmith.com').replace(/\/+$/, '').replace(/\/api\/v1$/, '');
    this.key = key;
    this.fetch = fetchImpl;
  }
  async get(p) {
    const res = await this.fetch(`${this.base}/api/v1/${p}`, { headers: { Authorization: `Api-Key ${this.key}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Flagsmith ${res.status} for ${p.split('?')[0]}`);
    return res.json();
  }
  async patch(p, body) {
    const res = await this.fetch(`${this.base}/api/v1/${p}`, { method: 'PATCH', headers: { Authorization: `Api-Key ${this.key}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Flagsmith ${res.status} for ${p.split('?')[0]}`);
    return res.json();
  }
  async list(p) {
    const out = [];
    let next = p;
    while (next) {
      const d = await this.get(next);
      if (Array.isArray(d)) return d;
      out.push(...(d.results || []));
      next = d.next ? d.next.replace(/^.*\/api\/v1\//, '') : null;
    }
    return out;
  }
}

// Snapshot of every flag in a project: per-environment default state + any experiment on it.
async function loadProject(client, projectId) {
  const [features, envs] = await Promise.all([
    client.list(`projects/${projectId}/features/`),
    client.list(`projects/${projectId}/environments/`),
  ]);
  const flags = {};
  const optKey = {};
  await Promise.all(features.filter((f) => f.type === 'MULTIVARIATE').map(async (f) => {
    for (const o of await client.list(`projects/${projectId}/features/${f.id}/mv-options/`)) optKey[o.id] = o.key || o.string_value;
  }));
  for (const f of features.filter((x) => !x.is_archived)) {
    flags[f.name] = { name: f.name, id: f.id, description: f.description || '', type: f.type, envs: [], experiments: [],
      lastModified: f.last_modified_in_any_environment || f.created_date, segmentOverrides: f.num_segment_overrides || 0, identityOverrides: f.num_identity_overrides || 0,
      variants: (f.multivariate_options || []).map((o) => o.key || o.string_value) };
  }
  const byId = Object.fromEntries(Object.values(flags).map((f) => [f.id, f]));
  await Promise.all(envs.map(async (env) => {
    const states = await client.list(`features/featurestates/?environment=${env.id}`);
    for (const s of states) {
      const f = byId[s.feature];
      if (!f || s.feature_segment != null || s.identity != null) continue;
      const weights = (s.multivariate_feature_state_values || []).filter((m) => m.percentage_allocation > 0).map((m) => `${optKey[m.multivariate_feature_option]}=${m.percentage_allocation}%`);
      f.envs.push({ name: env.name, key: env.api_key, stateId: s.id, enabled: s.enabled, value: valueOf(s.feature_state_value), weights });
    }
    let exps = [];
    try { exps = await client.list(`environments/${env.api_key}/experiments/`); } catch { /* experimentation off here */ }
    for (const x of exps.filter((e) => e.status === 'running' || e.status === 'created')) {
      const name = typeof x.feature === 'object' ? x.feature?.name : Object.values(flags).find((f) => f.id === x.feature)?.name;
      const f = flags[name];
      if (!f) continue;
      const exp = { id: x.id, name: x.name, status: x.status, env: env.name, envKey: env.api_key, best: null, users: 0 };
      if (x.status === 'running') {
        try {
          const r = await client.get(`environments/${env.api_key}/experiments/${x.id}/results/`);
          const m = r?.results?.payload?.metrics?.[0];
          exp.users = Object.values(m?.variants || {}).reduce((a, v) => a + (v.n || 0), 0);
          const best = Object.entries(m?.inference || {}).filter(([, v]) => v).sort((a, b) => b[1].chance_to_win - a[1].chance_to_win)[0];
          if (best) exp.best = { key: best[0], win: best[1].chance_to_win, lift: best[1].lift };
        } catch { /* no results yet */ }
      }
      f.experiments.push(exp);
    }
  }));
  const order = Object.fromEntries(envs.map((e, i) => [e.name, i]));
  for (const f of Object.values(flags)) f.envs.sort((a, b) => order[a.name] - order[b.name]);
  return { flags, environments: envs.map((e) => ({ name: e.name, key: e.api_key })), loadedAt: Date.now() };
}

const abbr = (n) => (/^dev/i.test(n) ? 'dev' : /^stag/i.test(n) ? 'stg' : /^prod/i.test(n) ? 'prod' : clean(n).slice(0, 6));
const short = (e) => `${e.enabled ? '●' : '○'} ${abbr(e.name)}${e.enabled ? `:${clean(e.weights.length ? e.weights.join(',') : e.value).slice(0, 24)}` : ''}`;

function inlineText(f) {
  const exp = f.experiments.find((x) => x.status === 'running');
  const bits = f.envs.map(short);
  if (exp) bits.push(`🧪 #${exp.id}${exp.best ? ` ${clean(exp.best.key)} ${pct(exp.best.win)}` : ` ${exp.users} users`}`);
  return `  ${bits.join('  ')}`;
}

function hoverMarkdown(f, dashboard, projectId) {
  const lines = [`**🚩 ${md(f.name)}**${f.description ? ` · ${md(f.description).slice(0, 140)}` : ''}`, '', '| environment | state | value |', '|---|---|---|'];
  for (const e of f.envs) lines.push(`| ${md(e.name)} | ${e.enabled ? '🟢 on' : '⚪ off'} | ${md(e.value ?? '')}${e.weights.length ? ` (${md(e.weights.join(', '))})` : ''} |`);
  const drift = new Set(f.envs.map((e) => `${e.enabled}:${e.value}:${e.weights}`)).size > 1;
  if (drift) lines.push('', '≠ environments differ');
  for (const x of f.experiments) {
    lines.push('', `🧪 **Experiment #${x.id}** in ${md(x.env)}: ${md(x.name)} (${md(x.status)})`);
    if (x.best) lines.push(`${md(x.best.key)}: **${pct(x.best.win)}** chance to beat control, lift ${pct(x.best.lift)}, ${x.users} users${x.best.win >= 0.95 ? ' · meets the ship bar' : ''}`);
    else if (x.status === 'running') lines.push(`${x.users} users so far, no result yet`);
    if (dashboard && projectId) lines.push(`[Open in Flagsmith](${dashboard}/project/${encodeURIComponent(projectId)}/environment/${encodeURIComponent(x.envKey)}/experiments/${x.id})`);
  }
  return lines.join('\n');
}

const dashboardOf = (apiUrl) => (/^https:\/\/(edge\.)?api\.flagsmith\.com/.test(apiUrl || '') ? 'https://app.flagsmith.com' : String(apiUrl || '').replace(/\/+$/, '').replace(/\/api\/v1$/, ''));

module.exports = { findFlagRefs, findFlagCalls, suggest, levenshtein, lifecycleOf, Client, loadProject, inlineText, hoverMarkdown, dashboardOf, clean, md, abbr };
