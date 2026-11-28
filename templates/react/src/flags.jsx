// Feature flags for this React app, on top of the Flagsmith JS SDK.
//
//   <FlagsProvider>…</FlagsProvider>          once, at the root
//   const on = useFlag('checkout_v2').enabled
//   const msg = useFlag('welcome_message').value
//   const layout = useVariant('pricing_layout')   // experiment bucket; records the exposure once
//   const track = useTrack(); track('upgrade_click')
//
// What it adds over the SDK:
//   - Typed names: only flags in flags.generated.js are accepted; a typo throws in development.
//   - First paint never flashes "everything off": it renders with the Production defaults from the last
//     `npm run flags:sync`, then the last flags this browser saw (cached), then live values.
//   - Preview links: open ?flags=pricing_layout=compact,checkout_v2=on to see any variant without touching
//     Flagsmith (development builds, or when VITE_FLAG_PREVIEW=true). Great for design review and QA.
//   - A stable anonymous id per browser, so experiments can count visitors who never log in.
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import flagsmith from '@flagsmith/flagsmith';
import { FLAGS, FLAG_DEFAULTS, isFlag } from './flags.generated.js';

const env = import.meta.env ?? {};
const DEV = !!env.DEV;
const Ctx = createContext(null);

export function parseForce(s) {
  const out = {};
  for (const part of String(s || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    const name = i < 0 ? part : part.slice(0, i);
    const raw = i < 0 ? 'on' : part.slice(i + 1);
    if (!isFlag(name)) { if (DEV) console.error(`flag preview: "${name}" is not a flag`); continue; }
    out[name] = raw === 'on' ? { enabled: true, value: FLAG_DEFAULTS[name].value } : raw === 'off' ? { enabled: false, value: FLAG_DEFAULTS[name].value } : { enabled: true, value: raw, variant: raw };
  }
  return out;
}

function anonymousId() {
  try {
    let id = localStorage.getItem('uid');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('uid', id); }
    return id;
  } catch { return crypto.randomUUID(); }
}

function check(name) {
  if (isFlag(name)) return;
  const msg = `Unknown flag "${name}". Known: ${Object.keys(FLAGS).join(', ')}. Run \`npm run flags:sync\` if it is new.`;
  if (DEV) throw new Error(msg);
  console.warn(msg);
}

export function FlagsProvider({ children, identity, force, environmentKey = env.VITE_FLAGSMITH_ENVIRONMENT_KEY, apiUrl = env.VITE_FLAGSMITH_API_URL }) {
  const preview = useMemo(() => {
    if (force) return force;
    if (!(DEV || env.VITE_FLAG_PREVIEW === 'true') || typeof location === 'undefined') return {};
    return parseForce(new URLSearchParams(location.search).get('flags'));
  }, [force]);
  const [live, setLive] = useState(null);
  const [source, setSource] = useState('defaults');
  const id = useMemo(() => identity || anonymousId(), [identity]);

  useEffect(() => {
    if (!environmentKey) { if (environmentKey === undefined) console.warn('VITE_FLAGSMITH_ENVIRONMENT_KEY is not set: using flags.generated.js defaults'); return; }
    const base = apiUrl ? apiUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '') : null;
    let alive = true;
    flagsmith.init({
      environmentID: environmentKey,
      ...(base ? { api: `${base}/api/v1/` } : {}),
      identity: id,
      cacheFlags: true,
      defaultFlags: Object.fromEntries(Object.entries(FLAG_DEFAULTS).map(([k, v]) => [k, { enabled: v.enabled, value: v.value }])),
      enableEvents: true,
      ...(base ? { eventProcessorConfig: { eventsApiUrl: `${base}/api/` } } : {}),
      onChange: (_old, info) => { if (alive) { setLive({ ...flagsmith.getAllFlags() }); setSource(info?.isFromServer ? 'flagsmith' : 'cache'); } },
    }).catch((e) => console.warn('Flagsmith unreachable, using defaults:', e?.message));
    const flush = () => flagsmith.flushEvents?.();
    addEventListener('pagehide', flush);
    return () => { alive = false; removeEventListener('pagehide', flush); };
  }, [environmentKey, apiUrl, id]);

  const value = useMemo(() => ({ live, preview, source: Object.keys(preview).length ? `${source}+preview` : source, id, enabled: !!environmentKey }), [live, preview, source, id, environmentKey]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useCtx() {
  const c = useContext(Ctx);
  if (!c) throw new Error('Wrap your app in <FlagsProvider>');
  return c;
}

export function useFlag(name) {
  check(name);
  const { live, preview } = useCtx();
  if (preview[name]) return preview[name];
  const f = live?.[name];
  return f ? { enabled: !!f.enabled, value: f.value ?? null } : FLAG_DEFAULTS[name] ?? { enabled: false, value: null };
}

// Experiment bucket. Records the exposure once per mount, where the variant is actually shown.
export function useVariant(name) {
  check(name);
  const { live, preview, enabled } = useCtx();
  const recorded = useRef(false);
  const [variant, setVariant] = useState(() => preview[name]?.variant ?? String(FLAG_DEFAULTS[name]?.value ?? 'control'));
  useEffect(() => {
    if (preview[name]) { setVariant(preview[name].variant ?? 'control'); return; }
    if (!enabled || !live || recorded.current) return;
    recorded.current = true;
    const f = flagsmith.getExperimentFlag(name);
    setVariant(f?.enabled ? String(f.variant || f.value || 'control') : 'control');
  }, [name, live, preview, enabled]);
  return variant;
}

export function useTrack() {
  const { enabled } = useCtx();
  return (event) => { if (enabled) flagsmith.trackEvent(event); };
}

export const useFlagSource = () => useCtx().source;
