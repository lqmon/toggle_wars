// Serves the sample landing page, wired to the local self-hosted Flagsmith.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { envOf, DEMO } from './experiment.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export function serveDemo(state, { port = 3000, envName = 'Development' } = {}) {
  const env = envOf(state, envName);
  const sdkPath = path.join(path.dirname(require.resolve('@flagsmith/flagsmith')), 'index.mjs');
  const config = {
    environmentID: env.api_key,
    api: `${state.apiUrl}/api/v1/`,
    eventsApiUrl: `${state.apiUrl}/api/`,
    flag: state.experiments[env.name]?.flag || DEMO.flag,
    event: state.experiments[env.name]?.event || DEMO.event,
  };
  const routes = {
    '/': ['text/html', () => fs.readFileSync(path.join(ROOT, 'demo-app', 'index.html'))],
    '/config.js': ['text/javascript', () => `window.FLAGKIT_CONFIG = ${JSON.stringify(config)};`],
    '/sdk.mjs': ['text/javascript', () => fs.readFileSync(sdkPath)],
  };
  http
    .createServer((req, res) => {
      const route = routes[new URL(req.url, 'http://x').pathname];
      if (!route) { res.writeHead(404).end('not found'); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      res.writeHead(200, {
        'Content-Type': `${route[0]}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        // Page may only talk to itself and the configured Flagsmith host.
        'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ${new URL(state.apiUrl).origin}; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      }).end(route[1]());
    })
    .listen(port, '127.0.0.1', () => {
      console.log(`✔ Demo landing page on http://localhost:${port}  (environment ${env.name}, flag "${config.flag}")`);
      console.log('  Each new browser profile / private window is a new visitor. Ctrl+C to stop.');
    });
}
