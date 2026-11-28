// flagkit plan — before you start: how many visitors does this test need?
// Flagsmith's engine is Bayesian, so there is no closed-form sample size. We estimate it the honest way:
// simulate the experiment many times at your numbers and count how often it reaches the ship bar
// (chance to beat control >= threshold). The result is an estimate, and we say so.

// Small seeded RNG so the same inputs always give the same plan.
function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand) {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Binomial draw: exact for small n, normal approximation when it is accurate.
function binomial(n, p, rand) {
  if (n * p * (1 - p) < 25) {
    let k = 0;
    for (let i = 0; i < n; i++) if (rand() < p) k++;
    return k;
  }
  const k = Math.round(n * p + Math.sqrt(n * p * (1 - p)) * normal(rand));
  return Math.min(n, Math.max(0, k));
}

// Standard normal CDF (Abramowitz-Stegun 7.1.26).
export function phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// P(variant > control) with Beta(1+c, 1+n-c) posteriors, normal approximation.
export function chanceToBeat(nA, cA, nB, cB) {
  const beta = (n, c) => {
    const a = 1 + c, b = 1 + n - c;
    return { m: a / (a + b), v: (a * b) / ((a + b) ** 2 * (a + b + 1)) };
  };
  const A = beta(nA, cA), B = beta(nB, cB);
  return phi((B.m - A.m) / Math.sqrt(A.v + B.v));
}

// Share of simulated experiments with nPerArm users per arm that reach the ship bar.
export function power({ baseline, lift, nPerArm, threshold = 0.95, runs = 2000, seed = 42 }) {
  const rand = rng(seed);
  const pB = Math.min(0.999, baseline * (1 + lift));
  let wins = 0;
  for (let i = 0; i < runs; i++) {
    const cA = binomial(nPerArm, baseline, rand);
    const cB = binomial(nPerArm, pB, rand);
    if (chanceToBeat(nPerArm, cA, nPerArm, cB) >= threshold) wins++;
  }
  return wins / runs;
}

// Smallest users-per-arm that reaches `target` power (binary search over simulated power).
export function plan({ baseline, lift, threshold = 0.95, target = 0.8, runs = 2000, seed = 42, maxPerArm = 2_000_000 }) {
  if (!(baseline > 0 && baseline < 1)) throw new Error('--baseline must be a rate between 0 and 1 (e.g. 0.08 for 8%)');
  if (!(lift > 0)) throw new Error('--lift must be a positive relative lift (e.g. 0.2 for +20%)');
  if (baseline * (1 + lift) >= 1) throw new Error('baseline × (1 + lift) must stay below 100%');
  let lo = 20, hi = 20;
  while (power({ baseline, lift, nPerArm: hi, threshold, runs, seed }) < target) {
    lo = hi;
    hi *= 2;
    if (hi > maxPerArm) return { perArm: null, threshold, target };
  }
  while (hi - lo > Math.max(10, hi * 0.02)) {
    const mid = Math.round((lo + hi) / 2);
    if (power({ baseline, lift, nPerArm: mid, threshold, runs, seed }) >= target) hi = mid; else lo = mid;
  }
  return { perArm: hi, threshold, target, falsePositive: power({ baseline, lift: 1e-9, nPerArm: hi, threshold, runs, seed: seed + 1 }) };
}

export function printPlan({ baseline, lift, daily, arms = 2, threshold = 0.95, target = 0.8 }) {
  const p = plan({ baseline, lift, threshold, target });
  const pct = (x) => `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`;
  console.log(`\nPlan: baseline ${pct(baseline)}, detect a lift of +${pct(lift)} (${pct(baseline)} → ${pct(baseline * (1 + lift))})`);
  if (!p.perArm) {
    console.log('  This lift is too small to detect with a realistic number of visitors. Test something bolder.\n');
    return p;
  }
  const total = p.perArm * arms;
  console.log(`  ≈ ${p.perArm.toLocaleString()} visitors per version, ${total.toLocaleString()} in total (${arms} versions)`);
  console.log(`  gives the test an estimated ${pct(target)} chance of reaching the ship bar (≥${pct(threshold)} chance to beat control) if the lift is real.`);
  if (daily) {
    const days = Math.ceil(total / daily);
    console.log(`  At ${Number(daily).toLocaleString()} visitors a day: about ${days} day${days === 1 ? '' : 's'}.${days > 28 ? ' That is long: test a bigger change or a metric that fires more often.' : ''}`);
  }
  console.log(`  If there is no real difference, about ${pct(p.falsePositive)} of tests this size would still cross the bar by chance,`);
  console.log('  so don\'t stop the moment it first crosses: wait for this sample size.');
  console.log('  Estimate from 2,000 simulated experiments per step (Bayesian engines have no exact formula).\n');
  return p;
}
