// The one write path for flag changes made by people (admin panel, TUI, scheduler, promote, revert).
// Every change records who, why, through what, and the exact before/after, so any entry can be reverted.
// Guards: Production needs a reason; a flag inside a running experiment is refused unless the caller
// explicitly forces it (changing it mid-test corrupts the result).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR, writeSecure } from './config.js';
import { adminOf, envOf } from './experiment.js';
import { loadFlags, valueOf } from './flags.js';
import { clean, hasControl } from './sanitize.js';

const AUDIT = () => path.join(STATE_DIR, 'audit.json');
const SCHEDULES = () => path.join(STATE_DIR, 'schedules.json');
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; } };
const norm = (v) => (v == null ? '' : String(v)); // null and "" both mean "no value"
const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
export const isProd = (envName) => /prod/i.test(envName);

export const auditLog = ({ flag, limit = 200 } = {}) => readJson(AUDIT()).filter((e) => !flag || e.flag === flag).slice(-limit).reverse();
function record(entry) {
  const all = readJson(AUDIT());
  all.push(entry);
  writeSecure(AUDIT(), JSON.stringify(all.slice(-5000), null, 1));
  return entry;
}

function checkText(name, v, max = 500) {
  if (v == null) return '';
  if (hasControl(String(v))) throw new Error(`${name} contains control characters`);
  return String(v).slice(0, max);
}

async function currentState(state, flag, envName) {
  if (!NAME.test(flag || '')) throw new Error('Invalid flag name');
  const api = adminOf(state);
  const env = envOf(state, envName);
  const f = (await api.list(`projects/${state.project.id}/features/?search=${encodeURIComponent(flag)}`)).find((x) => x.name === flag);
  if (!f) throw new Error(`No flag "${clean(flag)}"`);
  const fsx = (await api.list(`features/featurestates/?environment=${env.id}&feature=${f.id}`)).find((s) => s.feature_segment == null && s.identity == null);
  if (!fsx) throw new Error(`No environment default for "${clean(flag)}" in ${env.name}`);
  let running = [];
  try { running = (await api.list(`environments/${env.api_key}/experiments/`)).filter((x) => x.status === 'running' && (x.feature?.id ?? x.feature) === f.id); } catch { /* experimentation off */ }
  return { api, env, feature: f, fs: fsx, running };
}

// change: { flag, env, enabled?, value? }   ctx: { actor, reason, via, force, dryRun }
export async function setFlag(state, change, ctx = {}) {
  const { api, env, fs: cur, running } = await currentState(state, change.flag, change.env);
  const actor = checkText('actor', ctx.actor || 'unknown', 80);
  const reason = checkText('reason', ctx.reason);
  if (isProd(env.name) && !reason.trim()) throw new Error('A reason is required for Production changes');
  if (running.length && !ctx.force) {
    throw new Error(`"${clean(change.flag)}" is in running experiment #${running[0].id} in ${env.name}. Changing it now corrupts the result; end the experiment first (or force).`);
  }
  const before = { enabled: !!cur.enabled, value: valueOf(cur.feature_state_value) };
  const after = { enabled: change.enabled === undefined ? before.enabled : !!change.enabled, value: change.value === undefined ? before.value : change.value === null ? null : checkText('value', change.value, 20_000) };
  if (before.enabled === after.enabled && norm(before.value) === norm(after.value)) return { noop: true, before, after };
  if (ctx.dryRun) return { dryRun: true, before, after, env: env.name };
  const body = { enabled: after.enabled };
  // The environment feature-state endpoint takes a plain value and infers its type.
  if (norm(before.value) !== norm(after.value)) {
    const v = after.value;
    body.feature_state_value = typeof before.value === 'boolean' && /^(true|false)$/.test(String(v)) ? String(v) === 'true'
      : typeof before.value === 'number' && /^-?\d{1,15}$/.test(String(v)) ? Number(v)
      : String(v ?? '');
  }
  await api.patch(`environments/${env.api_key}/featurestates/${cur.id}/`, body);
  return record({ id: id('aud'), at: new Date().toISOString(), flag: change.flag, env: env.name, before, after, actor, reason, via: clean(ctx.via || 'cli'), ...(ctx.revertOf ? { revertOf: ctx.revertOf } : {}), ...(ctx.scheduleId ? { scheduleId: ctx.scheduleId } : {}) });
}

export async function revert(state, auditId, ctx = {}) {
  const e = readJson(AUDIT()).find((x) => x.id === auditId);
  if (!e) throw new Error(`No audit entry ${clean(auditId)}`);
  return setFlag(state, { flag: e.flag, env: e.env, enabled: e.before.enabled, value: e.before.value }, { ...ctx, reason: ctx.reason || `revert ${e.id}`, revertOf: e.id });
}

// ── Promote: make one environment match another, flag by flag, with a preview ────────────────────────
export async function promotePlan(state, { from, to, flags: only }) {
  const src = envOf(state, from).name, dst = envOf(state, to).name;
  const flags = await loadFlags(adminOf(state), { projectId: state.project.id, environments: state.environments });
  return flags.filter((f) => !only || only.includes(f.name)).map((f) => {
    const a = f.envs[src], b = f.envs[dst];
    if (!a || !b) return null;
    const differs = a.enabled !== b.enabled || norm(a.value) !== norm(b.value);
    if (!differs) return null;
    const blocked = f.experiments.find((x) => x.env === dst);
    return { flag: f.name, from: { enabled: a.enabled, value: a.value }, to: { enabled: b.enabled, value: b.value }, blocked: blocked ? `experiment #${blocked.id} running in ${dst}` : null };
  }).filter(Boolean);
}

export async function promote(state, { from, to, flags }, ctx) {
  const plan = await promotePlan(state, { from, to, flags });
  const done = [];
  for (const p of plan) {
    if (p.blocked) { done.push({ flag: p.flag, skipped: p.blocked }); continue; }
    try {
      done.push(await setFlag(state, { flag: p.flag, env: to, enabled: p.from.enabled, value: p.from.value }, { ...ctx, reason: ctx.reason || `promote ${from} → ${to}`, via: ctx.via || 'promote' }));
    } catch (e) { done.push({ flag: p.flag, error: clean(e.message) }); }
  }
  return done;
}

// ── Schedules: "turn this on at 09:00 Monday" ─────────────────────────────────────────────────────────
// Run by any long-lived FlagKit process (panel, watch) or by `flagkit schedule run` from cron.
export const listSchedules = (status) => readJson(SCHEDULES()).filter((s) => !status || s.status === status);
const saveSchedules = (l) => writeSecure(SCHEDULES(), JSON.stringify(l, null, 1));

export async function addSchedule(state, { flag, env, enabled, value, at }, ctx = {}) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) throw new Error('Invalid time');
  if (when.getTime() < Date.now() - 60_000) throw new Error('That time is in the past');
  const e = envOf(state, env);
  const reason = checkText('reason', ctx.reason);
  if (isProd(e.name) && !reason.trim()) throw new Error('A reason is required for Production changes');
  await currentState(state, flag, e.name); // validates the flag exists now
  const s = { id: id('sch'), flag, env: e.name, ...(enabled !== undefined ? { enabled: !!enabled } : {}), ...(value !== undefined ? { value: checkText('value', value, 20_000) } : {}),
    at: when.toISOString(), actor: checkText('actor', ctx.actor || 'unknown', 80), reason, status: 'pending', createdAt: new Date().toISOString() };
  saveSchedules([...readJson(SCHEDULES()), s]);
  return s;
}

export function cancelSchedule(sid, actor) {
  const l = readJson(SCHEDULES());
  const s = l.find((x) => x.id === sid);
  if (!s || s.status !== 'pending') throw new Error(`No pending schedule ${clean(sid)}`);
  Object.assign(s, { status: 'cancelled', decidedAt: new Date().toISOString(), cancelledBy: clean(actor || 'unknown') });
  saveSchedules(l);
  return s;
}

export async function runDueSchedules(state, now = Date.now()) {
  const l = readJson(SCHEDULES());
  const ran = [];
  for (const s of l) {
    if (s.status !== 'pending' || new Date(s.at).getTime() > now) continue;
    try {
      const r = await setFlag(state, { flag: s.flag, env: s.env, enabled: s.enabled, value: s.value }, { actor: s.actor, reason: `scheduled: ${s.reason || s.id}`, via: 'schedule', scheduleId: s.id });
      Object.assign(s, { status: 'done', result: r.noop ? 'already in that state' : `applied (${r.id})` });
    } catch (e) { Object.assign(s, { status: 'failed', result: clean(e.message).slice(0, 300) }); }
    s.ranAt = new Date().toISOString();
    ran.push(s);
  }
  if (ran.length) saveSchedules(l);
  return ran;
}
