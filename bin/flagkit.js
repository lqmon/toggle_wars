#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '../src/bootstrap.js';
import { loadState, requireState, ENV_FILE, ensureStackSecrets, STACK_ENV_FILE } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = path.join(ROOT, 'stack', 'docker-compose.yml');

const HELP = `flagkit — self-hosted Flagsmith + Experimentation, ready in one command

Usage: flagkit <command> [options]

Stack
  up [--demo]        Start self-hosted Flagsmith in Docker and bootstrap it (no clicking).
                     --demo also seeds flags + an A/B test with visitors, and serves the sample app
                     (:3000) and the admin panel (:4100): a working setup from one command
  snapshot save|restore|list [name]  The whole local Flagsmith as one file: reset before a demo,
                     roll back a bad bulk change, hand a teammate your exact setup
  down [--wipe]      Stop the stack (--wipe also deletes its data)
  bootstrap          Bootstrap an already-running Flagsmith (--api-url, --email)
  status             Show URLs, keys and environments

Diagnose
  doctor             Check ANY self-hosted Flagsmith for silent experimentation breakage, CLI/SDK
                     misconfig and security issues  (--api-url, --env-key, --fix, --json)

Experiments
  experiment create  Create the demo landing-page A/B test (flag + metric + experiment) and start it
  experiment results Print live results (win probability, lift)
  plan               How many visitors a test needs before you start
                     (--baseline 0.08 --lift 0.2 [--daily 500] [--arms 2])
  report <id>        Readable results report: verdict, health checks, chart, next step (Markdown)
                     (--env Development | --env-key <key> [--admin-key k --api-url u] [--out report.md])
  tail               Live feed of exposures and conversions as they arrive (self-hosted)
                     ([--flag f] [--env Development] [--since 10m] [--once])
  watch              Guardrails for running experiments: file a human-approved kill request on trouble
                     ([--interval 300] [--once] [--env Development])
  simulate           Send simulated visitors through an experiment
                     (--users 600 --env Development [--flag f --event e --rates control=0.08,teal=0.2])
  demo               Serve the sample landing page on http://localhost:3000
  build-page         Build the landing page as a static site for public hosting
                     (--env-key <client-side key> [--out docs] [--public-api-url https://…]; default Flagsmith Cloud)

Dashboard
  tui                Terminal dashboard: flags × environments, experiments, doctor, approvals
  panel              Local web admin panel for non-developers: guarded toggles, reasons, schedules,
                     promote Staging → Production, audit log with revert, user lookup ([--port 4100] [--code .])
  promote <from> <to>  Preview (then --yes --reason "…") copying flag states between environments
  schedule [add|run|cancel]  Scheduled flag changes (--flag f --env E --at ISO --on|--off|--value v --reason r)
  set <flag>         Change a flag, audited: --env E (--on | --off | --value v) [--reason r]
                     (Production needs a reason; flags in a running experiment are refused)
  audit [--flag f]   Every change made through FlagKit: who, why, before → after
  revert <audit id>  Put a flag back exactly as it was before that change

Code
  init <template> [dir]  Starter app with flags wired in: express | react  (typed flags, offline defaults,
                     both-sides tests, flag lint in CI)
  codegen            Typed flag names + offline defaults from Flagsmith ([--env Production] [--out f] [--lang ts|js])
  lint               Find flags the code asks for that don't exist (typos), stale and unused flags
                     ([--code .] [--flags-file src/flags.generated.js for CI without Flagsmith]
                     [--strict] [--format text|json|github]); exit 1 on errors

Agents
  explain <user>     Which flags this user gets in each environment, and why
  mcp                MCP server (stdio) for coding agents: read tools + change PROPOSALS only
  approvals [--all]  List change requests filed by agents
  approve <id>       Apply a request (interactive terminal only; type the id to confirm)
  reject <id>        Reject a request

Options
  --api-url <url>    Flagsmith URL (default http://localhost:8000)
  --project <name>   Compose project name (default flagkit)
`;

function compose(args, project, extraEnv = {}) {
  ensureStackSecrets(); // random per-machine DB password + Django secrets, 0600, gitignored
  const r = spawnSync('docker', ['compose', '-p', project, '-f', COMPOSE, '--env-file', STACK_ENV_FILE, ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function printStatus(s) {
  const dash = s.apiUrl;
  console.log(`
  Flagsmith      ${dash}
  Login          ${s.admin.email} / ${values['show-secrets'] ? s.admin.password : '•••••• (in flagsmith.env, or --show-secrets)'}
  Project        ${s.project.name} (id ${s.project.id})
  Environments   ${s.environments.map((e) => `${e.name}=${e.api_key}`).join('  ')}
  CLI creds      source ${path.relative(process.cwd(), ENV_FILE) || ENV_FILE}
`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'api-url': { type: 'string', default: 'http://localhost:8000' },
    email: { type: 'string', default: process.env.FLAGKIT_ADMIN_EMAIL || 'admin@flagkit.local' },
    project: { type: 'string', default: 'flagkit' },
    users: { type: 'string', default: '600' },
    port: { type: 'string', default: '3000' },
    wipe: { type: 'boolean', default: false },
    'show-secrets': { type: 'boolean', default: false },
    fix: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    'env-key': { type: 'string' },
    out: { type: 'string', default: 'docs' },
    'public-api-url': { type: 'string' },
    'allow-remote': { type: 'boolean', default: false },
    env: { type: 'string', default: 'Development' },
    json: { type: 'boolean', default: false },
    flag: { type: 'string' },
    event: { type: 'string' },
    rates: { type: 'string' },
    baseline: { type: 'string' },
    lift: { type: 'string' },
    daily: { type: 'string' },
    arms: { type: 'string', default: '2' },
    'admin-key': { type: 'string' },
    since: { type: 'string', default: '10m' },
    once: { type: 'boolean', default: false },
    interval: { type: 'string', default: '300' },
    traits: { type: 'string' },
    'hide-hypothesis': { type: 'boolean', default: false },
    code: { type: 'string' },
    'flags-file': { type: 'string' },
    format: { type: 'string' },
    strict: { type: 'boolean', default: false },
    'stale-days': { type: 'string', default: '14' },
    at: { type: 'string' },
    on: { type: 'boolean', default: false },
    off: { type: 'boolean', default: false },
    value: { type: 'string' },
    reason: { type: 'string' },
    actor: { type: 'string' },
    lang: { type: 'string' },
    force: { type: 'boolean', default: false },
    demo: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, sub] = positionals;

try {
  switch (cmd) {
    case 'up': {
      console.log('▶ Starting self-hosted Flagsmith (Postgres, API + dashboard, task processor)…');
      compose(['up', '-d'], values.project, { PREVENT_SIGNUP: loadState() ? 'true' : 'false' });
      console.log('▶ Bootstrapping (admin, org, project, environments, API key, experimentation)…');
      let s;
      try {
        s = await bootstrap({ apiUrl: values['api-url'], email: values.email });
      } finally {
        // Close sign-up whether or not bootstrap succeeded, so a failed first run never leaves it open.
        console.log('▶ Locking sign-up…');
        compose(['up', '-d', '--wait', 'flagsmith', 'flagsmith-task-processor'], values.project, { PREVENT_SIGNUP: 'true' });
      }
      console.log('✔ Flagsmith is ready (bound to 127.0.0.1, sign-up disabled).');
      printStatus(s);
      if (!values.demo) { console.log('  Next:  flagkit up --demo (sample data + app + admin panel)  ·  flagkit tui  ·  flagkit panel\n'); break; }
      // --demo: everything a first look needs, from the same command. Idempotent: re-running reuses what exists.
      const exp = await import('../src/experiment.js');
      const { ensureStarterFlags } = await import('../src/init.js');
      console.log('▶ Seeding demo data (starter flags, an A/B test with simulated visitors)…');
      // The API container was just recreated to lock sign-up: wait until it answers again.
      const { waitForHealthy } = await import('../src/api.js');
      await waitForHealthy(s.apiUrl, { timeoutMs: 120_000 });
      await new Promise((r) => setTimeout(r, 2000));
      await ensureStarterFlags(s);
      const x = await exp.createDemoExperiment(s, { envName: 'Development' });
      const st = loadState();
      const r = await exp.adminOf(st).get(`environments/${st.environments[0].api_key}/experiments/${x.id}/results/`).catch(() => null);
      const { summarise } = await import('../src/results.js');
      if (summarise(r).rows.reduce((a, row) => a + row.exposures, 0) < 200) {
        const { simulate } = await import('../src/simulate.js');
        await simulate(st, { users: 600, envName: 'Development' });
        await exp.adminOf(st).post(`environments/${st.environments[0].api_key}/experiments/${x.id}/results/refresh/`).catch(() => {});
      }
      const { serveDemo } = await import('../src/demo-server.js');
      const { runPanel } = await import('../src/panel.js');
      serveDemo(st, { port: 3000, envName: 'Development' });
      runPanel(st, { port: 4100, codeRoot: process.cwd() });
      console.log('\n  Also try:  flagkit tui  ·  flagkit init react my-app  ·  flagkit snapshot save clean-demo\n');
      await new Promise(() => {});
      break;
    }
    case 'down':
      compose(['down', ...(values.wipe ? ['-v'] : [])], values.project);
      break;
    case 'bootstrap': {
      const s = await bootstrap({ apiUrl: values['api-url'], email: values.email });
      printStatus(s);
      break;
    }
    case 'status':
      printStatus(requireState());
      break;
    case 'experiment': {
      const exp = await import('../src/experiment.js');
      if (sub === 'create') await exp.createDemoExperiment(requireState(), { envName: values.env });
      else if (sub === 'results') await exp.printResults(requireState(), { envName: values.env, json: values.json });
      else console.log('Usage: flagkit experiment create|results');
      break;
    }
    case 'plan': {
      const { printPlan } = await import('../src/plan.js');
      if (!values.baseline || !values.lift) throw new Error('Usage: flagkit plan --baseline 0.08 --lift 0.2 [--daily 500]  (rates as fractions: 0.08 = 8%, 0.2 = +20%)');
      printPlan({ baseline: Number(values.baseline), lift: Number(values.lift), daily: values.daily ? Number(values.daily) : undefined, arms: Number(values.arms) });
      break;
    }
    case 'report': {
      const { resolveSource } = await import('../src/source.js');
      const { buildReport } = await import('../src/report.js');
      if (!/^\d+$/.test(sub || '')) throw new Error('Usage: flagkit report <experiment id> [--env Development | --env-key <key>] [--out report.md] [--json]');
      const explicitUrl = process.argv.some((a) => a === '--api-url' || a.startsWith('--api-url='));
      const src = resolveSource({ apiUrl: explicitUrl ? values['api-url'] : undefined, adminKey: values['admin-key'] || process.env.FLAGSMITH_ADMIN_KEY, envKey: values['env-key'], envName: values.env });
      const r = await buildReport(src, sub, { hideHypothesis: values['hide-hypothesis'] });
      if (values.json) console.log(JSON.stringify({ action: r.action, verdict: r.verdict, checks: r.checks, rows: r.s.rows, srm: r.srm }));
      else if (values.out !== 'docs') { const fs = await import('node:fs'); fs.writeFileSync(values.out, r.markdown); console.log(`✔ wrote ${values.out} (${r.action})`); }
      else console.log(r.markdown);
      break;
    }
    case 'tail': {
      const { runTail } = await import('../src/tail.js');
      await runTail(requireState(), { envName: values.env, flag: values.flag, since: values.since, once: values.once, project: values.project });
      break;
    }
    case 'watch': {
      const { runWatch } = await import('../src/watch.js');
      await runWatch(requireState(), { envName: values.env, interval: Number(values.interval), once: values.once, json: values.json });
      break;
    }
    case 'explain': {
      const { explain } = await import('../src/explain.js');
      if (!sub) throw new Error('Usage: flagkit explain <identity> [--flag f] [--env Development] [--traits plan=pro,country=IN]');
      console.log(await explain(requireState(), { identity: sub, flag: values.flag, traits: values.traits }));
      break;
    }
    case 'simulate': {
      const { simulate } = await import('../src/simulate.js');
      await simulate(requireState(), { users: Number(values.users), envName: values.env, flag: values.flag, event: values.event, rates: values.rates, allowRemote: values['allow-remote'] });
      break;
    }
    case 'demo': {
      const { serveDemo } = await import('../src/demo-server.js');
      serveDemo(requireState(), { port: Number(values.port), envName: values.env });
      break;
    }
    case 'build-page': {
      const { buildPage } = await import('../src/build-page.js');
      buildPage({ envKey: values['env-key'], out: values.out, apiUrl: values['public-api-url'] });
      break;
    }
    case 'doctor': {
      const { runDoctor } = await import('../src/doctor.js');
      const st = loadState();
      const target = values['api-url'] !== 'http://localhost:8000' ? values['api-url'] : process.env.FLAGSMITH_API_URL || st?.apiUrl || values['api-url'];
      // Saved keys belong to the saved instance: never send them to a different host.
      const sameHost = st && new URL(st.apiUrl).origin === new URL(target).origin;
      if (st && !sameHost) console.error(`note: not using saved keys for ${new URL(target).origin} (they belong to ${new URL(st.apiUrl).origin})`);
      process.exitCode = await runDoctor({
        apiUrl: target,
        envKey: values['env-key'] || process.env.FLAGSMITH_ENVIRONMENT || (sameHost ? st.environments?.[0]?.api_key : undefined),
        adminKey: process.env.FLAGSMITH_ADMIN_KEY || (sameHost ? st.masterKey : undefined),
        fix: values.fix, yes: values.yes, json: values.json,
      });
      break;
    }
    case 'mcp': {
      const { runMcp } = await import('../src/mcp.js');
      await runMcp(requireState());
      break;
    }
    case 'approvals': {
      const { listChanges, describeParams } = await import('../src/approvals.js');
      const { clean } = await import('../src/sanitize.js');
      const rows = listChanges(values.all ? undefined : 'pending');
      if (!rows.length) console.log(values.all ? 'No change requests.' : 'No pending change requests. (--all to see history)');
      // Everything an agent or server wrote is cleaned of control characters before it reaches the terminal.
      for (const c of rows) console.log(`${clean(c.id)}  ${clean(c.status).padEnd(8)} ${describeParams(c)}\n           reason: ${clean(c.reason)}${c.result ? `\n           result: ${clean(c.result)}` : ''}`);
      break;
    }
    case 'approve':
    case 'reject': {
      const { getChange, approveChange, rejectChange } = await import('../src/approvals.js');
      const id = sub;
      const c = id && getChange(id);
      if (!c) throw new Error(`Usage: flagkit ${cmd} <change id>  (see \`flagkit approvals\`)`);
      // Approval is a human act: require an interactive terminal and a typed confirmation.
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`${cmd} needs an interactive terminal (a person, not a script or agent).`);
      const { clean } = await import('../src/sanitize.js');
      const { describeParams, isProduction } = await import('../src/approvals.js');
      // Free text first (cleaned), then the facts built from the structured params, then the
      // Production warning last, directly above the prompt, so nothing printed earlier can cover it.
      console.log(`\nreason (from the requester): ${clean(c.reason)}`);
      console.log(`requested by ${clean(c.requestedBy)} at ${clean(c.createdAt)}\n`);
      console.log(`  change:  ${describeParams(c)}`);
      console.log(`  before:  ${clean(c.before)}`);
      console.log(`  after:   ${clean(c.after)}`);
      if (isProduction(requireState(), c)) console.log(`\n  ⚠  PRODUCTION: this changes what real users get.`);
      console.log('');
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const typed = (await rl.question(`Type the change id to ${cmd} it: `)).trim();
      rl.close();
      if (typed !== c.id) { console.log('Not confirmed. Nothing changed.'); break; }
      const done = cmd === 'approve' ? await approveChange(requireState(), c.id) : rejectChange(c.id);
      console.log(`${done.status === 'applied' ? '✔' : done.status === 'rejected' ? '✖ rejected' : '✖ failed'}  ${done.result || ''}`);
      break;
    }
    case 'panel': {
      const { runPanel } = await import('../src/panel.js');
      runPanel(requireState(), { port: process.argv.some((a) => a.startsWith('--port')) ? Number(values.port) : 4100, codeRoot: path.resolve(values.code || '.') });
      await new Promise(() => {});
      break;
    }
    case 'lint': {
      const { loadFlags, scanCode, lint, formatLint } = await import('../src/flags.js');
      let flags, names;
      if (values['flags-file']) {
        // Offline (CI): the flag list comes from the committed codegen file; only unknown-flag checks apply.
        const { readSnapshot } = await import('../src/codegen.js');
        names = Object.keys(readSnapshot(values['flags-file']));
        flags = [];
      } else {
        const { adminOf } = await import('../src/experiment.js');
        const st = requireState();
        flags = await loadFlags(adminOf(st), { projectId: st.project.id, environments: st.environments });
        names = flags.map((f) => f.name);
      }
      const scan = scanCode(path.resolve(values.code || '.'), names);
      const findings = lint(flags, scan, { staleDays: Number(values['stale-days']) });
      const format = values.json ? 'json' : values.format || (process.env.GITHUB_ACTIONS ? 'github' : 'text');
      console.log(formatLint(findings, { format }));
      if (format === 'github') console.log(formatLint(findings));
      process.exitCode = findings.some((f) => f.level === 'error') || (values.strict && findings.length) ? 1 : 0;
      break;
    }
    case 'schedule': {
      const ch = await import('../src/changes.js');
      const { clean } = await import('../src/sanitize.js');
      if (sub === 'run') {
        const ran = await ch.runDueSchedules(requireState());
        for (const s of ran) console.log(`${clean(s.id)}  ${clean(s.flag)} in ${clean(s.env)} → ${clean(s.status)} (${clean(s.result)})`);
        if (!ran.length) console.log('Nothing due.');
      } else if (sub === 'add') {
        if (!values.flag || !values.at) throw new Error('Usage: flagkit schedule add --flag f --env Production --at 2026-12-01T09:00 (--on | --off | --value v) --reason "…" --actor you');
        const s = await ch.addSchedule(requireState(), { flag: values.flag, env: values.env, at: values.at, enabled: values.on ? true : values.off ? false : undefined, value: values.value }, { actor: values.actor || process.env.USER, reason: values.reason });
        console.log(`✔ ${s.id}: ${s.flag} in ${s.env} at ${new Date(s.at).toLocaleString()}`);
      } else if (sub === 'cancel') {
        const id = positionals[2];
        console.log(`cancelled ${ch.cancelSchedule(id, process.env.USER).id}`);
      } else {
        const list = ch.listSchedules(values.all ? undefined : 'pending');
        if (!list.length) console.log(values.all ? 'No schedules.' : 'Nothing scheduled. (--all for history)');
        for (const s of list) console.log(`${clean(s.id)}  ${clean(s.status).padEnd(9)} ${new Date(s.at).toLocaleString().padEnd(22)} ${clean(s.flag)} in ${clean(s.env)} → ${s.value !== undefined ? `value=${clean(s.value)}` : s.enabled ? 'ON' : 'OFF'}  (${clean(s.actor)}: ${clean(s.reason)})`);
      }
      break;
    }
    case 'promote': {
      const ch = await import('../src/changes.js');
      const { clean } = await import('../src/sanitize.js');
      const [from, to] = [positionals[1], positionals[2]];
      if (!from || !to) throw new Error('Usage: flagkit promote <from env> <to env> [--flag f] [--yes --reason "…"]');
      const only = values.flag ? values.flag.split(',') : undefined;
      const plan = await ch.promotePlan(requireState(), { from, to, flags: only });
      if (!plan.length) { console.log(`${to} already matches ${from}.`); break; }
      const st = (x) => `${x.enabled ? 'on' : 'off'}${x.value != null && x.value !== '' ? ` ${clean(String(x.value))}` : ''}`;
      for (const p of plan) console.log(`  ${clean(p.flag).padEnd(24)} ${st(p.to).padEnd(18)} → ${st(p.from)}${p.blocked ? `   🔒 skipped: ${p.blocked}` : ''}`);
      if (!values.yes) { console.log(`\nPreview only. Re-run with --yes --reason "…" to copy these to ${to}.`); break; }
      const done = await ch.promote(requireState(), { from, to, flags: only }, { actor: values.actor || process.env.USER, reason: values.reason, via: 'cli' });
      for (const d of done) console.log(d.error ? `✖ ${clean(d.flag)}: ${d.error}` : d.skipped ? `· ${clean(d.flag)}: skipped (${d.skipped})` : `✔ ${clean(d.flag)} (${d.id})`);
      break;
    }
    case 'set': {
      const ch = await import('../src/changes.js');
      if (!sub || (!values.on && !values.off && values.value === undefined)) throw new Error('Usage: flagkit set <flag> --env Development (--on | --off | --value v) [--reason "…"] [--actor you]');
      const r = await ch.setFlag(requireState(), { flag: sub, env: values.env, enabled: values.on ? true : values.off ? false : undefined, value: values.value }, { actor: values.actor || process.env.USER || 'cli', reason: values.reason, via: 'cli' });
      const { clean } = await import('../src/sanitize.js');
      const st = (x) => `${x.enabled ? 'on' : 'off'}${x.value != null && x.value !== '' ? ` ${clean(String(x.value))}` : ''}`;
      console.log(r.noop ? 'Already in that state.' : `✔ ${clean(sub)} in ${clean(r.env)}: ${st(r.before)} → ${st(r.after)}  (${r.id}; undo: flagkit revert ${r.id})`);
      break;
    }
    case 'audit': {
      const ch = await import('../src/changes.js');
      const { clean } = await import('../src/sanitize.js');
      const st = (x) => `${x.enabled ? 'on' : 'off'}${x.value != null && x.value !== '' ? ` ${clean(String(x.value))}` : ''}`;
      const list = ch.auditLog({ flag: values.flag, limit: 50 });
      if (!list.length) console.log('No changes recorded yet.');
      for (const e of list) console.log(`${clean(e.id)}  ${clean(e.at).slice(0, 19)}  ${clean(e.flag)} in ${clean(e.env)}: ${st(e.before)} → ${st(e.after)}  by ${clean(e.actor)} via ${clean(e.via)}${e.reason ? `  “${clean(e.reason)}”` : ''}`);
      break;
    }
    case 'revert': {
      const ch = await import('../src/changes.js');
      if (!sub) throw new Error('Usage: flagkit revert <audit id> [--reason "…"]  (ids from `flagkit audit`)');
      const r = await ch.revert(requireState(), sub, { actor: values.actor || process.env.USER, reason: values.reason, via: 'cli' });
      console.log(r.noop ? 'Already in that state.' : `✔ ${r.flag} in ${r.env} reverted (${r.id})`);
      break;
    }
    case 'codegen': {
      const { codegen } = await import('../src/codegen.js');
      const out = await codegen(requireState(), { env: values.env === 'Development' && !process.argv.includes('--env') ? 'Production' : values.env, out: values.out === 'docs' ? undefined : values.out, lang: values.lang });
      console.log(`✔ wrote ${out.file}: ${out.count} flags, typed, with ${out.env} values as offline defaults`);
      break;
    }
    case 'init': {
      const { init } = await import('../src/init.js');
      await init(loadState(), { template: sub, dir: positionals[2], force: values.force });
      break;
    }
    case 'snapshot': {
      const snap = await import('../src/snapshot.js');
      const name = positionals[2];
      if (sub === 'save') {
        const r = snap.saveSnapshot(name || new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19));
        console.log(`✔ snapshot "${r.name}": ${(r.bytes / 1024).toFixed(0)} KB compressed (${(r.rawBytes / 1024 / 1024).toFixed(1)} MB of SQL) in ${path.relative(process.cwd(), r.file)}`);
      } else if (sub === 'restore') {
        if (!name) throw new Error('Usage: flagkit snapshot restore <name>  (see `flagkit snapshot list`)');
        if (!values.yes) {
          if (!process.stdin.isTTY) throw new Error('restore replaces ALL Flagsmith data; pass --yes to confirm non-interactively');
          const readline = await import('node:readline/promises');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const typed = (await rl.question(`This replaces ALL data in the local Flagsmith with snapshot "${name}". Type the name to confirm: `)).trim();
          rl.close();
          if (typed !== name) { console.log('Not confirmed. Nothing changed.'); break; }
        }
        snap.restoreSnapshot(name, { compose: (args) => compose(args, values.project) });
        console.log(`✔ restored "${name}"`);
      } else {
        const list = snap.listSnapshots();
        if (!list.length) console.log('No snapshots. `flagkit snapshot save <name>` takes one.');
        for (const x of list) console.log(`${x.name.padEnd(30)} ${(x.bytes / 1024).toFixed(0).padStart(6)} KB  ${x.at.slice(0, 19).replace('T', ' ')}`);
      }
      break;
    }
    case 'tui': {
      const { runTui } = await import('../src/tui.js');
      await runTui(requireState());
      break;
    }
    default:
      console.log(HELP);
      if (!loadState() && cmd) process.exitCode = 1;
  }
} catch (e) {
  console.error(`✖ ${e.message}`);
  process.exit(1);
}
