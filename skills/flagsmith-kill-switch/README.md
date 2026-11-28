# flagsmith-kill-switch

An [Agent Skill](https://agentskills.io/specification) for **putting out the fire**: a coding agent goes from
"feature X is broken" to the flag behind it, a snapshot, a **human-approved** kill (ending any experiment on it),
proof that it's off, and an incident note with the exact undo command. All through the Flagsmith CLI.

```
cp -r skills/flagsmith-kill-switch ~/.claude/skills/
```

| step | script | the agent reads | bytes |
|---|---|---|---:|
| find the flag | `suspects.sh checkout` | ≤5 ranked lines: flag, state, score, files | 74 |
| snapshot | `snapshot.sh <flag>` | state, running experiment, code refs, PRODUCTION marker, rollback command | 233 |
| kill + prove | `kill.sh <flag>` | experiment ended, default off, `eval: 5/5 fresh users get it OFF` | 99 |
| trail | `trail.sh <flag> "<symptom>" "<rollback>"` | note path (+ issue URL) | 60 |
| **total** | | | **≈470 bytes ≈ 120 tokens** |

Safety:
- Two gates. Production and running experiments are spelled out in the approval question.
- The kill is verified with 5 fresh evaluations. Anything less than 5/5 stops the agent and leaves overrides alone.
- The agent never re-enables anything or runs the rollback itself.
- Every input is validated, and server-held names are stripped of control characters.

Measured on the FlagKit stack (`flagkit up`), Staging:

```
$ snapshot.sh cta_color
env=Staging flag=cta_color enabled=true value=control weights=teal=100
code_refs=.github/workflows/ci.yml
ROLLBACK: flagsmith flag update cta_color --yes --enable --value control --weight teal=100
$ kill.sh cta_color
default: enabled=false
eval: 5/5 fresh users get it OFF
$ trail.sh cta_color "CTA button renders invisible on Safari" "flagsmith flag update cta_color …"
note=incidents/20261128-1048-cta_color.md
```

With a running experiment on the flag, `kill.sh` first ends it with Flagsmith's own decision:
`experiment 7 completed (disabled)`.
