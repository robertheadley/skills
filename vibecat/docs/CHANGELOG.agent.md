# Agent Changelog

All modifications made to the sync utility codebase by the AI agent.

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
