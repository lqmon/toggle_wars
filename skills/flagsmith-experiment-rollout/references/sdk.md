# SDK instrumentation cheatsheet (Experimentation)

Minimum versions: JS/React `@flagsmith/flagsmith` 12.4.0, Node `@flagsmith/nodejs` 9.1.0, Python `flagsmith` 6.3.0,
Java 8.2.0, Go `flagsmith-go-client/v5` 5.3.0, Flutter 6.2.0.

Self-hosted: API URL `<host>/api/v1/`, events URL `<host>/api/` (SDK appends `v1/events`).

| | init (events on) | exposure | conversion | flush |
|---|---|---|---|---|
| JS | `flagsmith.init({environmentID, api, identity, enableEvents:true, eventProcessorConfig:{eventsApiUrl}})` | `flagsmith.getExperimentFlag('f')` | `flagsmith.trackEvent('e')` | `await flagsmith.flushEvents()` |
| React | `<FlagsmithProvider options={{environmentID, identity, enableEvents:true}}>` | `useExperiment('f')` | `flagsmith.trackEvent('e')` | — |
| Node | `new Flagsmith({environmentKey, apiUrl, enableEvents:true, eventProcessorConfig:{eventsApiUrl}})` | `await fs.getExperimentFlag('f', userId)` | `fs.trackEvent('e', {identifier:userId})` | `await fs.close()` |
| Python | `Flagsmith(environment_key=..., api_url=..., enable_events=True)` | `fs.get_experiment_flag("f", identifier=uid)` | `fs.track_event("e", identifier=uid)` | `EventProcessorConfig(max_buffer_items=1)` for scripts |
| Go | `flagsmith.NewClient(key, flagsmith.WithEvents(ctx))` | `client.GetExperimentFlag(ctx, "f", ec)` | `client.TrackEvent("e", &flagsmith.EventOptions{Identifier: uid})` | `client.FlushEvents(ctx)` |
| Java | `FlagsmithConfig.newBuilder().withEnableEvents(true)` | `fs.getExperimentFlag("f", uid)` | `fs.trackEvent("e", uid, null, null, null)` | `fs.close()` |
| Flutter | `FlagsmithConfig(enableEvents: true)` | `fs.getExperimentFlag('f', user: u)` | `fs.trackEvent('e', user: u)` | `await fs.flushEvents()` |

Branch on the variant key:
```js
const flag = flagsmith.getExperimentFlag('hero_headline');
const variant = (flag?.enabled && flag?.variant) || 'control';
```

Gotchas
- Exposures without an identity are dropped; anonymous web visitors need a persisted UUID.
- Conversions only count after that identity's first exposure.
- Event names are case-sensitive; unmatched events are silently ignored.
- An identity that sees two variants is quarantined from results.
- Each arm shows "collecting data" until ≥50 identities (or ≥5 conversions for occurrence metrics).
