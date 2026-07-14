# Agent Changelog

All modifications made to the sync utility codebase by the AI agent.

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
