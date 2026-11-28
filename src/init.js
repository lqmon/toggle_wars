// flagkit init <express|react> [dir]: a starter app with flags already wired in and working.
// With a local stack (flagkit up) it also creates the starter flags in Flagsmith, generates the typed flag
// file from them, and writes .env, so `npm install && npm run dev` shows live flags immediately.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminOf, envOf, ensureFeature } from './experiment.js';
import { loadFlags } from './flags.js';
import { snapshotOf, render } from './codegen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
export const TEMPLATES = ['express', 'react'];

// The four patterns every product needs: kill switch, release toggle, remote config, experiment.
export const STARTER_FLAGS = [
  { name: 'maintenance_mode', description: 'Kill switch: shows a maintenance page everywhere', enabled: false, value: null },
  { name: 'checkout_v2', description: 'Release toggle: the new one-page checkout', enabled: false, value: null, devOn: true },
  { name: 'welcome_message', description: 'Remote config: the home page headline', enabled: true, value: 'Welcome to the FlagKit starter' },
  { name: 'pricing_layout', description: 'Experiment: pricing cards stacked (control) vs side by side (compact)', enabled: true, value: 'control', variants: ['compact'] },
];

// Used when there is no Flagsmith to read from: the app still runs, on these defaults.
export function offlineSnapshot() {
  return {
    project: 'starter (offline)', environment: 'defaults',
    flags: Object.fromEntries(STARTER_FLAGS.map((f) => [f.name, {
      type: f.variants ? 'multivariate' : 'standard', ...(f.variants ? { variants: ['control', ...f.variants] } : {}),
      description: f.description, default: { enabled: f.enabled, value: f.value },
    }])),
  };
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.isSymbolicLink()) continue;
    const to = path.join(dst, e.name === 'gitignore' ? '.gitignore' : e.name); // npm drops .gitignore from packages
    if (e.isDirectory()) copyDir(path.join(src, e.name), to);
    else fs.copyFileSync(path.join(src, e.name), to);
  }
}

export async function ensureStarterFlags(state) {
  const api = adminOf(state);
  const pid = state.project.id;
  const existing = await api.list(`projects/${pid}/features/`);
  for (const f of STARTER_FLAGS) {
    if (f.variants) {
      await ensureFeature(api, pid, { flag: f.name, control: f.value, variants: f.variants.map((k) => ({ key: k, value: k })), description: f.description, defaultEnabled: f.enabled });
      continue;
    }
    if (existing.some((x) => x.name === f.name)) continue;
    const created = await api.post(`projects/${pid}/features/`, { name: f.name, description: f.description, default_enabled: f.enabled, ...(f.value != null ? { initial_value: f.value } : {}) });
    console.log(`  › created flag "${f.name}"`);
    if (f.devOn) {
      const dev = envOf(state, 'Development');
      const fsx = (await api.list(`features/featurestates/?environment=${dev.id}&feature=${created.id}`)).find((s) => s.feature_segment == null && s.identity == null);
      if (fsx) await api.patch(`environments/${dev.api_key}/featurestates/${fsx.id}/`, { enabled: true });
      console.log(`  › turned "${f.name}" on in Development only`);
    }
  }
}

export async function init(state, { template, dir, force = false } = {}) {
  if (!TEMPLATES.includes(template)) throw new Error(`Usage: flagkit init <${TEMPLATES.join('|')}> [dir]`);
  const target = path.resolve(dir || `flagkit-${template}`);
  if (fs.existsSync(target) && fs.readdirSync(target).length && !force) throw new Error(`${target} is not empty (use --force to write into it)`);
  copyDir(path.join(ROOT, template), target);
  console.log(`✔ ${template} starter in ${path.relative(process.cwd(), target) || '.'}`);

  let snapshot;
  if (state) {
    await ensureStarterFlags(state);
    const flags = await loadFlags(adminOf(state), { projectId: state.project.id, environments: state.environments });
    // Types for every flag in the project; the starter's own pages use the four above.
    snapshot = snapshotOf(flags, envOf(state, 'Production').name, state.project.name);
    const dev = envOf(state, 'Development');
    const envText = template === 'react'
      ? `VITE_FLAGSMITH_ENVIRONMENT_KEY=${dev.api_key}\nVITE_FLAGSMITH_API_URL=${state.apiUrl}\n`
      : `FLAGSMITH_ENVIRONMENT_KEY=${dev.api_key}\nFLAGSMITH_API_URL=${state.apiUrl}\n`;
    fs.writeFileSync(path.join(target, '.env'), `# Client-side Development key for the local Flagsmith (not a secret, but kept out of git)\n${envText}`);
    console.log(`  › .env points at ${state.apiUrl} (Development); defaults come from Production`);
  } else {
    snapshot = offlineSnapshot();
    console.log('  › no local Flagsmith (run `flagkit up`): the app runs on built-in defaults until you set the .env keys');
  }
  fs.writeFileSync(path.join(target, 'src', 'flags.generated.js'), render(snapshot, 'js'));
  console.log(`  › src/flags.generated.js: ${Object.keys(snapshot.flags).length} typed flags with offline defaults`);
  const rel = path.relative(process.cwd(), target) || '.';
  console.log(`
Next:
  cd ${rel} && npm install && npm run dev
  npm test             every flag × every state × every page must render (the flag matrix)
  npm run flags:sync   after you add or change flags in Flagsmith
  npm run flags:lint   fails on flag names the code uses that don't exist

Try it: flagkit panel → turn maintenance_mode ON in Development → reload the app.${template === 'react' ? '\nPreview any variant without touching Flagsmith: http://localhost:5173/?flags=pricing_layout=compact' : ''}
`);
  return target;
}
