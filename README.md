# ⚑ FlagKit

[![CI](https://github.com/lqmon/toggle_wars/actions/workflows/ci.yml/badge.svg)](https://github.com/lqmon/toggle_wars/actions/workflows/ci.yml)
[![Live A/B test](https://img.shields.io/badge/live%20A%2FB%20test-lqmon.github.io%2Ftoggle__wars-34d399)](https://lqmon.github.io/toggle_wars/)
![License](https://img.shields.io/badge/license-MIT-blue)

**Everything after `docker compose up` for self-hosted Flagsmith.** A zero-click bootstrap with Experimentation on, a **doctor** that finds the misconfigurations that silently drop your experiment data, tools for the whole life of an experiment (plan → live event feed → readable report → guardrails), a terminal dashboard, a **VS Code extension** with live flag values in your code, an **MCP server** where agents propose and humans approve, and **two Agent Skills**.

```bash
npx flagsmith-kit up          # self-hosted Flagsmith + Experimentation, ~30s, zero clicks
npx flagsmith-kit doctor      # or point it at YOUR existing Flagsmith: --api-url https://flags.acme.internal
npx flagsmith-kit tui         # flags × environments, experiments, doctor, approvals
```
From source: `git clone https://github.com/lqmon/toggle_wars && cd toggle_wars && npm install`, then `node bin/flagkit.js <command>`.

| | Track | What to look at |
|---|---|---|
| 🧰 | **03 · Build on Open Source Flagsmith** | `flagkit up`, `doctor`, `tui`, `tail`, [VS Code extension](vscode-extension/), [doctor](doctor/) + [report](report/) GitHub Actions, `npx flagsmith-kit`, CI that boots self-hosted Flagsmith from scratch |
| 🧪 | **01 · Test Something Real** | [Live headline A/B test](https://lqmon.github.io/toggle_wars/) on Flagsmith Cloud ([details and results](#-track-01-a-real-experiment)), `flagkit plan` and `flagkit report` |
| 🤖 | **02 · AI Agents and Feature Flags** | `flagkit mcp`: agents read, explain ("why does this user see this?") and propose; a person approves. `flagkit watch` files guardrail kill requests the same way |
| 📜 | **04 · Agent Skills** | [`flagsmith-experiment-rollout`](skills/flagsmith-experiment-rollout/) (prove it, then ship it: ~130 tokens) and [`flagsmith-kill-switch`](skills/flagsmith-kill-switch/) (put out the fire: ~120 tokens) |

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

**As a GitHub Action**, for any repo talking to a self-hosted Flagsmith:
```yaml
- uses: lqmon/toggle_wars/doctor@main
  with:
    api-url: https://flags.example.internal
    environment-key: ${{ vars.FLAGSMITH_ENV_KEY }}      # optional: SDK + events checks
    admin-key: ${{ secrets.FLAGSMITH_ADMIN_KEY }}       # optional: warehouse + experiment health
```
It fails the job on failures, exposes `failures`/`warnings` outputs, and writes a table to the job summary.

## 📈 The life of an experiment

| before | while it runs | when it's done |
|---|---|---|
| `flagkit plan`: how many visitors you need | `flagkit tail`: every exposure and conversion as it lands | `flagkit report`: verdict, health checks, chart, next step |
| | `flagkit watch`: guardrails that file a human-approved kill request | rollout via the TUI, the skill, or an approved agent proposal |

**`flagkit plan --baseline 0.08 --lift 0.44 --daily 300`**. Flagsmith's engine is Bayesian, so there's no exact sample-size formula. `plan` simulates the test thousands of times at your numbers instead:
```
Plan: baseline 8%, detect a lift of +44% (8% → 11.5%)
  ≈ 880 visitors per version, 1,760 in total (2 versions)
  gives the test an estimated 80% chance of reaching the ship bar (≥95% chance to beat control) if the lift is real.
  At 300 visitors a day: about 6 days.
  If there is no real difference, about 4.9% of tests this size would still cross the bar by chance,
```

**`flagkit tail`** answers *"is my tracking even working?"* live. Self-hosted only: it reads the stack's own events table, and each conversion is matched to the version that user saw:
```
10:44:22  👁  exposure    hero_headline → benefit    sim-mx0a9f0a-3       nodejs 9.5.0
10:44:22  🎯 signup_click in benefit    sim-mx0a9f0a-3       nodejs 9.5.0
10:44:22  👁  exposure    hero_headline → control    sim-mx0a9f0a-4       nodejs 9.5.0
10:44:22  🎯 signup_click in control    sim-mx0a9f0a-4       nodejs 9.5.0
```

**`flagkit report <id>`** turns raw results into something you can paste into a PR. It gives a plain-English verdict ("very likely better, but the size of the win is uncertain"), a results table with the likely range, health checks (≥50 users per version, sample-ratio mismatch, ran a full week), a cumulative-rate chart (Mermaid, so it renders on GitHub), and the exact next command. It works on self-hosted and on **Flagsmith Cloud** (through `flagsmith login`). `--hide-hypothesis` keeps the wording of each version private while a public test runs. As a GitHub Action, it writes the job summary and updates a PR comment:
```yaml
- uses: lqmon/toggle_wars/report@main
  with:
    experiment-id: '1245'
    environment-key: ${{ vars.FLAGSMITH_ENV_KEY }}
    admin-key: ${{ secrets.FLAGSMITH_ADMIN_KEY }}
```

**`flagkit watch`** checks every running experiment every 5 minutes. A sample-ratio mismatch, or a version that is clearly worse (≤1% chance to beat control, with ≥100 users per version), gets a **"send everyone back to control" request** in the approval queue. It never acts on its own. A stall (no exposures for 6 hours) is printed as a warning.
```
🚨 Development #8 Checkout copy: calm vs urgent · 500 users
     trouble: urgent is clearly worse than control (0.0% chance to beat it, lift -65%)
     → filed chg_955fe87bd828: send everyone back to control. A human approves in `flagkit tui` → Approvals or `flagkit approve chg_955fe87bd828`.
```

## 🧩 VS Code extension: live flags in your code

[`vscode-extension/`](vscode-extension/) shows, at the end of any line that mentions a flag, its live state in every environment and its experiment's chance to win:
```js
const flag = flagsmith.getExperimentFlag('hero_headline');   ● dev:control  ● stg:control  ● prod:control  🧪 #1 benefit 99.4%
```
Hover the flag name for a table of every environment (value, variant weights, drift) plus the experiment and a link to it. It connects to the FlagKit stack with no setup (it reads `.flagkit/state.json`), or to Cloud and any self-hosted instance with **FlagKit: Connect to Flagsmith**; the key goes into VS Code's secret storage. It's read-only, and server text is rendered as plain text (no HTML, no command links). Install: `code --install-extension vscode-extension/flagkit-vscode-0.1.0.vsix`. It's tested inside real VS Code (`vscode-extension/test/run.js`).

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
| `flagkit_explain_user` | **why does this user see this?** Every flag in every environment for one identity, with the reason: experiment bucket, segment match, percentage split, identity override or default. Uses Flagsmith's own evaluation; never creates the user, records no exposure |
| `flagkit_experiment_report` | the `flagkit report` Markdown: verdict, health checks, next step |
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

**"Why does this user see this?"** is also a command, `flagkit explain <user> [--flag f] [--traits plan=pro]`:
```
Development  known user, no traits
  hero_headline       on   control        in experiment #1 "Hero headline: generic vs benefit-led", bucketed into control
  cta_color           on   control        environment default (no rule targets this user)
  signup_form_length  on   short          percentage split: lands in short (100% of users get it)
Staging  never seen here: evaluated as a new user (nothing saved)
  cta_color           on   teal           percentage split: lands in teal (100% of users get it)
```

## 📜 Track 04: Agent Skills

[`skills/flagsmith-experiment-rollout`](skills/flagsmith-experiment-rollout/) takes an agent through preflight → design → create → instrument → start → monitor → **roll out the winner** → cleanup PR → archive, all with the Flagsmith CLI. It stops at 5 approval gates, rolls out through Flagsmith's own experiment-complete decision, verifies with `flagsmith eval`, and prints a rollback command. **A full measured run reads about 130 tokens of tool output.** [Token table and real transcript →](skills/flagsmith-experiment-rollout/README.md)
`scripts/stale.sh` handles the flag-debt side: finished or decided flags plus their remaining code references.

[`skills/flagsmith-kill-switch`](skills/flagsmith-kill-switch/) **puts out the fire**. It goes from "feature X is broken" to the flag behind it (`suspects.sh` ranks flags by code evidence), a snapshot with the exact rollback command, a **human-approved** kill (it ends a running experiment with Flagsmith's own `disable` decision, because the flag is locked while the experiment runs), proof that 5/5 fresh users get it off, and an incident note or GitHub issue with the undo command. Production and running experiments are named in the approval question, and the agent never re-enables anything. **≈120 tokens of tool output.** [Details →](skills/flagsmith-kill-switch/README.md)

**Tested with a real agent:** a headless Claude Code session took the [sample sign-up app](examples/signup-app) from one sentence ("prove three fields beat six") through all 5 gates to a rolled-out winner and a cleanup commit, for $0.80. The run exposed 5 real problems (sandboxed agents can't run `$VAR` commands, an API shape change, a refresh race…), all now fixed. [What happened →](examples/agent-run/README.md)

## 🧪 Track 01: a real experiment

**https://lqmon.github.io/toggle_wars/**: FlagKit A/B tests its own landing page on **Flagsmith Cloud**.

- **Hypothesis:** replacing the generic, category-style headline with a benefit-led one (what you can do with FlagKit) will increase the share of visitors who click **Get early access**. The exact wording of both is kept out of this README until the test ends, so readers who come here first don't see both versions and skew it.
- **Flag:** `hero_headline`, multivariate. Control `control`, variant key `benefit`. **The headline is the only difference** between the arms.
- **Metric:** `signup_click`, occurrence, higher is better. It fires early in a visit, so data comes in fast.
- **Split:** 100% of visitors, 50/50. Each anonymous visitor gets a persisted random UUID as their identity.
- **Stop rule:** ship when a variant has ≥95% chance to beat control, ≥50 users per arm, and no sample-ratio-mismatch warning.
- **Honesty rules:** no simulated traffic touches this experiment (`flagkit simulate` refuses remote hosts), and test visits use the Development environment.
- **Instrumentation** ([demo-app/index.html](demo-app/index.html)): `getExperimentFlag('hero_headline')` logs the exposure, the page branches on `flag.variant`, and the button calls `trackEvent('signup_click')` once per visit.
- **Privacy:** anonymous ID, variant and click only. No cookies, no personal data. Only the client-side key is published, and the page runs under a strict content-security policy.

### Results

There are two separate experiments, and they are never mixed.

**1. Simulated traffic, self-hosted (done ✅).** The same flag, metric and 50/50 split ran on the local FlagKit stack, with 2,001 visitors from `flagkit simulate`. The simulator *assumes* the true click rates (8% control, 11.5% benefit) and Flagsmith has to discover them from exposures and events alone:

| version | visitors | clicks | rate | lift vs control | 95% credible interval | chance to beat control |
|---|---|---|---|---|---|---|
| control | 969 | 73 | 7.5% | (baseline) | | |
| benefit | 1,032 | 120 | 11.6% | **+54%** | +12% to +97% | **99.4%** |

How to read it: the benefit-led headline almost certainly converts better (99.4% is above the 95% stop rule), and the lift is very likely somewhere between +12% and +97%. The interval is wide, so the *size* of the win is uncertain even though the *direction* isn't. The split is 48/52, close enough to 50/50 that there's no sample-ratio warning. The measured rates (7.5% and 11.6%) land close to the assumed ones (8% and 11.5%), which shows the whole pipeline works: flag → exposure → event → warehouse → Bayesian result. At 601 visitors the same experiment showed only 66.8%, which is why the stop rule waits for data.

Reproduce it: `flagkit up && flagkit experiment create && flagkit simulate --users 2000 && flagkit experiment results`

**2. Real visitors, Flagsmith Cloud (still running, more visitors needed 🙏).** As of Nov 28, experiment #1245 has **11 real visitors** (7 benefit, 4 control) and 3 clicks. That is far below the 50-per-arm stop rule, so Flagsmith doesn't compute a win probability yet, and we don't claim one. **[Visit the page](https://lqmon.github.io/toggle_wars/) to add your vote.** Final real results and the rollout decision will be added here before the deadline.

Check live: `FLAGSMITH_ENVIRONMENT=<prod key> skills/flagsmith-experiment-rollout/scripts/results.sh 1245`, or the Flagsmith dashboard → Experiments.

## Security

The stack and tools were reviewed before going live (see commit `Security hardening before going live`): loopback-only binding, generated secrets, sign-up lock, `DJANGO_ALLOWED_HOSTS`, client traits off, injection-safe skill scripts, a simulator that refuses real experiments, CSP and security headers on the demo server, and a human-only approval path for agents.

## Commands

```
up / down [--wipe] / bootstrap / status       stack
doctor [--api-url] [--env-key] [--fix] [--json]
tui                                           flags · experiments · doctor · approvals
experiment create|results / simulate / demo / build-page
plan / report <id> / tail / watch / explain <user>
mcp / approvals [--all] / approve <id> / reject <id>
```

## How Flagsmith is used

- **Self-hosted Flagsmith** (official images and compose) is the backend of `up`, `doctor`, `tui` and `mcp`.
- **Admin API**: bootstrap, features, multivariate options, environments, warehouse connections, metrics, experiments (create / start / results / refresh / complete-with-rollout-decision), feature states.
- **Experimentation**: Bayesian results (`chance_to_win`, lift, credible interval), exposures, SRM.
- **SDKs**: `@flagsmith/flagsmith` (browser, `getExperimentFlag`/`trackEvent`) and `@flagsmith/nodejs` (simulator).
- **Flagsmith CLI v2**: both Agent Skills, `flagkit report` on Cloud (through `flagsmith login`), and the CI journey.
- **Identity evaluation** (`reason`, `variant`, experiment metadata, `transient` identities): `flagkit explain` and its MCP tool.
- **The events table** behind self-hosted Experimentation: `flagkit tail`.
- **Flagsmith Cloud**: the live Track 01 experiment.

## Develop

```bash
npm test                 # unit tests
node test/mcp-smoke.mjs  # MCP server against the local stack
```
CI ([workflow](.github/workflows/ci.yml)) boots self-hosted Flagsmith on a clean runner, runs `doctor` as a gate, a simulated experiment, `plan`/`tail`/`explain`/`report`, a guardrail drill (a clearly worse variant must produce a pending kill request), both Agent Skills end to end with the official CLI, the report Action, the MCP smoke test, and security assertions. The VS Code extension has an integration test that runs inside real VS Code.

MIT © 2026 Puneet Madan
