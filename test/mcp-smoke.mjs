import { Client } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
const c = new Client({ name: 'test', version: '1' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['bin/flagkit.js', 'mcp'], cwd: new URL('..', import.meta.url).pathname, stderr: 'ignore' }));
const tools = await c.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));
const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const t = r.content[0].text; console.log(`\n== ${name} ${JSON.stringify(args)} (${t.length} chars)${r.isError ? ' ERROR' : ''}\n${t}`); return t; };
await call('flagkit_list_flags');
await call('flagkit_list_experiments');
await call('flagkit_experiment_results', { experiment_id: 2, environment: 'Staging' });
const p = await call('flagkit_propose_change', { kind: 'toggle_flag', environment: 'Production', flag: 'hero_headline', enabled: false, reason: 'Kill switch drill for the demo' });
await call('flagkit_propose_change', { kind: 'toggle_flag', environment: 'Production', flag: 'x; rm -rf /', enabled: false, reason: 'hostile input' });
const id = p.match(/chg_[0-9a-f]{6}/)[0];
await call('flagkit_change_status', { id });
await call('flagkit_list_flags');
await c.close();
// Assertions for CI: the proposal must not have been applied.
const { listChanges } = await import('../src/approvals.js');
const pending = listChanges('pending');
if (!pending.length) { console.error('expected a pending change'); process.exit(1); }
console.log(`\nOK: ${pending.length} pending change(s), nothing applied without a human.`);
