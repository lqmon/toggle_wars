// Zero-click first-run setup for a fresh self-hosted Flagsmith:
// admin user -> organisation -> project -> environments -> master API key -> experimentation warehouse.
// Idempotent: re-running reuses whatever already exists.
import crypto from 'node:crypto';
import { FlagsmithAdmin, waitForHealthy } from './api.js';
import { loadState, saveState, writeEnvFile } from './config.js';

const log = (...a) => console.log('  ›', ...a);

export async function bootstrap({
  apiUrl = 'http://localhost:8000',
  email = 'admin@flagkit.local',
  orgName = 'FlagKit',
  projectName = 'Demo',
  environments = ['Development', 'Staging', 'Production'],
} = {}) {
  await waitForHealthy(apiUrl, {
    onTick: (s) => s % 10 === 0 && log(`waiting for Flagsmith at ${apiUrl} (${s}s)…`),
  });

  const prev = loadState();
  const password = prev?.admin?.email === email ? prev.admin.password : crypto.randomBytes(12).toString('base64url');
  const anon = new FlagsmithAdmin({ apiUrl });

  // 1. Admin user. The first sign-up on a fresh instance becomes the superuser.
  let token;
  try {
    const r = await anon.post('auth/users/', { email, password, first_name: 'Flag', last_name: 'Kit', superuser: true });
    token = r.key;
    log(`created admin user ${email}`);
  } catch (e) {
    if (e.status !== 400) throw e;
  }
  if (!token) {
    try {
      token = (await anon.post('auth/login/', { email, password })).key;
      log(`logged in as ${email}`);
    } catch (e) {
      throw new Error(
        `Could not sign up or log in as ${email}. If this instance was set up by hand, pass --email and set FLAGKIT_ADMIN_PASSWORD.\n${e.message}`,
      );
    }
  }
  const api = new FlagsmithAdmin({ apiUrl, token });

  // 2. Organisation
  let org = (await api.list('organisations/')).find((o) => o.name === orgName);
  if (!org) {
    org = await api.post('organisations/', { name: orgName });
    log(`created organisation "${orgName}"`);
  }

  // 3. Project
  let project = (await api.list(`projects/?organisation=${org.id}`)).find((p) => p.name === projectName);
  if (!project) {
    project = await api.post('projects/', { name: projectName, organisation: org.id });
    log(`created project "${projectName}"`);
  }

  // 4. Environments
  let envs = await api.list(`environments/?project=${project.id}`);
  for (const name of environments) {
    if (!envs.find((e) => e.name === name)) {
      envs.push(await api.post('environments/', { name, project: project.id }));
      log(`created environment "${name}"`);
    }
  }
  envs = envs.filter((e) => environments.includes(e.name));

  // 5. Master (admin) API key for the Flagsmith CLI / agents
  let masterKey = prev?.masterKey;
  if (masterKey) {
    try { await new FlagsmithAdmin({ apiUrl, masterKey }).get('organisations/'); } catch { masterKey = null; }
  }
  if (!masterKey) {
    const k = await api.post(`organisations/${org.id}/master-api-keys/`, { name: 'flagkit', is_admin: true });
    masterKey = k.key;
    log('created admin API key "flagkit"');
  }

  // 6. Experimentation: store SDK events in Flagsmith's own Postgres.
  // On self-hosted, the dashboard's "Flagsmith database" option is a postgres connection with this
  // exact config; anything else makes /api/v1/events/ answer 404 "does not store events in Flagsmith".
  const FLAGSMITH_DB = { source: 'flagsmith_database' };
  const isFlagsmithDb = (c) => c.warehouse_type === 'postgres' && c.config?.source === FLAGSMITH_DB.source;
  for (const env of envs) {
    const base = `environments/${env.api_key}/warehouse-connections/`;
    try {
      const conns = await api.list(base);
      let conn = conns.find(isFlagsmithDb);
      if (!conn) {
        for (const c of conns) await api.del(`${base}${c.id}/`); // one connection per environment
        conn = await api.post(base, { warehouse_type: 'postgres', name: 'Flagsmith database', config: FLAGSMITH_DB });
        log(`enabled experimentation (Flagsmith database warehouse) for "${env.name}"`);
      }
      if (conn.status !== 'connected') {
        await api.post(`${base}${conn.id}/test-warehouse-connection/`).catch(() => {});
      }
    } catch (e) {
      log(`warning: could not enable warehouse for "${env.name}" (is EXPERIMENTATION_ENABLED=true?): ${e.message}`);
    }
  }

  const state = {
    apiUrl,
    admin: { email, password },
    token,
    masterKey,
    organisation: { id: org.id, name: org.name },
    project: { id: project.id, name: project.name },
    environments: envs.map((e) => ({ id: e.id, name: e.name, api_key: e.api_key })),
    experiments: prev?.experiments || {},
  };
  saveState(state);
  writeEnvFile(state);
  return state;
}
