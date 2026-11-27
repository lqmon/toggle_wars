// Human-in-the-loop change queue.
// Agents (via the MCP server) can only PROPOSE changes. A change is applied only from a human-facing
// surface: the TUI's Approvals tab, or `flagkit approve <id>` in an interactive terminal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './config.js';
import { adminOf, envOf, createExperiment, completeExperiment } from './experiment.js';

const FILE = path.join(STATE_DIR, 'approvals.json');
const NAME = /^[a-z0-9][a-z0-9_-]{0,99}$/;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function save(list) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.chmodSync(FILE, 0o600);
}

export const listChanges = (status) => load().filter((c) => !status || c.status === status);
export const getChange = (id) => load().find((c) => c.id === id);

async function findFeatureState(state, flag, envName) {
  const api = adminOf(state);
  const env = envOf(state, envName);
  const f = (await api.list(`projects/${state.project.id}/features/?search=${encodeURIComponent(flag)}`)).find((x) => x.name === flag);
  if (!f) throw new Error(`No flag "${flag}"`);
  const fs = (await api.list(`features/featurestates/?environment=${env.id}&feature=${f.id}`)).find((s) => s.feature_segment == null && s.identity == null);
  if (!fs) throw new Error(`No environment default for "${flag}" in ${env.name}`);
  return { api, env, feature: f, fs };
}
const valueOf = (v) => (v && typeof v === 'object' ? v.string_value ?? v.integer_value ?? v.boolean_value : v);

// Validate and describe a proposed change (reads current state; never writes).
async function describe(state, kind, p) {
  const env = envOf(state, p.environment);
  const risk = /prod/i.test(env.name) ? 'high' : 'normal';
  switch (kind) {
    case 'toggle_flag': {
      const { fs } = await findFeatureState(state, p.flag, env.name);
      return { risk, summary: `Turn "${p.flag}" ${p.enabled ? 'ON' : 'OFF'} in ${env.name}`, before: fs.enabled ? 'on' : 'off', after: p.enabled ? 'on' : 'off' };
    }
    case 'set_flag_value': {
      const { fs } = await findFeatureState(state, p.flag, env.name);
      return { risk, summary: `Set "${p.flag}" value in ${env.name}`, before: String(valueOf(fs.feature_state_value)), after: String(p.value) };
    }
    case 'ship_winner': {
      const api = adminOf(state);
      const exp = await api.get(`environments/${env.api_key}/experiments/${p.experiment_id}/`);
      if (exp.status !== 'running') throw new Error(`Experiment #${exp.id} is ${exp.status}, not running`);
      return { risk, summary: `End experiment #${exp.id} "${exp.name}" and roll "${p.winner}" out to 100% of ${env.name}`, before: 'experiment running', after: `everyone gets ${p.winner}` };
    }
    case 'create_experiment': {
      for (const n of [p.flag, p.event, ...(p.variants || [])]) if (!NAME.test(n || '')) throw new Error(`Invalid name "${n}" (lowercase, digits, _ and - only)`);
      if (!p.variants?.length) throw new Error('At least one variant key is required');
      return { risk, summary: `Create and start experiment "${p.name}" on flag "${p.flag}" in ${env.name} (${p.rollout ?? 100}% of traffic)`, before: '—', after: `control vs ${p.variants.join(', ')}, metric ${p.event}` };
    }
    default: throw new Error(`Unknown change kind "${kind}"`);
  }
}

export async function proposeChange(state, { kind, params, reason, requestedBy = 'agent' }) {
  const info = await describe(state, kind, params);
  const change = {
    id: `chg_${crypto.randomBytes(3).toString('hex')}`,
    kind, params, reason: String(reason || '').slice(0, 500), requestedBy,
    ...info, status: 'pending', createdAt: new Date().toISOString(),
  };
  save([...load(), change]);
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
      await api.patch(`environments/${env.api_key}/featurestates/${fs.id}/`, { feature_state_value: { type: 'unicode', string_value: String(p.value) } });
      return `${p.flag} = ${p.value} in ${env.name}`;
    }
    case 'ship_winner':
      await completeExperiment(state, { envName: p.environment, experimentId: p.experiment_id, winner: p.winner });
      return `experiment #${p.experiment_id} completed, ${p.winner} rolled out`;
    case 'create_experiment': {
      const exp = await createExperiment(state, {
        envName: p.environment, rollout: p.rollout ?? 100, flag: p.flag, control: p.control || 'control',
        variants: p.variants, event: p.event, name: p.name, hypothesis: p.hypothesis,
      });
      return `experiment #${exp.id} ${exp.status}`;
    }
    default: throw new Error(`Unknown change kind "${c.kind}"`);
  }
}

// Called ONLY from human-facing surfaces (TUI, interactive CLI).
export async function approveChange(state, id) {
  const list = load();
  const c = list.find((x) => x.id === id);
  if (!c) throw new Error(`No change ${id}`);
  if (c.status !== 'pending') throw new Error(`${id} is already ${c.status}`);
  // Re-validate against current state right before applying.
  Object.assign(c, await describe(state, c.kind, c.params));
  try {
    c.result = await apply(state, c);
    c.status = 'applied';
  } catch (e) {
    c.status = 'failed';
    c.result = e.message.slice(0, 300);
  }
  c.decidedAt = new Date().toISOString();
  c.decidedBy = os.userInfo().username;
  save(list);
  return c;
}

export function rejectChange(id, note = '') {
  const list = load();
  const c = list.find((x) => x.id === id);
  if (!c) throw new Error(`No change ${id}`);
  if (c.status !== 'pending') throw new Error(`${id} is already ${c.status}`);
  Object.assign(c, { status: 'rejected', result: note || 'rejected by a human', decidedAt: new Date().toISOString(), decidedBy: os.userInfo().username });
  save(list);
  return c;
}
