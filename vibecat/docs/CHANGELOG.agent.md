# Agent Changelog

All modifications made to the sync utility codebase by the AI agent.

## [2.0.5] - 2026-08-06

```yaml
id: vibecat-2.0.5-vibecat-native-workflow
timestamp: 2026-08-06T21:10:00+00:00
what: Made the workflow vibecat-native end to end. Added `vibecat init` to scaffold a base userscript (`--project`, `--match`, `--name`; refuses overwrite), added `connect --wait` (`--wait-timeout`, default 60s) so agents block deterministically until the page bridge acknowledges, and rewrote the skill operating contract (root and nested SKILL.md) so the default flow is init -> start --reload -> push -> connect --wait -> inspect through the injected bridge -> watch --push --reload -> validate -> stop. The agent's external browser tools are documented as a fallback only, never the default source of DOM facts.
why: Agents were using their own browser tools to inspect pages (slow, and bot walls block datacenter browsers); the injected bridge already provides inspect/query/screenshot on the real synchronized page, so the workflow should scaffold a base script, inject it, and debug through vibecat itself.
components:
  - bin/vibecat.js (init command, connect --wait, help)
  - tests/cli.test.js (init scaffold + overwrite refusal)
  - SKILL.md, skills/sync-scriptcat-userscripts/SKILL.md (vibecat-native workflow)
type: patch
validation:
  - npm run lint
  - npm test
  - npm run check
```

## [2.0.4] - 2026-08-06

```yaml
id: vibecat-2.0.4-project-lazy-esbuild
timestamp: 2026-08-06T20:55:00+00:00
what: Lazy-loaded esbuild in project.js config loading. vibecat.config.ts/.js transpiling was the last eager esbuild require on the CLI startup path (services.js pulls in project.js); esbuild now loads only when a TypeScript/JS config actually needs transpiling, so status, doctor, and start no longer pay ~90ms of module load on projects without a config file.
components:
  - src/project.js (lazy esbuild in loadConfig)
type: patch
validation:
  - npm run lint
  - npm test
  - npm run check
```

## [2.0.3] - 2026-08-06

```yaml
id: vibecat-2.0.3-stale-connect-autoreload
timestamp: 2026-08-06T20:45:00+00:00
what: Closed the last manual-reload gap in rapid iteration. In reload mode, a page bridge that connects while running a stale build (hash older than the latest delivered build) is now auto-refreshed 50ms after registration, so opening a tab is enough — the page upgrades itself to the latest build without a manual reload. Pages already running the current build are left untouched.
why: The first page load after a new project still required a manual reload before the bridge existed; with connect-time staleness detection the first open tab self-corrects and every later sync keeps it current.
components:
  - src/server.js (browserHello staleness check, gated on reload mode)
  - tests/sync-server.test.js (stale connect refreshes; current connect untouched)
type: patch
validation:
  - npm run lint
  - npm test
  - npm run check
```

## [2.0.2] - 2026-08-06

```yaml
id: vibecat-2.0.2-rapid-iteration-loop
timestamp: 2026-08-06T20:10:00+00:00
what: Made VibeCat usable as a rapid-iteration tool. Added `--reload` (start, watch --push, push): after every delivered build the server fire-and-forgets a reload command to the connected page bridge, the page reloads, ScriptCat re-executes the bundle, and the new hash is acknowledged; push widens its ack window when reload is requested. Cut CLI startup by lazy-loading esbuild and typescript (previously every command, including `version` and `locate`, paid ~150ms of module load). Cut process-ownership verification cost on Windows by batching PID command-line lookups into one PowerShell call and caching them per project with an 8-second TTL, so status/stop sequences stop paying ~420ms per PID. Reduced the watch-sync debounce from 100ms to 30ms so save-to-delivery lands around 40ms. Added `reload` to server health, a `reloadBrowser` server API, and `scripts/benchmark-loop.js` plus `npm run benchmark:loop` to measure the iteration loop.
why: A full agent workflow (locate, doctor, bootstrap, status, connect, inspect, watch, push, validate, stop) took minutes, dominated by per-command CLI startup and repeated PowerShell ownership checks, and there was no mechanism for the page to refresh itself with the updated script. The goal is edit -> rebuild -> push -> page reload -> ack in well under two seconds of tool time.
components:
  - src/build.js, src/services.js (lazy esbuild/typescript)
  - src/services.js (batched TTL-cached PID verification, reload session env, push ack window)
  - src/browser-bridge.js (reload operation)
  - src/server.js (reloadBrowser, delivery-time reload, health.reload)
  - sync-server.js (VIBECAT_RELOAD)
  - bin/vibecat.js (--reload flag, help)
  - scripts/benchmark-loop.js, package.json (benchmark:loop)
  - tests/sync-server.test.js (reload bridge op, reload-mode delivery, no-reload guard)
type: patch
validation:
  - npm run lint
  - npm test
  - npm run check
  - npm run benchmark:loop
```

## [2.0.1] - 2026-08-06

```yaml
id: vibecat-2.0.1-divergence-aware-install-detection
timestamp: 2026-08-06T19:20:00+00:00
what: Fixed the duplicate-installation false positive. `vibecat locate` and the `duplicate-installations` doctor check now warn only when detected copies genuinely diverge (different versions or incomplete copies) instead of warning for every multi-copy layout. The documented skill-plus-CLI installation pattern (agent skill directory plus a global CLI copy of the same version) no longer emits a permanent warning. Added a `divergent` field to locate/doctor output and unit tests for the new selection semantics.
why: The documented distribution model installs the skill into an agent skills directory (Hermes, Codex, Antigravity) while the CLI also lives in the user home; the previous `candidates.length > 1` heuristic warned on every command in exactly that supported layout, and the remediation asked users to delete a copy that the install instructions tell them to keep. Same-version copies are interchangeable, so only divergent copies carry stale-CLI risk.
components:
  - src/services.js (selectInstallation divergence computation, doctor check)
  - bin/vibecat.js (locate warning condition and message)
  - tests/locate.test.js (selection and divergence unit tests)
  - package.json / package-lock.json (2.0.1)
type: patch
validation:
  - npm run lint
  - npm test
  - npm run check
```

## [2.0.0] - 2026-07-17

```yaml
id: vibecat-2.0-cross-agent
timestamp: 2026-07-17T15:40:06-05:00
what: Added the deterministic VibeCat CLI, reusable application core, project-scoped lifecycle state, verified process ownership, TypeScript/esbuild builds and watch contexts, authenticated browser execution acknowledgement, bounded live DOM inspection, selector and mutation tools, screenshots, and observable validation.
why: Hermes exposed that the previous skill depended on manual discovery, shell-specific paths, implicit prose state, and selector guessing; modular TypeScript and real browser evidence were unavailable.
components:
  - bin/vibecat.js
  - src application core and browser bridge
  - sync-server.js and legacy manager wrappers
  - skill, README, architecture, backlog, benchmarks
  - unit, integration, browser, lifecycle, and validation tests
type: major backward-compatible architecture and capability release
validation:
  - npm run lint
  - npm test
  - npm run check
  - npm run benchmark
  - dynamic-port lifecycle smoke
  - authenticated ScriptCat plus DOM-runtime end-to-end validation
  - production npm audit with zero vulnerabilities
  - unrelated-directory installed CLI and canonical skill-path proof
performance: Clean TypeScript build median 26.16 ms; observed incremental edit-to-output median 132.84 ms on the documented Windows workstation.
working_directory_note: The C:\Windows\Temp invocation was an adversarial unrelated-working-directory verification, not the normal or recommended place to run a skill. Normal operation keeps the skill and executable in stable installation directories and allows `vibecat` to be invoked from the userscript project or any ordinary working directory. Hermes was abnormal because it mixed its stable skill installation, Git Bash/MSYS paths, native Windows paths, tool-specific temporary mappings, and inconsistent filesystem views while trying to rediscover the skill.
readme_note: Expanded README.md from a quick-start summary into the complete VibeCat 2.0 user reference, covering installation and discovery, JSON contracts, doctor checks, lifecycle, JavaScript and TypeScript projects, esbuild and metadata, ScriptCat delivery, browser acknowledgement, every DOM and selector command family, mutations, screenshots, validation, paths, recovery, agent workflows, compatibility, security, and verification.
github_note: Prepared VibeCat 2.0 for the existing robertheadley/skills monorepo under vibecat/, preserving its root SKILL.md and scripts/manage-sync.ps1 entrypoints while intentionally retiring the unrestricted REPL evaluation, embedded source loader, full-HTML DOM reports, and obsolete production-export path superseded by named bounded inspection and `vibecat build --production`.
github_validation: Validated the reconciled vibecat/ subtree from a clean robertheadley/skills main clone with npm ci, lint, TypeScript checking, 29 tests, production dependency audit, and diff-integrity checks before direct main publication.
risks:
  - DOM-rendered screenshots are not pixel-exact browser compositor captures.
  - Native Linux and macOS process lifecycle behavior is unit-covered but not executed on those operating systems in this run.
  - Live installed ScriptCat on port 8642 belonged to another Hermes VibeCat installation and was intentionally not interrupted.
follow_up:
  - Add installed-browser matrix coverage and an explicitly authorized CDP screenshot backend.
```

## [1.2.0] - 2026-07-14

### Added
- Implemented secure WebSocket connection authentication based on query parameters (`token` or `key`).
- Integrated origin domain whitelisting to filter socket handshakes.
- Restored `dom_report` page-to-server action, saving layout snapshots to `<script>_dom_report.json` for authenticated sessions.

## [1.1.0] - 2026-07-14

### Added
- Integrated HTTP server to serve `/debug/health` endpoint on port `8642`.
- Added SHA-256 code hashing support via the Node.js `crypto` library.
- Built a JSON Lines console log writer dumping browser events to `.runtime/userscript-console.jsonl`.
- Created client console capture overrides in `sync-client-template.js`.
- Created this `docs/CHANGELOG.agent.md` and `docs/EXECUTION_LOGS.md`.

### Changed
- Locked host listening interface to strictly `127.0.0.1` (removed `0.0.0.0` exposure).
- Modified sync update console formats to output stdout lines readable by powershell manager helpers.
- Refactored `sync-client-template.js` to feed version and hash headers dynamically using server payloads.

### Removed
- Removed unsafe arbitrary `dom_report` file saving to secure local storage against cross-origin script executions.
