// FlagKit for VS Code: live Flagsmith flag values next to the flag names in your code.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { findFlagRefs, findFlagCalls, suggest, lifecycleOf, Client, loadProject, inlineText, hoverMarkdown, dashboardOf, clean, abbr } = require('./lib');

let data = null;
let diagnostics;
const lensChanged = new vscode.EventEmitter();
let conn = null;
let timer = null;
const deco = vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 1em', fontStyle: 'italic' } });

// Connection: settings + a key in VS Code's secret storage, or the FlagKit local stack (.flagkit/state.json).
async function resolveConnection(ctx) {
  const cfg = vscode.workspace.getConfiguration('flagkit');
  const key = await ctx.secrets.get('flagkit.apiKey');
  if (key && cfg.get('projectId')) return { apiUrl: cfg.get('apiUrl'), key, projectId: String(cfg.get('projectId')), source: 'settings' };
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const p = path.join(folder.uri.fsPath, '.flagkit', 'state.json');
    try {
      if (fs.lstatSync(p).isSymbolicLink()) continue;
      const st = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (st.masterKey && st.project?.id) return { apiUrl: st.apiUrl, key: st.masterKey, projectId: String(st.project.id), source: 'flagkit stack' };
    } catch { /* not a FlagKit folder */ }
  }
  return null;
}

async function refresh(ctx, { quiet = true } = {}) {
  conn = await resolveConnection(ctx);
  if (!conn) {
    data = null;
    status.text = '$(flag) FlagKit: not connected';
    status.tooltip = 'Run "FlagKit: Connect to Flagsmith", or `flagkit up` in this folder';
    redrawAll();
    return;
  }
  try {
    status.text = '$(sync~spin) FlagKit';
    data = await loadProject(new Client({ apiUrl: conn.apiUrl, key: conn.key }), conn.projectId);
    const n = Object.keys(data.flags).length;
    const running = Object.values(data.flags).reduce((a, f) => a + f.experiments.filter((x) => x.status === 'running').length, 0);
    status.text = `$(flag) ${n} flags${running ? ` · 🧪 ${running}` : ''}`;
    status.tooltip = `FlagKit · ${conn.source} · ${conn.apiUrl} · project ${conn.projectId}\nClick to refresh`;
  } catch (e) {
    status.text = '$(warning) FlagKit';
    status.tooltip = `FlagKit could not load flags: ${e.message}`;
    if (!quiet) vscode.window.showErrorMessage(`FlagKit: ${e.message}`);
  }
  redrawAll();
}

function redraw(editor) {
  if (!editor) return;
  if (!data || !vscode.workspace.getConfiguration('flagkit').get('inline', true)) return editor.setDecorations(deco, []);
  const doc = editor.document;
  if (doc.lineCount > 20000) return;
  const refs = findFlagRefs(doc.getText(), new Set(Object.keys(data.flags)));
  const seenLines = new Set();
  const opts = [];
  for (const r of refs) {
    const pos = doc.positionAt(r.after);
    if (seenLines.has(pos.line)) continue;
    seenLines.add(pos.line);
    const end = doc.lineAt(pos.line).range.end;
    opts.push({ range: new vscode.Range(end, end), renderOptions: { after: { contentText: inlineText(data.flags[r.flag]) } } });
  }
  editor.setDecorations(deco, opts);
}
const redrawAll = () => { vscode.window.visibleTextEditors.forEach(redraw); vscode.workspace.textDocuments.forEach(diagnose); lensChanged.fire(); };

const DOC_SELECTOR = [{ scheme: 'file' }, { scheme: 'untitled' }];
const isCode = (doc) => !['plaintext', 'markdown', 'json', 'jsonc', 'yaml', 'log', 'git-commit', 'scminput'].includes(doc.languageId) && doc.lineCount <= 20000;

// Problems panel: flag names that don't exist (a typo ships the default to everyone), and stale flags.
function diagnose(doc) {
  if (!diagnostics || !['file', 'untitled'].includes(doc.uri.scheme)) return;
  if (!data || !isCode(doc)) return diagnostics.delete(doc.uri);
  const names = Object.keys(data.flags);
  const text = doc.getText();
  const out = [];
  for (const c of findFlagCalls(text)) {
    if (!c.name || data.flags[c.name]) continue;
    const s = suggest(c.name, names);
    const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(c.start), doc.positionAt(c.end)),
      `"${clean(c.name)}" is not a flag in this Flagsmith project${s ? `. Did you mean "${s}"?` : ''} This code will always get the default.`, vscode.DiagnosticSeverity.Error);
    d.source = 'FlagKit'; d.code = 'unknown-flag';
    if (s) d.suggestion = s;
    out.push(d);
  }
  const staleDays = vscode.workspace.getConfiguration('flagkit').get('staleDays', 14);
  const seen = new Set();
  for (const r of findFlagRefs(text, new Set(names))) {
    const lc = lifecycleOf(data.flags[r.flag], { staleDays });
    if (lc.status !== 'stale' || seen.has(r.start)) continue;
    seen.add(r.start);
    const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)), lc.advice, vscode.DiagnosticSeverity.Information);
    d.source = 'FlagKit'; d.code = 'stale-flag';
    out.push(d);
  }
  diagnostics.set(doc.uri, out);
}

// Quick fix: replace the unknown name with the closest real flag.
const codeActions = {
  provideCodeActions(doc, _range, ctx) {
    return ctx.diagnostics.filter((d) => d.source === 'FlagKit' && d.code === 'unknown-flag' && d.suggestion).map((d) => {
      const a = new vscode.CodeAction(`Change to "${d.suggestion}"`, vscode.CodeActionKind.QuickFix);
      a.edit = new vscode.WorkspaceEdit();
      a.edit.replace(doc.uri, d.range, d.suggestion);
      a.diagnostics = [d];
      a.isPreferred = true;
      return a;
    });
  },
};

// Autocomplete flag names inside SDK calls, with each flag's live state as the detail.
const completion = {
  provideCompletionItems(doc, pos) {
    if (!data) return [];
    const line = doc.lineAt(pos.line).text.slice(0, pos.character);
    if (!/(['"`])[\w.-]*$/.test(line)) return [];
    if (!findFlagCalls(`${line}')`).length) return [];
    const quote = /(['"`])([\w.-]*)$/.exec(line);
    const range = new vscode.Range(pos.translate(0, -quote[2].length), pos);
    return Object.values(data.flags).map((f) => {
      const item = new vscode.CompletionItem(f.name, vscode.CompletionItemKind.EnumMember);
      item.range = range;
      item.detail = f.envs.map((e) => `${abbr(e.name)} ${e.enabled ? 'on' : 'off'}`).join(' · ') + (f.experiments.some((x) => x.status === 'running') ? ' · 🧪' : '');
      const doc2 = new vscode.MarkdownString(hoverMarkdown(f, dashboardOf(conn?.apiUrl), conn?.projectId));
      doc2.isTrusted = false;
      item.documentation = doc2;
      return item;
    });
  },
};

// CodeLens above a line that uses a flag: its state per environment, click to toggle (not Production).
const codeLens = {
  onDidChangeCodeLenses: lensChanged.event,
  provideCodeLenses(doc) {
    if (!data || !vscode.workspace.getConfiguration('flagkit').get('codeLens', true) || !isCode(doc)) return [];
    const lenses = [];
    const lines = new Set();
    for (const c of findFlagCalls(doc.getText())) {
      const f = data.flags[c.name];
      const line = doc.positionAt(c.start).line;
      if (!f || lines.has(line)) continue;
      lines.add(line);
      const range = new vscode.Range(line, 0, line, 0);
      for (const e of f.envs) {
        const prod = /prod/i.test(e.name);
        lenses.push(new vscode.CodeLens(range, prod
          ? { title: `${e.enabled ? '●' : '○'} ${e.name}`, tooltip: 'Production changes go through `flagkit panel` (reason + audit log)', command: '' }
          : { title: `${e.enabled ? '●' : '○'} ${e.name}`, tooltip: `Turn ${f.name} ${e.enabled ? 'OFF' : 'ON'} in ${e.name}`, command: 'flagkit.toggle', arguments: [f.name, e.name] }));
      }
      const lc = lifecycleOf(f);
      if (lc.status === 'experiment') {
        const x = f.experiments.find((y) => y.status === 'running');
        lenses.push(new vscode.CodeLens(range, { title: `🧪 #${x.id}${x.best ? ` ${clean(x.best.key)} ${(x.best.win * 100).toFixed(0)}%` : ''}: don't toggle mid-test`, command: '' }));
      }
    }
    return lenses;
  },
};

let status;

function activate(ctx) {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'flagkit.refresh';
  status.show();
  ctx.subscriptions.push(status, deco);

  diagnostics = vscode.languages.createDiagnosticCollection('flagkit');
  ctx.subscriptions.push(
    diagnostics,
    vscode.languages.registerCodeActionsProvider(DOC_SELECTOR, codeActions, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerCompletionItemProvider(DOC_SELECTOR, completion, "'", '"', '`'),
    vscode.languages.registerCodeLensProvider(DOC_SELECTOR, codeLens),
    vscode.workspace.onDidOpenTextDocument(diagnose),
    vscode.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)),
  );

  ctx.subscriptions.push(vscode.languages.registerHoverProvider(DOC_SELECTOR, {
    provideHover(doc, pos) {
      if (!data) return null;
      const range = doc.getWordRangeAtPosition(pos, /[A-Za-z0-9_.-]+/);
      const word = range && doc.getText(range);
      const f = word && data.flags[word];
      if (!f) return null;
      const hover = new vscode.MarkdownString(hoverMarkdown(f, dashboardOf(conn?.apiUrl), conn?.projectId));
      hover.isTrusted = false; // server-held text is data: no command links
      hover.supportHtml = false;
      return new vscode.Hover(hover, range);
    },
  }));

  ctx.subscriptions.push(
    vscode.commands.registerCommand('flagkit.refresh', () => refresh(ctx, { quiet: false })),
    // Toggle from the editor. Never Production (that goes through the panel, with a reason and an audit trail),
    // never a flag inside a running experiment, and always behind a modal confirmation.
    vscode.commands.registerCommand('flagkit.toggle', async (flagName, envName) => {
      const f = data?.flags[flagName];
      const e = f?.envs.find((x) => x.name === envName);
      if (!f || !e) return;
      if (/prod/i.test(e.name)) return vscode.window.showWarningMessage('FlagKit: Production changes go through `flagkit panel`, where they need a reason and are audited.');
      const x = f.experiments.find((y) => y.status === 'running' && y.env === e.name);
      if (x) return vscode.window.showWarningMessage(`FlagKit: ${f.name} is in running experiment #${x.id} in ${e.name}. Toggling it now corrupts the result.`);
      const pick = await vscode.window.showWarningMessage(`Turn ${f.name} ${e.enabled ? 'OFF' : 'ON'} in ${e.name}?`, { modal: true }, 'Yes');
      if (pick !== 'Yes') return;
      try {
        await new Client({ apiUrl: conn.apiUrl, key: conn.key }).patch(`environments/${encodeURIComponent(e.key)}/featurestates/${Number(e.stateId)}/`, { enabled: !e.enabled });
        vscode.window.setStatusBarMessage(`FlagKit: ${f.name} ${e.enabled ? 'OFF' : 'ON'} in ${e.name}`, 4000);
        await refresh(ctx);
      } catch (err) { vscode.window.showErrorMessage(`FlagKit: ${err.message}`); }
    }),
    vscode.commands.registerCommand('flagkit.connect', async () => {
      const cfg = vscode.workspace.getConfiguration('flagkit');
      const apiUrl = await vscode.window.showInputBox({ prompt: 'Flagsmith API URL', value: cfg.get('apiUrl') || 'https://api.flagsmith.com', ignoreFocusOut: true });
      if (!apiUrl) return;
      const projectId = await vscode.window.showInputBox({ prompt: 'Project id (the number in the dashboard URL after /project/)', value: String(cfg.get('projectId') || ''), ignoreFocusOut: true, validateInput: (v) => (/^\d+$/.test(v) ? null : 'a number') });
      if (!projectId) return;
      const key = await vscode.window.showInputBox({ prompt: 'Organisation API key (stored in VS Code secret storage, never in settings)', password: true, ignoreFocusOut: true });
      if (!key) return;
      await cfg.update('apiUrl', apiUrl, vscode.ConfigurationTarget.Workspace);
      await cfg.update('projectId', Number(projectId), vscode.ConfigurationTarget.Workspace);
      await ctx.secrets.store('flagkit.apiKey', key);
      await refresh(ctx, { quiet: false });
    }),
    vscode.commands.registerCommand('flagkit.disconnect', async () => { await ctx.secrets.delete('flagkit.apiKey'); await refresh(ctx); }),
    vscode.window.onDidChangeActiveTextEditor(redraw),
    vscode.window.onDidChangeVisibleTextEditors(redrawAll),
    vscode.workspace.onDidChangeTextDocument((e) => { vscode.window.visibleTextEditors.filter((ed) => ed.document === e.document).forEach(redraw); diagnose(e.document); }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('flagkit') && refresh(ctx)),
  );

  const every = Math.max(15, vscode.workspace.getConfiguration('flagkit').get('refreshSeconds', 60));
  timer = setInterval(() => refresh(ctx), every * 1000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  refresh(ctx);
}

function deactivate() { if (timer) clearInterval(timer); }

module.exports = { activate, deactivate };
