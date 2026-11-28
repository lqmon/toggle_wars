// Flag intelligence shared by every surface (lint, codegen, panel, TUI, VS Code):
//   - load every flag with its state in every environment and the experiments running on it
//   - find where code uses flags, and calls that name a flag that does not exist (typos)
//   - classify each flag's lifecycle: live / experiment / stale (same everywhere, untouched) / unused
// Pure functions are exported separately so they can be unit tested without a server.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { clean } from './sanitize.js';

export const valueOf = (v) => (v && typeof v === 'object' ? v.string_value ?? v.integer_value ?? v.boolean_value ?? null : v ?? null);
const DAY = 86_400_000;

// ── Server side ─────────────────────────────────────────────────────────────────────────────────────
export async function loadFlags(api, { projectId, environments }) {
  const features = (await api.list(`projects/${projectId}/features/`)).filter((f) => !f.is_archived);
  const states = {};
  const experiments = [];
  await Promise.all(environments.map(async (env) => {
    for (const s of await api.list(`features/featurestates/?environment=${env.id}`)) {
      if (s.feature_segment == null && s.identity == null) states[`${s.feature}:${env.id}`] = s;
    }
    try {
      for (const x of await api.list(`environments/${env.api_key}/experiments/`)) {
        if (x.status === 'running' || x.status === 'paused') experiments.push({ id: x.id, name: clean(x.name), status: x.status, env: env.name, feature: typeof x.feature === 'object' ? x.feature?.id : x.feature });
      }
    } catch { /* experimentation off in this environment */ }
  }));
  return features.map((f) => ({
    id: f.id,
    name: clean(f.name),
    type: f.type,
    description: clean(f.description || ''),
    tags: f.tags || [],
    variants: (f.multivariate_options || []).map((o) => clean(o.key || o.string_value)),
    segmentOverrides: f.num_segment_overrides ?? 0,
    identityOverrides: f.num_identity_overrides ?? 0,
    created: f.created_date,
    lastModified: f.last_modified_in_any_environment || f.created_date,
    experiments: experiments.filter((x) => x.feature === f.id),
    envs: Object.fromEntries(environments.map((e) => {
      const s = states[`${f.id}:${e.id}`];
      return [e.name, s ? { id: s.id, enabled: !!s.enabled, value: valueOf(s.feature_state_value), updated: s.updated_at, envKey: e.api_key, envId: e.id } : null];
    })),
  }));
}

// ── Lifecycle ───────────────────────────────────────────────────────────────────────────────────────
// stale: identical in every environment, no overrides, no experiment, untouched for `staleDays`.
//        The flag does nothing any more: inline its value and delete it.
// unused: no reference anywhere in the code that was scanned. Safe to archive.
export function lifecycle(flag, { refs, staleDays = 14, now = Date.now() } = {}) {
  const cells = Object.values(flag.envs).filter(Boolean);
  const same = cells.length > 0 && new Set(cells.map((c) => `${c.enabled}|${c.value ?? ''}`)).size === 1;
  const ageDays = (now - new Date(flag.lastModified).getTime()) / DAY;
  const out = { same, ageDays: Math.floor(ageDays), status: 'live', advice: '' };
  if (flag.experiments.length) { out.status = 'experiment'; out.advice = `in experiment #${flag.experiments.map((x) => x.id).join(', #')}: changing it corrupts the result`; }
  else if (refs && refs.length === 0) { out.status = 'unused'; out.advice = 'no code references this flag: archive it'; }
  else if (same && !flag.segmentOverrides && !flag.identityOverrides && ageDays >= staleDays) {
    const c = cells[0];
    out.status = 'stale';
    out.advice = `${c.enabled ? 'ON' : 'OFF'}${c.value != null && c.value !== '' ? ` = ${JSON.stringify(c.value)}` : ''} everywhere for ${Math.floor(ageDays)} days: hard-code it and delete the flag`;
  }
  return out;
}

// Which environments disagree, and how (for the drift marker and for promote).
export function drift(flag) {
  const sigs = Object.entries(flag.envs).filter(([, c]) => c).map(([e, c]) => [e, `${c.enabled ? 'on' : 'off'}${c.value != null && c.value !== '' ? ` ${c.value}` : ''}`]);
  return new Set(sigs.map(([, s]) => s)).size > 1 ? Object.fromEntries(sigs) : null;
}

// ── Code side ───────────────────────────────────────────────────────────────────────────────────────
// SDK calls whose first argument is a flag name, across the Flagsmith SDKs and FlagKit's own helpers.
// Generic names (getValue, getFlag) only count on a receiver that names flags (flagsmith.getValue, flags.getFlag),
// so a form library's getValue('email') is not reported as a missing flag.
const CALL = /(?:\b(hasFeature|isFeatureEnabled|is_feature_enabled|getFeatureValue|get_feature_value|useFlag|useVariant|getVariant|feature_enabled|GetFeatureValue|IsFeatureEnabled)|\b(?:[Ff]lag\w*|FLAGS?)\s*\.\s*(getValue|getFlag|get|variant|isOn|value))\s*\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?['"`]([^'"`\s]{1,100})['"`]/g;
const LIST = /\b(useFlags|getFlags)\s*\(\s*\[([^\]]{0,800})\]/g;
const STR = /['"`]([^'"`\s]{1,100})['"`]/g;

// Returns { refs: [{name, line, col, call}], calls: [{name, line, col}] } for one file's text.
// refs: any string literal that equals a known flag name. calls: names passed to an SDK call (known or not).
export function scanText(text, known) {
  const names = known instanceof Set ? known : new Set(known);
  const refs = [];
  const calls = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const pos = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: idx - lineStarts[lo] + 1 };
  };
  for (const m of text.matchAll(STR)) if (names.has(m[1])) refs.push({ name: m[1], ...pos(m.index + 1) });
  for (const m of text.matchAll(CALL)) {
    const at = m.index + m[0].lastIndexOf(m[3]);
    calls.push({ name: m[3], call: m[1] || m[2], ...pos(at) });
  }
  for (const m of text.matchAll(LIST)) {
    for (const s of m[2].matchAll(STR)) calls.push({ name: s[1], call: m[1], ...pos(m.index + m[0].indexOf(m[2]) + s.index + 1) });
  }
  return { refs, calls };
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function suggest(name, known) {
  let best = null, dist = Infinity;
  for (const k of known) {
    const d = levenshtein(name.toLowerCase(), k.toLowerCase());
    if (d < dist) { dist = d; best = k; }
  }
  return best && dist <= Math.max(2, Math.floor(name.length / 4)) ? best : null;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.flagkit', 'vendor', '__pycache__', '.venv']);
const CODE_EXT = /\.(m?[jt]sx?|cjs|vue|svelte|py|go|rb|java|kt|swift|cs|php|html|rs|dart)$/i;

export function listCodeFiles(root) {
  const git = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let files;
  if (git.status === 0) files = git.stdout.split('\n').filter(Boolean);
  else {
    files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel); }
        else files.push(rel);
      }
    };
    walk('.');
  }
  return files.filter((f) => CODE_EXT.test(f) && !f.split(/[\\/]/).some((p) => SKIP_DIRS.has(p)) && !/\.generated\.|\.min\./.test(f));
}

export function scanCode(root, knownNames) {
  const known = new Set(knownNames);
  const refs = Object.fromEntries([...known].map((n) => [n, []]));
  const unknown = [];
  for (const file of listCodeFiles(root)) {
    let text;
    try {
      const st = fs.statSync(path.join(root, file));
      if (st.size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch { continue; }
    const r = scanText(text, known);
    for (const x of r.refs) refs[x.name].push({ file, line: x.line, col: x.col });
    for (const c of r.calls) if (!known.has(c.name)) unknown.push({ file, line: c.line, col: c.col, name: c.name, call: c.call, suggestion: suggest(c.name, known) });
  }
  return { refs, unknown };
}

// ── Lint (CI) ───────────────────────────────────────────────────────────────────────────────────────
// error   unknown-flag  code asks for a flag that does not exist (a typo ships the default to everyone)
// warning stale-flag    the flag no longer varies: remove it
// warning unused-flag   no code reads it: archive it
export function lint(flags, scan, { staleDays = 14, now = Date.now() } = {}) {
  const findings = [];
  for (const u of scan.unknown) {
    findings.push({ level: 'error', rule: 'unknown-flag', flag: u.name, file: u.file, line: u.line, col: u.col,
      message: `"${clean(u.name)}" is not a flag in this project${u.suggestion ? `. Did you mean "${u.suggestion}"?` : ''} Your code will silently get the default.` });
  }
  for (const f of flags) {
    const refs = scan.refs[f.name] || [];
    const lc = lifecycle(f, { refs, staleDays, now });
    if (lc.status === 'stale') findings.push({ level: 'warning', rule: 'stale-flag', flag: f.name, file: refs[0]?.file, line: refs[0]?.line, message: `${f.name}: ${lc.advice} (${refs.length} reference${refs.length === 1 ? '' : 's'})` });
    if (lc.status === 'unused') findings.push({ level: 'warning', rule: 'unused-flag', flag: f.name, message: `${f.name}: ${lc.advice}` });
  }
  return findings;
}

export function formatLint(findings, { format = 'text' } = {}) {
  if (format === 'json') return JSON.stringify(findings, null, 2);
  if (format === 'github') {
    // GitHub workflow commands: values are escaped so a flag name can never inject another command.
    const esc = (s) => String(s ?? '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
    return findings.map((f) => `::${f.level} ${f.file ? `file=${esc(f.file)},line=${f.line || 1},` : ''}title=${esc(f.rule)}::${String(f.message).replace(/%/g, '%25').replace(/\r?\n/g, ' ')}`).join('\n');
  }
  if (!findings.length) return '✔ No flag problems found.';
  const icon = { error: '✖', warning: '⚠' };
  return findings.map((f) => `${icon[f.level]} ${f.rule.padEnd(13)} ${f.file ? `${f.file}:${f.line}  ` : ''}${f.message}`).join('\n');
}
