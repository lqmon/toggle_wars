# Demo video script (target: 3–4 minutes)

Judges score: **problem → what you built → how Flagsmith fits**. Record at 1080p, terminal font ≥16pt, and use a
dark theme to match the page. Before recording: `node bin/flagkit.js down --wipe` so `up` runs from scratch.

## 0:00 – 0:20 · The problem (talking head or title card)
> "Starting self-hosted Flagsmith is one command. Getting a working A/B test on it took me an afternoon.
> The obvious setup silently throws away every experiment event, and leaves the admin open on your Wi-Fi."

## 0:20 – 0:55 · `flagkit doctor` on the stock setup (Track 3)
- `examples/stock-compose-demo.sh` boots the untouched upstream compose on :8100 and prints the doctor command.
- `node bin/flagkit.js doctor --api-url http://localhost:8100 --env-key <key>`
- Pause on **"Events are being DROPPED"** and **"Admin API is reachable from your network"**.
- `--fix` → `y` → re-run: events check is green.
> "Six failures, including the one that makes your experiment show nothing. It works on any self-hosted Flagsmith."

## 0:55 – 1:25 · `flagkit up` (Track 3)
- `time node bin/flagkit.js up` → show the ~30s finish and "bound to 127.0.0.1, sign-up disabled".
- `source flagsmith.env && flagsmith flag list` → the official CLI works immediately.
- `node bin/flagkit.js doctor` → all green.

## 1:25 – 2:05 · `flagkit tui` (Track 3)
- Tab 1: flags × environments. Press space on Production → confirm prompt. Press `/` to search; point at the `≠` drift marker.
- Tab 2: experiment with bars and 98% chance to win → press `s` → confirm → shipped.
- Tab 3: doctor inside the dashboard.

## 2:05 – 2:45 · Agent + MCP with human approval (Track 2)
- Claude Code in this repo (`.mcp.json` auto-registers). Prompt:
  *"Check the experiments. If one meets the ship bar, propose rolling out the winner. Also propose turning hero_headline off in Production."*
- Show the agent calling `flagkit_experiment_results` → `flagkit_propose_change` → "pending — NOT applied".
- Switch to the TUI: **4 Approvals (2)** lights up → approve one (`a`, `y`), reject the other (`x`, `y`).
- Back in Claude Code: `flagkit_change_status` → applied / rejected.
> "The agent has no write path. Only a person in the TUI can apply a change."

## 2:45 – 3:20 · Agent Skill (Track 4)
- `cp -r skills/flagsmith-experiment-rollout ~/.claude/skills/`, then ask Claude Code:
  *"Prove that a three-field signup form beats six fields."*
- Show it stopping at gates 1 and 4. Show `results.sh` (5 lines) and `rollout.sh` with `eval: 5/5` and the ROLLBACK line.
- Overlay: **"whole job ≈ 130 tokens of tool output"** (see skills/…/README.md).

## 3:20 – 3:50 · The live experiment (Track 1)
- Open https://lqmon.github.io/toggle_wars/ in two private windows → two different headlines.
- Flagsmith dashboard → Experiments → #1245 → Refresh results: users per arm, lift, chance to win.
- State the hypothesis, the stop rule, and the result **honestly**, even if it's "not conclusive yet: here's why".

## 3:50 – 4:00 · Close
- CI badge: "every push boots self-hosted Flagsmith from scratch and runs this whole journey."
- `git clone … && node bin/flagkit.js up`
