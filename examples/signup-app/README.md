# Acme sign-up (sample app)

A deliberately plain six-field sign-up page used to demo the
[`flagsmith-experiment-rollout`](../../skills/flagsmith-experiment-rollout) skill with a real coding agent:

> "Prove that a three-field sign-up form beats our six-field one."

`npm start` → http://localhost:4000. Each visitor gets an anonymous `vid` cookie, which serves as the experiment identity.
See [`../agent-run`](../agent-run) for the recorded agent session.
