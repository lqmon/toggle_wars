// Tests for plan, report, watch, explain, tail formatting and the VS Code extension's pure logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { plan, chanceToBeat } from '../src/plan.js';
import { srmPValue, analyse, renderReport, plannedSplit } from '../src/report.js';
import { assess } from '../src/watch.js';
import { why, parseTraits } from '../src/explain.js';
import { formatEvent } from '../src/tail.js';

const vsc = createRequire(import.meta.url)('../vscode-extension/lib.js');

const EXP = {
  id: 9, name: 'Exp', status: 'running', hypothesis: 'h', started_at: '2026-11-20T00:00:00Z',
  feature: { id: 1, name: 'f', multivariate_options: [{ id: 5, key: 'b' }] },
  metrics: [{ metric_name: 'm', aggregation: 'occurrence', expected_direction: 'increase' }],
  experiment_rollout: { multivariate_feature_state_values: [{ multivariate_feature_option: 5, percentage_allocation: 50 }] },
};
const res = (nA, cA, nB, cB, inf, extra = {}) => ({ results: { as_of: 'now', payload: {
  metrics: [{ variants: { control: { n: nA, sum: cA }, b: { n: nB, sum: cB } }, inference: { b: inf } }],
  srm_p_value: null, exposures_timeseries: { points: [] }, ...extra } } });
const NOW = new Date('2026-11-28T00:00:00Z');

test('plan matches the textbook sample size for 8% -> 11.5%', () => {
  const p = plan({ baseline: 0.08, lift: 0.4375 });
  assert.ok(p.perArm > 750 && p.perArm < 1050, `got ${p.perArm}`);
  assert.ok(p.falsePositive < 0.08);
  assert.throws(() => plan({ baseline: 2, lift: 0.1 }), /baseline/);
});

test('chanceToBeat is symmetric and sensible', () => {
  assert.ok(Math.abs(chanceToBeat(1000, 100, 1000, 100) - 0.5) < 0.01);
  assert.ok(chanceToBeat(1000, 80, 1000, 120) > 0.99);
});

test('srmPValue flags a broken split and passes a fair one', () => {
  assert.ok(srmPValue({ control: 500, b: 500 }, { control: 0.5, b: 0.5 }) > 0.9);
  assert.ok(srmPValue({ control: 600, b: 400 }, { control: 0.5, b: 0.5 }) < 0.001);
  assert.deepEqual(plannedSplit(EXP), { b: 0.5, control: 0.5 });
});

test('report verdicts: too early, ship, keep control, srm', () => {
  assert.equal(analyse(EXP, res(10, 1, 12, 3, null), NOW).action, 'wait');
  assert.equal(analyse(EXP, res(1000, 80, 1000, 120, { lift: 0.5, ci_low: 0.1, ci_high: 0.9, chance_to_win: 0.995 }), NOW).action, 'ship');
  assert.equal(analyse(EXP, res(1000, 120, 1000, 80, { lift: -0.33, ci_low: -0.5, ci_high: -0.1, chance_to_win: 0.003 }), NOW).action, 'keep-control');
  assert.equal(analyse(EXP, res(1200, 100, 800, 70, { lift: 0, ci_low: -0.2, ci_high: 0.2, chance_to_win: 0.5 }), NOW).action, 'investigate');
  const r = renderReport(EXP, res(1000, 80, 1000, 120, { lift: 0.5, ci_low: 0.1, ci_high: 0.9, chance_to_win: 0.995 }), { now: NOW });
  assert.match(r.markdown, /rollout\.sh 9 f b/);
  assert.doesNotMatch(renderReport(EXP, null, { now: NOW, hideHypothesis: true }).markdown, /Hypothesis/);
});

test('report escapes server-held names', () => {
  const evil = { ...EXP, name: 'x | <img src=x> \u001b[2J' };
  const md = renderReport(evil, null, { now: NOW }).markdown;
  assert.doesNotMatch(md, /\u001b|[^\\]<img/);
});

test('watch: clearly worse variant and SRM are trouble; healthy is quiet', () => {
  const worse = assess(EXP, res(500, 100, 500, 30, { lift: -0.7, ci_low: -0.8, ci_high: -0.5, chance_to_win: 0.0001 }), NOW);
  assert.deepEqual(worse.findings.map((f) => f.code), ['worse']);
  const srm = assess(EXP, res(700, 70, 300, 30, { lift: 0, ci_low: -0.2, ci_high: 0.2, chance_to_win: 0.5 }), NOW);
  assert.ok(srm.findings.some((f) => f.code === 'srm'));
  assert.equal(assess(EXP, res(500, 50, 500, 55, { lift: 0.1, ci_low: -0.2, ci_high: 0.4, chance_to_win: 0.7 }), NOW).findings.length, 0);
  const stalled = res(500, 50, 500, 55, { lift: 0.1, chance_to_win: 0.7 }, { exposures_timeseries: { points: [{ bucket: '2026-11-27T00:00:00Z', new_identities: {} }] } });
  assert.ok(assess(EXP, stalled, NOW).findings.some((f) => f.code === 'stalled'));
});

test('explain turns Flagsmith reasons into sentences, and cleans names', () => {
  assert.match(why({ reason: 'TARGETING_MATCH; segment=experiment-1-rollout', variant: 'b', metadata: { experiment: { id: 1, name: 'N\u001b[8m', in_experiment: true } } }), /experiment #1 "N\\x1b\[8m", bucketed into b/);
  assert.match(why({ reason: 'SPLIT; weight=25.0', variant: 'teal' }), /percentage split: lands in teal \(25%/);
  assert.match(why({ reason: 'TARGETING_MATCH; segment=beta users' }), /segment "beta users"/);
  assert.match(why({ reason: 'IDENTITY_OVERRIDE' }), /identity override/);
  assert.match(why({ reason: 'STATIC' }), /environment default/);
  assert.deepEqual(parseTraits('plan=pro,age=30,beta=true'), [{ trait_key: 'plan', trait_value: 'pro' }, { trait_key: 'age', trait_value: 30 }, { trait_key: 'beta', trait_value: true }]);
  assert.throws(() => parseTraits('nokey'), /Bad trait/);
});

test('tail never prints raw control characters from identities', () => {
  const line = formatEvent({ time: '10:00:00', event: '$flag_exposure', feature: 'f', value: 'b', identity: 'u\u001b]52;c;x\u0007', sdk: 'js' });
  assert.doesNotMatch(line, /[\u0000-\u001f]/);
});

test('vscode: finds flag literals and renders safe hovers', () => {
  const refs = vsc.findFlagRefs(`a('hero_headline'); b("other"); c(\`hero_headline\`)`, new Set(['hero_headline']));
  assert.equal(refs.length, 2);
  const f = { name: 'x', description: '[click](command:evil) <b>', envs: [{ name: 'Production', enabled: true, value: 'v', weights: [] }], experiments: [] };
  const h = vsc.hoverMarkdown(f);
  assert.doesNotMatch(h, /\]\(command:/);
  assert.doesNotMatch(h, /<b>/);
  assert.match(vsc.inlineText({ ...f, experiments: [{ status: 'running', id: 3, best: { key: 'b', win: 0.97 } }] }), /● prod:v {2}🧪 #3 b 97\.0%/);
});
