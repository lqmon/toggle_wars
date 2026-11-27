#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '../src/bootstrap.js';
import { loadState, requireState, ENV_FILE } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = path.join(ROOT, 'stack', 'docker-compose.yml');

const HELP = `flagkit — self-hosted Flagsmith + Experimentation, ready in one command

Usage: flagkit <command> [options]

Stack
  up                 Start self-hosted Flagsmith in Docker and bootstrap it (no clicking)
  down [--wipe]      Stop the stack (--wipe also deletes its data)
  bootstrap          Bootstrap an already-running Flagsmith (--api-url, --email)
  status             Show URLs, keys and environments

Experiments
  experiment create  Create the demo landing-page A/B test (flag + metric + experiment) and start it
  experiment results Print live results (win probability, lift)
  simulate           Send simulated visitors through an experiment
                     (--users 600 --env Development [--flag f --event e --rates control=0.08,teal=0.2])
  demo               Serve the sample landing page on http://localhost:3000

Dashboard
  tui                Terminal dashboard: flags across environments + live experiment results

Options
  --api-url <url>    Flagsmith URL (default http://localhost:8000)
  --project <name>   Compose project name (default flagkit)
`;

function compose(args, project) {
  const r = spawnSync('docker', ['compose', '-p', project, '-f', COMPOSE, ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function printStatus(s) {
  const dash = s.apiUrl;
  console.log(`
  Flagsmith      ${dash}
  Login          ${s.admin.email} / ${s.admin.password}
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
    env: { type: 'string', default: 'Development' },
    json: { type: 'boolean', default: false },
    flag: { type: 'string' },
    event: { type: 'string' },
    rates: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, sub] = positionals;

try {
  switch (cmd) {
    case 'up': {
      console.log('▶ Starting self-hosted Flagsmith (Postgres, API + dashboard, task processor)…');
      compose(['up', '-d'], values.project);
      console.log('▶ Bootstrapping (admin, org, project, environments, API key, experimentation)…');
      const s = await bootstrap({ apiUrl: values['api-url'], email: values.email });
      console.log('✔ Flagsmith is ready.');
      printStatus(s);
      console.log('  Next:  flagkit experiment create  →  flagkit simulate  →  flagkit tui\n');
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
    case 'simulate': {
      const { simulate } = await import('../src/simulate.js');
      await simulate(requireState(), { users: Number(values.users), envName: values.env, flag: values.flag, event: values.event, rates: values.rates });
      break;
    }
    case 'demo': {
      const { serveDemo } = await import('../src/demo-server.js');
      serveDemo(requireState(), { port: Number(values.port), envName: values.env });
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
