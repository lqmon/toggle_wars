# A real agent running the skill, end to end

A headless **Claude Code (Sonnet)** session was given [`examples/signup-app`](../signup-app) with the
[`flagsmith-experiment-rollout`](../../skills/flagsmith-experiment-rollout) skill installed, plus one sentence:

> *"Prove that a three-field sign-up form (name, email, password) gets more completed sign-ups than our current
> six-field one. Use our self-hosted Flagsmith; the CLI credentials are already in the environment and this is
> the Development environment."*

Full, unedited transcript: [transcript.md](transcript.md). Credentials were in the environment only, and the transcript
contains no keys.

## What the agent did

| Gate | Agent | Person |
|---|---|---|
| — | preflight, read the app, wrote the hypothesis, flag, metric, rollout and stop rule. **Flagged** that another experiment shares the environment | |
| ⛔ 1 | "Create this flag, metric and experiment?" | yes |
| | `create.sh` → `signup_form_length` (`long` / `short`), metric `signup_completed`, experiment #5 (not started) | |
| ⛔ 2 | showed the diff: Node SDK, `getExperimentFlag` at render, `trackEvent` on submit, flush on SIGTERM, keys from env | yes |
| | applied it, **caught a wrong SDK import itself** (`{ Flagsmith }` is a named export), `node --check` | |
| ⛔ 3 | asked before starting, even in Development. **Wouldn't treat a background notification as approval** | yes |
| | `start.sh 5` → `bucketing: control=3 short=5` | ran the app + 700 local visitors |
| | `results.sh 5` → control 19% vs short 36%, +90%, 100% chance to win | |
| | **refused to call it proof**: "simulated visitors exercise the pipeline, they can't prove the hypothesis" | |
| ⛔ 4 | "Roll out `short` to 100% of Development?" | yes |
| | `rollout.sh` → completed, `eval: 5/5 -> short`, printed the rollback verbatim | |
| ⛔ 5 | cleanup diff on `cleanup/signup_form_length` (losing branch + exposure call removed, metric kept) | yes |
| | committed; no `gh`, so gave the branch and PR text; archive left until after deploy | |

12 turns, 53 agent steps, **$0.80** for the whole session including the blocked turns below.

## What the run found, and what was fixed

Running the skill with a real agent, rather than calling its scripts by hand, exposed problems that every judge's agent would hit:

1. **Sandboxed agents can't run `source flagsmith.env`, or any command that expands `$FLAGSMITH_ENVIRONMENT`.**
   Claude Code refuses such commands, so the skill stalled at "start the experiment".
   → Every credential-using step now runs through a script (`start.sh` and `verify.sh` are new), and SKILL.md has no raw `$VAR` commands.
2. **`experiment.feature` is an object on current Flagsmith, not an id.** This broke `start.sh`, and silently would have
   broken "ship the winner" in the TUI and MCP server too. The agent diagnosed it from the 404.
   → `featureIdOf()` + unit test.
3. **`results.sh` raced the results recompute**, and hid the 5-minute refresh rate limit, so the agent saw
   "no results" right after traffic. → It waits until results are newer than its request, and says when a refresh is rate-limited.
4. Brace-expansion `grep --include=*.{js,ts}` is refused too → `git grep`.
5. Without a `gh` fallback, the cleanup step had nothing to do → documented fallback.

The agent's behaviour throughout was the point of the gates: it stopped every time, didn't work around a single
permission block, never printed a key, and labelled the simulated result honestly in its final report.
