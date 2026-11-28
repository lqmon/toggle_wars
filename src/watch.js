// flagkit watch — guardrails for running experiments.
// Every interval it checks each running experiment in every environment. On real trouble it does NOT act:
// it files a change request (send everyone back to control) that a human approves in `flagkit tui` or with
// `flagkit approve <id>`, the same queue agents use. Warnings that need judgement are only printed.
//
//   trouble (files a request):  sample ratio mismatch (p < 0.001) · a variant is clearly worse (≤1% chance to beat control)
//   warnings (printed only):    exposures stopped arriving · results failing to compute
import { adminOf } from './experiment.js';
import { analyse } from './report.js';
import { proposeChange, listChanges } from './approvals.js';
import { clean } from './sanitize.js';

const SRM_ALARM = 0.001;
const WORSE = 0.01;
const MIN_PER_ARM = 100;
const STALL_HOURS = 6;

export function assess(exp, results, now = new Date()) {
  const a = analyse(exp, results, now);
  const rows = a.s.rows;
  const findings = [];
  const minArm = rows.length ? Math.min(...rows.map((r) => r.exposures)) : 0;
  if (a.srm != null && a.srm < SRM_ALARM && a.total >= 2 * MIN_PER_ARM) {
    findings.push({ level: 'trouble', code: 'srm', text: `sample ratio mismatch: the split is off (p = ${a.srm.toExponential(1)}), so assignment or tracking is broken` });
  }
  for (const r of rows.filter((x) => !x.isControl)) {
    if (r.win != null && r.win <= WORSE && minArm >= MIN_PER_ARM) {
      findings.push({ level: 'trouble', code: 'worse', text: `${clean(r.key)} is clearly worse than control (${(r.win * 100).toFixed(1)}% chance to beat it, lift ${(r.lift * 100).toFixed(0)}%)` });
    }
  }
  const pts = (results?.results?.payload ?? results?.payload)?.exposures_timeseries?.points || [];
  const lastBucket = pts.length ? new Date(pts[pts.length - 1].bucket) : null;
  if (lastBucket && (now - lastBucket) / 3_600_000 > STALL_HOURS) {
    findings.push({ level: 'warn', code: 'stalled', text: `no new exposures for ${Math.floor((now - lastBucket) / 3_600_000)}h: check the SDK still calls getExperimentFlag (\`flagkit tail\`)` });
  }
  if (results?.results?.last_error_at) findings.push({ level: 'warn', code: 'compute', text: `results last failed to compute at ${clean(results.results.last_error_at)}` });
  return { findings, analysis: a };
}

export async function checkOnce(state, { log = console.log } = {}) {
  const api = adminOf(state);
  const report = [];
  for (const env of state.environments) {
    const running = (await api.list(`environments/${env.api_key}/experiments/`)).filter((e) => e.status === 'running');
    for (const exp of running) {
      const base = `environments/${env.api_key}/experiments/${exp.id}`;
      await api.post(`${base}/results/refresh/`).catch(() => {}); // at most once / 5 min; a 429 is fine
      const results = await api.get(`${base}/results/`).catch(() => null);
      const { findings, analysis } = assess(exp, results);
      const entry = { environment: env.name, id: exp.id, name: clean(exp.name), users: analysis.total, findings, filed: null };
      const trouble = findings.filter((f) => f.level === 'trouble');
      if (trouble.length) {
        const already = listChanges('pending').find((c) => c.kind === 'ship_winner' && Number(c.params.experiment_id) === exp.id && c.params.environment === env.name);
        if (already) entry.filed = already.id;
        else {
          const c = await proposeChange(state, {
            kind: 'ship_winner',
            params: { experiment_id: exp.id, environment: env.name, winner: 'control' },
            reason: `flagkit watch guardrail: ${trouble.map((f) => f.text).join('; ')}`.slice(0, 500),
            requestedBy: 'flagkit-watch',
          });
          entry.filed = c.id;
          entry.new = true;
        }
      }
      report.push(entry);
      const mark = trouble.length ? '🚨' : findings.length ? '⚠️ ' : '✅';
      log(`${mark} ${env.name} #${exp.id} ${clean(exp.name)} · ${analysis.total} users${findings.length ? '' : ' · healthy'}`);
      for (const f of findings) log(`     ${f.level === 'trouble' ? 'trouble' : 'warning'}: ${f.text}`);
      if (entry.filed) log(`     → ${entry.new ? 'filed' : 'already pending'} ${entry.filed}: send everyone back to control. A human approves in \`flagkit tui\` → Approvals or \`flagkit approve ${entry.filed}\`.`);
    }
  }
  if (!report.length) log('no running experiments');
  return report;
}

export async function runWatch(state, { interval = 300, once = false, json = false } = {}) {
  const sec = Math.max(60, Number(interval) || 300); // results only recompute every 5 minutes anyway
  const log = json ? () => {} : console.log;
  for (;;) {
    if (!json) log(`\n— ${new Date().toISOString().slice(0, 19)}Z  checking running experiments —`);
    const r = await checkOnce(state, { log });
    if (json) console.log(JSON.stringify(r));
    if (once) return r;
    await new Promise((res) => setTimeout(res, sec * 1000));
  }
}
