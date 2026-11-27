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

export async function createDemoExperiment(state, { envName = 'Development', rollout = 100 } = {}) {
  const api = adminOf(state);
  const env = envOf(state, envName);
  const { feature, options } = await ensureFeature(api, state.project.id, { ...DEMO, description: 'FlagKit demo: landing page headline' });
  const metric = await ensureMetric(api, env.api_key, { name: DEMO.metricName, event: DEMO.event, description: 'Visitors who click Sign up' });

  let exp = (await api.list(`environments/${env.api_key}/experiments/`)).find((e) => e.name === DEMO.name);
  if (!exp) {
    const share = 100 / (DEMO.variants.length + 1);
    exp = await api.post(`environments/${env.api_key}/experiments/`, {
      feature: feature.id,
      name: DEMO.name,
      hypothesis: DEMO.hypothesis,
      metrics: [{ metric: String(metric.id), expected_direction: 'increase' }],
      experiment_rollout: {
        enabled: true,
        rollout_percentage: rollout,
        feature_state_value: { type: 'string', value: DEMO.control },
        multivariate_feature_state_values: DEMO.variants.map((v) => ({
          multivariate_feature_option: options.find((o) => o.key === v.key).id,
          percentage_allocation: share,
        })),
      },
    });
    console.log(`  › created experiment #${exp.id} "${DEMO.name}"`);
  }
  if (exp.status !== 'running') {
    try {
      exp = await api.post(`environments/${env.api_key}/experiments/${exp.id}/start/`);
      console.log(`  › started experiment #${exp.id}`);
    } catch (e) {
      console.log(`  › could not start yet: ${e.message}`);
    }
  }
  state.experiments[env.name] = { id: exp.id, flag: DEMO.flag, event: DEMO.event };
  saveState(state);
  console.log(`\n✔ Experiment #${exp.id} is ${exp.status}.`);
  console.log(`  Dashboard: ${state.apiUrl}/project/${state.project.id}/environment/${env.api_key}/experiments/${exp.id}\n`);
  return exp;
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
