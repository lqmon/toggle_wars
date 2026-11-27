# ⚑ FlagKit

[![CI](https://github.com/lqmon/toggle_wars/actions/workflows/ci.yml/badge.svg)](https://github.com/lqmon/toggle_wars/actions/workflows/ci.yml)
[![Live A/B test](https://img.shields.io/badge/live%20A%2FB%20test-lqmon.github.io%2Ftoggle__wars-34d399)](https://lqmon.github.io/toggle_wars/)
![License](https://img.shields.io/badge/license-MIT-blue)

**Everything after `docker compose up` for self-hosted Flagsmith.** A zero-click bootstrap with Experimentation on, a **doctor** that finds the misconfigurations that silently drop your experiment data, a terminal dashboard, an **MCP server** where agents propose and humans approve, and an **Agent Skill** that runs an A/B test from hypothesis to rollout.

```bash
git clone https://github.com/lqmon/toggle_wars && cd toggle_wars && npm install
node bin/flagkit.js up        # self-hosted Flagsmith + Experimentation, ~30s, zero clicks
node bin/flagkit.js doctor    # or point it at YOUR existing Flagsmith: --api-url https://flags.acme.internal
node bin/flagkit.js tui       # flags × environments, experiments, doctor, approvals
```

| | Track | What to look at |
|---|---|---|
| 🧰 | **03 · Build on Open Source Flagsmith** | `flagkit up`, `flagkit doctor`, `flagkit tui`, CI that boots self-hosted Flagsmith from scratch |
| 🧪 | **01 · Test Something Real** | [Live headline A/B test](https://lqmon.github.io/toggle_wars/) on Flagsmith Cloud ([details](#-track-01--a-real-experiment)) |
| 🤖 | **02 · AI Agents and Feature Flags** | `flagkit mcp`: agents read and propose, a person approves in the TUI |
| 📜 | **04 · Agent Skills** | [`skills/flagsmith-experiment-rollout`](skills/flagsmith-experiment-rollout/): whole job in ~130 tokens of tool output |

---

## The problem

Starting Flagsmith is one command. Getting a **working A/B test** on self-hosted Flagsmith took me an afternoon of reading Django source, because of things the stock setup gets wrong without telling you:

| What happens | Why | What FlagKit does |
|---|---|---|
| **Your experiment shows no data, ever** | The obvious warehouse choice (`flagsmith`) is Cloud-only. On self-hosted, `/api/v1/events/` answers `404 "does not store events"` and SDKs drop every exposure and conversion **silently** | `up` configures `postgres` + `{"source":"flagsmith_database"}`; `doctor` detects it on any instance and `--fix` repairs it |
| **Your admin is on the café Wi-Fi** | Stock compose publishes `8000` and `8001` on every interface | `up` binds to `127.0.0.1`; `doctor` probes your LAN addresses |
| **Sessions can be forged** | Stock compose ships `DJANGO_SECRET_KEY=secret` and a `password` database | random per-machine secrets in `.flagkit/stack.env` (0600, gitignored) |
| **Anyone can sign up** | Open registration | sign-up locked once the admin exists |
| **The CLI ignores your key** | Flagsmith CLI v2 only reads `FLAGSMITH_API_KEY_<host>` for non-Cloud hosts | `flagsmith.env` sets the host-scoped variable |
| **`flagsmith eval` → 405** | SDK URL must be the host root, not `/api/v1/` | written correctly; `doctor` flags it |

## 🧰 `flagkit up`

```
▶ Starting self-hosted Flagsmith (Postgres, API + dashboard, task processor)…
▶ Bootstrapping (admin, org, project, environments, API key, experimentation)…
  › created admin user admin@flagkit.local
  › created organisation "FlagKit" · project "Demo"
  › created environment "Development" / "Staging" / "Production"
  › created admin API key "flagkit"
  › enabled experimentation (Flagsmith database warehouse) for each environment
▶ Locking sign-up now that the admin exists…
✔ Flagsmith is ready (bound to 127.0.0.1, sign-up disabled).
```
Official images and compose, every step through the Admin API, idempotent (re-run it any time). It writes `flagsmith.env`, which the official CLI and Flagsmith's [coding-agent prompt](https://docs.flagsmith.com/experimentation/set-up-with-a-coding-agent) use directly: `source flagsmith.env && flagsmith flag list`.

## 🩺 `flagkit doctor`: works on any self-hosted Flagsmith

Run against an untouched upstream `docker-compose.yml`, set up the obvious way ([full output](docs-assets/doctor-stock-compose.txt)):

```
EXPERIMENTATION
  ✖ Events are being DROPPED: this environment does not store SDK events
      Every exposure and conversion your SDKs send gets a 404 and is discarded silently.
      fix: Warehouse must be postgres + {"source":"flagsmith_database"} — `flagkit doctor --fix` can do this
  ✖ Web / Production: warehouse type "flagsmith" is the Cloud-only managed warehouse; self-hosted events get 404
SECURITY
  ✖ Admin API is reachable from your network: 10.1.21.84:8100
  ✖ Default secrets in running containers: DJANGO_SECRET_KEY, WAREHOUSE_CREDENTIALS_SECRET, database password
  ⚠ Open sign-up: anyone who can reach this URL can create an account
  ⚠ DJANGO_ALLOWED_HOSTS accepts any Host header ('*')
CLI
  ✖ FLAGSMITH_API_KEY is set, but the Flagsmith CLI ignores it for self-hosted hosts
      fix: export FLAGSMITH_API_KEY_localhost_8100=$FLAGSMITH_API_KEY && unset FLAGSMITH_API_KEY
  ✖ FLAGSMITH_SDK_API_URL=http://localhost:8100/api/v1/ makes `flagsmith eval` fail with 405

3 passed, 3 warnings, 6 failures
Run with --fix to repair 2 issue(s) (asks before changing anything).
```

- Needs **no credentials** for the public probes. Add `--env-key` for SDK and events checks, or an admin key for warehouse, traits and experiment health (sample ratio mismatch, "running but no exposures").
- `--fix` repairs API-level issues **after asking**. `--json` and exit code 1 on failures make it a **CI gate**.

## 🖥 `flagkit tui`

Four tabs:
- **Flags**: every flag × environment. `space` toggles; Production asks first. `/` searches, and `≠` marks drift between environments.
- **Experiments**: every experiment in every environment, with conversion bars, lift, credible interval and chance to beat control. `s` ships the winner, only at ≥95% and only after confirming.
- **Doctor**: live health checks.
- **Approvals**: changes agents have proposed.

## 🤖 Track 02: `flagkit mcp`: agents propose, people approve

```bash
claude mcp add flagkit -- node "$PWD/bin/flagkit.js" mcp     # or just open this repo: .mcp.json registers it
```
| tool | does |
|---|---|
| `flagkit_list_flags` | flags × environments, including multivariate weights (`control(teal=100%)`) and drift |
| `flagkit_list_experiments`, `flagkit_experiment_results` | live Bayesian results plus a verdict (`meets the ship bar` / `not conclusive` / `DO NOT SHIP — SRM`) |
| `flagkit_doctor` | instance health |
| `flagkit_propose_change` | toggle, set value, ship winner, or create experiment, **filed as a request** |
| `flagkit_change_status` | pending / applied / rejected / failed |

**The agent has no write path.** A proposal is applied only when a person approves it in the TUI's Approvals tab, or with `flagkit approve <id>`, which needs an interactive terminal and the change id typed back. It's re-validated against live state at approval time, and Production is marked high-risk. CI checks that a proposal stays pending until a person acts.

```
agent → flagkit_propose_change {toggle_flag, hero_headline, Production, enabled:false}
      ← proposed chg_c79f0c (HIGH RISK: production) — Turn "hero_headline" OFF in Production
        status: pending — NOT applied. Ask the user to approve it in `flagkit tui` → 4 Approvals
human → TUI → 4 Approvals (1) → a → y
      ✔ applied chg_c79f0c: hero_headline is OFF in Production   (decided by puneet)
```

## 📜 Track 04: Agent Skill

[`skills/flagsmith-experiment-rollout`](skills/flagsmith-experiment-rollout/) takes an agent through preflight → design → create → instrument → start → monitor → **roll out the winner** → cleanup PR → archive, all with the Flagsmith CLI. It stops at 5 approval gates, rolls out through Flagsmith's own experiment-complete decision, verifies with `flagsmith eval`, and prints a rollback command. **A full measured run reads about 130 tokens of tool output.** [Token table and real transcript →](skills/flagsmith-experiment-rollout/README.md)

## 🧪 Track 01: a real experiment

**https://lqmon.github.io/toggle_wars/**: FlagKit A/B tests its own landing page on **Flagsmith Cloud**.

- **Hypothesis:** replacing the generic headline *"Feature flags for modern teams"* with the benefit-led *"Ship on Friday. Roll back in one click."* will increase the share of visitors who click **Get early access**.
- **Flag:** `hero_headline`, multivariate. Control `control`, variant key `benefit`. **The headline is the only difference** between the arms.
- **Metric:** `signup_click`, occurrence, higher is better. It fires early in a visit, so data comes in fast.
- **Split:** 100% of visitors, 50/50. Each anonymous visitor gets a persisted random UUID as their identity.
- **Stop rule:** ship when a variant has ≥95% chance to beat control, ≥50 users per arm, and no sample-ratio-mismatch warning.
- **Honesty rules:** no simulated traffic touches this experiment (`flagkit simulate` refuses remote hosts), and test visits use the Development environment.
- **Instrumentation** ([demo-app/index.html](demo-app/index.html)): `getExperimentFlag('hero_headline')` logs the exposure, the page branches on `flag.variant`, and the button calls `trackEvent('signup_click')` once per visit.
- **Privacy:** anonymous ID, variant and click only. No cookies, no personal data. Only the client-side key is published, and the page runs under a strict content-security policy.

Results: `FLAGSMITH_ENVIRONMENT=<prod key> skills/flagsmith-experiment-rollout/scripts/results.sh 1245`, or the Flagsmith dashboard → Experiments.

## Security

The stack and tools were reviewed before going live (see commit `Security hardening before going live`): loopback-only binding, generated secrets, sign-up lock, `DJANGO_ALLOWED_HOSTS`, client traits off, injection-safe skill scripts, a simulator that refuses real experiments, CSP and security headers on the demo server, and a human-only approval path for agents.

## Commands

```
up / down [--wipe] / bootstrap / status       stack
doctor [--api-url] [--env-key] [--fix] [--json]
tui                                           flags · experiments · doctor · approvals
experiment create|results / simulate / demo / build-page
mcp / approvals [--all] / approve <id> / reject <id>
```

## How Flagsmith is used

- **Self-hosted Flagsmith** (official images and compose) is the backend of `up`, `doctor`, `tui` and `mcp`.
- **Admin API**: bootstrap, features, multivariate options, environments, warehouse connections, metrics, experiments (create / start / results / refresh / complete-with-rollout-decision), feature states.
- **Experimentation**: Bayesian results (`chance_to_win`, lift, credible interval), exposures, SRM.
- **SDKs**: `@flagsmith/flagsmith` (browser, `getExperimentFlag`/`trackEvent`) and `@flagsmith/nodejs` (simulator).
- **Flagsmith CLI v2**: the whole Agent Skill and the CI journey.
- **Flagsmith Cloud**: the live Track 01 experiment.

## Develop

```bash
npm test                 # unit tests
node test/mcp-smoke.mjs  # MCP server against the local stack
```
CI ([workflow](.github/workflows/ci.yml)) boots self-hosted Flagsmith on a clean runner, runs `doctor` as a gate, a simulated experiment, the whole Agent Skill with the official CLI, the MCP smoke test, and security assertions.

MIT © 2026 Puneet Madan
