// Human-in-the-loop change queue.
// Agents (via the MCP server) can only PROPOSE changes. A change is applied only from a human-facing
// surface: the TUI's Approvals tab, or `flagkit approve <id>` in an interactive terminal.
// Everything an agent supplies is treated as untrusted: names are validated, free text may not contain
// control characters, and what the person is shown is built from the structured params, not agent prose.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR, writeSecure } from './config.js';
import { adminOf, envOf, createExperiment, completeExperiment, featureIdOf } from './experiment.js';
import { clean, hasControl } from './sanitize.js';

const FILE = path.join(STATE_DIR, 'approvals.json');
const NAME = /^[a-z0-9][a-z0-9_-]{0,99}$/;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function save(list) {
  writeSecure(FILE, JSON.stringify(list, null, 2));
}

export const listChanges = (status) => load().filter((c) => !status || c.status === status);
// If an id ever appears twice, refuse to pick one (defence in depth; ids are 48-bit and checked unique).
export function getChange(id) {
  const matches = load().filter((c) => c.id === id);
  if (matches.length > 1) throw new Error(`More than one change has id ${clean(id)}; refusing to guess which one you mean.`);
  return matches[0];
}

export const isProduction = (state, c) => /prod/i.test(envOf(state, c.params.environment).name);

// One line describing exactly what will be applied, built only from validated, structured params.
export function describeParams(c) {
  const p = c.params || {};
  const env = clean(p.environment);
  switch (c.kind) {
    case 'toggle_flag': return `toggle_flag    ${clean(p.flag)} -> ${p.enabled ? 'ON' : 'OFF'} in ${env}`;
    case 'set_flag_value': return `set_flag_value ${clean(p.flag)} = ${JSON.stringify(String(p.value ?? ''))} in ${env}`;
    case 'ship_winner': return `ship_winner    experiment #${Number(p.experiment_id)} -> ${clean(p.winner)} for 100% of ${env}`;
    case 'create_experiment': return `create_experiment on flag ${clean(p.flag)} in ${env}, ${Number(p.rollout ?? 100)}% traffic, variants ${(p.variants || []).map(clean).join(',')}, metric ${clean(p.event)}`;
    default: return `unknown change kind ${clean(c.kind)}`;
  }
}

async function findFeature(state, flag) {
  const api = adminOf(state);
  return (await api.list(`projects/${state.project.id}/features/?search=${encodeURIComponent(flag)}`)).find((x) => x.name === flag);
}

async function findFeatureState(state, flag, envName) {
  const api = adminOf(state);
  const env = envOf(state, envName);
  const f = await findFeature(state, flag);
  if (!f) throw new Error(`No flag "${clean(flag)}"`);
  const fs = (await api.list(`features/featurestates/?environment=${env.id}&feature=${f.id}`)).find((s) => s.feature_segment == null && s.identity == null);
  if (!fs) throw new Error(`No environment default for "${clean(flag)}" in ${env.name}`);
  return { api, env, feature: f, fs };
}
const valueOf = (v) => (v && typeof v === 'object' ? v.string_value ?? v.integer_value ?? v.boolean_value : v);

function validate(kind, p) {
  for (const [k, v] of Object.entries(p)) {
    if (hasControl(v) || (Array.isArray(v) && v.some(hasControl))) throw new Error(`Field "${k}" contains control characters`);
  }
  if (p.flag !== undefined && !NAME.test(p.flag)) throw new Error('Invalid flag name (lowercase, digits, _ and - only)');
  if (kind === 'create_experiment') {
    for (const n of [p.flag, p.event, ...(p.variants || [])]) if (!NAME.test(n || '')) throw new Error(`Invalid name "${clean(n)}" (lowercase, digits, _ and - only)`);
    if (!p.variants?.length) throw new Error('At least one variant key is required');
    if (!p.name || String(p.name).length > 120) throw new Error('An experiment name (≤120 characters) is required');
  }
}

// Validate and describe a proposed change (reads current state; never writes).
async function describe(state, kind, p) {
  validate(kind, p);
  const env = envOf(state, p.environment);
  let risk = /prod/i.test(env.name) ? 'high' : 'normal';
  switch (kind) {
    case 'toggle_flag': {
      const { fs } = await findFeatureState(state, p.flag, env.name);
      return { risk, summary: describeParams({ kind, params: p }), before: fs.enabled ? 'on' : 'off', after: p.enabled ? 'on' : 'off' };
    }
    case 'set_flag_value': {
      const { fs } = await findFeatureState(state, p.flag, env.name);
      return { risk, summary: describeParams({ kind, params: p }), before: clean(String(valueOf(fs.feature_state_value))), after: clean(String(p.value)) };
    }
    case 'ship_winner': {
      const api = adminOf(state);
      const exp = await api.get(`environments/${env.api_key}/experiments/${Number(p.experiment_id)}/`);
      if (exp.status !== 'running') throw new Error(`Experiment #${exp.id} is ${exp.status}, not running`);
      if (!['control', 'disable'].includes(p.winner)) {
        const opts = await api.list(`projects/${state.project.id}/features/${featureIdOf(exp)}/mv-options/`);
        if (!opts.some((o) => o.key === p.winner)) throw new Error(`"${clean(p.winner)}" is not a variant of experiment #${exp.id}`);
      }
      return { risk, summary: describeParams({ kind, params: p }), before: `experiment #${exp.id} "${clean(exp.name)}" running`, after: `everyone gets ${clean(p.winner)}` };
    }
    case 'create_experiment': {
      // Never let an approval start some other, pre-existing experiment that happens to share the name.
      const existing = (await adminOf(state).list(`environments/${env.api_key}/experiments/`)).find((e) => e.name === p.name);
      if (existing) throw new Error(`An experiment named "${clean(p.name)}" already exists in ${env.name} (#${existing.id}, ${existing.status}); choose another name`);
      const flagExists = !!(await findFeature(state, p.flag));
      // A new flag is created project-wide, i.e. in EVERY environment (disabled by default), so say so.
      if (!flagExists) risk = 'high';
      return {
        risk,
        summary: describeParams({ kind, params: p }),
        before: flagExists ? `flag ${clean(p.flag)} exists` : 'flag does not exist yet',
        after: `${flagExists ? '' : `creates flag ${clean(p.flag)} in ALL environments (off by default); `}starts experiment "${clean(p.name)}"`,
        details: p.hypothesis ? `hypothesis: ${clean(p.hypothesis)}` : undefined,
      };
    }
    default: throw new Error(`Unknown change kind "${clean(kind)}"`);
  }
}

export async function proposeChange(state, { kind, params, reason, requestedBy = 'agent' }) {
  if (hasControl(reason)) throw new Error('Field "reason" contains control characters');
  const info = await describe(state, kind, params);
  const list = load();
  let id;
  do { id = `chg_${crypto.randomBytes(6).toString('hex')}`; } while (list.some((c) => c.id === id));
  const change = {
    id, kind, params, reason: String(reason || '').slice(0, 500), requestedBy: clean(requestedBy),
    ...info, status: 'pending', createdAt: new Date().toISOString(),
  };
  save([...list, change]);
  return change;
}

async function apply(state, c) {
  const p = c.params;
  switch (c.kind) {
    case 'toggle_flag': {
      const { api, env, fs } = await findFeatureState(state, p.flag, p.environment);
      await api.patch(`environments/${env.api_key}/featurestates/${fs.id}/`, { enabled: !!p.enabled });
      return `${p.flag} is ${p.enabled ? 'ON' : 'OFF'} in ${env.name}`;
    }
    case 'set_flag_value': {
      const { api, env, fs } = await findFeatureState(state, p.flag, p.environment);
      await api.patch(`environments/${env.api_key}/featurestates/${fs.id}/`, { feature_state_value: String(p.value) });
      return `${p.flag} = ${clean(p.value)} in ${env.name}`;
    }
    case 'ship_winner':
      await completeExperiment(state, { envName: p.environment, experimentId: Number(p.experiment_id), winner: p.winner });
      return `experiment #${Number(p.experiment_id)} completed, ${clean(p.winner)} rolled out`;
    case 'create_experiment': {
      const exp = await createExperiment(state, {
        envName: p.environment, rollout: p.rollout ?? 100, flag: p.flag, control: 'control',
        variants: p.variants, event: p.event, name: p.name, hypothesis: p.hypothesis,
        allowReuse: false, defaultEnabled: false,
      });
      return `experiment #${exp.id} ${exp.status}`;
    }
    default: throw new Error(`Unknown change kind "${clean(c.kind)}"`);
  }
}

// Called ONLY from human-facing surfaces (TUI, interactive CLI).
// `shown` (optional) is the record the person was looking at; refuse if the stored one differs.
export async function approveChange(state, id, shown) {
  const list = load();
  const matches = list.filter((x) => x.id === id);
  if (matches.length !== 1) throw new Error(matches.length ? `More than one change has id ${clean(id)}; refusing` : `No change ${clean(id)}`);
  const c = matches[0];
  if (shown && (shown.createdAt !== c.createdAt || shown.kind !== c.kind || JSON.stringify(shown.params) !== JSON.stringify(c.params))) {
    throw new Error(`${clean(id)} no longer matches what was shown; nothing applied`);
  }
  if (c.status !== 'pending') throw new Error(`${clean(id)} is already ${c.status}`);
  // Re-validate against current state right before applying.
  Object.assign(c, await describe(state, c.kind, c.params));
  try {
    c.result = await apply(state, c);
    c.status = 'applied';
  } catch (e) {
    c.status = 'failed';
    c.result = clean(e.message.slice(0, 300));
  }
  c.decidedAt = new Date().toISOString();
  c.decidedBy = os.userInfo().username;
  save(list);
  return c;
}

export function rejectChange(id, note = '', shown) {
  const list = load();
  const matches = list.filter((x) => x.id === id);
  if (matches.length !== 1) throw new Error(matches.length ? `More than one change has id ${clean(id)}; refusing` : `No change ${clean(id)}`);
  const c = matches[0];
  if (shown && shown.createdAt !== c.createdAt) throw new Error(`${clean(id)} no longer matches what was shown`);
  if (c.status !== 'pending') throw new Error(`${clean(id)} is already ${c.status}`);
  Object.assign(c, { status: 'rejected', result: clean(note) || 'rejected by a human', decidedAt: new Date().toISOString(), decidedBy: os.userInfo().username });
  save(list);
  return c;
}
