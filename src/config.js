import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// State lives in the directory you run flagkit from, so each project gets its own stack.
export const STATE_DIR = path.resolve(process.env.FLAGKIT_HOME || '.flagkit');
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const ENV_FILE = path.resolve('flagsmith.env');
export const STACK_ENV_FILE = path.join(STATE_DIR, 'stack.env');

// A cloned repository could plant `flagsmith.env -> ~/.zshrc` or a `.flagkit` symlink. Refuse to write
// through symlinks: write a fresh temp file next to the target (O_EXCL, 0600) and rename it into place.
function refuseSymlink(p) {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`Refusing to write ${p}: it is a symbolic link`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

export function ensureStateDir() {
  refuseSymlink(STATE_DIR);
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  refuseSymlink(STATE_DIR);
}

export function writeSecure(file, data) {
  const dir = path.dirname(file);
  if (dir === STATE_DIR) ensureStateDir();
  refuseSymlink(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' }); // wx: fail if it exists, never follow a link
  fs.renameSync(tmp, file); // rename replaces a path entry; it does not write through a link at `file`
}

// Keep secrets out of commits when flagkit runs inside someone's git repo.
function excludeFromGit() {
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (inRepo.status !== 0 || inRepo.stdout.trim() !== 'true') return;
  const missing = ['flagsmith.env', '.flagkit/'].filter(
    (p) => spawnSync('git', ['check-ignore', '-q', p.replace(/\/$/, '/x')]).status !== 0,
  );
  if (!missing.length) return;
  const gitDir = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).stdout.trim();
  if (!gitDir) return;
  try {
    fs.mkdirSync(path.dirname(gitDir), { recursive: true });
    fs.appendFileSync(gitDir, `\n# added by flagkit: local secrets\n${missing.join('\n')}\n`);
  } catch { /* best effort */ }
}

// Docker Compose secrets, generated once per machine. Never committed (.flagkit/ is gitignored).
export function ensureStackSecrets() {
  ensureStateDir();
  if (fs.existsSync(STACK_ENV_FILE)) return;
  const rnd = (n) => crypto.randomBytes(n).toString('hex');
  writeSecure(STACK_ENV_FILE, [`POSTGRES_PASSWORD=${rnd(24)}`, `DJANGO_SECRET_KEY=${rnd(32)}`, `WAREHOUSE_CREDENTIALS_SECRET=${rnd(32)}`, ''].join('\n'));
}

export function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

export function saveState(state) {
  writeSecure(STATE_FILE, JSON.stringify(state, null, 2));
  excludeFromGit();
}

export function requireState() {
  const s = loadState();
  if (!s) {
    console.error('No FlagKit state found. Run `flagkit up` first (or `flagkit bootstrap` if Flagsmith is already running).');
    process.exit(1);
  }
  return s;
}

// FLAGSMITH_API_KEY_<host>: '-' -> '__', '.' and ':' -> '_'  (e.g. localhost:8000 -> localhost_8000)
export function cliKeyVar(apiUrl) {
  const host = new URL(apiUrl).host.replace(/-/g, '__').replace(/[.:]/g, '_');
  return `FLAGSMITH_API_KEY_${host}`;
}

// Values come from a Flagsmith server; flagsmith.env gets `source`d. Validate shape AND single-quote,
// so a hostile server can never turn a key into a shell command.
const TOKEN = /^[A-Za-z0-9._:/-]{1,200}$/;
function shq(name, value, pattern = TOKEN) {
  const v = String(value ?? '');
  if (!pattern.test(v)) throw new Error(`Refusing to write ${name} to flagsmith.env: unexpected characters in the value from the server`);
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

// flagsmith.env is what the official Flagsmith CLI + coding-agent prompt expect for a local instance.
export function writeEnvFile(state) {
  const dev = state.environments.find((e) => e.name === 'Development') || state.environments[0];
  const url = shq('FLAGSMITH_API_URL', state.apiUrl, /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/);
  const varName = (n) => `FLAGSMITH_ENV_${String(n).toUpperCase().replace(/\W+/g, '_')}`;
  const lines = [
    '# Written by flagkit. Load with: source flagsmith.env',
    `export FLAGSMITH_API_URL=${url}`,
    // The Flagsmith CLI only accepts host-scoped keys for non-Cloud hosts.
    `export ${cliKeyVar(state.apiUrl)}=${shq('admin key', state.masterKey)}`,
    `export FLAGSMITH_SDK_API_URL=${url}`,
    `export FLAGSMITH_ENVIRONMENT_KEY=${shq('environment key', dev.api_key)}`,
    `export FLAGSMITH_ENVIRONMENT=${shq('environment key', dev.api_key)}`,
    `export FLAGSMITH_PROJECT=${shq('project id', state.project.id, /^\d+$/)}`,
    `export FLAGSMITH_PROJECT_ID=${shq('project id', state.project.id, /^\d+$/)}`,
    `export FLAGSMITH_NO_INPUT=1`,
    `export FLAGSMITH_DASHBOARD_URL=${url}`,
    `# Dashboard login (local test instance only)`,
    `export FLAGKIT_ADMIN_EMAIL=${shq('admin email', state.admin.email, /^[^\s'"`$\\;|&<>]{3,200}$/)}`,
    `export FLAGKIT_ADMIN_PASSWORD=${shq('admin password', state.admin.password, /^[A-Za-z0-9_-]{8,200}$/)}`,
    ...state.environments
      .filter((e) => /^\w[\w -]{0,60}$/.test(e.name))
      .map((e) => `export ${varName(e.name)}=${shq('environment key', e.api_key)}`),
    '',
  ];
  writeSecure(ENV_FILE, lines.join('\n'));
  excludeFromGit();
}
