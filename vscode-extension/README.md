# FlagKit for VS Code: live Flagsmith flags in your code

See every Flagsmith flag's **live state in each environment**, and its **experiment's chance to win**, right where the
flag is used.

- **Inline**: the end of any line that mentions a flag shows `● dev:control  ● stg:teal=100%  ○ prod  🧪 #1 benefit 99.4%`
  (● on, ○ off, `≠` in the hover when environments differ).
- **Hover** a flag name for a table of every environment (state, value, variant weights), the running experiment,
  its chance to beat control, and a link to it in Flagsmith.
- **Status bar**: flag count and running experiments. Click to refresh. It also reloads every 60 seconds.

Works with any string literal that matches a flag name, in any language: `getExperimentFlag('hero_headline')`,
`flags.is_feature_enabled("checkout")`, `useFlags(['banner'])`, config files…

## Connect

- **FlagKit local stack**: nothing to do. If the folder has `.flagkit/state.json` (from `flagkit up`), it connects to it.
- **Flagsmith Cloud or any self-hosted instance**: run **FlagKit: Connect to Flagsmith** and enter the API URL,
  project id and an Organisation API key. The key goes into VS Code's secret storage, never into settings files.

It is read-only. Flag text from the server is shown as plain text: no HTML, and no command links.

## Install

```bash
code --install-extension flagkit-vscode-0.1.0.vsix
```
