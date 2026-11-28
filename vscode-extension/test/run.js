// Integration test inside real VS Code: activate, open a file that mentions a flag, ask for the hover.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
exports.run = async () => {
  const out = path.join(__dirname, 'result.json');
  try {
    const ext = vscode.extensions.all.find((e) => e.id.endsWith('flagkit-vscode'));
    await ext.activate();
    const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content: "const flag = flagsmith.getExperimentFlag('hero_headline');\n" });
    await vscode.window.showTextDocument(doc);
    let hovers = [];
    for (let i = 0; i < 40 && !hovers.length; i++) {
      await new Promise((r) => setTimeout(r, 500));
      hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 45));
    }
    const text = hovers.flatMap((h) => h.contents.map((c) => c.value || String(c))).join('\n');
    fs.writeFileSync(out, JSON.stringify({ ok: /hero\\?_headline/.test(text) && /chance to beat control/.test(text), text }));
  } catch (e) {
    fs.writeFileSync(out, JSON.stringify({ ok: false, error: String(e && e.stack || e) }));
  }
};
