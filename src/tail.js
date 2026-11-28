// flagkit tail — watch experiment events arrive, like `tail -f`. Answers "is my tracking working?"
// Self-hosted only: it reads the events table of the stack's own Postgres (`docker exec … psql`), the
// same place Flagsmith's experiment results are computed from. Flagsmith Cloud has no raw-event API.
// Read-only. Values are passed to psql as variables (never spliced into SQL) and cleaned before printing.
import { spawnSync } from 'node:child_process';
import { envOf } from './experiment.js';
import { clean } from './sanitize.js';

const CONTAINER = process.env.FLAGKIT_DB_CONTAINER || 'flagsmith_postgres';
const NAME = /^[a-z0-9][a-z0-9_-]{0,99}$/;

const SQL = `
select e.id, to_char(e.timestamp at time zone 'UTC', 'HH24:MI:SS'), e.event, coalesce(e.feature_name, ''), e.identifier,
       coalesce(e.value, ''), coalesce(e.sdk_language, ''), coalesce(nullif(e.sdk_version, 'unknown'), e.metadata::json->>'sdk_version', ''),
       case when e.event = '$flag_exposure' then e.value else
         (select x.value from experimentation_sdkexperimentationevent x
           where x.environment_key = e.environment_key and x.identifier = e.identifier and x.event = '$flag_exposure'
             and (:'flag' = '' or x.feature_name = :'flag')
           order by x.id desc limit 1) end
from experimentation_sdkexperimentationevent e
where e.environment_key = :'env' and e.id > :last
  and (:'flag' = '' or e.feature_name = :'flag' or e.event <> '$flag_exposure')
  and (:since = 0 or e.timestamp > now() - make_interval(secs => :since))
order by e.id ORDER_DIR
limit 500;`;

export function query({ envKey, flag = '', last = 0, since = 0, newest = false }) {
  const r = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'flagsmith', '-X', '-q', '-At', '-F', '\t',
    '-v', 'ON_ERROR_STOP=1', '-v', `env=${envKey}`, '-v', `flag=${flag}`, '-v', `last=${Number(last)}`, '-v', `since=${Number(since)}`, '-f', '-'],
  { input: SQL.replace('ORDER_DIR', newest ? 'desc' : 'asc'), encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    const msg = (r.stderr || r.error?.message || '').trim().split('\n')[0];
    throw new Error(`Could not read events from the ${CONTAINER} container (${msg || 'not running?'}). \`flagkit tail\` works with the local FlagKit stack; on Flagsmith Cloud use the dashboard.`);
  }
  const rows = r.stdout.split('\n').filter(Boolean).map((l) => {
    const [id, time, event, feature, identity, value, lang, ver, variant] = l.split('\t');
    return { id: Number(id), time, event, feature, identity, value, sdk: [lang, ver].filter(Boolean).join(' '), variant };
  });
  return newest ? rows.reverse() : rows;
}

const parseSince = (s) => {
  const m = /^(\d+)\s*([smhd]?)$/.exec(String(s || '0'));
  if (!m) throw new Error('--since looks like 30s, 10m, 2h or 1d');
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
};

const short = (id) => (id.length > 22 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id);

export function formatEvent(e) {
  const who = clean(short(e.identity)).padEnd(20);
  if (e.event === '$flag_exposure') return `${e.time}  👁  exposure    ${clean(e.feature)} → ${clean(e.value).padEnd(10)} ${who} ${clean(e.sdk)}`;
  return `${e.time}  🎯 ${clean(e.event).padEnd(12)} ${e.variant ? `in ${clean(e.variant)}`.padEnd(13 + clean(e.feature).length) : '(no exposure seen)'.padEnd(13 + clean(e.feature).length)} ${who} ${clean(e.sdk)}`;
}

export async function runTail(state, { envName = 'Development', flag, since = '10m', once = false, intervalMs = 1000 } = {}) {
  if (flag && !NAME.test(flag)) throw new Error('Invalid --flag name');
  const env = envOf(state, envName);
  const totals = {};
  const count = (e) => {
    const k = e.variant || '(none)';
    totals[k] ||= { exposures: 0, conversions: 0 };
    if (e.event === '$flag_exposure') totals[k].exposures++; else totals[k].conversions++;
  };
  const summary = () => Object.entries(totals).map(([k, t]) => `${clean(k)}: ${t.exposures} seen, ${t.conversions} converted`).join(' · ');

  let rows = query({ envKey: env.api_key, flag: flag || '', since: parseSince(since), newest: true });
  console.log(`flagkit tail · ${env.name}${flag ? ` · flag ${flag}` : ''} · last ${since} then live${once ? ' (once)' : ''}  (Ctrl+C to stop)\n`);
  if (!rows.length) console.log(`  no events in the last ${since}. Open the demo (flagkit demo) or run flagkit simulate.`);
  const shown = rows.slice(-40);
  if (rows.length > shown.length) console.log(`  … ${rows.length - shown.length} earlier events counted, not shown${rows.length === 500 ? ' (window capped at the latest 500)' : ''}`);
  rows.forEach(count);
  shown.forEach((e) => console.log(formatEvent(e)));
  let last = rows.length ? rows[rows.length - 1].id : 0;
  if (!last) last = query({ envKey: env.api_key, newest: true }).at(-1)?.id ?? 0;
  if (once) { console.log(`\n  ${summary() || 'no events'}`); return { totals, rows }; }

  let quietTicks = 0;
  process.on('SIGINT', () => { console.log(`\n  ${summary() || 'no events'}`); process.exit(0); });
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const fresh = query({ envKey: env.api_key, flag: flag || '', last });
    if (fresh.length) {
      fresh.forEach((e) => { count(e); console.log(formatEvent(e)); });
      last = fresh[fresh.length - 1].id;
      quietTicks = 0;
    } else if (++quietTicks % 30 === 0) {
      console.log(`  · waiting for events · ${summary() || 'none yet'}`);
    }
  }
}
