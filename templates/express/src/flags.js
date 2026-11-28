// Feature flags for this app, on top of the Flagsmith Node SDK.
//
//   const flags = await req.flags;          // one evaluation per request, for this visitor
//   flags.isOn('checkout_v2')               // on/off
//   flags.value('welcome_message')          // remote config value
//   flags.variant('pricing_layout')         // experiment bucket: records the exposure Flagsmith needs
//   flags.track('upgrade_click')            // the conversion your experiment metric counts
//
// What it adds over calling the SDK directly:
//   - Typed names: only flags in flags.generated.js are accepted; a typo throws in dev/test, never ships silently.
//   - Offline-safe: if Flagsmith is slow (>2s) or down, every flag falls back to its Production state from the
//     last `npm run flags:sync`, not to "everything off". `flags.source` says which you got.
//   - FLAGS_FORCE=name=on,other=variant pins flags for local dev and for tests (see test/flag-matrix.test.js).
import { Flagsmith, DefaultFlag } from '@flagsmith/nodejs';
import { FLAGS, FLAG_DEFAULTS, isFlag } from './flags.generated.js';

const STRICT = process.env.NODE_ENV !== 'production';

export function parseForce(s) {
  const out = {};
  for (const part of String(s || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    const name = i < 0 ? part : part.slice(0, i);
    const raw = i < 0 ? 'on' : part.slice(i + 1);
    if (!isFlag(name)) throw new Error(`FLAGS_FORCE: "${name}" is not a flag in flags.generated.js`);
    out[name] = raw === 'on' ? { enabled: true, value: FLAG_DEFAULTS[name].value }
      : raw === 'off' ? { enabled: false, value: FLAG_DEFAULTS[name].value }
      : { enabled: true, value: raw, variant: raw };
  }
  return out;
}

function checkName(name) {
  if (isFlag(name)) return true;
  const msg = `Unknown flag "${name}". Known flags: ${Object.keys(FLAGS).join(', ')}. Run \`npm run flags:sync\` if it was just created.`;
  if (STRICT) throw new Error(msg);
  console.warn(msg);
  return false;
}

export function createFlagClient({
  environmentKey = process.env.FLAGSMITH_ENVIRONMENT_KEY,
  apiUrl = process.env.FLAGSMITH_API_URL,
  force = parseForce(process.env.FLAGS_FORCE),
} = {}) {
  const base = apiUrl ? apiUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '') : undefined;
  const sdk = environmentKey ? new Flagsmith({
    environmentKey,
    ...(base ? { apiUrl: `${base}/api/v1/` } : {}),
    requestTimeoutSeconds: 2,
    retries: 0,
    enableEvents: true,
    ...(base ? { eventProcessorConfig: { eventsApiUrl: `${base}/api/` } } : {}),
    defaultFlagHandler: (name) => new DefaultFlag(FLAG_DEFAULTS[name]?.value ?? null, FLAG_DEFAULTS[name]?.enabled ?? false),
  }) : null;
  if (!sdk && environmentKey === undefined) console.warn('FLAGSMITH_ENVIRONMENT_KEY is not set: using the defaults in flags.generated.js');

  async function forUser(identity, traits = {}) {
    let flags = null;
    let source = 'defaults';
    if (sdk) {
      try {
        flags = await sdk.getIdentityFlags(identity, traits);
        // On a failed request the SDK hands back an empty set that answers from defaultFlagHandler.
        if (flags.allFlags().length) source = 'flagsmith';
        else flags = null;
      }
      catch (e) { console.warn(`Flagsmith unreachable (${e.message}): using defaults`); }
    }
    const state = (name) => {
      if (force[name]) return force[name];
      if (!flags) return FLAG_DEFAULTS[name];
      const f = flags.getFlag(name);
      return { enabled: f.enabled, value: f.value ?? null };
    };
    return {
      identity,
      get source() { return Object.keys(force).length ? `${source}+forced` : source; },
      isOn: (name) => checkName(name) && !!state(name)?.enabled,
      value: (name) => (checkName(name) ? state(name)?.value ?? null : null),
      // Use for experiments: records the exposure, so call it where the variant is actually shown.
      async variant(name) {
        if (!checkName(name)) return 'control';
        if (force[name]) return force[name].variant ?? (force[name].enabled ? String(force[name].value ?? 'control') : 'control');
        if (!sdk || !flags) return String(FLAG_DEFAULTS[name]?.value ?? 'control');
        try {
          const f = await sdk.getExperimentFlag(name, identity, traits);
          return f.enabled ? String(f.variant || f.value || 'control') : 'control';
        } catch { return String(FLAG_DEFAULTS[name]?.value ?? 'control'); }
      },
      track(event) { sdk?.trackEvent(event, { identifier: identity }); },
    };
  }

  return { forUser, close: () => sdk?.close?.() };
}
