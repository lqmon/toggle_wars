// Every flag, in every state it can be in, on every page: nothing may 500.
// The matrix is built from flags.generated.js, so a new flag is tested the moment you run `npm run flags:sync`.
// This catches the bug that only shows up when someone flips a flag in production you never tried locally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAGS, FLAG_DEFAULTS } from '../src/flags.generated.js';
import { createApp } from '../src/app.js';
import { createFlagClient } from '../src/flags.js';

const PAGES = [['GET', '/'], ['GET', '/pricing'], ['GET', '/checkout'], ['POST', '/upgrade'], ['GET', '/health']];

const states = (name, f) => (f.variants ? ['off', ...f.variants] : ['on', 'off']).map((s) => `${name}=${s}`);
const cases = [''].concat(Object.entries(FLAGS).flatMap(([n, f]) => states(n, f)));

async function run(force) {
  // No environment key: the matrix runs offline, on the defaults plus the forced state.
  const app = createApp({ flagClient: createFlagClient({ environmentKey: '', force: force ? (await import('../src/flags.js')).parseForce(force) : {} }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [method, path] of PAGES) {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: method === 'POST' ? 'plan=Pro' : undefined });
      assert.ok(res.status < 500 || (res.status === 503 && /maintenance_mode=on/.test(force)), `${method} ${path} → ${res.status} with ${force || 'defaults'}`);
    }
  } finally { server.close(); }
}

for (const c of cases) test(`pages render with ${c || 'the Production defaults'}`, () => run(c));

test('an unknown flag name fails loudly in development', async () => {
  const { parseForce } = await import('../src/flags.js');
  assert.throws(() => parseForce('not_a_real_flag=on'), /not a flag/);
});

test('defaults exist for every flag', () => {
  for (const name of Object.keys(FLAGS)) assert.ok(FLAG_DEFAULTS[name], name);
});
