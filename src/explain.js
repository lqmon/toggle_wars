// flagkit explain <identity> — which flags does this user get in each environment, and why?
// Uses Flagsmith's own evaluation (the SDK identities endpoint returns a `reason` per flag), so the answer
// is exactly what the SDK would get. Read-only: a user Flagsmith has never seen is evaluated as `transient`,
// so nothing is created. Exposures are only recorded by SDKs calling getExperimentFlag, never by this.
import { adminOf } from './experiment.js';
import { clean } from './sanitize.js';

const NAME = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const valueOf = (v) => (v && typeof v === 'object' ? v.string_value ?? v.integer_value ?? v.boolean_value : v);

export function parseTraits(s) {
  if (!s) return [];
  return String(s).split(',').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    if (i < 1) throw new Error(`Bad trait "${clean(kv)}": use key=value,key2=value2`);
    const key = kv.slice(0, i).trim(), raw = kv.slice(i + 1).trim();
    const value = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    return { trait_key: key, trait_value: value };
  });
}

// Turn Flagsmith's evaluation reason into a sentence.
export function why(flag) {
  const r = String(flag.reason || '');
  const exp = flag.metadata?.experiment;
  const variant = flag.variant && flag.variant !== 'control' ? flag.variant : null;
  if (exp?.in_experiment) return `in experiment #${exp.id} "${clean(exp.name)}", bucketed into ${clean(flag.variant || 'control')}`;
  if (/^IDENTITY_OVERRIDE/.test(r)) return 'set specifically for this user (identity override)';
  const seg = /segment=(.+)$/.exec(r)?.[1];
  if (/^TARGETING_MATCH/.test(r) && seg) return `matches segment "${clean(seg)}"`;
  const w = /^SPLIT; weight=([\d.]+)/.exec(r)?.[1];
  if (w) return `percentage split: lands in ${clean(variant || flag.variant || 'control')} (${Number(w)}% of users get it)`;
  if (r === 'STATIC' || r === 'DEFAULT') return 'environment default (no rule targets this user)';
  return clean(r) || 'no reason given';
}

async function evaluate(state, env, identity, traits) {
  const api = adminOf(state);
  const known = (await api.list(`environments/${env.api_key}/identities/?q=${encodeURIComponent(identity)}`)).some((i) => i.identifier === identity);
  const url = `${state.apiUrl.replace(/\/+$/, '')}/api/v1/identities/`;
  const headers = { 'X-Environment-Key': env.api_key, 'Content-Type': 'application/json' };
  // Known user: evaluate with their stored traits and overrides. Unknown: transient, so nothing is created.
  const res = known && !traits.length
    ? await fetch(`${url}?identifier=${encodeURIComponent(identity)}`, { headers })
    : await fetch(url, { method: 'POST', headers, body: JSON.stringify({ identifier: identity, traits, transient: !known }) });
  if (!res.ok) throw new Error(`${env.name}: evaluation failed (${res.status})`);
  return { known, data: await res.json() };
}

export async function explainData(state, { identity, flag, traits }) {
  if (!identity || identity.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(identity)) throw new Error('Identity must be 1–200 printable characters');
  if (flag && !NAME.test(flag)) throw new Error('Invalid flag name');
  const tr = parseTraits(traits);
  const out = { identity, environments: [] };
  for (const env of state.environments) {
    const { known, data } = await evaluate(state, env, identity, tr);
    const flags = (data.flags || []).filter((f) => !flag || f.feature.name === flag).map((f) => ({
      flag: f.feature.name, enabled: f.enabled, value: valueOf(f.feature_state_value), variant: f.variant ?? null, reason: f.reason ?? null, why: why(f),
    }));
    out.environments.push({ name: env.name, known, traits: (data.traits || []).map((t) => `${t.trait_key}=${t.trait_value}`), flags });
  }
  return out;
}

export async function explain(state, opts) {
  const d = await explainData(state, opts);
  const lines = [`Why "${clean(d.identity)}" sees what they see${opts.flag ? ` (flag ${opts.flag})` : ''}:`, ''];
  for (const env of d.environments) {
    lines.push(`${env.name}  ${env.known ? `known user${env.traits.length ? `, traits ${env.traits.map(clean).join(' ')}` : ', no traits'}` : 'never seen here: evaluated as a new user (nothing saved)'}`);
    if (!env.flags.length) lines.push('  (no flags)');
    const w = Math.max(4, ...env.flags.map((f) => clean(f.flag).length));
    for (const f of env.flags) {
      lines.push(`  ${clean(f.flag).padEnd(w)}  ${f.enabled ? 'on ' : 'off'}  ${clean(String(f.value ?? '')).slice(0, 24).padEnd(14)} ${f.why}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
