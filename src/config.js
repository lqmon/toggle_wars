import fs from 'node:fs';
import path from 'node:path';

// State lives in the directory you run flagkit from, so each project gets its own stack.
export const STATE_DIR = path.resolve(process.env.FLAGKIT_HOME || '.flagkit');
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const ENV_FILE = path.resolve('flagsmith.env');

export function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

export function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function requireState() {
  const s = loadState();
  if (!s) {
    console.error('No FlagKit state found. Run `flagkit up` first (or `flagkit bootstrap` if Flagsmith is already running).');
    process.exit(1);
  }
  return s;
}

// FLAGSMITH_API_KEY_<host>: '-' doubled, '.' and ':' -> '_'  (e.g. localhost:8000 -> localhost_8000)
export function cliKeyVar(apiUrl) {
  const host = new URL(apiUrl).host.replace(/-/g, '--').replace(/[.:]/g, '_');
  return `FLAGSMITH_API_KEY_${host}`;
}

// flagsmith.env is what the official Flagsmith CLI + coding-agent prompt expect for a local instance.
export function writeEnvFile(state) {
  const dev = state.environments.find((e) => e.name === 'Development') || state.environments[0];
  const lines = [
    '# Written by flagkit. Load with: source flagsmith.env',
    `export FLAGSMITH_API_URL=${state.apiUrl}`,
    // The Flagsmith CLI only accepts host-scoped keys for non-Cloud hosts.
    `export ${cliKeyVar(state.apiUrl)}=${state.masterKey}`,
    `export FLAGSMITH_SDK_API_URL=${state.apiUrl}`,
    `export FLAGSMITH_ENVIRONMENT_KEY=${dev.api_key}`,
    `export FLAGSMITH_ENVIRONMENT=${dev.api_key}`,
    `export FLAGSMITH_PROJECT=${state.project.id}`,
    `export FLAGSMITH_PROJECT_ID=${state.project.id}`,
    `export FLAGSMITH_NO_INPUT=1`,
    `export FLAGSMITH_DASHBOARD_URL=${state.apiUrl}`,
    `# Dashboard login (local test instance only)`,
    `export FLAGKIT_ADMIN_EMAIL=${state.admin.email}`,
    `export FLAGKIT_ADMIN_PASSWORD=${state.admin.password}`,
    ...state.environments.map((e) => `export FLAGSMITH_ENV_${e.name.toUpperCase().replace(/\W+/g, '_')}=${e.api_key}`),
    '',
  ];
  fs.writeFileSync(ENV_FILE, lines.join('\n'), { mode: 0o600 });
}
