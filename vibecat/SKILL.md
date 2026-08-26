---
name: vibecat
description: Use when developing userscripts with VibeCat: scaffold, push, auto-reload, inspect the live DOM, read console logs, and validate — entirely through the CLI, no user-side steps.
---

# VibeCat

VibeCat is a deterministic CLI-driven userscript development environment for ScriptCat (Tampermonkey-style browser extension). It builds and synchronizes scripts, runs an injected bridge inside the user's real browser, and exposes live DOM and console data back to the CLI. Agents develop and debug userscripts **entirely through vibecat** — no external browser tools, no DevTools, no asking the user to run or paste anything.

The user should never have to explain what vibecat can do. If a task is on this page, vibecat does it — use it.

## What VibeCat can do

| Area | Capability |
|---|---|
| Scaffold | `vibecat init --project "<abs-path>" --match "<url-pattern>" [--settings] --json` — base userscript with `@inject-into content` (CSP-safe bridge) and a tagged verbose `log()` helper; `--settings` adds an in-page key/preferences menu via GM.getValue/GM.setValue |
| Lifecycle | `locate`, `doctor`, `bootstrap --plan/--execute`, `start --reload`, `status`, `connect --wait`, `stop` — all JSON, all state-checked |
| Build & deliver | `build`, `watch --push --reload` (save → rebuild → deliver → page auto-refreshes itself), `push` (proves exact-hash browser execution), `validate --browser` |
| Live DOM | `inspect page/landmarks/tree/element`, `query "<css>"`, `query-xpath`, `attributes`, `text`, `styles`, `rect`, `highlight` — read the REAL page through the bridge, including logged-in and adult-gated pages |
| Console read-back | `events --level <lvl> --hash <prefix> --limit <n> --json` — every console line from the userscript is relayed and readable; `status` shows `console_diagnostics.buffered_events` |
| Sandbox eval | `eval --expr "<js>" [--timeout-ms <n>] [--file <path>] --json` — run a userscript function in a browser-less `node:vm` sandbox (DOM/GM/location stubs, network off) and get `{ result, type, calls, timeMs }`; ideal for search-URL/NZB-query/date logic before touching the real page |
| Live call | `call --fn "<name>" [--args <json>] --json` — invoke a function the userscript registered under `window.__vibecatExpose` on the live page and return its result; `--args` is an array (spread positionally) or a single object (one arg) |
| Match diagnostics | `status` reports `browser.match_state` (`matched`/`mismatched`/`no_patterns`/`no_tab`); `BROWSER_EXECUTION_NOT_ACKNOWLEDGED` push failures include it with tailored `nextActions` so you can tell wrong-URL from no-tab from stale-build |
| Selectors | `selector suggest <handle>`, `selector test "<css>"`, `selector compare <a> <b>` |
| Mutations | `mutations start/read/clear/stop` — observe dynamic pages |
| Capture | `screenshot --output "<abs.png>"` (may fail on tainted canvases — fall back to `query`/`text`/`rect`) |
| Settings | `init --settings` scaffolds the dialog; the script reads values with `await loadSettings()` |

## Default workflow — do this, don't ask the user

1. `vibecat locate --json`
2. `vibecat init --project "<absolute-project-path>" --match "<url-pattern>" --json` (add `--settings` when the script needs keys/preferences)
3. `vibecat doctor --project "<path>" --json` — resolve every FAIL using its `remediation`
4. `vibecat start --project "<path>" --reload --json`
5. `vibecat push --project "<path>" --json` — delivery success is `delivery.sent=true`
6. `vibecat connect --wait --project "<path>" --json` — blocks until the page bridge acknowledges
7. `vibecat inspect landmarks --json` then `vibecat query "<selector>" --json` — write selectors ONLY from this live data
8. `vibecat events --project "<path>" --limit 20 --json` — read the script's relayed console output
9. `vibecat watch --project "<path>" --push --reload --json` — edit source; every save delivers and the page refreshes itself
10. `vibecat validate --project "<path>" --browser --json` — require `VALIDATED`
11. `vibecat stop --project "<path>" --json` when finished

For pure-function iteration (search-URL / NZB-query / date logic), skip the push-reload loop: `vibecat eval --project "<path>" --expr "buildSearchUrl('Mature NL', ['Eileen'])" --json` returns the result in <1s. To run a function the script registers via `window.__vibecatExpose` on the live page, use `vibecat call --project "<path>" --fn "<name>" --args '<json>' --json`.

## Rules — violating these stalled real sessions

- **Never assume site structure.** Write selectors only from live bridge inspection. A selector that works on one page variant (e.g. a studio page) is not guaranteed on another (network page, scene page). When the user says "it doesn't work on page X", inspect THAT page through the bridge.
- **Never guess when you can verify.** Every claim about the page (element exists, link target, value present) comes from `query`/`attributes`/`text`/`events` output.
- **Logged-in and gated pages work through the bridge** — it runs in the user's real, authenticated browser session. Never report a page as unreachable because it needs login.
- **Verbose logging is the default.** Keep the tagged `log()` helper; read it with `vibecat events`. Never ask the user to paste console output or open DevTools.
- **Never ask the user to act when vibecat can.** No "run this one-liner", no "change ScriptCat settings", no manual page reloads — `--reload` refreshes the page after every delivery.
- **Keys and preferences go in the in-page settings menu** (`init --settings`). The user enters values through the menu; never hard-code them or ask the user to edit the script.
- **Batch tool calls into one turn** — the workflow above fits in a single session. Hitting iteration limits means over-inspecting.
- **Userscript projects are standalone directories** — never commit them to an unrelated repo.

## Recovery essentials

- `SCRIPTCAT_NOT_CONNECTED` → enable ScriptCat development synchronization; `status.service.websocket_clients > 0` confirms it.
- `BROWSER_NOT_CONNECTED` → load/reload the matched URL, then `connect --wait`.
- `BROWSER_EXECUTION_NOT_ACKNOWLEDGED` → ScriptCat received the bundle but no page executed it. Check `browser.match_state`: `mismatched` → the tab is on a URL outside `@match` (open the matched URL); `no_tab` → no tab is connected (open/reload); `matched` → the page is on the right URL but hasn't run the updated build (reload or `--reload`, then retry).
- Page CSP blocks the bridge (`connect-src` violations) → scripts scaffolded by `init` carry `@inject-into content` (isolated world, CSP-exempt); that is the fix for strict sites like duckduckgo.com.
- `PORT_OCCUPIED` / duplicate instances → stop the conflicting project; `STALE_PID` → run `doctor`.
- `STALE_ELEMENT_HANDLE` → re-query; `STALE_BUILD` → push + reload; `BROWSER_RUNTIME_ERROR` → read `events` for the exact-hash failure, fix, rebuild, push.
- Events survive `vibecat stop` (archived at `<project>/.vibecat/events.jsonl`, `evidence.live=false`).

## Full contract

The complete operating contract — lifecycle states, JSON result schema, validation guarantees, security model, path handling, and the full command reference — lives at `skills/sync-scriptcat-userscripts/SKILL.md`. Read it for deep detail; the sections above are enough to start real work.
