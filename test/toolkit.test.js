// Tests for the flag toolkit: code scanning + lint, lifecycle, codegen, the admin panel's security boundary,
// starter templates, and the VS Code extension's diagnostics logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { scanText, suggest, lifecycle, drift, lint, formatLint } from '../src/flags.js';
import { snapshotOf, render, readSnapshot } from '../src/codegen.js';
import { offlineSnapshot, STARTER_FLAGS } from '../src/init.js';
import { createPanel } from '../src/panel.js';

const vsc = createRequire(import.meta.url)('../vscode-extension/lib.js');
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-28T00:00:00Z');
const flag = (name, envs, extra = {}) => ({ name, type: 'STANDARD', description: '', variants: [], segmentOverrides: 0, identityOverrides: 0, experiments: [], lastModified: new Date(NOW - 30 * DAY).toISOString(), envs, ...extra });
const on = (value = null) => ({ enabled: true, value });
const off = (value = null) => ({ enabled: false, value });

test('scanText finds flag literals and SDK calls, ignoring look-alike methods', () => {
  const src = [
    "if (flagsmith.hasFeature('new_checkout')) {}",
    "const v = flags.getValue('welcom_message');",
    "form.getValue('email'); map.get('new_checkout');",
    "const [a, b] = useFlags(['new_checkout', 'ghost_flag']);",
    "client.is_feature_enabled(identity, 'py_flag')",
  ].join('\n');
  const r = scanText(src, ['new_checkout', 'welcome_message']);
  assert.deepEqual(r.refs.map((x) => [x.name, x.line]), [['new_checkout', 1], ['new_checkout', 3], ['new_checkout', 4]]);
  const calls = r.calls.map((c) => c.name);
  assert.ok(calls.includes('welcom_message') && calls.includes('ghost_flag') && calls.includes('py_flag'));
  assert.ok(!calls.includes('email'), 'form.getValue is not a flag call');
  assert.equal(r.calls.find((c) => c.name === 'welcom_message').line, 2);
});

test('suggest finds the intended flag but not unrelated ones', () => {
  assert.equal(suggest('welcom_message', ['welcome_message', 'checkout_v2']), 'welcome_message');
  assert.equal(suggest('checkout_v3', ['welcome_message', 'checkout_v2']), 'checkout_v2');
  assert.equal(suggest('totally_different', ['welcome_message']), null);
});

test('lifecycle: stale, unused, experiment and live', () => {
  const envs = { Development: on('x'), Production: on('x') };
  assert.equal(lifecycle(flag('a', envs), { refs: [{}], now: NOW }).status, 'stale');
  assert.match(lifecycle(flag('a', envs), { refs: [{}], now: NOW }).advice, /ON = "x" everywhere for 30 days/);
  assert.equal(lifecycle(flag('a', envs), { refs: [], now: NOW }).status, 'unused');
  assert.equal(lifecycle(flag('a', envs, { lastModified: new Date(NOW - DAY).toISOString() }), { refs: [{}], now: NOW }).status, 'live');
  assert.equal(lifecycle(flag('a', envs, { segmentOverrides: 2 }), { refs: [{}], now: NOW }).status, 'live');
  assert.equal(lifecycle(flag('a', { Development: on(), Production: off() }), { refs: [{}], now: NOW }).status, 'live');
  assert.equal(lifecycle(flag('a', envs, { experiments: [{ id: 3, env: 'Development' }] }), { refs: [], now: NOW }).status, 'experiment');
  // null and "" both mean "no value": not a difference
  assert.equal(lifecycle(flag('a', { Development: on(''), Production: on(null) }), { refs: [{}], now: NOW }).status, 'stale');
});

test('drift reports which environments disagree', () => {
  assert.equal(drift(flag('a', { Development: on(), Production: on() })), null);
  assert.deepEqual(drift(flag('a', { Development: on(), Production: off() })), { Development: 'on', Production: 'off' });
});

test('lint: unknown flags are errors with a suggestion; GitHub output cannot be injected', () => {
  const flags = [flag('welcome_message', { Development: on('hi') }, { lastModified: new Date(NOW).toISOString() })];
  const scan = { refs: { welcome_message: [{ file: 'a.js', line: 1 }] }, unknown: [{ name: 'welcom_message', file: 'b.js', line: 4, col: 3, suggestion: 'welcome_message' }] };
  const f = lint(flags, scan, { now: NOW });
  assert.equal(f.length, 1);
  assert.equal(f[0].level, 'error');
  assert.match(f[0].message, /Did you mean "welcome_message"/);
  const evil = [{ level: 'error', rule: 'unknown-flag', file: 'x.js\n::set-output name=x::y', line: 1, message: 'a\n::error::injected' }];
  const out = formatLint(evil, { format: 'github' });
  assert.equal(out.split('\n').length, 1, 'one workflow command, no injected second line');
  assert.match(out, /x\.js%0A%3A%3Aset-output/);
});

test('codegen: typed output round-trips through readSnapshot', () => {
  const flags = [
    { name: 'pricing_layout', type: 'MULTIVARIATE', variants: ['compact'], description: 'p', envs: { Production: { enabled: true, value: 'control' } } },
    { name: 'checkout_v2', type: 'STANDARD', variants: [], description: '', envs: { Production: { enabled: false, value: null } } },
    { name: 'bad name; drop', type: 'STANDARD', variants: [], description: '', envs: {} },
  ];
  const snap = snapshotOf(flags, 'Production', 'Demo');
  assert.deepEqual(Object.keys(snap.flags), ['checkout_v2', 'pricing_layout'], 'invalid identifiers are skipped');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-'));
  for (const lang of ['ts', 'js']) {
    const file = path.join(dir, `flags.generated.${lang}`);
    fs.writeFileSync(file, render(snap, lang));
    assert.deepEqual(readSnapshot(file), JSON.parse(JSON.stringify(snap.flags)));
  }
  const ts = render(snap, 'ts');
  assert.match(ts, /"pricing_layout": "control" \| "compact";/);
  assert.match(ts, /export type FlagName = keyof typeof FLAGS;/);
});

test('starter: offline snapshot covers the four patterns and the templates exist', () => {
  const snap = offlineSnapshot();
  assert.deepEqual(Object.keys(snap.flags), STARTER_FLAGS.map((f) => f.name));
  assert.deepEqual(snap.flags.pricing_layout.variants, ['control', 'compact']);
  for (const t of ['express', 'react']) {
    const pkg = JSON.parse(fs.readFileSync(new URL(`../templates/${t}/package.json`, import.meta.url)));
    assert.ok(pkg.scripts['flags:sync'] && pkg.scripts['flags:lint'] && pkg.scripts.test, t);
    assert.ok(fs.existsSync(new URL(`../templates/${t}/.github/workflows/flags.yml`, import.meta.url)));
  }
});

test('panel: token, host and origin checks guard every API call', async () => {
  const state = { apiUrl: 'http://127.0.0.1:9', masterKey: 'k', project: { id: 1, name: 'T' }, environments: [] };
  const p = createPanel(state, { port: 0, token: 'secret-token-123', codeRoot: os.tmpdir() });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  const port = p.server.address().port;
  // the allowed-host list was built for port 0; rebuild a panel on the real port
  p.server.close();
  const q = createPanel(state, { port, token: 'secret-token-123', codeRoot: os.tmpdir() });
  await new Promise((r) => q.server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/api/schedules`)).status, 401, 'no token');
    assert.equal((await fetch(`${base}/api/schedules`, { headers: { 'X-FlagKit-Token': 'secret-token-12X' } })).status, 401, 'wrong token');
    assert.equal((await fetch(`${base}/api/schedules`, { headers: { 'X-FlagKit-Token': 'secret-token-123' } })).status, 200, 'right token');
    const post = (headers) => fetch(`${base}/api/flags/set`, { method: 'POST', headers: { 'X-FlagKit-Token': 'secret-token-123', 'Content-Type': 'application/json', 'X-Actor': 'me', ...headers }, body: '{}' });
    assert.equal((await post({ Origin: 'http://evil.example' })).status, 403, 'cross-origin POST');
    assert.equal((await post({ 'Content-Type': 'text/plain' })).status, 415, 'form-style POST');
    assert.equal((await post({ 'X-Actor': '' })).status, 400, 'anonymous change');
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    // DNS rebinding: a request whose Host is not localhost is refused, even with the token.
    const http = await import('node:http');
    const status = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/schedules', headers: { Host: 'attacker.example', 'X-FlagKit-Token': 'secret-token-123' } }, (res) => resolve(res.statusCode)));
    assert.equal(status, 421);
  } finally { q.server.close(); }
});

test('vscode: SDK calls, suggestions and stale lifecycle', () => {
  const calls = vsc.findFlagCalls("flagsmith.getValue('welcom_message'); form.getValue('email'); useFlag('')");
  assert.deepEqual(calls.map((c) => c.name), ['welcom_message', '']);
  assert.equal(vsc.suggest('welcom_message', ['welcome_message']), 'welcome_message');
  const f = { name: 'x', envs: [{ enabled: true, value: 'a', weights: [] }, { enabled: true, value: 'a', weights: [] }], experiments: [], lastModified: new Date(NOW - 20 * DAY).toISOString() };
  assert.equal(vsc.lifecycleOf(f, { now: NOW }).status, 'stale');
  assert.equal(vsc.lifecycleOf({ ...f, experiments: [{ status: 'running' }] }, { now: NOW }).status, 'experiment');
});
