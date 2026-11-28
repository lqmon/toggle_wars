// FlagKit for VS Code: live Flagsmith flag values next to the flag names in your code.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { findFlagRefs, Client, loadProject, inlineText, hoverMarkdown, dashboardOf } = require('./lib');

let data = null;
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
const redrawAll = () => vscode.window.visibleTextEditors.forEach(redraw);

let status;

function activate(ctx) {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'flagkit.refresh';
  status.show();
  ctx.subscriptions.push(status, deco);

  ctx.subscriptions.push(vscode.languages.registerHoverProvider([{ scheme: 'file' }, { scheme: 'untitled' }], {
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
    vscode.workspace.onDidChangeTextDocument((e) => vscode.window.visibleTextEditors.filter((ed) => ed.document === e.document).forEach(redraw)),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('flagkit') && refresh(ctx)),
  );

  const every = Math.max(15, vscode.workspace.getConfiguration('flagkit').get('refreshSeconds', 60));
  timer = setInterval(() => refresh(ctx), every * 1000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  refresh(ctx);
}

function deactivate() { if (timer) clearInterval(timer); }

module.exports = { activate, deactivate };
