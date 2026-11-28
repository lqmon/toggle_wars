import fs from 'node:fs';
import { createApp } from './app.js';

// Load .env (written by `flagkit init`) without a dependency. Real environment variables win.
try {
  for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch { /* no .env: defaults from flags.generated.js */ }

const { createFlagClient } = await import('./flags.js');
const port = Number(process.env.PORT || 3000);
createApp({ flagClient: createFlagClient() }).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}`));
