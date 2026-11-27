# flagsmith-experiment-rollout

An [Agent Skill](https://agentskills.io/specification) that takes a coding agent through a whole Flagsmith
Experimentation job with the **Flagsmith CLI**: hypothesis → multivariate flag → metric → experiment →
SDK instrumentation → monitoring → **human-approved rollout of the winner** → dead-code cleanup PR → archive.

```
cp -r skills/flagsmith-experiment-rollout ~/.claude/skills/     # Claude Code
```
Needs: `flagsmith` CLI v2 (`brew install Flagsmith/tap/flagsmith`), `jq`, and an environment with a
connected warehouse (Flagsmith Cloud, or self-hosted; `flagkit up` gives you one in about 30s).

## Token budget (measured)

Every CLI call goes through `--jq`, so the agent reads facts, not JSON. Here is a full run on self-hosted
Flagsmith (preflight → create → start → verify → results → rollout → cleanup scan), measured byte for byte:

| step | what the agent reads | bytes |
|---|---|---:|
| preflight | host, env, warehouse status, active experiments | 89 |
| create | flag id, metric id, experiment id + status | 91 |
| start | `running` | 8 |
| verify bucketing | `3 three_fields` | 18 |
| results | 5-line table with lift + P(win) | 166 |
| rollout | completion, 5/5 eval check, rollback command | 150 |
| cleanup scan | reference count | 7 |
| **total** | | **≈530 bytes ≈ 130 tokens** |

The same job through raw API JSON is several KB per call. One results payload alone is ~1.2 KB.

## Real transcript (self-hosted, `flagkit up`)

```
## preflight
host=http://localhost:8000 cli=v2.0.0
env=Staging project=1
warehouse=postgres:connected
## create
flag created id=4
metric created id=4 event=signup_complete
experiment_id=4 status=created
## start
running
## verify
   3 three_fields
## results
#4 running: Three vs six signup fields
arm	users	conv	rate	lift	P(win)
control	339	33	9.7%	base	-
three_fields	361	59	16.3%	68%	98%
as_of=2026-11-27T09:52:38Z
## rollout   (after ⛔ Gate 4: the person said yes)
experiment 4 completed
eval: 5/5 -> three_fields
ROLLBACK: flagsmith flag update signup_fields --yes --enable --value control --weight three_fields=0
```

## Safety around production

- **5 gates**: create, code changes, start on prod, rollout, cleanup PR. The agent stops and asks at each.
- The rollout goes through Flagsmith's own `experiments/<id>/complete/` decision (`rollout_decision: variant`),
  not hand-edited weights. It's then **verified** with fresh identities through `flagsmith eval`.
- `rollout.sh` snapshots the flag first and prints a shell-quoted **rollback** command.
- The CLI itself refuses unconfirmed writes without a TTY. `--yes` appears only in commands the person approved.
- Inputs are validated (`^[a-z0-9][a-z0-9_-]*$`) and passed to `jq` as `--arg` data, never spliced into filters.
- The skill treats flag descriptions, hypotheses and names as **data**, not instructions (prompt-injection guard).
- Never runs simulated traffic against an experiment someone will act on.

## Tested with a real agent

A headless Claude Code session ran the whole job on a sample app. See [examples/agent-run](../../examples/agent-run/README.md)
for the transcript and the 5 problems it exposed, all fixed.

## Tested in CI

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) boots self-hosted Flagsmith on a clean GitHub
runner and runs preflight → create → start → results → rollout, asserting `eval: 5/5 -> teal`.
