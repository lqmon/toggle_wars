# Demo video script (target: 4–5 minutes)

Judges score: **problem → what you built → how Flagsmith fits**. Record at 1080p, terminal font ≥16pt, and use a
dark theme to match the page. Before recording: `node bin/flagkit.js down --wipe` so `up` runs from scratch.
Right after `up` (off camera), rebuild the demo data the later shots use (about 3 minutes):
```bash
node bin/flagkit.js experiment create && node bin/flagkit.js simulate --users 2000
node -e "import('./src/experiment.js').then(async (m) => m.createExperiment((await import('./src/config.js')).loadState(), { envName: 'Development', flag: 'checkout_copy', variants: ['urgent'], event: 'checkout_click', name: 'Checkout copy: calm vs urgent', hypothesis: 'Urgent copy increases checkout clicks.' }))"
node bin/flagkit.js simulate --users 500 --flag checkout_copy --event checkout_click --rates control=0.2,urgent=0.06
node bin/flagkit.js experiment results    # asks Flagsmith to compute; wait a minute before the report/watch shots
```

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

## 1:45 – 2:05 · `flagkit panel` + `flagkit init` (Track 3)
- `node bin/flagkit.js panel` → enter your name → toggle `checkout_v2` in Staging → the modal shows before → after.
- Try Production: a reason is required and you type the flag name. Try `hero_headline`: 🧪 locked mid-experiment.
- Promote tab: Staging → Production preview. Activity tab: **Revert**. User lookup: "why does customer-4821 see this?"
- `node bin/flagkit.js init express /tmp/shop && cd /tmp/shop && npm i && npm test` → the flag matrix (every flag state on every page).
- `npm run dev`, then in the panel turn `maintenance_mode` ON in Development → reload → maintenance page; Revert → back.
> "Flags for people who don't write code, with the guard rails production needs."

## 2:05 – 2:25 · VS Code extension (Track 3)
- `code --install-extension vscode-extension/flagkit-vscode-0.2.0.vsix`, then open `demo-app/index.html` in this repo.
- Point at the grey text at the end of the `hero_headline` line: live state per environment + `🧪 #1 benefit 99.4%`.
- Hover the flag name → the table and the experiment. Type `flagsmith.getValue('hero_headlin')` → red squiggle, "Did you mean hero_headline?", quick fix.
- Type `hasFeature('` → autocomplete lists every flag with its live state. CodeLens above the call → click "Development" to toggle.
> "Your editor knows what production is doing."

## 2:25 – 3:05 · Agent + MCP with human approval (Track 2)
- Claude Code in this repo (`.mcp.json` auto-registers). Prompt:
  *"Check the experiments. If one meets the ship bar, propose rolling out the winner. Also propose turning hero_headline off in Production."*
- Show the agent calling `flagkit_experiment_results` → `flagkit_propose_change` → "pending — NOT applied".
- Switch to the TUI: **4 Approvals (2)** lights up → approve one (`a`, `y`), reject the other (`x`, `y`).
- Back in Claude Code: `flagkit_change_status` → applied / rejected.
- Ask: *"Why does user <any id from `flagkit tail`> see the headline they see?"* → `flagkit_explain_user` answers with "in experiment #1, bucketed into control" per environment.
- `node bin/flagkit.js watch --once` → 🚨 "urgent is clearly worse… filed chg_…": the guardrail uses the same approval queue.
> "The agent has no write path. Only a person can apply a change, whether the agent or the guardrail asked."

## 3:05 – 3:45 · Agent Skills (Track 4)
- `cp -r skills/flagsmith-experiment-rollout ~/.claude/skills/`, then ask Claude Code:
  *"Prove that a three-field signup form beats six fields."*
- Show it stopping at gates 1 and 4. Show `results.sh` (5 lines) and `rollout.sh` with `eval: 5/5` and the ROLLBACK line.
- Overlay: **"whole job ≈ 130 tokens of tool output"** (see skills/…/README.md).
- Second skill, `flagsmith-kill-switch`: *"The CTA button is invisible on Safari, put out the fire in Staging."* Show
  `suspects.sh` → `snapshot.sh` (ROLLBACK line) → the gate question → `kill.sh` with `eval: 5/5 fresh users get it OFF` → the incident note.

## 3:45 – 4:40 · The experiment, start to finish (Track 1)
- `node bin/flagkit.js plan --baseline 0.08 --lift 0.44 --daily 300` → "≈880 per version, about 6 days".
- `node bin/flagkit.js tail` in one pane, `node bin/flagkit.js simulate --users 50` in another → events stream in live.
- `node bin/flagkit.js report 1` → the verdict, the table, the health checks (simulated run, 99.4%).
- Live test: `FLAGSMITH_PROJECT=56751 node bin/flagkit.js report 1245 --env-key <prod key> --hide-hypothesis` → real visitors,
  and the honest verdict ("too early" or the winner).
- ⚠ Show both headlines only **after** the live test has ended. While it runs, a public video that reveals them skews it.

## 4:40 – 4:50 · Close
- CI badge: "every push boots self-hosted Flagsmith from scratch and runs this whole journey."
- `npx flagsmith-kit up`
