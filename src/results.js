// Normalise the (beta) experiment results payload into rows.
export function summarise(results) {
  const payload = results?.results?.payload ?? results?.payload ?? null;
  if (!payload) return { asOf: results?.results?.as_of ?? null, rows: [] };
  // payload.metrics[i] = { variants: {key: {n, sum}}, inference: {key: {lift, ci_low, ci_high, chance_to_win}} }
  const metric = (payload.metrics || [])[0] || {};
  const inference = metric.inference || {};
  const rows = Object.entries(metric.variants || {}).map(([key, v]) => {
    const inf = inference[key];
    return {
      key,
      isControl: key === 'control',
      exposures: v.n,
      conversions: v.sum,
      value: v.n ? v.sum / v.n : null,
      lift: inf?.lift ?? null,
      win: inf ? inf.chance_to_win : null,
      ci: inf ? [inf.ci_low, inf.ci_high] : null,
    };
  }).sort((a, b) => Number(b.isControl) - Number(a.isControl));
  return { asOf: results?.results?.as_of ?? null, rows, srm: payload.srm_p_value };
}

const pct = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`);

export function formatTable(results) {
  const s = summarise(results);
  if (!s.rows.length) return 'collecting data (no results computed yet)';
  const lines = ['variation  users  conv   rate    lift     chance_to_win'];
  for (const r of s.rows) lines.push(`${(r.key + (r.isControl ? '*' : '')).padEnd(10)} ${String(r.exposures).padStart(5)} ${String(r.conversions).padStart(5)}  ${pct(r.value).padStart(6)}  ${(r.isControl ? '—' : pct(r.lift)).padStart(7)}  ${r.isControl ? 'baseline' : pct(r.win)}`);
  lines.push(`as_of ${s.asOf}${s.srm != null && s.srm < 0.01 ? '  ⚠ sample ratio mismatch' : ''}`);
  return lines.join('\n');
}
