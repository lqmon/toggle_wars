// Integration test inside real VS Code: activate, open code that uses flags, then check the hover, the
// typo diagnostic and its quick fix, flag-name completion and the CodeLens.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async () => {
  const out = path.join(__dirname, 'result.json');
  const checks = {};
  try {
    const ext = vscode.extensions.all.find((e) => e.id.endsWith('flagkit-vscode'));
    await ext.activate();
    const content = [
      "const flag = flagsmith.getExperimentFlag('hero_headline');",
      "const msg = flagsmith.getValue('hero_headlin');",
      "const on = hasFeature('');",
    ].join('\n');
    const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content });
    await vscode.window.showTextDocument(doc);

    let hovers = [];
    for (let i = 0; i < 40 && !hovers.length; i++) {
      await wait(500);
      hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 45));
    }
    const text = hovers.flatMap((h) => h.contents.map((c) => c.value || String(c))).join('\n');
    checks.hover = /hero\\?_headline/.test(text) && /chance to beat control/.test(text);

    let diags = [];
    for (let i = 0; i < 20 && !diags.length; i++) { await wait(300); diags = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'FlagKit'); }
    const typo = diags.find((d) => d.code === 'unknown-flag');
    checks.typoDiagnostic = !!typo && /Did you mean "hero_headline"/.test(typo.message) && typo.range.start.line === 1;

    const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, typo.range);
    const fix = (actions || []).find((a) => /Change to "hero_headline"/.test(a.title));
    checks.quickFix = !!fix;
    if (fix?.edit) { await vscode.workspace.applyEdit(fix.edit); checks.quickFixApplied = doc.lineAt(1).text.includes("'hero_headline'"); }

    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(2, 23));
    checks.completion = (list?.items || []).some((i) => (i.label.label || i.label) === 'hero_headline');

    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
    checks.codeLens = (lenses || []).some((l) => /Development/.test(l.command?.title || ''));

    fs.writeFileSync(out, JSON.stringify({ ok: Object.values(checks).every(Boolean), checks, hover: text.slice(0, 400) }));
  } catch (e) {
    fs.writeFileSync(out, JSON.stringify({ ok: false, checks, error: String((e && e.stack) || e) }));
  }
};
