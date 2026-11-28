// The app. Four flag patterns you will use in every product:
//   maintenance_mode  kill switch: one toggle turns the whole site into a friendly 503 (health checks stay up)
//   checkout_v2       release toggle: ship the new checkout dark, turn it on per environment or per segment
//   welcome_message   remote config: change copy without a deploy
//   pricing_layout    experiment: control vs compact, with the exposure and the conversion recorded
import express from 'express';
import crypto from 'node:crypto';
import { createFlagClient } from './flags.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title, body, source) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px}
.plans{display:grid;gap:12px}.plans.compact{grid-template-columns:repeat(3,1fr)}.plan{border:1px solid #ddd;border-radius:10px;padding:14px}
button{padding:8px 14px;border-radius:8px;border:0;background:#111;color:#fff}small{color:#777}</style></head>
<body>${body}<p><small>flags: ${esc(source)}</small></p></body></html>`;

export function createApp({ flagClient = createFlagClient() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));

  // Anonymous visitors need a stable id, or experiments can't count them.
  app.use((req, res, next) => {
    let uid = /(?:^|;\s*)uid=([\w-]{8,64})/.exec(req.headers.cookie || '')?.[1];
    if (!uid) {
      uid = crypto.randomUUID();
      res.cookie('uid', uid, { httpOnly: true, sameSite: 'lax', maxAge: 31536000e3 });
    }
    req.flags = flagClient.forUser(uid);
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  // Kill switch: checked before every other route.
  app.use(async (req, res, next) => {
    const flags = await req.flags;
    res.set('X-Flags-Source', flags.source);
    if (flags.isOn('maintenance_mode')) return res.status(503).send(page('Back soon', '<h1>Back in a few minutes</h1><p>We are doing some maintenance.</p>', flags.source));
    next();
  });

  app.get('/', async (req, res) => {
    const flags = await req.flags;
    const welcome = flags.value('welcome_message') || 'Welcome!';
    res.send(page('Home', `<h1>${esc(welcome)}</h1>
      <p><a href="/pricing">Pricing</a> · <a href="/checkout">Checkout</a></p>`, flags.source));
  });

  app.get('/pricing', async (req, res) => {
    const flags = await req.flags;
    const layout = await flags.variant('pricing_layout'); // exposure recorded here, where it is shown
    const plans = [['Free', '$0'], ['Pro', '$12'], ['Team', '$40']]
      .map(([n, p]) => `<div class="plan"><b>${n}</b> ${p}/mo <form method="post" action="/upgrade"><input type="hidden" name="plan" value="${n}"><button>Choose ${n}</button></form></div>`).join('');
    res.send(page('Pricing', `<h1>Pricing</h1><div class="plans ${layout === 'compact' ? 'compact' : ''}">${plans}</div>`, flags.source));
  });

  app.post('/upgrade', async (req, res) => {
    const flags = await req.flags;
    flags.track('upgrade_click'); // the conversion the pricing_layout experiment counts
    res.send(page('Thanks', `<h1>Thanks for choosing ${esc(req.body.plan)}</h1><p><a href="/">Home</a></p>`, flags.source));
  });

  app.get('/checkout', async (req, res) => {
    const flags = await req.flags;
    if (flags.isOn('checkout_v2')) {
      return res.send(page('Checkout', '<h1>Checkout</h1><p>One page, Apple Pay first. (checkout_v2)</p>', flags.source));
    }
    res.send(page('Checkout', '<h1>Checkout</h1><p>Step 1 of 3: your details.</p>', flags.source));
  });

  return app;
}
