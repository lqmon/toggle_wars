// SIMULATED visitors for the local demo: each one loads the sign-up page through the app (so the app's own
// Flagsmith instrumentation records the exposure), then submits the form with a probability that depends on
// how many fields it was shown. The probabilities are this script's assumption, which the experiment has to discover.
// usage: node traffic.mjs [visitors=700] [url=http://127.0.0.1:4000]
const N = Number(process.argv[2] || 700);
const URL_ = process.argv[3] || 'http://127.0.0.1:4000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_)) throw new Error('traffic.mjs only targets a local app');
const P_SIGNUP = { 6: 0.22, 3: 0.34 };

const tally = {};
async function visit() {
  const r = await fetch(`${URL_}/`);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const html = await r.text();
  const fields = (html.match(/<input /g) || []).length;
  const t = (tally[fields] ??= { visitors: 0, signups: 0 });
  t.visitors++;
  if (Math.random() < (P_SIGNUP[fields] ?? 0.2)) {
    await fetch(`${URL_}/signup`, { method: 'POST', headers: { cookie } });
    t.signups++;
  }
}
const queue = Array.from({ length: N }, (_, i) => i);
await Promise.all(Array.from({ length: 10 }, async () => { while (queue.length) { queue.pop(); await visit(); } }));
for (const [f, t] of Object.entries(tally)) console.log(`${f}-field form: ${t.visitors} visitors, ${t.signups} sign-ups (${((100 * t.signups) / t.visitors).toFixed(1)}%)`);
