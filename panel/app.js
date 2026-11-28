// FlagKit admin panel. Everything is built with DOM APIs and textContent: nothing from the server is ever
// parsed as HTML. The access token lives in the URL fragment and in sessionStorage, and goes out as a header.
'use strict';
(() => {
  const TOKEN_KEY = 'flagkit-token';
  const hashToken = new URLSearchParams(location.hash.slice(1)).get('t');
  try { if (hashToken) { sessionStorage.setItem(TOKEN_KEY, hashToken); history.replaceState(null, '', location.pathname); } } catch { /* storage off */ }
  let token = hashToken;
  try { token = token || sessionStorage.getItem(TOKEN_KEY); } catch { /* storage off */ }

  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v; // CSSOM, allowed under the strict CSP (style attributes are not)
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'value') n[k] = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, String(v));
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  };
  const put = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  const fmtVal = (v) => (v === null || v === undefined || v === '' ? '' : String(v));
  const ago = (iso) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 0) { const m = -s / 60; return m < 60 ? `in ${Math.round(m)} min` : m < 1440 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} d`; }
    return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  };
  const isProd = (env) => /prod/i.test(env);
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

  const actorInput = $('#actor');
  try { actorInput.value = localStorage.getItem('flagkit-actor') || ''; } catch { /* storage off */ }
  actorInput.addEventListener('input', () => { try { localStorage.setItem('flagkit-actor', actorInput.value.trim()); } catch { /* storage off */ } actorInput.classList.remove('need'); });

  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show${err ? ' err' : ''}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast'; }, err ? 6000 : 3000);
  }

  async function call(method, url, body) {
    if (!token) throw new Error('No access token. Open the link that “flagkit panel” printed.');
    const headers = { 'X-FlagKit-Token': token };
    if (body !== undefined) {
      const actor = actorInput.value.trim();
      if (!actor) { actorInput.classList.add('need'); actorInput.focus(); throw new Error('Enter your name first (top right), so the change is attributed.'); }
      headers['Content-Type'] = 'application/json';
      headers['X-Actor'] = actor;
    }
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }
  const get = (u) => call('GET', u);
  const post = (u, b) => call('POST', u, b);

  // ── state ──
  const S = { tab: 'flags', view: null, filter: 'all', q: '', open: null, experiments: null };
  const TABS = [['flags', 'Flags'], ['experiments', 'Experiments'], ['promote', 'Promote'], ['schedules', 'Scheduled'], ['activity', 'Activity'], ['approvals', 'Approvals'], ['lookup', 'User lookup']];

  function renderTabs() {
    const nav = $('#tabs');
    put(nav, ...TABS.map(([k, label]) => {
      const n = k === 'approvals' ? S.view?.pendingApprovals : k === 'schedules' ? S.view?.pendingSchedules : 0;
      return el('button', { role: 'tab', 'aria-selected': String(S.tab === k), onclick: () => { S.tab = k; render(); } }, label, n ? el('span', { class: 'count' }, n) : null);
    }));
  }

  async function load({ drawer = true } = {}) {
    try {
      S.view = await get('/api/flags');
      $('#project').textContent = `· ${S.view.project}`;
      document.title = `FlagKit Admin · ${S.view.project}`;
    } catch (e) { put($('#main'), el('div', { class: 'empty' }, e.message)); return; }
    renderTabs();
    if (S.tab === 'flags') renderFlags();
    if (S.open && drawer) renderDrawer(S.open);
  }

  function render() {
    renderTabs();
    ({ flags: renderFlags, experiments: renderExperiments, promote: renderPromote, schedules: renderSchedules, activity: renderActivity, approvals: renderApprovals, lookup: renderLookup })[S.tab]();
  }

  // ── confirm modal: shows the exact diff; Production asks for a reason and the flag name typed back ──
  function confirmChange({ title, rows, env, flag, locked, reasonOptional }) {
    return new Promise((resolve) => {
      const m = $('#modal');
      const prod = isProd(env);
      const reason = el('textarea', { rows: 2, placeholder: prod ? 'Required for Production' : 'Optional', maxlength: 500 });
      const typed = prod ? el('input', { type: 'text', placeholder: flag, autocomplete: 'off', spellcheck: 'false' }) : null;
      const force = locked ? el('input', { type: 'checkbox' }) : null;
      const ok = el('button', { class: `btn ${prod ? 'danger' : 'primary'}`, type: 'button' }, prod ? 'Apply to Production' : 'Apply');
      const check = () => { ok.disabled = (prod && !reasonOptional && !reason.value.trim()) || (typed && typed.value !== flag) || (force && !force.checked); };
      [reason, typed, force].forEach((x) => x?.addEventListener('input', check));
      check();
      put(m, 
        el('h2', {}, title),
        el('table', { class: 'diff' }, rows.map((r) => el('tr', {}, el('td', { class: 'muted' }, r[0]), el('td', { class: 'from' }, r[1]), el('td', {}, '→'), el('td', { class: 'to' }, r[2])))),
        prod ? el('div', { class: 'warnbox prodbox' }, '⚠ Production: this changes what real users get right now.') : null,
        locked ? el('div', { class: 'warnbox' }, `🧪 ${locked}. Changing it now changes what users in the test see and makes the result unreliable.`, el('label', { style: 'display:block;margin-top:6px' }, force, ' I understand, change it anyway')) : null,
        el('label', {}, 'Why are you making this change?', reason),
        typed ? el('label', { style: 'display:block;margin-top:8px' }, 'Type the flag name to confirm: ', el('b', { class: 'mono' }, flag), typed) : null,
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => { m.close(); resolve(null); } }, 'Cancel'), ok),
      );
      ok.onclick = () => { m.close(); resolve({ reason: reason.value.trim(), force: !!force?.checked }); };
      m.onclose = () => resolve(null);
      m.showModal();
      (typed || reason).focus();
    });
  }

  async function change(flag, env, patch) {
    const f = S.view.flags.find((x) => x.name === flag);
    const cur = f.envs[env];
    const next = { enabled: patch.enabled ?? cur.enabled, value: patch.value ?? cur.value };
    const rows = [];
    if (next.enabled !== cur.enabled) rows.push(['state', cur.enabled ? 'on' : 'off', next.enabled ? 'on' : 'off']);
    if (String(next.value) !== String(cur.value)) rows.push(['value', fmtVal(cur.value) || '(empty)', fmtVal(next.value) || '(empty)']);
    if (!rows.length) return;
    const exp = f.experiments.find((x) => x.env === env);
    const ok = await confirmChange({ title: `${flag} in ${env}`, rows, env, flag, locked: exp ? `In running experiment #${exp.id} "${exp.name}"` : null });
    if (!ok) return;
    try {
      const r = await post('/api/flags/set', { flag, env, ...patch, reason: ok.reason, force: ok.force });
      toast(r.noop ? 'Already in that state' : `✔ ${flag} updated in ${env}`);
      await load();
    } catch (e) { toast(e.message, true); }
  }

  // ── Flags ──
  function renderFlags() {
    const v = S.view;
    if (!v) return;
    const filters = [['all', 'All'], ['drift', 'Differs between envs'], ['experiment', 'In experiment'], ['stale', 'Stale'], ['unused', 'Unused in code']];
    const match = (f) => (!S.q || f.name.toLowerCase().includes(S.q) || f.description.toLowerCase().includes(S.q))
      && (S.filter === 'all' || (S.filter === 'drift' ? !!f.drift : f.lifecycle.status === S.filter));
    const shown = v.flags.filter(match);
    const search = el('input', { type: 'search', placeholder: `Search ${v.flags.length} flags…`, value: S.q, oninput: (e) => { S.q = e.target.value.toLowerCase(); renderFlags(); setTimeout(() => { const s = $('input[type=search]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }); } });
    const counts = { drift: v.flags.filter((f) => f.drift).length, experiment: 0, stale: 0, unused: 0 };
    for (const f of v.flags) if (counts[f.lifecycle.status] !== undefined) counts[f.lifecycle.status]++;

    const banner = v.unknownRefs.length ? el('div', { class: 'banner' },
      el('b', {}, `✖ ${v.unknownRefs.length} place${v.unknownRefs.length > 1 ? 's' : ''} in ${v.codeRoot} ask for a flag that doesn't exist.`), ' Those users silently get the default.',
      el('ul', {}, v.unknownRefs.slice(0, 6).map((u) => el('li', { class: 'mono' }, `${u.file}:${u.line}  "${u.name}"`, u.suggestion ? el('span', { class: 'muted' }, `  did you mean "${u.suggestion}"?`) : null)))) : null;

    const table = el('table', { class: 'grid' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Flag'), v.environments.map((e) => el('th', {}, e, isProd(e) ? el('span', { class: 'badge b-prod' }, 'LIVE') : null)), v.codeRoot ? el('th', { title: `References in ${v.codeRoot}` }, 'Code') : null)),
      el('tbody', {}, shown.map((f) => el('tr', {},
        el('td', {},
          el('button', { class: 'fname mono', onclick: () => { S.open = f.name; renderDrawer(f.name); } }, f.name),
          f.lifecycle.status === 'experiment' ? el('span', { class: 'badge b-experiment', title: f.lifecycle.advice }, '🧪 experiment') : null,
          f.lifecycle.status === 'stale' ? el('span', { class: 'badge b-stale', title: f.lifecycle.advice }, 'stale') : null,
          f.lifecycle.status === 'unused' ? el('span', { class: 'badge b-unused', title: f.lifecycle.advice }, 'unused') : null,
          f.drift ? el('span', { class: 'badge b-drift', title: Object.entries(f.drift).map(([e, s]) => `${e}: ${s}`).join('\n') }, '≠') : null,
          f.description ? el('div', { class: 'desc', title: f.description }, f.description) : null),
        v.environments.map((env) => {
          const c = f.envs[env];
          if (!c) return el('td', { class: 'muted' }, '—');
          const exp = f.experiments.find((x) => x.env === env);
          return el('td', {}, el('div', { class: 'cell' },
            el('button', { class: 'switch', role: 'switch', 'aria-checked': String(c.enabled), 'aria-label': `${f.name} in ${env}`, title: exp ? `In experiment #${exp.id}` : `Turn ${c.enabled ? 'off' : 'on'}`, onclick: () => change(f.name, env, { enabled: !c.enabled }) }),
            fmtVal(c.value) ? el('span', { class: 'val mono', title: fmtVal(c.value) }, fmtVal(c.value)) : null,
            exp ? el('span', { title: `experiment #${exp.id}` }, '🧪') : null));
        }),
        v.codeRoot ? el('td', { class: 'muted mono' }, f.refCount ?? '') : null))),
    );
    put($('#main'), 
      banner,
      el('div', { class: 'toolbar' }, search, filters.map(([k, label]) => el('button', { class: 'chip', 'aria-pressed': String(S.filter === k), onclick: () => { S.filter = k; renderFlags(); } }, label, k !== 'all' && counts[k] ? ` ${counts[k]}` : ''))),
      shown.length ? table : el('div', { class: 'empty' }, v.flags.length ? 'No flags match.' : 'No flags yet.'),
      el('p', { class: 'muted' }, 'Click a flag for values, scheduling and history. ≠ means environments disagree. Stale = same everywhere and untouched: remove it from the code.'),
    );
  }

  // ── Drawer: one flag ──
  async function renderDrawer(name) {
    const d = $('#drawer');
    const f = S.view.flags.find((x) => x.name === name);
    if (!f) { d.hidden = true; return; }
    const close = () => { S.open = null; d.hidden = true; };
    const hist = el('ul', { class: 'list' }, el('li', { class: 'muted' }, 'loading…'));
    put(d, 
      el('button', { class: 'close', 'aria-label': 'Close', onclick: close }, '×'),
      el('h2', { class: 'mono' }, f.name),
      el('div', { class: 'muted' }, f.description || 'No description', ' · ', f.type === 'MULTIVARIATE' ? `variants: ${['control', ...f.variants].join(', ')}` : 'standard flag'),
      f.lifecycle.advice ? el('div', { class: `warnbox${f.lifecycle.status === 'experiment' ? '' : ''}` }, f.lifecycle.advice) : null,
      (f.segmentOverrides || f.identityOverrides) ? el('div', { class: 'muted' }, `${f.segmentOverrides} segment override(s), ${f.identityOverrides} user override(s): some users see something other than the defaults below.`) : null,
      el('h3', {}, 'Environments'),
      S.view.environments.map((env) => {
        const c = f.envs[env];
        if (!c) return el('div', { class: 'envcard muted' }, `${env}: not set`);
        const value = el('input', { type: 'text', value: fmtVal(c.value), 'aria-label': `value in ${env}`, list: `variants-${f.id}` });
        const when = el('input', { type: 'datetime-local', 'aria-label': `when, ${env}` });
        const what = el('select', { 'aria-label': `scheduled state, ${env}` }, el('option', { value: 'on' }, 'turn ON'), el('option', { value: 'off' }, 'turn OFF'), el('option', { value: 'value' }, 'set value to the box above'));
        return el('div', { class: 'envcard' },
          el('div', { class: 'cell' }, el('b', {}, env), isProd(env) ? el('span', { class: 'badge b-prod' }, 'LIVE') : null,
            el('span', { style: 'flex:1' }),
            el('span', { class: 'muted' }, c.updated ? `changed ${ago(c.updated)}` : ''),
            el('button', { class: 'switch', role: 'switch', 'aria-checked': String(c.enabled), 'aria-label': `${f.name} in ${env}`, onclick: () => change(f.name, env, { enabled: !c.enabled }) })),
          el('div', { class: 'row' }, value, el('button', { class: 'btn sm', onclick: () => change(f.name, env, { value: value.value }) }, 'Save value')),
          el('div', { class: 'row' }, el('span', { class: 'muted' }, 'Schedule:'), what, when, el('button', { class: 'btn sm', onclick: () => schedule(f.name, env, what.value, value.value, when.value) }, 'Schedule')),
        );
      }),
      el('datalist', { id: `variants-${f.id}` }, ['control', ...f.variants].map((v) => el('option', { value: v }))),
      f.refs ? el('h3', {}, `In the code (${f.refCount})`) : null,
      f.refs ? el('ul', { class: 'list mono' }, f.refs.length ? f.refs.map((r) => el('li', {}, `${r.file}:${r.line}`)) : el('li', { class: 'muted' }, 'No references found.')) : null,
      el('h3', {}, 'History'),
      hist,
    );
    d.hidden = false;
    try {
      const entries = await get(`/api/audit?flag=${encodeURIComponent(name)}`);
      put(hist, ...(entries.length ? entries.slice(0, 30).map(auditRow) : [el('li', { class: 'muted' }, 'No changes made through FlagKit yet.')]));
    } catch (e) { put(hist, el('li', {}, e.message)); }
  }

  const stateText = (s) => `${s.enabled ? 'on' : 'off'}${fmtVal(s.value) ? ` · ${fmtVal(s.value)}` : ''}`;
  function auditRow(e) {
    return el('li', {},
      el('span', {}, el('b', { class: 'mono' }, e.flag), ` in ${e.env}: `, el('span', { class: 'from' }, stateText(e.before)), ' → ', el('b', {}, stateText(e.after)),
        el('div', { class: 'muted' }, `${e.actor} via ${e.via} · ${ago(e.at)}${e.reason ? ` · “${e.reason}”` : ''}${e.revertOf ? ` · reverts ${e.revertOf}` : ''}`)),
      el('button', { class: 'btn sm', title: `Put ${e.flag} in ${e.env} back to ${stateText(e.before)}`, onclick: () => doRevert(e) }, 'Revert'));
  }

  async function doRevert(e) {
    const ok = await confirmChange({ title: `Revert ${e.flag} in ${e.env}`, rows: [['back to', stateText(e.after), stateText(e.before)]], env: e.env, flag: e.flag });
    if (!ok) return;
    try { await post('/api/revert', { id: e.id, reason: ok.reason }); toast(`✔ reverted ${e.flag} in ${e.env}`); await load(); if (S.tab === 'activity') renderActivity(); }
    catch (err) { toast(err.message, true); }
  }

  async function schedule(flag, env, what, value, when) {
    if (!when) return toast('Pick a date and time', true);
    const body = { flag, env, at: new Date(when).toISOString() };
    if (what === 'on') body.enabled = true;
    else if (what === 'off') body.enabled = false;
    else body.value = value;
    const rows = [['at', '', new Date(when).toLocaleString()], ['change', '', what === 'value' ? `value = ${value}` : what.toUpperCase()]];
    const ok = await confirmChange({ title: `Schedule ${flag} in ${env}`, rows, env, flag });
    if (!ok) return;
    try { await post('/api/schedules', { ...body, reason: ok.reason }); toast('✔ scheduled. It runs while “flagkit panel” (or “flagkit schedule run”) is running.'); await load(); }
    catch (e) { toast(e.message, true); }
  }

  // ── Experiments ──
  async function renderExperiments() {
    put($('#main'), el('p', { class: 'muted' }, 'Loading experiments…'));
    try { S.experiments = await get('/api/experiments'); } catch (e) { return put($('#main'), el('div', { class: 'empty' }, e.message)); }
    if (!S.experiments.length) return put($('#main'), el('div', { class: 'empty' }, 'No running experiments.'));
    put($('#main'), el('div', { class: 'cards' }, S.experiments.map((x) => el('div', { class: 'card' },
      el('h3', {}, `#${x.id} ${x.name}`),
      el('div', { class: 'muted' }, `${x.env} · flag `, el('span', { class: 'mono' }, x.flag), ` · ${x.status}`),
      x.rows.length ? el('div', { class: 'kv' }, x.rows.flatMap((r) => [
        el('span', { class: 'mono' }, r.key), el('div', { class: `bar${(r.win ?? 0) >= 0.95 ? ' win' : ''}` }, el('span', { style: `width:${r.isControl ? 0 : Math.round((r.win ?? 0) * 100)}%` })),
        el('span', { class: 'muted' }, r.isControl ? `${r.exposures} users · ${pct(r.value)}` : `${r.exposures} users · ${pct(r.value)} · ${pct(r.win)} to win`),
      ])) : el('p', { class: 'muted' }, 'Collecting data.'),
      el('p', { class: 'muted' }, 'The flag is locked in the Flags tab while this runs. Ship a winner from “flagkit tui” or “flagkit report”.'),
    ))));
  }

  // ── Promote ──
  async function renderPromote() {
    const envs = S.view.environments;
    const from = el('select', {}, envs.map((e, i) => el('option', { value: e, selected: i === Math.max(0, envs.length - 2) }, e)));
    const to = el('select', {}, envs.map((e, i) => el('option', { value: e, selected: i === envs.length - 1 }, e)));
    const out = el('div');
    const preview = async () => {
      put(out, el('p', { class: 'muted' }, 'Comparing…'));
      if (from.value === to.value) return put(out, el('div', { class: 'empty' }, 'Pick two different environments.'));
      let plan;
      try { plan = await get(`/api/promote?from=${encodeURIComponent(from.value)}&to=${encodeURIComponent(to.value)}`); } catch (e) { return put(out, el('div', { class: 'empty' }, e.message)); }
      if (!plan.length) return put(out, el('div', { class: 'empty' }, `${to.value} already matches ${from.value}.`));
      const boxes = plan.map((p) => el('input', { type: 'checkbox', checked: !p.blocked, disabled: !!p.blocked, value: p.flag }));
      const go = el('button', { class: `btn ${isProd(to.value) ? 'danger' : 'primary'}` }, `Copy selected to ${to.value}`);
      go.onclick = async () => {
        const flags = boxes.filter((b) => b.checked).map((b) => b.value);
        if (!flags.length) return toast('Nothing selected', true);
        const rows = plan.filter((p) => flags.includes(p.flag)).map((p) => [p.flag, stateText(p.to), stateText(p.from)]);
        const ok = await confirmChange({ title: `Promote ${flags.length} flag(s) ${from.value} → ${to.value}`, rows, env: to.value, flag: to.value });
        if (!ok) return;
        try {
          const done = await post('/api/promote', { from: from.value, to: to.value, flags, reason: ok.reason });
          const bad = done.filter((x) => x.error || x.skipped);
          toast(bad.length ? `Done with ${bad.length} problem(s): ${bad.map((x) => `${x.flag}: ${x.error || x.skipped}`).join('; ')}` : `✔ ${done.length} flag(s) now match ${from.value}`, bad.length > 0);
          await load(); preview();
        } catch (e) { toast(e.message, true); }
      };
      put(out, 
        el('table', { class: 'grid' },
          el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'Flag'), el('th', {}, `${to.value} now`), el('th', {}, `becomes (from ${from.value})`))),
          el('tbody', {}, plan.map((p, i) => el('tr', {}, el('td', {}, boxes[i]), el('td', { class: 'mono' }, p.flag, p.blocked ? el('div', { class: 'muted' }, `🔒 ${p.blocked}`) : null), el('td', { class: 'from' }, stateText(p.to)), el('td', { class: 'to' }, stateText(p.from)))))),
        el('div', { class: 'toolbar', style: 'margin-top:12px' }, go),
      );
    };
    from.onchange = preview; to.onchange = preview;
    put($('#main'), 
      el('p', {}, 'Make one environment match another. Typical use: once Staging is verified, copy exactly those flag states to Production. Nothing changes until you confirm.'),
      el('div', { class: 'form' }, 'Copy from', from, 'to', to),
      out,
    );
    preview();
  }

  // ── Schedules ──
  async function renderSchedules() {
    let list;
    try { list = await get('/api/schedules'); } catch (e) { return put($('#main'), el('div', { class: 'empty' }, e.message)); }
    put($('#main'), 
      el('p', { class: 'muted' }, 'Scheduled changes run while “flagkit panel” is open, or from cron with “flagkit schedule run”. Create one from a flag\'s panel.'),
      list.length ? el('table', { class: 'grid' },
        el('thead', {}, el('tr', {}, ['When', 'Flag', 'Environment', 'Change', 'By', 'Status', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, list.map((s) => el('tr', {},
          el('td', {}, new Date(s.at).toLocaleString(), el('div', { class: 'muted' }, ago(s.at))),
          el('td', { class: 'mono' }, s.flag), el('td', {}, s.env),
          el('td', {}, s.value !== undefined ? `value = ${s.value}` : s.enabled ? 'turn ON' : 'turn OFF'),
          el('td', {}, s.actor, s.reason ? el('div', { class: 'muted' }, s.reason) : null),
          el('td', {}, s.status, s.result ? el('div', { class: 'muted' }, s.result) : null),
          el('td', {}, s.status === 'pending' ? el('button', { class: 'btn sm', onclick: async () => { try { await post('/api/schedules/cancel', { id: s.id }); toast('cancelled'); renderSchedules(); load(); } catch (e) { toast(e.message, true); } } }, 'Cancel') : null))))) : el('div', { class: 'empty' }, 'Nothing scheduled.'),
    );
  }

  // ── Activity ──
  async function renderActivity() {
    let list;
    try { list = await get('/api/audit'); } catch (e) { return put($('#main'), el('div', { class: 'empty' }, e.message)); }
    put($('#main'), 
      el('p', { class: 'muted' }, 'Every change made through the panel, the TUI, schedules and promotions: who, why, before and after. Revert puts the flag back exactly as it was.'),
      list.length ? el('div', { class: 'card' }, el('ul', { class: 'list' }, list.map(auditRow))) : el('div', { class: 'empty' }, 'No changes yet.'),
    );
  }

  // ── Approvals ──
  async function renderApprovals() {
    let list;
    try { list = await get('/api/approvals'); } catch (e) { return put($('#main'), el('div', { class: 'empty' }, e.message)); }
    const act = async (c, approve) => {
      const m = $('#modal');
      const typed = el('input', { type: 'text', placeholder: c.id, autocomplete: 'off', spellcheck: 'false' });
      const note = el('input', { type: 'text', placeholder: 'note (optional)' });
      const ok = el('button', { class: `btn ${approve ? (c.production ? 'danger' : 'primary') : ''}`, disabled: approve }, approve ? 'Apply' : 'Reject');
      typed.oninput = () => { ok.disabled = approve && typed.value !== c.id; };
      put(m, 
        el('h2', {}, `${approve ? 'Apply' : 'Reject'} ${c.id}`),
        el('p', { class: 'mono' }, c.describe),
        el('table', { class: 'diff' }, el('tr', {}, el('td', { class: 'muted' }, 'now'), el('td', {}, c.before)), el('tr', {}, el('td', { class: 'muted' }, 'after'), el('td', { class: 'to' }, c.after))),
        el('p', { class: 'muted' }, `Requested by ${c.requestedBy}. Their reason (unverified): `, c.reason),
        c.production ? el('div', { class: 'warnbox prodbox' }, '⚠ Production') : null,
        approve ? el('label', {}, 'Type the change id to apply it:', typed) : el('label', {}, note),
        el('div', { class: 'actions' }, el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok),
      );
      ok.onclick = async () => {
        m.close();
        try {
          const r = approve ? await post('/api/approvals/approve', { id: c.id, createdAt: c.createdAt, confirm: typed.value }) : await post('/api/approvals/reject', { id: c.id, createdAt: c.createdAt, note: note.value });
          toast(`${r.status}: ${r.result || ''}`, r.status === 'failed'); renderApprovals(); load();
        } catch (e) { toast(e.message, true); }
      };
      m.showModal();
    };
    put($('#main'), 
      el('p', { class: 'muted' }, 'Coding agents (through “flagkit mcp”) and the “flagkit watch” guardrail can only request changes. Nothing happens until a person applies it here or in the TUI.'),
      list.length ? el('table', { class: 'grid' },
        el('thead', {}, el('tr', {}, ['Request', 'Change', 'From', 'Status', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, list.map((c) => el('tr', {},
          el('td', { class: 'mono' }, c.id, el('div', { class: 'muted' }, ago(c.createdAt))),
          el('td', {}, el('span', { class: 'mono' }, c.describe), c.production ? el('span', { class: 'badge b-prod' }, 'PROD') : null, el('div', { class: 'muted' }, c.reason)),
          el('td', {}, c.requestedBy), el('td', {}, c.status, c.result ? el('div', { class: 'muted' }, c.result) : null),
          el('td', {}, c.status === 'pending' ? [el('button', { class: 'btn sm primary', onclick: () => act(c, true) }, 'Apply…'), ' ', el('button', { class: 'btn sm', onclick: () => act(c, false) }, 'Reject')] : null))))) : el('div', { class: 'empty' }, 'No requests.'),
    );
  }

  // ── Lookup ──
  function renderLookup() {
    const id = el('input', { type: 'text', placeholder: 'user id, e.g. customer-4821', maxlength: 200, style: 'min-width:260px' });
    const traits = el('input', { type: 'text', placeholder: 'traits (optional): plan=pro,country=IN', style: 'min-width:260px' });
    const out = el('div');
    const go = async () => {
      if (!id.value.trim()) return;
      put(out, el('p', { class: 'muted' }, 'Evaluating…'));
      try {
        const d = await get(`/api/explain?identity=${encodeURIComponent(id.value.trim())}${traits.value.trim() ? `&traits=${encodeURIComponent(traits.value.trim())}` : ''}`);
        put(out, el('div', { class: 'cards' }, d.environments.map((env) => el('div', { class: 'card' },
          el('h3', {}, env.name, isProd(env.name) ? el('span', { class: 'badge b-prod' }, 'LIVE') : null),
          el('div', { class: 'muted' }, env.known ? `known user${env.traits.length ? ` · ${env.traits.join(' ')}` : ''}` : 'never seen: evaluated as a new user (nothing saved)'),
          el('ul', { class: 'list' }, env.flags.map((f) => el('li', {}, el('span', {}, el('b', { class: 'mono' }, f.flag), ' ', f.enabled ? 'on' : 'off', fmtVal(f.value) ? ` · ${fmtVal(f.value)}` : '', el('div', { class: 'muted' }, f.why))))),
        ))));
      } catch (e) { put(out, el('div', { class: 'empty' }, e.message)); }
    };
    id.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    put($('#main'), 
      el('p', {}, '"Why does this customer see that?" Uses Flagsmith\'s own evaluation, so the answer is exactly what the app gets: segment, percentage split, experiment bucket or a per-user override.'),
      el('div', { class: 'form' }, id, traits, el('button', { class: 'btn primary', onclick: go }, 'Look up')),
      out,
    );
    id.focus();
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').open) { S.open = null; $('#drawer').hidden = true; } });
  load();
  setInterval(() => { if (!document.hidden && !$('#modal').open && S.tab === 'flags') load({ drawer: false }); }, 10_000);
})();
