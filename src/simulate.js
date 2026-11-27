// Simulated visitors for the demo experiment, sent through the real Flagsmith Node SDK:
// each visitor is an identity, gets bucketed by Flagsmith (exposure event), and maybe clicks Sign up (conversion).
// The click rates below are the simulation's *assumption*; the experiment has to discover them.
import { Flagsmith } from '@flagsmith/nodejs';
import { envOf } from './experiment.js';

export async function simulate(state, { users = 600, envName = 'Development', rates, flag, event, concurrency = 20 } = {}) {
  const env = envOf(state, envName);
  const exp = flag && event ? { flag, event } : state.experiments[env.name];
  if (!exp) throw new Error(`No experiment in ${env.name}. Run \`flagkit experiment create\` or pass --flag and --event.`);
  rates = { control: 0.08, benefit: 0.115, ...parseRates(rates) };

  const flagsmith = new Flagsmith({
    environmentKey: env.api_key,
    apiUrl: `${state.apiUrl}/api/v1/`,
    enableEvents: true,
    eventProcessorConfig: { eventsApiUrl: `${state.apiUrl}/api/`, flushInterval: 2000 },
  });

  const run = Date.now().toString(36);
  const tally = {};
  let done = 0;

  async function visit(i) {
    const identifier = `sim-${run}-${i}`;
    const flag = await flagsmith.getExperimentFlag(exp.flag, identifier);
    const variant = flag.variant || flag.value || 'control';
    const t = (tally[variant] ??= { visitors: 0, clicks: 0, enrolled: 0 });
    t.visitors++;
    if (flag.experiment?.inExperiment) t.enrolled++;
    const rate = rates[variant] ?? rates.control;
    if (Math.random() < rate) {
      flagsmith.trackEvent(exp.event, { identifier });
      t.clicks++;
    }
    done++;
    if (done % 50 === 0) process.stdout.write(`\r  › ${done}/${users} visitors`);
  }

  const queue = Array.from({ length: users }, (_, i) => i);
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) await visit(queue.shift());
    }),
  );
  await flagsmith.flushEvents();
  await flagsmith.close?.();

  console.log(`\r  › ${done}/${users} visitors — events flushed to ${state.apiUrl}/api/v1/events/`);
  for (const [v, t] of Object.entries(tally)) {
    console.log(`    ${v.padEnd(10)} visitors=${String(t.visitors).padStart(5)} enrolled=${String(t.enrolled).padStart(5)} clicks=${String(t.clicks).padStart(4)} (${((t.clicks / t.visitors) * 100).toFixed(1)}%)`);
  }
  console.log('\n  Results refresh at most every 5 min: `flagkit experiment results` or watch `flagkit tui`.\n');
  return tally;
}

// "control=0.08,teal=0.2" -> { control: 0.08, teal: 0.2 }
function parseRates(r) {
  if (!r || typeof r === 'object') return r || {};
  return Object.fromEntries(r.split(',').map((kv) => kv.split('=')).map(([k, v]) => [k.trim(), Number(v)]));
}
