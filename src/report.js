// flagkit report <experiment id> — a results report a person can read: numbers, a plain-English verdict,
// health checks (sample ratio, sample size, duration) and what to do next. Markdown, so it renders on
// GitHub, in a PR comment or a job summary. Read-only.
import { summarise } from './results.js';
import { phi } from './plan.js';
import { clean } from './sanitize.js';

const MIN_PER_ARM = 50;
const SHIP = 0.95;
const pct = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const signed = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`);
// Markdown cells: no pipes, no newlines, no control characters from server-held names.
const md = (s) => clean(String(s ?? '')).replace(/[|`<>]/g, (c) => `\\${c}`);

// Planned share of traffic per arm: each variant's allocation, control gets the rest.
export function plannedSplit(exp) {
  const keyOf = Object.fromEntries((exp.feature?.multivariate_options || []).map((o) => [o.id, o.key || o.string_value]));
  const split = {};
  let used = 0;
  for (const v of exp.experiment_rollout?.multivariate_feature_state_values || []) {
    const k = keyOf[v.multivariate_feature_option];
    if (k) { split[k] = v.percentage_allocation / 100; used += v.percentage_allocation; }
  }
  split.control = Math.max(0, 1 - used / 100);
  return split;
}

// Chi-square goodness-of-fit p-value for the observed split (Wilson–Hilferty approximation for df > 1).
export function srmPValue(observed, planned) {
  const keys = Object.keys(observed).filter((k) => planned[k] > 0);
  const total = keys.reduce((a, k) => a + observed[k], 0);
  if (keys.length < 2 || total === 0) return null;
  const chi2 = keys.reduce((a, k) => a + (observed[k] - total * planned[k]) ** 2 / (total * planned[k]), 0);
  const df = keys.length - 1;
  if (df === 1) return 2 * (1 - phi(Math.sqrt(chi2)));
  const z = ((chi2 / df) ** (1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return 1 - phi(z);
}

export function analyse(exp, results, now = new Date()) {
  const s = summarise(results);
  const planned = plannedSplit(exp);
  const control = s.rows.find((r) => r.isControl);
  const variants = s.rows.filter((r) => !r.isControl);
  const total = s.rows.reduce((a, r) => a + r.exposures, 0);
  const observed = Object.fromEntries(s.rows.map((r) => [r.key, r.exposures]));
  const srm = s.srm ?? srmPValue(observed, planned);
  const days = exp.started_at ? (now - new Date(exp.started_at)) / 86_400_000 : 0;
  const minArm = s.rows.length ? Math.min(...s.rows.map((r) => r.exposures)) : 0;
  const best = [...variants].sort((a, b) => (b.win ?? 0) - (a.win ?? 0))[0];

  const checks = [
    { ok: s.rows.length > 0, label: 'Results computed', detail: s.rows.length ? `as of ${s.asOf}` : 'no results yet: check events arrive (`flagkit doctor`, `flagkit tail`)' },
    { ok: minArm >= MIN_PER_ARM, label: `At least ${MIN_PER_ARM} users per version`, detail: `smallest version has ${minArm}` },
    { ok: srm == null || srm >= 0.01, label: 'Split matches the plan (no sample ratio mismatch)', detail: srm == null ? 'not enough data to check' : `p = ${srm.toFixed(3)}; planned ${Object.entries(planned).map(([k, v]) => `${md(k)} ${pct(v, 0)}`).join(' / ')}` },
    { ok: days >= 7, warnOnly: true, label: 'Ran at least a week (covers weekday/weekend differences)', detail: `${days.toFixed(1)} days so far` },
  ];

  let verdict, action;
  if (!s.rows.length || !control) { verdict = 'Collecting data. No results have been computed yet.'; action = 'wait'; }
  else if (srm != null && srm < 0.01) { verdict = `Don't trust these numbers: the split between versions is off (p = ${srm.toFixed(4)}). Something is assigning or recording users unevenly. Fix that before reading any result.`; action = 'investigate'; }
  else if (minArm < MIN_PER_ARM) { verdict = `Too early to call. The smallest version has ${minArm} users; the bar is ${MIN_PER_ARM} per version. Any difference now is mostly noise.`; action = 'wait'; }
  else if (best && best.win >= SHIP) {
    const wide = best.ci && best.ci[1] - best.ci[0] > Math.abs(best.lift) * 1.5;
    verdict = `**${md(best.key)}** is very likely better than control: ${pct(best.win)} chance to beat it, with a lift of ${signed(best.lift)} (likely between ${signed(best.ci?.[0])} and ${signed(best.ci?.[1])}).` +
      (wide ? ' The direction is clear but the size of the win is uncertain.' : '');
    action = 'ship';
  } else if (variants.length && variants.every((v) => v.win != null && v.win <= 1 - SHIP)) {
    verdict = `Control is very likely better than every variant (each has ≤${pct(1 - SHIP, 0)} chance to beat it). Keep control.`;
    action = 'keep-control';
  } else {
    verdict = `Not conclusive yet. The leading version${best ? `, **${md(best.key)}**, has a ${pct(best.win)} chance to beat control` : ''}; the ship bar is ${pct(SHIP, 0)}. Keep it running.`;
    action = 'wait';
  }
  return { s, total, srm, days, checks, verdict, action, best, planned };
}

// Cumulative conversion rate per version over time, as a Mermaid line chart (renders on GitHub).
function chart(results, keys) {
  const p = results?.results?.payload ?? results?.payload;
  const exp = p?.exposures_timeseries?.points || [];
  const conv = p?.metrics?.[0]?.conversions_timeseries?.points || [];
  if (exp.length < 2) return '';
  const buckets = [...new Set([...exp, ...conv].map((x) => x.bucket))].sort();
  const step = Math.ceil(buckets.length / 20);
  const n = {}, c = {}, series = Object.fromEntries(keys.map((k) => [k, []]));
  const labels = [];
  buckets.forEach((b, i) => {
    for (const k of keys) {
      n[k] = (n[k] || 0) + (exp.find((x) => x.bucket === b)?.new_identities?.[k] || 0);
      c[k] = (c[k] || 0) + (conv.find((x) => x.bucket === b)?.converted_identities?.[k] || 0);
    }
    if (i % step === 0 || i === buckets.length - 1) {
      labels.push(`"${b.slice(5, 13).replace('T', ' ')}h"`);
      for (const k of keys) series[k].push(n[k] ? +((100 * c[k]) / n[k]).toFixed(2) : 0);
    }
  });
  const max = Math.ceil(Math.max(1, ...Object.values(series).flat()) * 1.2);
  return ['```mermaid', 'xychart-beta', '  title "Cumulative conversion rate (%)"', `  x-axis [${labels.join(', ')}]`, `  y-axis "conversion %" 0 --> ${max}`,
    ...keys.map((k) => `  line [${series[k].join(', ')}]`), '```', `Lines, in order: ${keys.map(md).join(', ')}.`, ''].join('\n');
}

export function renderReport(exp, results, { dashboard, envKey, projectId, now, hideHypothesis = false } = {}) {
  const a = analyse(exp, results, now);
  const metric = exp.metrics?.[0];
  const icon = { ship: '🚀', 'keep-control': '🛑', investigate: '⚠️', wait: '⏳' }[a.action];
  const lines = [
    `## ${icon} Experiment #${exp.id}: ${md(exp.name)}`,
    '',
    `**Status:** ${md(exp.status)} · **Flag:** \`${md(exp.feature?.name ?? exp.feature)}\` · **Metric:** ${md(metric?.metric_name ?? '—')} (${md(metric?.aggregation ?? '')}, ${md(metric?.expected_direction ?? 'increase')} is better) · **Running for:** ${a.days.toFixed(1)} days`,
    '',
    exp.hypothesis && !hideHypothesis ? `> **Hypothesis:** ${md(exp.hypothesis)}\n` : '',
    `### Verdict\n\n${a.verdict}\n`,
  ];
  if (a.s.rows.length) {
    lines.push('### Results', '', '| version | users | conversions | rate | lift vs control | likely range | chance to beat control |', '|---|---:|---:|---:|---:|---|---:|');
    for (const r of a.s.rows) {
      lines.push(`| ${md(r.key)}${r.isControl && r.key !== 'control' ? ' (control)' : ''} | ${r.exposures.toLocaleString()} | ${r.conversions.toLocaleString()} | ${pct(r.value)} | ${r.isControl ? '—' : signed(r.lift)} | ${r.isControl || !r.ci ? '—' : `${signed(r.ci[0])} to ${signed(r.ci[1])}`} | ${r.isControl ? '—' : pct(r.win)} |`);
    }
    lines.push('', `${a.total.toLocaleString()} users in total. "Likely range" is the 95% credible interval for the lift.`, '');
    const c = chart(results, a.s.rows.map((r) => r.key));
    if (c) lines.push(c);
  }
  lines.push('### Health checks', '');
  for (const ch of a.checks) lines.push(`- ${ch.ok ? '✅' : ch.warnOnly ? '⚠️' : '❌'} ${ch.label}: ${ch.detail}`);
  lines.push('', '### Next step', '');
  const id = exp.id;
  const flag = md(exp.feature?.name ?? '<flag>');
  if (a.action === 'ship') lines.push(`Roll **${md(a.best.key)}** out to everyone (ends the experiment, keeps the flag): \`skills/flagsmith-experiment-rollout/scripts/rollout.sh ${id} ${flag} ${md(a.best.key)}\`, or press \`s\` in \`flagkit tui\`. An agent can propose it with \`flagkit_propose_change\` → \`ship_winner\` for a human to approve.`);
  else if (a.action === 'keep-control') lines.push(`End the experiment and keep control: \`skills/flagsmith-experiment-rollout/scripts/rollout.sh ${id} ${flag} control\`.`);
  else if (a.action === 'investigate') lines.push('Pause and debug assignment: check every exposure uses the same identity as its conversion, and that no version errors before it records an exposure. `flagkit tail` shows events as they arrive.');
  else lines.push(`Keep it running. \`flagkit plan --baseline <rate> --lift <lift>\` estimates how many users you need. Re-run \`flagkit report ${id}\` later.`);
  if (dashboard && envKey && projectId) lines.push('', `[Open in Flagsmith](${dashboard}/project/${projectId}/environment/${envKey}/experiments/${id})`);
  lines.push('', `<sub>Generated by FlagKit \`flagkit report\` from Flagsmith Experimentation results.</sub>`, '');
  return { markdown: lines.filter((l) => l !== null).join('\n'), ...a };
}

export async function buildReport(src, id, opts = {}) {
  const base = `environments/${src.envKey}/experiments/${Number(id)}`;
  const [exp, results] = await Promise.all([src.api.get(`${base}/`), src.api.get(`${base}/results/`).catch(() => null)]);
  return renderReport(exp, results, { dashboard: src.dashboard, envKey: src.envKey, projectId: src.projectId ?? exp.feature?.project, ...opts });
}
