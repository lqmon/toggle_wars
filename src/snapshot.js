// flagkit snapshot save|restore|list: the whole self-hosted Flagsmith (flags, segments, identities,
// experiments, events, users and keys) as one file. Uses:
//   - reset to a known state before a demo, a test run or a training session
//   - roll back a bad bulk change in seconds
//   - hand a teammate an exact copy of your setup
// Snapshots live in .flagkit/snapshots/ (0600, never committed) together with the FlagKit state that matches them.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { STATE_DIR, STATE_FILE, ensureStateDir, writeSecure } from './config.js';

const CONTAINER = process.env.FLAGKIT_DB_CONTAINER || 'flagsmith_postgres';
const DIR = () => path.join(STATE_DIR, 'snapshots');
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

function checkName(name) {
  if (!NAME.test(name || '')) throw new Error('Snapshot name: letters, digits, "_", "." and "-" (up to 60)');
  return name;
}

export function listSnapshots() {
  try {
    return fs.readdirSync(DIR()).filter((f) => f.endsWith('.sql.gz')).map((f) => {
      const st = fs.statSync(path.join(DIR(), f));
      return { name: f.replace(/\.sql\.gz$/, ''), bytes: st.size, at: st.mtime.toISOString() };
    }).sort((a, b) => b.at.localeCompare(a.at));
  } catch { return []; }
}

export function saveSnapshot(name) {
  checkName(name);
  const dump = spawnSync('docker', ['exec', CONTAINER, 'pg_dump', '-U', 'postgres', '-d', 'flagsmith', '--clean', '--if-exists', '--no-owner'], { maxBuffer: 1024 * 1024 * 1024 });
  if (dump.status !== 0) throw new Error(`pg_dump failed: ${String(dump.stderr || dump.error?.message).trim().slice(0, 300)}. Is the stack up (\`flagkit up\`)?`);
  ensureStateDir();
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  const file = path.join(DIR(), `${name}.sql.gz`);
  writeSecure(file, zlib.gzipSync(dump.stdout));
  try { writeSecure(path.join(DIR(), `${name}.state.json`), fs.readFileSync(STATE_FILE)); } catch { /* no state yet */ }
  return { name, file, bytes: fs.statSync(file).size, rawBytes: dump.stdout.length };
}

// compose(args) runs `docker compose` for this stack (passed in from the CLI, which owns the compose config).
export function restoreSnapshot(name, { compose }) {
  checkName(name);
  const file = path.join(DIR(), `${name}.sql.gz`);
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) throw new Error(`No snapshot "${name}" (see \`flagkit snapshot list\`)`);
  const sql = zlib.gunzipSync(fs.readFileSync(file));
  // Stop the API and task processor so nothing writes while the database is replaced.
  compose(['stop', 'flagsmith', 'flagsmith-task-processor']);
  try {
    const r = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-q', '-U', 'postgres', '-d', 'flagsmith', '-v', 'ON_ERROR_STOP=1'], { input: sql, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`restore failed: ${String(r.stderr).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
  } finally {
    compose(['up', '-d', '--wait', 'flagsmith', 'flagsmith-task-processor']);
  }
  const stateCopy = path.join(DIR(), `${name}.state.json`);
  if (fs.existsSync(stateCopy) && !fs.lstatSync(stateCopy).isSymbolicLink()) writeSecure(STATE_FILE, fs.readFileSync(stateCopy));
  return { name };
}
