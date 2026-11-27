// The demo experiment: does a benefit-led hero headline get more visitors to click "Sign up"?
import { FlagsmithAdmin } from './api.js';
import { saveState } from './config.js';
import { summarise, formatTable } from './results.js';

export const DEMO = {
  flag: 'hero_headline',
  event: 'signup_click',
  name: 'Hero headline: generic vs benefit-led',
  hypothesis:
    'Replacing the generic headline "Feature flags for modern teams" with the benefit-led ' +
    '"Ship on Friday. Roll back in one click." will increase the share of visitors who click Sign up.',
  control: 'control',
  variants: [{ key: 'benefit', value: 'benefit' }],
  metricName: 'Sign-up click rate',
};

export const envOf = (state, name) => {
  const e = state.environments.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!e) throw new Error(`No environment "${name}". Have: ${state.environments.map((x) => x.name).join(', ')}`);
  return e;
};

export const adminOf = (state) => new FlagsmithAdmin({ apiUrl: state.apiUrl, masterKey: state.masterKey });

export async function ensureFeature(api, projectId, { flag, control, variants, description }) {
  let feature = (await api.list(`projects/${projectId}/features/?search=${encodeURIComponent(flag)}`)).find((f) => f.name === flag);
  if (!feature) {
    feature = await api.post(`projects/${projectId}/features/`, {
      name: flag,
      initial_value: control,
      default_enabled: true,
      description,
    });
    console.log(`  › created multivariate flag "${flag}" (control="${control}")`);
  }
  const existing = await api.list(`projects/${projectId}/features/${feature.id}/mv-options/`);
  for (const v of variants) {
    if (!existing.find((o) => o.key === v.key)) {
      existing.push(
        await api.post(`projects/${projectId}/features/${feature.id}/mv-options/`, {
          feature: feature.id,
          type: 'unicode',
          string_value: v.value,
          key: v.key,
          default_percentage_allocation: 0,
        }),
      );
      console.log(`  › added variant "${v.key}"`);
    }
  }
  return { feature, options: existing };
}

export async function ensureMetric(api, envKey, { name, event, description }) {
  const metrics = await api.list(`environments/${envKey}/experiment-metrics/`);
  let m = metrics.find((x) => x.name === name);
  if (!m) {
    m = await api.post(`environments/${envKey}/experiment-metrics/`, {
      name,
      description,
      aggregation: 'occurrence',
      direction: 'up',
      definition: { version: 1, event },
    });
    console.log(`  › created metric "${name}" (event "${event}")`);
  }
  return m;
}

// Generic: flag + keyed variants + metric + experiment, started unless start=false. Idempotent by name.
export async function createExperiment(state, {
  envName = 'Development', rollout = 100, start = true, track = false,
  flag, control = 'control', variants, event, metricName, name, hypothesis, description,
}) {
  const api = adminOf(state);
  const env = envOf(state, envName);
  const vs = variants.map((v) => (typeof v === 'string' ? { key: v, value: v } : v));
  const { feature, options } = await ensureFeature(api, state.project.id, { flag, control, variants: vs, description: description || `Experiment: ${name}` });
  const metric = await ensureMetric(api, env.api_key, { name: metricName || `${event} rate`, event, description: `Identities that fire ${event}` });

  let exp = (await api.list(`environments/${env.api_key}/experiments/`)).find((e) => e.name === name);
  if (!exp) {
    const share = 100 / (vs.length + 1);
    exp = await api.post(`environments/${env.api_key}/experiments/`, {
      feature: feature.id,
      name,
      hypothesis,
      metrics: [{ metric: String(metric.id), expected_direction: 'increase' }],
      experiment_rollout: {
        enabled: true,
        rollout_percentage: rollout,
        feature_state_value: { type: 'string', value: control },
        multivariate_feature_state_values: vs.map((v) => ({
          multivariate_feature_option: options.find((o) => o.key === v.key).id,
          percentage_allocation: share,
        })),
      },
    });
    console.log(`  › created experiment #${exp.id} "${name}"`);
  }
  if (start && exp.status !== 'running') {
    try {
      exp = await api.post(`environments/${env.api_key}/experiments/${exp.id}/start/`);
      console.log(`  › started experiment #${exp.id}`);
    } catch (e) {
      console.log(`  › could not start yet: ${e.message}`);
    }
  }
  if (track) {
    state.experiments[env.name] = { id: exp.id, flag, event };
    saveState(state);
  }
  return exp;
}

export async function createDemoExperiment(state, { envName = 'Development', rollout = 100 } = {}) {
  const env = envOf(state, envName);
  const exp = await createExperiment(state, {
    envName, rollout, track: true,
    flag: DEMO.flag, control: DEMO.control, variants: DEMO.variants, event: DEMO.event,
    metricName: DEMO.metricName, name: DEMO.name, hypothesis: DEMO.hypothesis, description: 'FlagKit demo: landing page headline',
  });
  console.log(`\n✔ Experiment #${exp.id} is ${exp.status}.`);
  console.log(`  Dashboard: ${state.apiUrl}/project/${state.project.id}/environment/${env.api_key}/experiments/${exp.id}\n`);
  return exp;
}

// Experiment.feature is an object ({id, name, …}) on current Flagsmith, a bare id on older versions.
export const featureIdOf = (exp) => (exp.feature && typeof exp.feature === 'object' ? exp.feature.id : exp.feature);

// End an experiment and let Flagsmith roll the decision out to 100% of the environment.
export async function completeExperiment(state, { envName, experimentId, winner }) {
  const api = adminOf(state);
  const env = envOf(state, envName);
  const exp = await api.get(`environments/${env.api_key}/experiments/${experimentId}/`);
  let body = { rollout_decision: 'control' };
  if (winner === 'disable') body = { rollout_decision: 'disable' };
  else if (winner !== 'control') {
    const opts = await api.list(`projects/${state.project.id}/features/${featureIdOf(exp)}/mv-options/`);
    const opt = opts.find((o) => o.key === winner);
    if (!opt) throw new Error(`No variant "${winner}" on experiment #${experimentId}`);
    body = { rollout_decision: 'variant', rollout_variant: opt.id };
  }
  return api.post(`environments/${env.api_key}/experiments/${experimentId}/complete/`, body);
}

export async function getResults(state, { envName = 'Development', refresh = true } = {}) {
  const api = adminOf(state);
  const env = envOf(state, envName);
  const id = state.experiments[env.name]?.id;
  if (!id) throw new Error(`No experiment in ${env.name}. Run \`flagkit experiment create\`.`);
  if (refresh) {
    try { await api.post(`environments/${env.api_key}/experiments/${id}/results/refresh/`); } catch { /* rate-limited to once / 5 min */ }
  }
  const [experiment, results] = await Promise.all([
    api.get(`environments/${env.api_key}/experiments/${id}/`),
    api.get(`environments/${env.api_key}/experiments/${id}/results/`).catch((e) => ({ error: e.message })),
  ]);
  return { experiment, results };
}

export async function printResults(state, opts) {
  const { experiment, results } = await getResults(state, opts);
  if (opts?.json) return console.log(JSON.stringify({ experiment: { id: experiment.id, status: experiment.status }, rows: summarise(results).rows }));
  console.log(`#${experiment.id} ${experiment.name} — ${experiment.status}`);
  console.log(formatTable(results));
}
