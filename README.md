# ⚑ FlagKit

**Self-hosted Flagsmith with Experimentation in one command. No clicking, plus a terminal dashboard, a sample A/B test and an Agent Skill that runs experiments end to end.**

```bash
git clone https://github.com/lqmon/toggle_wars && cd toggle_wars && npm install && node bin/flagkit.js up   # ~30s on a warm Docker cache
```

```
▶ Starting self-hosted Flagsmith (Postgres, API + dashboard, task processor)…
▶ Bootstrapping (admin, org, project, environments, API key, experimentation)…
  › created admin user admin@flagkit.local
  › created organisation "FlagKit"
  › created project "Demo"
  › created environment "Development" / "Staging" / "Production"
  › created admin API key "flagkit"
  › enabled experimentation (Flagsmith database warehouse) for each environment
✔ Flagsmith is ready.
```

## Why

Running Flagsmith yourself is easy: `docker compose up`. Getting to the point where you can **run an experiment** is not:

1. Open the dashboard, sign up, create an organisation, a project and environments by hand.
2. Create an Admin API key, then find out that the Flagsmith CLI **ignores `FLAGSMITH_API_KEY` for self-hosted hosts**. It wants `FLAGSMITH_API_KEY_localhost_8000`.
3. Enable a warehouse per environment. On self-hosted, the "Flagsmith database" option is really
   `warehouse_type: postgres` + `config: {"source": "flagsmith_database"}`. Any other value makes
   `/api/v1/events/` return **404 "This environment does not store events in Flagsmith"**, and your SDKs drop every exposure and conversion.
4. Point the SDKs at `<host>/api/v1/` for flags but `<host>/api/` for events, and the CLI's SDK URL at `<host>` (not `/api/v1/`, which returns 405).

I hit every one of these while setting it up. FlagKit does all of them for you, idempotently, and writes a `flagsmith.env` that the official Flagsmith CLI and [coding-agent setup prompt](https://docs.flagsmith.com/experimentation/set-up-with-a-coding-agent) pick up directly.

## What's inside

| | |
|---|---|
| `flagkit up` / `down [--wipe]` | Official Flagsmith `docker-compose.yml` (Postgres + API/dashboard + task processor, `EXPERIMENTATION_ENABLED=true`) and a zero-click bootstrap through the Admin API |
| `flagkit tui` | **Terminal dashboard**: every flag × every environment (toggle with space; Production asks first), plus live experiment results with chance-to-win bars and a guarded **ship the winner** key |
| `flagkit experiment create\|results` | Creates and starts a real A/B test: multivariate flag, metric and experiment. `results --json` for scripts |
| `flagkit demo` | Sample landing page instrumented with the Flagsmith JS SDK (identity, `getExperimentFlag`, `trackEvent`) |
| `flagkit simulate` | Simulated visitors through the real Node SDK, so you can see results without real traffic |
| [`skills/flagsmith-experiment-rollout`](skills/flagsmith-experiment-rollout/SKILL.md) | An [Agent Skill](https://agentskills.io/specification) that takes a coding agent from hypothesis to rollout and cleanup with the Flagsmith CLI, with 5 human approval gates |

## Quick start

Requirements: Docker, Node 20+. For the skill: the [Flagsmith CLI](https://docs.flagsmith.com/integrating-with-flagsmith/CLI) (`brew install Flagsmith/tap/flagsmith`) and `jq`.

```bash
git clone https://github.com/lqmon/toggle_wars && cd toggle_wars && npm install
node bin/flagkit.js up                    # Flagsmith on http://localhost:8000 (login printed)
node bin/flagkit.js experiment create     # hero_headline A/B test, started
node bin/flagkit.js demo                  # landing page on http://localhost:3000
node bin/flagkit.js simulate --users 600  # simulated traffic
node bin/flagkit.js tui                   # watch it, ship the winner
```

Already running Flagsmith? `node bin/flagkit.js bootstrap --api-url http://your-host:8000`.

Use the official CLI right away:
```bash
source flagsmith.env
flagsmith flag list
flagsmith eval hero_headline --identity alice
```

## The experiment (Track 01)

FlagKit A/B tests **its own landing page**. It's live, so try it: **https://lqmon.github.io/toggle_wars/**
(Static page from [`docs/`](docs/) on GitHub Pages, running Flagsmith Cloud experiment #1245. Only the client-side environment key is published.)

- **Hypothesis:** replacing the generic headline *"Feature flags for modern teams"* with the benefit-led *"Ship on Friday. Roll back in one click."* will increase the share of visitors who click **Get early access**.
- **Flag:** `hero_headline`, multivariate. Control `control`, variant key `benefit`.
- **Metric:** `signup_click`, occurrence, higher is better. It fires early in a visit, so it gathers data fast.
- **Split:** 100% of visitors, 50/50.
- **Stop rule:** ship when a variant has ≥95% chance to beat control with ≥50 users per arm and no sample-ratio-mismatch warning.

Instrumentation ([demo-app/index.html](demo-app/index.html)): anonymous visitors get a persisted UUID as their identity, `flagsmith.getExperimentFlag('hero_headline')` records the exposure, the page branches on `flag.variant`, and the Sign up button calls `flagsmith.trackEvent('signup_click')`.

## The Agent Skill (Track 04)

`skills/flagsmith-experiment-rollout` handles a whole "prove it works" job: preflight → design → create → instrument → start → monitor → **roll out the winner** → remove dead code + archive the flag.

- **Uses the CLI throughout:** `flagsmith feature create/variant add`, `flagsmith api … --input -` for metrics and experiments, `flagsmith eval --identity` to verify bucketing and rollout, `flagsmith flag update --weight` for rollback.
- **Token-efficient:** every call uses `--jq`. A full results readout is ~145 bytes:
  ```
  #2 running: CTA colour test
  arm	users	conv	rate	lift	P(win)
  control	399	27	6.7%	base	-
  teal	401	74	18.4%	173%	100%
  as_of=2026-11-27T08:24:20Z
  ```
- **Safe around production:** 5 ⛔ gates (create, code changes, start on prod, rollout, cleanup PR). The rollout goes through Flagsmith's own `experiments/<id>/complete/` decision. `rollout.sh` snapshots the flag first and prints an exact **rollback** command, and it verifies the result with fresh identities (`eval: 5/5 -> teal`).

Install it into Claude Code: `cp -r skills/flagsmith-experiment-rollout ~/.claude/skills/`.

## How Flagsmith is used

- **Self-hosted Flagsmith** (official image and compose) is the whole backend.
- **Admin API**: bootstrap, features, multivariate options, warehouse connections, metrics, experiments, results, complete/rollout.
- **Experimentation**: Bayesian results (`chance_to_win`, lift, credible interval), exposures, SRM check.
- **SDKs**: `@flagsmith/flagsmith` (browser) and `@flagsmith/nodejs` (simulator) with `enableEvents`.
- **Flagsmith CLI v2**: everything in the Agent Skill.

## License

MIT
