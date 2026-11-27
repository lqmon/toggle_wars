// Builds the landing page as a static site (e.g. for GitHub Pages) wired to a public Flagsmith,
// usually Flagsmith Cloud. Only the *client-side* environment key is embedded — it is public by design.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DEMO } from './experiment.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export function buildPage({ envKey, out = 'docs', apiUrl, flag = DEMO.flag, event = DEMO.event }) {
  if (!/^[A-Za-z0-9]{10,40}$/.test(envKey || '')) throw new Error('--env-key must be a client-side environment key (server keys start with "ser." and must never be published)');
  const cfg = { environmentID: envKey, flag, event };
  let origins = ['https://edge.api.flagsmith.com', 'https://api.flagsmith.com', 'https://events.api.flagsmith.com'];
  if (apiUrl) {
    const base = apiUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
    if (!base.startsWith('https://')) throw new Error('--api-url must be https:// for a public page');
    Object.assign(cfg, { api: `${base}/api/v1/`, eventsApiUrl: `${base}/api/` });
    origins = [new URL(base).origin];
  }
  const csp = `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${origins.join(' ')}; img-src 'self' data:; base-uri 'none'; form-action 'none'`;
  const sdk = path.join(path.dirname(require.resolve('@flagsmith/flagsmith')), 'index.mjs');
  fs.mkdirSync(out, { recursive: true });
  const html = fs.readFileSync(path.join(ROOT, 'demo-app', 'index.html'), 'utf8')
    .replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${csp}" />`);
  fs.writeFileSync(path.join(out, 'index.html'), html);
  fs.writeFileSync(path.join(out, 'config.js'), `window.FLAGKIT_CONFIG = ${JSON.stringify(cfg)};\n`);
  fs.copyFileSync(sdk, path.join(out, 'sdk.mjs'));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  console.log(`✔ Static page written to ${out}/ (flag "${flag}", event "${event}", ${apiUrl ? apiUrl : 'Flagsmith Cloud'})`);
}
