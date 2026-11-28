// flagkit tui — one terminal screen for a self-hosted Flagsmith:
//   1 Flags        every flag × every environment, search, drift markers, guarded toggles
//   2 Experiments  every experiment in every environment, live Bayesian results, guarded "ship the winner"
//   3 Doctor       live health: silent event loss, security posture, CLI/SDK config
//   4 Approvals    changes proposed by agents (MCP) — nothing is applied until a person approves here
//   5 Activity     every change made through FlagKit, who/why/before→after, u to undo one
// Flag changes go through src/changes.js: audited, Production needs a reason, experiment flags are locked.
import os from 'node:os';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import { adminOf, featureIdOf } from './experiment.js';
import { summarise } from './results.js';
import { runDoctor } from './doctor.js';
import { listChanges, approveChange, rejectChange, describeParams, isProduction } from './approvals.js';
import { clean } from './sanitize.js';
import { setFlag, revert, auditLog } from './changes.js';
import { lifecycle, scanCode } from './flags.js';

// Everything from Flagsmith or from agents is cleaned of control characters as it is loaded,
// so nothing the TUI renders can carry terminal escape sequences.
const cleanObj = (o) => {
  if (typeof o === 'string') return clean(o);
  if (Array.isArray(o)) return o.map(cleanObj);
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [clean(k), cleanObj(v)]));
  return o;
};

const h = React.createElement;
const valueOf = (v) => (v && typeof v === 'object' ? v.string_value ?? v.integer_value ?? v.boolean_value : v);
const pct = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const bar = (p, w = 18) => {
  const n = Math.max(0, Math.min(w, Math.round((p ?? 0) * w)));
  return '█'.repeat(n) + '░'.repeat(w - n);
};
const TABS = [['flags', '1 Flags'], ['exp', '2 Experiments'], ['doctor', '3 Doctor'], ['appr', '4 Approvals'], ['act', '5 Activity']];
// Apply typed input to a text field: DEL/BS delete (pasted or batched keys arrive as one string), other control characters are dropped.
const typeInto = (s, input) => { let out = s; for (const ch of input) { if (ch === '\x7f' || ch === '\b') out = out.slice(0, -1); else if (!/[\u0000-\u001f\u007f-\u009f]/.test(ch)) out += ch; } return out; };
const ACTOR = (() => { try { return os.userInfo().username; } catch { return 'tui'; } })();
const LC = { stale: ['⌛', 'yellow', 'stale: same everywhere and untouched, remove it'], unused: ['∅', 'gray', 'unused: no code references it'], experiment: ['🧪', 'magenta', 'in a running experiment: locked'] };
const ICON = { pass: ['✔', 'green'], warn: ['⚠', 'yellow'], fail: ['✖', 'red'], skip: ['·', 'gray'] };

function useFlags(state, api) {
  const [data, setData] = useState({ features: [], cells: {}, error: null, loading: true });
  const load = useCallback(async () => {
    try {
      const features = await api.list(`projects/${state.project.id}/features/`);
      const cells = {};
      await Promise.all(state.environments.map(async (env) => {
        const fs = await api.list(`features/featurestates/?environment=${env.id}`);
        for (const s of fs) if (s.feature_segment == null && s.identity == null) cells[`${s.feature}:${env.id}`] = s;
      }));
      setData({ features: cleanObj(features.filter((f) => !f.is_archived)), cells: cleanObj(cells), error: null, loading: false });
    } catch (e) { setData((d) => ({ ...d, error: clean(e.message), loading: false })); }
  }, []);
  return [data, load];
}

function useExperiments(state, api) {
  const [list, setList] = useState([]);
  const load = useCallback(async (refreshId) => {
    const out = [];
    for (const env of state.environments) {
      let exps = [];
      try { exps = await api.list(`environments/${env.api_key}/experiments/`); } catch { continue; }
      for (const x of exps) {
        if (refreshId === x.id) await api.post(`environments/${env.api_key}/experiments/${x.id}/results/refresh/`).catch(() => {});
        let results = null;
        try { results = await api.get(`environments/${env.api_key}/experiments/${x.id}/results/`); } catch { /* none yet */ }
        out.push({ ...cleanObj(x), env, summary: cleanObj(summarise(results)) });
      }
    }
    out.sort((a, b) => (a.status === 'running' ? -1 : 1) - (b.status === 'running' ? -1 : 1) || b.id - a.id);
    setList(out);
  }, []);
  return [list, load];
}

function App({ state }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = Math.min(stdout?.columns || 100, 120);
  const api = useMemo(() => adminOf(state), []);
  const [tab, setTab] = useState('flags');
  const [{ features, cells, error, loading }, reloadFlags] = useFlags(state, api);
  const [experiments, reloadExps] = useExperiments(state, api);
  const [doctor, setDoctor] = useState(null);
  const [refs, setRefs] = useState(null);
  useEffect(() => { try { setRefs(scanCode(process.cwd(), features.map((f) => f.name)).refs); } catch { setRefs(null); } }, [features.length]);
  const [prompt, setPrompt] = useState(null); // { label, value, onSubmit }
  const [audit, setAudit] = useState([]);
  const [acRow, setAcRow] = useState(0);
  useEffect(() => { const load = () => setAudit(cleanObj(auditLog({ limit: 100 }))); load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, []);
  const [row, setRow] = useState(0);
  const [col, setCol] = useState(0);
  const [expRow, setExpRow] = useState(0);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [msg, setMsg] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [healthy, setHealthy] = useState(null);
  const [changes, setChanges] = useState([]);
  const [apRow, setApRow] = useState(0);
  useEffect(() => {
    const load = () => setChanges(cleanObj(listChanges()).sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1) || b.createdAt.localeCompare(a.createdAt)));
    load(); const t = setInterval(load, 2000); return () => clearInterval(t);
  }, []);
  const pending = changes.filter((c) => c.status === 'pending');

  useEffect(() => { reloadFlags(); const t = setInterval(reloadFlags, 5000); return () => clearInterval(t); }, []);
  useEffect(() => { reloadExps(); const t = setInterval(() => reloadExps(), 15000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const ping = () => fetch(`${state.apiUrl}/health`).then((r) => setHealthy(r.ok)).catch(() => setHealthy(false));
    ping(); const t = setInterval(ping, 5000); return () => clearInterval(t);
  }, []);
  const runDoc = useCallback(async () => {
    setDoctor({ running: true, results: [] });
    const dev = state.environments.find((e) => e.name === 'Development') || state.environments[0];
    setDoctor(cleanObj(await runDoctor({ apiUrl: state.apiUrl, envKey: dev.api_key, adminKey: state.masterKey, quiet: true })));
  }, []);
  useEffect(() => { if (tab === 'doctor' && !doctor) runDoc(); }, [tab]);

  const shown = features.filter((f) => !query || f.name.toLowerCase().includes(query.toLowerCase()));
  const cellOf = (f, e) => cells[`${f.id}:${e.id}`];
  const drift = (f) => {
    const sigs = state.environments.map((e) => { const c = cellOf(f, e); return c ? `${c.enabled}|${valueOf(c.feature_state_value) ?? ''}` : '-'; });
    return new Set(sigs).size > 1;
  };
  const selExp = experiments[Math.min(expRow, Math.max(0, experiments.length - 1))];
  const best = selExp?.summary.rows.filter((r) => !r.isControl).sort((a, b) => (b.win ?? 0) - (a.win ?? 0))[0];

  const lcOf = (f) => {
    const envs = Object.fromEntries(state.environments.map((e) => { const c = cellOf(f, e); return [e.name, c ? { enabled: c.enabled, value: valueOf(c.feature_state_value) } : null]; }));
    const running = experiments.filter((x) => x.status === 'running' && (x.feature?.id ?? x.feature) === f.id).map((x) => ({ id: x.id, env: x.env.name }));
    return lifecycle({ ...f, envs, experiments: running, lastModified: f.last_modified_in_any_environment || f.created_date, segmentOverrides: f.num_segment_overrides, identityOverrides: f.num_identity_overrides }, { refs: refs ? refs[f.name] || [] : undefined });
  };

  // Every change: audited; Production asks for a reason first; experiment flags are refused by setFlag.
  async function applyChange(f, env, patch, reason) {
    try {
      const r = await setFlag(state, { flag: f.name, env: env.name, ...patch }, { actor: ACTOR, reason, via: 'tui' });
      setMsg(r.noop ? 'already in that state' : `✔ ${f.name} in ${env.name}: ${r.before.enabled ? 'on' : 'off'} ${clean(String(r.before.value ?? ''))} → ${r.after.enabled ? 'on' : 'off'} ${clean(String(r.after.value ?? ''))}  (u in Activity to undo)`);
      reloadFlags();
    } catch (e) { setMsg(`✖ ${clean(e.message.slice(0, 160))}`); }
  }
  function change(f, env, patch, what) {
    if (/prod/i.test(env.name)) setPrompt({ label: `PRODUCTION: ${what}. Reason (Enter to apply, Esc to cancel): `, value: '', onSubmit: (reason) => applyChange(f, env, patch, reason) });
    else applyChange(f, env, patch, '');
  }
  function toggle() {
    const f = shown[row]; const env = state.environments[col];
    const cell = f && cellOf(f, env);
    if (cell) change(f, env, { enabled: !cell.enabled }, `turn ${f.name} ${cell.enabled ? 'OFF' : 'ON'}`);
  }
  function editValue() {
    const f = shown[row]; const env = state.environments[col];
    const cell = f && cellOf(f, env);
    if (!cell) return;
    setPrompt({ label: `${f.name} value in ${env.name}: `, value: String(valueOf(cell.feature_state_value) ?? ''), onSubmit: (v) => change(f, env, { value: v }, `set ${f.name} = ${v}`) });
  }
  // Copy the selected cell's state to the next environment to the right (Development → Staging → Production).
  function promoteCell() {
    const f = shown[row]; const from = state.environments[col]; const to = state.environments[col + 1];
    const a = f && cellOf(f, from); const b = f && to && cellOf(f, to);
    if (!a || !b) { setMsg('nothing to the right to promote to'); return; }
    const va = valueOf(a.feature_state_value), vb = valueOf(b.feature_state_value);
    if (a.enabled === b.enabled && String(va ?? '') === String(vb ?? '')) { setMsg(`${to.name} already matches ${from.name}`); return; }
    const what = `promote ${f.name} ${from.name} → ${to.name} (${b.enabled ? 'on' : 'off'} ${vb ?? ''} → ${a.enabled ? 'on' : 'off'} ${va ?? ''})`;
    if (/prod/i.test(to.name)) change(f, to, { enabled: a.enabled, value: va }, what);
    else setConfirm({ type: 'promote', text: `${what}?`, run: () => applyChange(f, to, { enabled: a.enabled, value: va }, `promote ${from.name} → ${to.name}`) });
  }

  async function shipWinner(x, winner) {
    try {
      // Flagsmith ends the experiment and rolls the decision out to 100% of the environment.
      let body = { rollout_decision: 'control' };
      if (winner !== 'control') {
        const opts = await api.list(`projects/${state.project.id}/features/${featureIdOf(x)}/mv-options/`);
        body = { rollout_decision: 'variant', rollout_variant: opts.find((o) => o.key === winner).id };
      }
      await api.post(`environments/${x.env.api_key}/experiments/${x.id}/complete/`, body);
      setMsg(`✔ #${x.id} ended; "${winner}" rolled out to 100% of ${x.env.name}`);
      reloadFlags(); reloadExps();
    } catch (e) { setMsg(`✖ ${clean(e.message.slice(0, 160))}`); }
  }

  useInput((input, key) => {
    if (prompt) {
      if (key.escape) { setPrompt(null); setMsg('cancelled: nothing changed'); return; }
      if (key.return) { const p = prompt; setPrompt(null); p.onSubmit(p.value); return; }
      if (key.backspace || key.delete) { setPrompt((p) => ({ ...p, value: p.value.slice(0, -1) })); return; }
      if (input && !key.ctrl && !key.meta) setPrompt((p) => ({ ...p, value: typeInto(p.value, input).slice(0, 500) }));
      return;
    }
    if (confirm) {
      const c = confirm; setConfirm(null);
      if (input === 'y') {
        if (c.type === 'promote' || c.type === 'undo') c.run();
        else if (c.type === 'ship') shipWinner(c.exp, c.winner);
        // Pass the exact record that was shown, so a different change can never be applied in its place.
        else if (c.type === 'approve') approveChange(state, c.id, c.shown).then((r) => { setMsg(`${r.status === 'applied' ? '✔ applied' : '✖ failed'} ${c.id}: ${clean(r.result)}`); setChanges(cleanObj(listChanges())); reloadFlags(); reloadExps(); }).catch((e) => setMsg(`✖ ${clean(e.message)}`));
        else if (c.type === 'reject') { try { rejectChange(c.id, '', c.shown); setMsg(`rejected ${c.id}`); setChanges(cleanObj(listChanges())); } catch (e) { setMsg(`✖ ${clean(e.message)}`); } }
      }
      else setMsg('cancelled: nothing changed');
      return;
    }
    if (searching) {
      if (key.return || key.escape) { setSearching(false); if (key.escape) setQuery(''); return; }
      if (key.backspace || key.delete) { setQuery((q) => q.slice(0, -1)); setRow(0); return; }
      if (input && !key.ctrl) { setQuery((q) => typeInto(q, input)); setRow(0); }
      return;
    }
    if (input === 'q' || (key.escape && !query)) exit();
    if (key.escape) setQuery('');
    const idx = TABS.findIndex(([k]) => k === tab);
    if (key.tab) setTab(TABS[(idx + (key.shift ? TABS.length - 1 : 1)) % TABS.length][0]);
    if (['1', '2', '3', '4', '5'].includes(input)) setTab(TABS[Number(input) - 1][0]);
    if (tab === 'flags') {
      if (key.upArrow) setRow((r) => Math.max(0, r - 1));
      if (key.downArrow) setRow((r) => Math.min(shown.length - 1, r + 1));
      if (key.leftArrow) setCol((c) => Math.max(0, c - 1));
      if (key.rightArrow) setCol((c) => Math.min(state.environments.length - 1, c + 1));
      if (input === ' ') toggle();
      if (input === 'e') editValue();
      if (input === 'p') promoteCell();
      if (input === '/') { setSearching(true); setQuery(''); }
      if (input === 'r') { reloadFlags(); setMsg('reloaded'); }
    } else if (tab === 'exp') {
      if (key.upArrow) setExpRow((r) => Math.max(0, r - 1));
      if (key.downArrow) setExpRow((r) => Math.min(experiments.length - 1, r + 1));
      if (input === 'r' && selExp) { setMsg('results refresh requested (Flagsmith allows one per 5 min)'); reloadExps(selExp.id); }
      if (input === 's' && selExp?.status === 'running' && best) {
        if ((best.win ?? 0) < 0.95) setMsg(`not yet: best variant "${best.key}" is at ${pct(best.win)}; ship at ≥95%`);
        else setConfirm({ type: 'ship', exp: selExp, winner: best.key, text: `End #${selExp.id} and roll out "${best.key}" (${pct(best.win)} chance to win) to ALL of ${selExp.env.name}?` });
      }
    } else if (tab === 'doctor' && input === 'r') runDoc();
    else if (tab === 'act') {
      if (key.upArrow) setAcRow((r) => Math.max(0, r - 1));
      if (key.downArrow) setAcRow((r) => Math.min(audit.length - 1, r + 1));
      const a = audit[acRow];
      if (a && input === 'u') {
        const st = (x) => `${x.enabled ? 'on' : 'off'} ${x.value ?? ''}`;
        const undo = (reason) => revert(state, a.id, { actor: ACTOR, reason, via: 'tui' }).then((r) => { setMsg(r.noop ? 'already in that state' : `✔ undone: ${a.flag} in ${a.env} is back to ${st(a.before)}`); reloadFlags(); }).catch((e) => setMsg(`✖ ${clean(e.message)}`));
        if (/prod/i.test(a.env)) setPrompt({ label: `PRODUCTION: undo ${a.flag} (${st(a.after)} → ${st(a.before)}). Reason: `, value: '', onSubmit: undo });
        else setConfirm({ type: 'undo', text: `Undo: put ${a.flag} in ${a.env} back to ${st(a.before)}?`, run: () => undo(`undo ${a.id}`) });
      }
    }
    else if (tab === 'appr') {
      const sel = changes[apRow];
      if (key.upArrow) setApRow((r) => Math.max(0, r - 1));
      if (key.downArrow) setApRow((r) => Math.min(changes.length - 1, r + 1));
      // The confirmation is built from the structured params (never agent prose); production is computed, not claimed.
      const raw = sel && listChanges().find((x) => x.id === sel.id && x.createdAt === sel.createdAt);
      if (raw?.status === 'pending' && input === 'a') setConfirm({ type: 'approve', id: raw.id, shown: raw, text: `${isProduction(state, raw) ? 'PRODUCTION! ' : ''}APPLY ${raw.id}: ${describeParams(raw)}?` });
      if (raw?.status === 'pending' && input === 'x') setConfirm({ type: 'reject', id: raw.id, shown: raw, text: `Reject ${raw.id}?` });
    }
  });

  // ── header ──
  const header = h(Box, { borderStyle: 'round', borderColor: 'cyan', paddingX: 1, justifyContent: 'space-between', width },
    h(Text, null, h(Text, { bold: true, color: 'cyan' }, '⚑ flagkit '), h(Text, { color: healthy == null ? 'gray' : healthy ? 'green' : 'red' }, healthy == null ? '○' : '●'), h(Text, { dimColor: true }, ` ${state.project.name}`)),
    h(Text, null, ...TABS.flatMap(([k, label]) => [h(Text, { key: k, inverse: tab === k, color: tab === k ? 'cyan' : k === 'appr' && pending.length ? 'yellow' : undefined, bold: tab === k || (k === 'appr' && pending.length > 0) }, ` ${label}${k === 'appr' && pending.length ? ` (${pending.length})` : ''} `), ' '])),
  );

  let body;
  if (tab === 'flags') {
    const W = Math.max(18, Math.min(30, width - 8 - state.environments.length * 16));
    body = h(Box, { flexDirection: 'column', paddingX: 1 },
      h(Box, null,
        h(Text, { bold: true, dimColor: true }, 'FLAG'.padEnd(W)),
        ...state.environments.map((e, i) => h(Text, { key: e.id, bold: true, color: i === col ? 'cyan' : undefined, dimColor: i !== col }, e.name.slice(0, 14).padEnd(16)))),
      searching || query ? h(Text, { color: 'cyan' }, `/${query}${searching ? '▏' : ''}  `, h(Text, { dimColor: true }, `${shown.length} of ${features.length}`)) : null,
      loading ? h(Text, { dimColor: true }, 'loading…') : null,
      ...shown.map((f, i) => {
        const sel = i === row;
        const d = drift(f);
        return h(Box, { key: f.id },
          h(Text, { color: sel ? 'cyan' : undefined, bold: sel }, `${sel ? '› ' : '  '}${f.name.slice(0, W - 6).padEnd(W - 5)}`),
          h(Text, { color: 'magenta' }, d ? '≠ ' : '  '),
          (() => { const lc = LC[lcOf(f).status]; return h(Text, { color: lc?.[1] }, lc ? `${lc[0]} `.slice(0, 2).padEnd(2) : '  '); })(),
          h(Text, { dimColor: true }, f.type === 'MULTIVARIATE' ? 'mv ' : '   '),
          ...state.environments.map((e, j) => {
            const c = cellOf(f, e);
            const v = c ? valueOf(c.feature_state_value) : null;
            const label = c ? `${c.enabled ? '● on ' : '○ off'}${v != null && v !== '' ? ` ${String(v).slice(0, 8)}` : ''}` : '  —';
            return h(Text, { key: e.id, color: c?.enabled ? 'green' : 'gray', inverse: sel && j === col }, label.padEnd(15), ' ');
          }));
      }),
      !loading && shown.length === 0 ? h(Text, { dimColor: true }, query ? 'No flags match.' : 'No flags yet. Try `flagkit experiment create`.') : null,
      h(Text, { dimColor: true }, '\n≠ envs differ  ⌛ stale  ∅ unused in code  🧪 in experiment (locked)'),
      shown[row] ? h(Text, { dimColor: true }, (() => { const lc = lcOf(shown[row]); return lc.advice ? `${shown[row].name}: ${lc.advice}` : ' '; })()) : null,
    );
  } else if (tab === 'exp') {
    body = h(Box, { flexDirection: 'column', paddingX: 1 },
      experiments.length === 0 ? h(Text, { dimColor: true }, 'No experiments yet. Run `flagkit experiment create`, or let the agent skill create one.') : null,
      ...experiments.map((x, i) => h(Text, { key: `${x.env.id}-${x.id}`, color: i === expRow ? 'cyan' : undefined, bold: i === expRow },
        `${i === expRow ? '› ' : '  '}#${String(x.id).padEnd(4)}`,
        h(Text, { color: x.status === 'running' ? 'green' : x.status === 'completed' ? 'gray' : 'yellow' }, x.status.padEnd(10)),
        h(Text, { dimColor: i !== expRow }, `${x.env.name.padEnd(12)} ${x.name.slice(0, 50)}`))),
      selExp ? h(Box, { flexDirection: 'column', marginTop: 1, borderStyle: 'single', borderColor: 'gray', paddingX: 1, width: width - 2 },
        h(Text, { bold: true }, selExp.name),
        h(Text, { dimColor: true, wrap: 'wrap' }, `Hypothesis: ${selExp.hypothesis}`),
        h(Text, null, ' '),
        selExp.summary.rows.length === 0
          ? h(Text, { color: 'yellow' }, '◌ Collecting data. Each arm needs ≥50 identities; press r to refresh results (max once / 5 min).')
          : h(Box, { flexDirection: 'column' },
            h(Text, { bold: true, dimColor: true }, 'ARM'.padEnd(11) + 'USERS'.padStart(6) + '  CONV'.padStart(7) + '   RATE' + ' '.repeat(15) + 'LIFT     CHANCE TO BEAT CONTROL'),
            ...selExp.summary.rows.map((r) => {
              const maxRate = Math.max(...selExp.summary.rows.map((x) => x.value || 0), 0.0001);
              return h(Text, { key: r.key },
                h(Text, { bold: !r.isControl }, r.key.slice(0, 10).padEnd(11)),
                String(r.exposures ?? '—').padStart(6), String(r.conversions ?? '—').padStart(7), '  ',
                h(Text, { color: r.isControl ? 'gray' : 'cyan' }, bar((r.value || 0) / maxRate, 10)), ` ${pct(r.value).padStart(6)}  `,
                h(Text, { color: (r.lift ?? 0) > 0 ? 'green' : 'red' }, (r.isControl ? '—' : `${r.lift > 0 ? '+' : ''}${pct(r.lift, 0)}`).padEnd(8)),
                r.isControl ? h(Text, { dimColor: true }, 'baseline') : h(Text, { color: (r.win ?? 0) >= 0.95 ? 'green' : 'yellow' }, `${bar(r.win)} ${pct(r.win, 0)}`),
              );
            }),
            best?.ci ? h(Text, { dimColor: true }, `${best.key}: 95% credible interval for lift ${pct(best.ci[0], 0)} … ${pct(best.ci[1], 0)}`) : null,
            selExp.summary.srm != null && selExp.summary.srm < 0.01 ? h(Text, { color: 'red', bold: true }, '⚠ Sample ratio mismatch: traffic is not splitting as configured. Don\'t act on these results.') : null,
            best && selExp.status === 'running' && (best.win ?? 0) >= 0.95 ? h(Text, { color: 'green', bold: true }, `🏆 "${best.key}" clears the 95% bar. Press s to ship it (asks first).`) : null,
          ),
        h(Text, { dimColor: true }, `as of ${selExp.summary.asOf ?? 'never'} · ${state.apiUrl}/project/${state.project.id}/environment/${selExp.env.api_key}/experiments/${selExp.id}`),
      ) : null,
    );
  } else if (tab === 'appr') {
    const sel = changes[Math.min(apRow, Math.max(0, changes.length - 1))];
    const color = { pending: 'yellow', applied: 'green', rejected: 'gray', failed: 'red' };
    body = h(Box, { flexDirection: 'column', paddingX: 1 },
      changes.length === 0 ? h(Text, { dimColor: true }, 'No change requests. Agents file them through the MCP server (`flagkit mcp`) → flagkit_propose_change.') : null,
      ...changes.slice(0, 12).map((c, i) => h(Text, { key: c.id, bold: i === apRow, color: i === apRow ? 'cyan' : undefined },
        `${i === apRow ? '› ' : '  '}${c.id}  `, h(Text, { color: color[c.status] }, c.status.padEnd(9)), c.risk === 'high' ? h(Text, { color: 'red' }, isProduction(state, c) ? 'PROD ' : 'HIGH ') : '     ', c.summary.slice(0, width - 34))),
      sel ? h(Box, { flexDirection: 'column', marginTop: 1, borderStyle: 'single', borderColor: sel.status === 'pending' ? 'yellow' : 'gray', paddingX: 1, width: width - 2 },
        h(Text, { bold: true }, sel.summary),
        h(Text, null, h(Text, { dimColor: true }, 'before  '), sel.before),
        h(Text, null, h(Text, { dimColor: true }, 'after   '), h(Text, { color: 'cyan' }, sel.after)),
        h(Text, { wrap: 'wrap' }, h(Text, { dimColor: true }, 'reason  '), sel.reason),
        sel.details ? h(Text, { wrap: 'wrap' }, h(Text, { dimColor: true }, 'details '), sel.details) : null,
        h(Text, { dimColor: true }, `requested by ${sel.requestedBy} · ${sel.createdAt}${sel.decidedBy ? ` · decided by ${sel.decidedBy}` : ''}`),
        sel.result ? h(Text, { color: color[sel.status] }, `→ ${sel.result}`) : null,
      ) : null,
    );
  } else if (tab === 'act') {
    const st = (x) => `${x.enabled ? 'on' : 'off'}${x.value != null && x.value !== '' ? ` ${String(x.value).slice(0, 14)}` : ''}`;
    body = h(Box, { flexDirection: 'column', paddingX: 1 },
      audit.length === 0 ? h(Text, { dimColor: true }, 'No changes yet. Changes from the TUI, `flagkit panel`, schedules and promote show up here.') : null,
      ...audit.slice(0, 12).flatMap((a, i) => [
        h(Text, { key: a.id, color: i === acRow ? 'cyan' : undefined, bold: i === acRow },
          `${i === acRow ? '› ' : '  '}${a.at.slice(5, 16).replace('T', ' ')}  `,
          h(Text, { color: /prod/i.test(a.env) ? 'red' : undefined }, a.env.slice(0, 11).padEnd(12)),
          `${a.flag.slice(0, 22).padEnd(23)}`, h(Text, { dimColor: true }, st(a.before).padEnd(19)), '→ ', h(Text, { color: 'cyan' }, st(a.after))),
        h(Text, { key: `${a.id}-w`, dimColor: true }, `      ${a.actor} via ${a.via}${a.reason ? `: ${a.reason}` : ''}`.slice(0, width - 4)),
      ]),
    );
  } else {
    const order = ['Reachability', 'Security', 'Experimentation', 'SDK', 'CLI', 'Admin'];
    const rows = [...(doctor?.results || [])].sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));
    let last = '';
    const counts = ['pass', 'warn', 'fail'].map((s) => rows.filter((r) => r.status === s).length);
    body = h(Box, { flexDirection: 'column', paddingX: 1 },
      doctor?.running ? h(Text, { color: 'cyan' }, '◌ running checks…') : null,
      ...rows.flatMap((r, i) => {
        const out = [];
        if (r.section !== last) { last = r.section; out.push(h(Text, { key: `s${i}`, bold: true, dimColor: true }, r.section.toUpperCase())); }
        out.push(h(Text, { key: i }, '  ', h(Text, { color: ICON[r.status][1] }, ICON[r.status][0]), ` ${r.title}`));
        if (r.fix && r.status !== 'pass') out.push(h(Text, { key: `f${i}`, dimColor: true }, `      fix: ${r.fix}`));
        return out;
      }),
      doctor && !doctor.running ? h(Text, { bold: true, color: counts[2] ? 'red' : counts[1] ? 'yellow' : 'green' }, `\n${counts[0]} passed · ${counts[1]} warnings · ${counts[2]} failures${doctor.fixable ? `  ·  ${doctor.fixable} auto-fixable: run \`flagkit doctor --fix\`` : ''}`) : null,
    );
  }

  const hints = {
    flags: '↑↓←→ move  space toggle  e edit value  p promote → right  / search  r reload',
    exp: '↑↓ select  r refresh results  s ship winner',
    doctor: 'r re-run checks',
    appr: '↑↓ select  a approve & apply  x reject',
    act: '↑↓ select  u undo this change',
  }[tab];
  const footer = h(Box, { flexDirection: 'column', paddingX: 1, marginTop: 1 },
    prompt ? h(Box, { borderStyle: 'round', borderColor: /PRODUCTION/.test(prompt.label) ? 'red' : 'cyan', paddingX: 1 }, h(Text, { bold: true }, prompt.label), h(Text, null, `${prompt.value}▏`)) : null,
    confirm ? h(Box, { borderStyle: 'round', borderColor: 'yellow', paddingX: 1 }, h(Text, { color: 'yellow', bold: true }, `⚠ ${confirm.text}  `), h(Text, null, '[y] yes  [any key] cancel')) : null,
    error ? h(Text, { color: 'red' }, `✖ ${error}`) : msg ? h(Text, { color: msg.startsWith('✖') ? 'red' : 'magenta' }, msg) : null,
    h(Text, { dimColor: true }, `${hints}  ·  tab/1-5 switch  ·  q quit`),
  );

  return h(Box, { flexDirection: 'column' }, header, body, footer);
}

export async function runTui(state) {
  const { waitUntilExit } = render(h(App, { state }));
  await waitUntilExit();
}
