// A tiny product sign-up page: the "real app" the agent skill runs an experiment on.
// No dependencies. Each visitor gets an anonymous id cookie, which is the identity to experiment on.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 4000);

const FIELDS = [
  ['name', 'Full name', 'text'],
  ['email', 'Work email', 'email'],
  ['password', 'Password', 'password'],
  ['company', 'Company', 'text'],
  ['role', 'Job title', 'text'],
  ['phone', 'Phone number', 'tel'],
];

function visitorId(req, res) {
  const m = /(?:^|;\s*)vid=([\w-]{8,64})/.exec(req.headers.cookie || '');
  if (m) return m[1];
  const id = `v-${crypto.randomUUID()}`;
  res.setHeader('Set-Cookie', `vid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  return id;
}

function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Acme — Start your free trial</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px}
label{display:block;margin:12px 0 4px;font-weight:600}input{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:#111;color:#fff;font-weight:700}</style></head>
<body>${body}</body></html>`;
}

function signupForm(fields) {
  const inputs = fields.map(([n, l, t]) => `<label for="${n}">${l}</label><input id="${n}" name="${n}" type="${t}" required>`).join('');
  return page(`<h1>Start your free trial</h1><form method="post" action="/signup">${inputs}<button type="submit">Create account</button></form>`);
}

const server = http.createServer(async (req, res) => {
  const vid = visitorId(req, res);
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(signupForm(FIELDS));
  }
  if (req.method === 'POST' && req.url === '/signup') {
    // (a real app would create the account here)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page(`<h1>Welcome aboard!</h1><p>Account created for visitor ${vid.slice(0, 10)}.</p>`));
  }
  res.writeHead(404).end('not found');
});

server.listen(PORT, '127.0.0.1', () => console.log(`signup app on http://localhost:${PORT}`));
