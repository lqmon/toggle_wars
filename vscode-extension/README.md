# FlagKit for VS Code: live Flagsmith flags in your code

See each Flagsmith flag's **live state in every environment** where the flag is used. Catch **flag-name typos**
before they ship, and get told when a flag is **stale and ready to delete**.

- **Inline**: the end of any line that mentions a flag shows `● dev:control  ● stg:teal=100%  ○ prod  🧪 #1 benefit 99.4%`
  (● on, ○ off).
- **Typo detection**: an SDK call with a flag name that doesn't exist (`getValue('hero_headlin')`) is an error in the
  Problems panel: *"is not a flag in this Flagsmith project. Did you mean "hero_headline"?"*, with a one-click
  **quick fix**. Without it, that code would silently get the default forever.
- **Autocomplete** flag names inside SDK calls, with each flag's state per environment.
- **Stale flags**: a flag that's identical in every environment, has no overrides and hasn't changed for 14 days
  (`flagkit.staleDays`) gets an info hint: hard-code its value and delete it.
- **CodeLens** above each flag call: its state per environment. Click to toggle it in Development or Staging, after
  a modal confirmation. It never toggles Production (use `flagkit panel`, which needs a reason and keeps an audit log)
  and never a flag in a running experiment (that would corrupt the result).
- **Hover** a flag name for a table of every environment (state, value, variant weights), the running experiment,
  its chance to beat control, and a link to it in Flagsmith.
- **Status bar**: flag count and running experiments. Click to refresh. It also reloads every 60 seconds.

Calls it understands: `hasFeature`, `isFeatureEnabled`, `getExperimentFlag`, `getFeatureValue`, `useFlag`,
`useVariant`, `is_feature_enabled` (Python), `GetFeatureValue` (Go/.NET), and `flags.getValue(...)`-style calls on a
flags object. A form library's `getValue('email')` is never mistaken for a flag. These are the same rules
`flagkit lint` uses in CI.

## Connect

- **FlagKit local stack**: nothing to do. If the folder has `.flagkit/state.json` (from `flagkit up`), it connects to it.
- **Flagsmith Cloud or any self-hosted instance**: run **FlagKit: Connect to Flagsmith** and enter the API URL,
  project id and an Organisation API key. The key goes into VS Code's secret storage, never into settings files.

Flag text from the server is shown as plain text: no HTML, and no command links.

## Install

```bash
code --install-extension flagkit-vscode-0.2.0.vsix
```
