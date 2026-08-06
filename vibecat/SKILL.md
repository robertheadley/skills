---
name: vibecat
description: Use VibeCat as a deterministic CLI-driven TypeScript or JavaScript userscript environment with ScriptCat synchronization, authenticated browser acknowledgement, bounded live DOM inspection, and observable validation.
---

# VibeCat Skill Entrypoint

The complete operating contract is maintained at:

```text
skills/sync-scriptcat-userscripts/SKILL.md
```

Read that file completely before taking VibeCat task actions. This root file preserves the public `vibecat/SKILL.md` interface used by the `robertheadley/skills` repository and skill installers.

Start with:

```text
vibecat locate --json
vibecat init --project "<absolute-project-path>" --match "<url-pattern>" --json
vibecat start --project "<absolute-project-path>" --reload --json
vibecat push --project "<absolute-project-path>" --json
vibecat connect --wait --project "<absolute-project-path>" --json
vibecat inspect landmarks --project "<absolute-project-path>" --json
```

Use returned JSON and canonical paths as the source of truth. Inspect the live page through the injected bridge (`inspect landmarks`, `query`, `screenshot`) before writing selectors — the agent's external browser tools are a fallback, not the default. Require exact-hash browser acknowledgement for push success, require `VALIDATED` when browser validation is configured, and finish with `vibecat stop --project "<canonical-projectPath>" --json`.
