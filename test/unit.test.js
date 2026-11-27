import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarise, formatTable } from '../src/results.js';
import { cliKeyVar } from '../src/config.js';
import { parseRates } from '../src/simulate.js';
import { buildPage } from '../src/build-page.js';

// Shape returned by GET /experiments/<id>/results/ on Flagsmith (beta).
const RESULTS = {
  results: {
    as_of: '2026-11-27T08:24:20Z',
    payload: {
      srm_p_value: 0.5,
      metrics: [{
        variants: { control: { n: 399, sum: 27 }, teal: { n: 401, sum: 74 } },
        inference: { teal: { lift: 1.73, ci_low: 0.9, ci_high: 2.6, chance_to_win: 0.9999 } },
      }],
    },
  },
};

test('summarise puts control first and computes rates', () => {
  const s = summarise(RESULTS);
  assert.equal(s.rows[0].key, 'control');
  assert.equal(s.rows[0].isControl, true);
  assert.equal(s.rows[1].win, 0.9999);
  assert.ok(Math.abs(s.rows[1].value - 74 / 401) < 1e-9);
});

test('summarise handles "not computed yet"', () => {
  assert.deepEqual(summarise({ results: { as_of: null, payload: null } }).rows, []);
  assert.match(formatTable({ results: { payload: null } }), /collecting data/);
});

test('formatTable flags sample ratio mismatch', () => {
  const srm = structuredClone(RESULTS);
  srm.results.payload.srm_p_value = 0.0001;
  assert.match(formatTable(srm), /sample ratio mismatch/);
});

test('cliKeyVar matches the Flagsmith CLI host-scoping rule', () => {
  assert.equal(cliKeyVar('http://localhost:8000'), 'FLAGSMITH_API_KEY_localhost_8000');
  // examples from the CLI docs: '-' doubled, '.' and ':' -> '_'
  assert.equal(cliKeyVar('https://flagsmith.corp-internal.io:8000'), 'FLAGSMITH_API_KEY_flagsmith_corp__internal_io_8000');
  assert.equal(cliKeyVar('https://flagsmith-staging.com:8000'), 'FLAGSMITH_API_KEY_flagsmith__staging_com_8000');
});

test('parseRates', () => {
  assert.deepEqual(parseRates('control=0.08, teal=0.2'), { control: 0.08, teal: 0.2 });
  assert.deepEqual(parseRates(undefined), {});
});

test('buildPage refuses server-side keys and plain-http public APIs', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-'));
  assert.throws(() => buildPage({ envKey: 'ser.abc123', out }), /client-side/);
  assert.throws(() => buildPage({ envKey: 'abcdefghijklmnop', out, apiUrl: 'http://example.com' }), /https/);
});

test('buildPage writes a CSP-locked static site', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-'));
  buildPage({ envKey: 'abcdefghijklmnop', out });
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src https:\/\/edge\.api\.flagsmith\.com/);
  assert.ok(fs.existsSync(path.join(out, 'sdk.mjs')));
  assert.match(fs.readFileSync(path.join(out, 'config.js'), 'utf8'), /"environmentID":"abcdefghijklmnop"/);
});

test('control is identified by key even before any conversions', () => {
  const s = summarise({ results: { payload: { metrics: [{ variants: { benefit: { n: 5, sum: 0 }, control: { n: 2, sum: 0 } }, inference: {} }] } } });
  assert.equal(s.rows[0].key, 'control');
  assert.equal(s.rows.filter((r) => r.isControl).length, 1);
});

test('featureIdOf handles object and bare-id shapes', async () => {
  const { featureIdOf } = await import('../src/experiment.js');
  assert.equal(featureIdOf({ feature: { id: 5, name: 'x' } }), 5);
  assert.equal(featureIdOf({ feature: 7 }), 7);
});
