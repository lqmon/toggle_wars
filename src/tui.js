// flagkit tui — one screen for a self-hosted Flagsmith:
//   • every flag × every environment, toggle with <space>
//   • live experiment results with win probability, and a guarded "ship the winner" action
import React, { useEffect, useState, useCallback } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { adminOf, getResults } from './experiment.js';
import { summarise } from './results.js';

const h = React.createElement;
const valueOf = (v) => (v && typeof v === 'object' ? v.string_value ?? v.integer_value ?? v.boolean_value : v);
const pct = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const bar = (p, w = 20) => {
  const n = Math.max(0, Math.min(w, Math.round((p ?? 0) * w)));
  return '█'.repeat(n) + '░'.repeat(w - n);
};

function useFlags(state) {
  const api = adminOf(state);
  const [data, setData] = useState({ features: [], cells: {}, error: null, loading: true });
  const load = useCallback(async () => {
    try {
      const features = await api.list(`projects/${state.project.id}/features/`);
      const cells = {};
      await Promise.all(
        state.environments.map(async (env) => {
          const fs = await api.list(`features/featurestates/?environment=${env.id}`);
          for (const s of fs) if (s.feature_segment == null && s.identity == null) cells[`${s.feature}:${env.id}`] = s;
        }),
      );
      setData({ features: features.filter((f) => !f.is_archived), cells, error: null, loading: false });
    } catch (e) {
      setData((d) => ({ ...d, error: e.message, loading: false }));
    }
  }, []);
  return [data, load, api];
}

function App({ state }) {
  const { exit } = useApp();
  const [tab, setTab] = useState('flags');
  const [{ features, cells, error, loading }, reload, api] = useFlags(state);
  const [row, setRow] = useState(0);
  const [col, setCol] = useState(0);
  const [msg, setMsg] = useState('');
  const [exp, setExp] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const expEnv = Object.keys(state.experiments)[0] || 'Development';

  useEffect(() => { reload(); const t = setInterval(reload, 5000); return () => clearInterval(t); }, []);

  const loadExp = useCallback(async (refresh = false) => {
    if (!state.experiments[expEnv]) return;
    try { setExp(await getResults(state, { envName: expEnv, refresh })); } catch (e) { setMsg(e.message); }
  }, []);
  useEffect(() => { loadExp(true); const t = setInterval(() => loadExp(false), 10000); return () => clearInterval(t); }, []);

  async function toggle() {
    const f = features[row];
    const env = state.environments[col];
    const cell = f && cells[`${f.id}:${env.id}`];
    if (!cell) return;
    if (/prod/i.test(env.name) && confirm?.type !== 'toggle') {
      setConfirm({ type: 'toggle', text: `Toggle "${f.name}" in ${env.name}? (y/n)` });
      return;
    }
    setConfirm(null);
    try {
      await api.patch(`environments/${env.api_key}/featurestates/${cell.id}/`, { enabled: !cell.enabled });
      setMsg(`${f.name} → ${!cell.enabled ? 'ON' : 'OFF'} in ${env.name}`);
      reload();
    } catch (e) { setMsg(`✖ ${e.message.slice(0, 120)}`); }
  }

  async function shipWinner(winner) {
    setConfirm(null);
    const env = state.environments.find((e) => e.name === expEnv);
    const id = state.experiments[expEnv].id;
    try {
      // Flagsmith ends the experiment and rolls the decision out to 100% of the environment.
      const f = features.find((x) => x.name === state.experiments[expEnv].flag);
      let body = { rollout_decision: 'control' };
      if (winner !== 'control') {
        const opts = await api.list(`projects/${state.project.id}/features/${f.id}/mv-options/`);
        body = { rollout_decision: 'variant', rollout_variant: opts.find((o) => o.key === winner).id };
      }
      await api.post(`environments/${env.api_key}/experiments/${id}/complete/`, body);
      setMsg(`✔ Experiment ended, "${winner}" rolled out to 100% of ${expEnv}`);
      reload(); loadExp(false);
    } catch (e) { setMsg(`✖ ${e.message.slice(0, 160)}`); }
  }

  const summary = summarise(exp?.results);
  const best = summary.rows.filter((r) => !r.isControl).sort((a, b) => (b.win ?? 0) - (a.win ?? 0))[0];

  useInput((input, key) => {
    if (confirm) {
      if (input === 'y') confirm.type === 'toggle' ? toggle() : shipWinner(confirm.winner);
      else { setConfirm(null); setMsg('cancelled'); }
      return;
    }
    if (input === 'q' || key.escape) exit();
    if (key.tab || input === '1' || input === '2') setTab(input === '1' ? 'flags' : input === '2' ? 'exp' : tab === 'flags' ? 'exp' : 'flags');
    if (tab === 'flags') {
      if (key.upArrow) setRow((r) => Math.max(0, r - 1));
      if (key.downArrow) setRow((r) => Math.min(features.length - 1, r + 1));
      if (key.leftArrow) setCol((c) => Math.max(0, c - 1));
      if (key.rightArrow) setCol((c) => Math.min(state.environments.length - 1, c + 1));
      if (input === ' ') toggle();
      if (input === 'r') reload();
    } else {
      if (input === 'r') { setMsg('refresh requested (max once / 5 min)'); loadExp(true); }
      if (input === 's' && best) setConfirm({ type: 'ship', winner: best.key, text: `End experiment and roll out "${best.key}" (win ${pct(best.win)}) to all of ${expEnv}? (y/n)` });
    }
  });

  const header = h(Box, { borderStyle: 'round', borderColor: 'cyan', paddingX: 1, justifyContent: 'space-between' },
    h(Text, { bold: true, color: 'cyan' }, '⚑ flagkit'),
    h(Text, null, `${state.project.name} @ ${state.apiUrl}`),
    h(Text, null, h(Text, { inverse: tab === 'flags' }, ' 1 Flags '), ' ', h(Text, { inverse: tab === 'exp' }, ' 2 Experiment ')),
  );

  let body;
  if (tab === 'flags') {
    const W = 26;
    body = h(Box, { flexDirection: 'column', paddingX: 1 },
      h(Box, null, h(Text, { bold: true }, 'FLAG'.padEnd(W)), ...state.environments.map((e, i) => h(Text, { key: e.id, bold: true, color: i === col ? 'cyan' : undefined }, e.name.padEnd(14)))),
      loading ? h(Text, { dimColor: true }, 'loading…') : null,
      ...features.map((f, i) => h(Box, { key: f.id },
        h(Text, { color: i === row ? 'cyan' : undefined }, (i === row ? '› ' : '  ') + f.name.slice(0, W - 3).padEnd(W - 2)),
        ...state.environments.map((e, j) => {
          const c = cells[`${f.id}:${e.id}`];
          const on = c?.enabled;
          const label = c ? (on ? '● ON ' : '○ off') + (valueOf(c.feature_state_value) != null && valueOf(c.feature_state_value) !== '' ? ` ${String(valueOf(c.feature_state_value)).slice(0, 7)}` : '') : '  —';
          return h(Text, { key: e.id, color: on ? 'green' : 'gray', inverse: i === row && j === col }, label.padEnd(14));
        }),
      )),
      features.length === 0 && !loading ? h(Text, { dimColor: true }, 'No flags yet. Try `flagkit experiment create`.') : null,
    );
  } else {
    const e = exp?.experiment;
    body = h(Box, { flexDirection: 'column', paddingX: 1 },
      !e ? h(Text, { dimColor: true }, 'No experiment yet. Run `flagkit experiment create`.') : h(React.Fragment, null,
        h(Text, { bold: true }, `#${e.id} ${e.name}  `, h(Text, { color: e.status === 'running' ? 'green' : 'yellow' }, `[${e.status}]`), h(Text, { dimColor: true }, `  ${expEnv}`)),
        h(Text, { dimColor: true, wrap: 'wrap' }, `Hypothesis: ${e.hypothesis}`),
        h(Text, null, ' '),
        summary.rows.length === 0
          ? h(Text, { color: 'yellow' }, 'Collecting data… (each variation needs ≥50 identities; results refresh at most every 5 min — press r)')
          : h(Box, { flexDirection: 'column' },
            h(Text, { bold: true }, 'VARIATION'.padEnd(12) + 'USERS'.padStart(7) + '   RATE'.padEnd(10) + 'LIFT'.padEnd(9) + 'CHANCE TO WIN'),
            ...summary.rows.map((r) => h(Text, { key: r.key },
              (r.key + (r.isControl ? '*' : '')).padEnd(12),
              String(r.exposures ?? '—').padStart(7),
              '   ' + pct(r.value).padEnd(7),
              h(Text, { color: (r.lift ?? 0) > 0 ? 'green' : 'red' }, (r.isControl ? '—' : pct(r.lift)).padEnd(9)),
              r.isControl ? h(Text, { dimColor: true }, 'baseline') : h(Text, { color: (r.win ?? 0) >= 0.95 ? 'green' : 'yellow' }, `${bar(r.win)} ${pct(r.win, 0)}`),
              r.ci ? h(Text, { dimColor: true }, `  95% CI ${pct(r.ci[0], 0)}…${pct(r.ci[1], 0)}`) : null,
            )),
            best && best.win >= 0.95 ? h(Text, { color: 'green', bold: true }, `\n🏆 "${best.key}" has a ${pct(best.win)} chance to beat control — press s to ship it`) : null,
          ),
        h(Text, { dimColor: true }, `as of ${summary.asOf ?? 'never'}  •  dashboard: ${state.apiUrl}/project/${state.project.id}/environment/${state.environments.find((x) => x.name === expEnv)?.api_key}/experiments/${e.id}`),
      ),
    );
  }

  const footer = h(Box, { flexDirection: 'column', paddingX: 1, marginTop: 1 },
    confirm ? h(Text, { color: 'yellow', bold: true }, `⚠ ${confirm.text}`) : null,
    error ? h(Text, { color: 'red' }, error) : msg ? h(Text, { color: 'magenta' }, msg) : null,
    h(Text, { dimColor: true }, tab === 'flags' ? '↑↓←→ move  space toggle (Production asks first)  r reload  tab switch  q quit' : 'r refresh results  s ship winner (asks first)  tab switch  q quit'),
  );

  return h(Box, { flexDirection: 'column' }, header, body, footer);
}

export async function runTui(state) {
  const { waitUntilExit } = render(h(App, { state }));
  await waitUntilExit();
}
