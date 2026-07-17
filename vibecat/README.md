# VibeCat

VibeCat is a deterministic, browser-aware userscript development environment for people and coding agents. ScriptCat remains responsible for installing and executing userscripts. VibeCat supplies the surrounding development system: discovery, diagnostics, project resolution, TypeScript builds, incremental watching, ScriptCat synchronization, browser execution acknowledgement, live DOM inspection, validation, and safe cleanup.

VibeCat works through one stable `vibecat` CLI. Codex, Antigravity, Hermes, and generic agents can all use the same commands and machine-readable JSON without locating a skill directory or reconstructing state from conversation history.

## Features

- Stable CLI available from the repository, a userscript project, or an unrelated working directory.
- Staged installation, discovery, update, repair, duplicate-installation reporting, and safe uninstall.
- Structured JSON output with lifecycle state, evidence, warnings, stable errors, retry safety, and exact next actions.
- Windows PowerShell, CMD, Git Bash/MSYS, WSL, Linux, and macOS path handling.
- Explicit distinction between the VibeCat installation and the target userscript project.
- Project-scoped lifecycle state and command-line-verified process ownership.
- Plain `.user.js` compatibility with no required project migration.
- Modular `.ts` and `.tsx` projects with ES module and JSON imports.
- Programmatic esbuild bundling, source maps, browser targets, production builds, and optional minification.
- Separate TypeScript compiler checking through `--typecheck`.
- Persistent incremental esbuild contexts for watch mode.
- Deterministic userscript metadata preservation or generation.
- Atomic output publication and previous-known-good bundle preservation after build failures.
- ScriptCat-native `hello` and `onchange` synchronization.
- Separate proof of ScriptCat delivery and actual page execution.
- Authenticated, project- and tab-scoped browser sessions.
- Page summaries, semantic landmarks, bounded DOM trees, CSS queries, and XPath queries.
- Opaque element handles with stale-handle and cross-session protection.
- Attribute, text, computed-style, and bounding-rectangle inspection.
- Selector suggestion, testing, comparison, stability estimates, and language-dependence warnings.
- Bounded mutation observation for dynamic applications.
- Temporary element highlighting and page- or element-scoped PNG capture.
- Password, token, API-key, authorization, and card-like value redaction.
- Build, type, metadata, syntax, browser, selector, attribute, style, runtime-error, and stale-build validation.
- Idempotent shutdown that stops only verified VibeCat-owned processes.

VibeCat does not expose unrestricted browser evaluation, cookies, local storage, session storage, authorization headers, unrelated tabs, or unbounded full-DOM dumps.

## Install

From this repository:

```powershell
npm install
node bin\vibecat.js install --from "D:\path\to\vibecat-repository" --json
```

Installation is staged before replacement, installs runtime dependencies, and creates a `vibecat` launcher in the npm global prefix. A successful result reports `installation.launcher.onPath: true`.

Verify it from another ordinary directory:

```powershell
vibecat version --json
vibecat locate --json
```

The test from `C:\Windows\Temp` used during development was deliberately an adversarial unrelated-working-directory check. Temp is not VibeCat's normal installation or execution location. Normal use keeps VibeCat in a stable installation directory and runs the CLI from the target project or any other ordinary working directory.

Installation management:

```text
vibecat locate --json
vibecat install --from "<source-path>" --json
vibecat install --from "<source-path>" --force --json
vibecat update --from "<source-path>" --json
vibecat uninstall --target "<installed-path>" --json
```

`locate` returns every detected installation, identifies the copy currently executing, reports completeness and versions, and warns about duplicates. `--no-launcher` exists only for isolated installation tests.

## Quick Start

Use an absolute userscript project path:

```powershell
vibecat locate --json
vibecat doctor --project "C:\absolute\userscript-project" --json
vibecat bootstrap --project "C:\absolute\userscript-project" --plan --json
vibecat bootstrap --project "C:\absolute\userscript-project" --execute --json
vibecat status --project "C:\absolute\userscript-project" --json
vibecat connect --project "C:\absolute\userscript-project" --json
vibecat inspect landmarks --project "C:\absolute\userscript-project" --json
vibecat watch --project "C:\absolute\userscript-project" --push --json
vibecat validate --project "C:\absolute\userscript-project" --browser --json
vibecat stop --project "C:\absolute\userscript-project" --json
```

Bootstrap plan mode is read-only. It reports intended file changes, process actions, and permission-sensitive work. Execute mode resolves the project, builds valid output, starts the local service, and returns the next browser action. It never claims a browser connection without browser acknowledgement.

## JSON Contract

Important commands accept `--json`. JSON mode writes exactly one valid JSON document to stdout. Errors use a nonzero exit code and include a stable shape:

```json
{
  "ok": false,
  "command": "connect",
  "state": "ERROR",
  "projectPath": "C:\\Users\\name\\project",
  "errors": [
    {
      "code": "BROWSER_NOT_CONNECTED",
      "message": "No browser tab has acknowledged the authenticated VibeCat bridge.",
      "evidence": { "activeSessions": 0 },
      "retryable": true,
      "nextActions": [
        "Load or reload the synchronized userscript in the intended tab.",
        "Rerun `vibecat connect --json`."
      ]
    }
  ],
  "nextActions": []
}
```

Results identify the canonical `projectPath` and `skillPath`; reuse those paths instead of translating them again in another shell or tool.

## Doctor

```text
vibecat doctor --project "<path>" --json
```

Doctor reports `PASS`, `WARN`, or `FAIL` for:

- Node.js and dependency readiness.
- Installation completeness and duplicate installations.
- Operating system, shell, and native path conversion.
- Project existence and writability.
- Configuration, entry point, and userscript metadata.
- TypeScript and esbuild availability.
- Existing output syntax and metadata.
- Local service health and configured port ownership.
- Stale lifecycle state and duplicate service records.
- ScriptCat connection, browser bridge, active tab, and injection evidence.

Browser warnings do not prevent an offline build. A required local dependency, project, configuration, or port failure makes `coreReady` false.

## Lifecycle

Public states are:

```text
UNAVAILABLE  INSTALLED  READY  STARTING  RUNNING  CONNECTED
BUILDING     WATCHING   DIRTY  PUSHING   PUSHED
VALIDATING   VALIDATED  STOPPING  STOPPED  ERROR
```

Normal transitions:

```text
UNAVAILABLE -> INSTALLED -> READY -> STARTING -> RUNNING -> CONNECTED
READY -> BUILDING -> READY
RUNNING or CONNECTED -> WATCHING -> DIRTY -> WATCHING
CONNECTED -> PUSHING -> PUSHED -> VALIDATING -> VALIDATED
RUNNING or CONNECTED or WATCHING -> STOPPING -> STOPPED
failure -> ERROR -> follow nextActions -> retry from observed status
```

Lifecycle commands:

```text
vibecat bootstrap --project "<path>" --plan --json
vibecat bootstrap --project "<path>" --execute --json
vibecat start --project "<path>" --json
vibecat status --project "<path>" --json
vibecat connect --project "<path>" --json
vibecat stop --project "<path>" --json
```

State is persisted per normalized project. `stop` is idempotent and verifies the recorded PID's command line, entry point, and project before terminating it. VibeCat never kills a process merely because it has the same executable name or owns the configured port.

## JavaScript Projects

A project can remain one executable userscript:

```text
project/
  example.user.js
```

If the directory contains exactly one `.user.js`, VibeCat detects it. Existing JavaScript is validated and synchronized without being forced into `src/` or `dist/`. When multiple userscripts exist, configure `entry` or pass `--file "<absolute.user.js>"`.

## TypeScript Projects

Recommended structure:

```text
project/
  src/
    main.ts
    config.ts
    dom/selectors.ts
    ui/styles.ts
  dist/
    example.user.js
    example.user.js.map
  vibecat.config.ts
  tsconfig.json
  package.json
```

Example configuration:

```ts
export default {
  entry: "src/main.ts",
  output: "dist/example.user.js",

  browser: {
    urlPattern: "https://example.com/*"
  },

  build: {
    sourcemap: true,
    target: "chrome120",
    minify: false
  },

  validation: {
    requireTypecheck: true,
    selectors: [
      { selector: "[data-example-ready]", minimumMatches: 1 }
    ],
    assertions: [
      {
        type: "attribute",
        selector: "[data-example-ready]",
        attribute: "data-example-ready"
      },
      {
        type: "style",
        selector: "[data-example-ready]",
        property: "border-left-style",
        equals: "solid"
      }
    ]
  }
};
```

Supported configuration files are `vibecat.config.ts`, `.js`, `.cjs`, and `.json`.

## Build and Watch

```text
vibecat build --project "<path>" --json
vibecat build --project "<path>" --typecheck --json
vibecat build --project "<path>" --production --json
vibecat watch --project "<path>" --json
vibecat watch --project "<path>" --typecheck --push --json
```

The build pipeline:

1. Resolves the configured entry and output.
2. Loads and validates userscript metadata.
3. Bundles TypeScript, TSX, JavaScript, local modules, and safe JSON imports.
4. Applies the configured browser target and optional minification.
5. Generates an external source map when enabled.
6. Ensures the metadata block is first.
7. Parses the generated JavaScript.
8. Runs TypeScript compiler diagnostics when requested.
9. Atomically replaces the output only after validation succeeds.
10. Records the build hash, size, module count, duration, and evidence.

TypeScript watch mode keeps one esbuild context alive. A syntax or type error moves the watcher to `DIRTY`, preserves the previous known-good output, and recovers automatically after the next valid save. Plain JavaScript source is watched directly.

## Userscript Metadata

Metadata can be the first block in the entry file or supplied through `metadata` configuration. Common fields such as `@name`, `@namespace`, `@version`, `@match`, `@include`, `@exclude`, `@grant`, `@run-at`, `@require`, `@resource`, `@connect`, and update URLs are supported.

VibeCat rejects missing delimiters, missing required fields, duplicate singleton fields, invalid match patterns, unsupported fields, and metadata appearing after executable content. Repeatable fields remain repeatable. Existing JavaScript metadata is preserved.

## ScriptCat Delivery and Browser Acknowledgement

The service binds to `127.0.0.1` and preserves ScriptCat's native `hello`/`onchange` development protocol. VibeCat does not replace ScriptCat's installation role and does not use a page-side source loader.

```text
vibecat push --project "<path>" --json
vibecat push --project "<path>" --file "<bundle.user.js>" --json
```

Push verifies:

- The bundle exists.
- Metadata and JavaScript are valid.
- The service watches the requested output.
- A ScriptCat synchronization peer is connected.
- The intended page executes the exact delivered SHA-256 hash.
- No stale tab or project claims the acknowledgement.

Successful socket transmission alone is not push success. `SCRIPTCAT_NOT_CONNECTED` means no extension peer received it. `BROWSER_EXECUTION_NOT_ACKNOWLEDGED` means ScriptCat delivery happened but the page did not execute that exact build before the timeout.

## Browser Sessions

The delivered development copy contains an authenticated browser bridge. Its random token is scoped to the service process and is never returned by CLI JSON, health output, DOM inspection, or logs.

Browser sessions report an opaque session ID and tab handle, URL, title, connection time, project scope, and executed hash. A project cannot take over another project's browser tab. Sessions and handles expire on disconnect.

```text
vibecat connect --project "<path>" --json
vibecat status --project "<path>" --json
```

## Live DOM Inspection

Use progressive inspection rather than requesting an entire document:

```text
vibecat inspect page --project "<path>" --json
vibecat inspect landmarks --project "<path>" --json
vibecat inspect tree --depth 3 --max-nodes 200 --project "<path>" --json
vibecat inspect tree --root <handle> --depth 3 --project "<path>" --json
vibecat inspect element <handle> --project "<path>" --json
```

Page information includes URL, title, readiness, language, viewport size, and document dimensions. Landmarks report visible semantic regions. Trees enforce depth and node limits and support subtree roots and visible-only filtering.

CSS and XPath:

```text
vibecat query "[role='listitem']" --limit 20 --project "<path>" --json
vibecat query "button" --visible-only --project "<path>" --json
vibecat query-xpath "//main//button" --limit 20 --project "<path>" --json
```

Element details:

```text
vibecat attributes <handle> --project "<path>" --json
vibecat text <handle> --limit 2000 --project "<path>" --json
vibecat styles <handle> --project "<path>" --json
vibecat rect <handle> --project "<path>" --json
vibecat highlight <handle> --project "<path>" --json
```

Handles are opaque and scoped to a project, browser session, and tab. DOM replacement or removal produces `STALE_ELEMENT_HANDLE`; re-query to obtain a current handle. Inspection allowlists attributes and truncates text. Passwords and secret-looking values are redacted.

## Selector Assistance

```text
vibecat selector suggest <handle> --project "<path>" --json
vibecat selector test "<selector>" --project "<path>" --json
vibecat selector compare <handle-a> <handle-b> --project "<path>" --json
```

Suggestions prefer stable IDs, semantic roles, accessible names, stable `aria-*` attributes, and stable `data-*` attributes. Results report match count, uniqueness, estimated stability, reasons, language dependence, and generated-class dependence. Comparison looks for shared stable structure across real elements.

## Mutation Observation

```text
vibecat mutations start --project "<path>" --json
vibecat mutations read --limit 100 --project "<path>" --json
vibecat mutations clear --project "<path>" --json
vibecat mutations stop --project "<path>" --json
```

Mutation records are bounded by retained event count, serialized nodes, text length, and an attribute allowlist. They identify added elements, removals, attribute changes, text changes, timestamps, and affected handles. This is intended for dynamic pages where a one-time selector query is insufficient.

## Screenshots and Highlighting

```text
vibecat screenshot --project "<path>" --output "C:\absolute\page.png" --json
vibecat screenshot --element <handle> --project "<path>" --output "C:\absolute\element.png" --json
vibecat highlight <handle> --project "<path>" --json
```

Screenshots capture a bounded DOM-rendered page or element, not browser chrome. Results report output path, dimensions, method, and byte count. This is not a pixel-exact browser compositor capture. Highlighting is explicit, temporary, and automatically cleaned up.

## Validation

```text
vibecat validate --project "<path>" --json
vibecat validate --project "<path>" --typecheck --json
vibecat validate --project "<path>" --browser --json
vibecat validate --project "<path>" --typecheck --browser --json
```

Depending on configuration and flags, validation proves:

- Source build success.
- Required type-check success.
- Valid metadata at the start of the output.
- Parseable output JavaScript.
- Current browser session and intended tab.
- Exact latest-build execution acknowledgement.
- Required selector match counts.
- Required attributes and computed styles.
- No fatal browser runtime event for the exact build hash.
- No accidental validation of a stale bundle.

Browser-dependent configuration or `--browser` makes a missing browser connection fatal. Offline validation reports browser execution as unproven instead of simulating success.

## Paths and Shells

VibeCat supports:

```text
C:\Users\name\Documents\userscripts
C:/Users/name/Documents/userscripts
/c/Users/name/Documents/userscripts
\\wsl$\Ubuntu\home\name\project
/home/name/project
/Users/name/project
```

Examples:

```powershell
# PowerShell or CMD
vibecat doctor --project "C:\Users\name\Documents\userscripts\demo" --json
```

```bash
# Git Bash/MSYS
vibecat doctor --project /c/Users/name/Documents/userscripts/demo --json

# WSL or Linux
vibecat doctor --project /home/name/userscripts/demo --json

# macOS
vibecat doctor --project /Users/name/userscripts/demo --json
```

VibeCat uses the runtime's native temporary-directory API only for owned disposable data. It does not assume `/tmp`, `$HOME`, and `%USERPROFILE%` are interchangeable. When path conversion cannot be identified safely, it returns `AMBIGUOUS_PATH_ENVIRONMENT` rather than guessing.

## Recovery

- `PROJECT_ENTRY_AMBIGUOUS`: configure `entry` or pass `--file`.
- `CONFIG_INVALID`: correct `vibecat.config.*` and rerun doctor.
- `PORT_OCCUPIED`: identify the owner or configure another port; never kill by port or process name alone.
- `STALE_PID`: run doctor and stop through VibeCat to clean owned state.
- `PROCESS_OWNERSHIP_MISMATCH`: do not terminate the recorded PID; inspect the evidence.
- `BUILD_FAILED`: fix the source; watch preserves the previous bundle.
- `TYPECHECK_FAILED`: fix compiler diagnostics; transpilation success is not type-check success.
- `SCRIPTCAT_NOT_CONNECTED`: connect ScriptCat development synchronization and retry.
- `BROWSER_NOT_CONNECTED`: load or reload the intended page and rerun `connect`.
- `BROWSER_EXECUTION_NOT_ACKNOWLEDGED`: reload the page so the exact build executes, then retry.
- `STALE_ELEMENT_HANDLE`: repeat the CSS or XPath query.
- `STALE_BUILD`: push the latest output, reload, and revalidate.
- `BROWSER_RUNTIME_ERROR`: inspect the exact-build event evidence, fix, rebuild, and retry.

## Agent Workflows

The skill is the agent operating contract; the CLI is the executable source of state. Native-skill and generic agents should both use the same commands.

Canonical generic/Hermes workflow:

```text
vibecat locate --json
vibecat doctor --project "<absolute-project-path>" --json
vibecat bootstrap --project "<absolute-project-path>" --plan --json
vibecat bootstrap --project "<absolute-project-path>" --execute --json
vibecat status --project "<canonical-projectPath>" --json
vibecat connect --project "<canonical-projectPath>" --json
vibecat inspect landmarks --project "<canonical-projectPath>" --json
vibecat watch --project "<canonical-projectPath>" --push --json
vibecat validate --project "<canonical-projectPath>" --browser --json
vibecat stop --project "<canonical-projectPath>" --json
```

Hermes's earlier use of temporary mappings and inconsistent Windows/MSYS filesystem views was abnormal behavior, not the intended skill workflow. The stable CLI and returned canonical paths eliminate the need to rediscover the skill between commands.

## Compatibility

The following remain available:

```text
node sync-server.js <file.user.js>
node scripts/manage-sync.js <start|status|health|stop> [file.user.js]
powershell -File scripts\manage-sync.ps1 -Action <action>
```

Legacy wrappers route through the shared application core where applicable. The ScriptCat `hello`/`onchange` wire contract and plain JavaScript projects remain supported. The obsolete embedded synchronization client and unbounded DOM-reporting path are intentionally retired.

## Security Model

- Local services bind to `127.0.0.1`.
- Browser sessions require random per-service authentication.
- Sessions and element handles are project- and tab-scoped.
- Tokens are not printed in CLI output or health data.
- Browser commands are named and bounded; arbitrary evaluation is unavailable.
- Sensitive values are redacted and browser storage is not exposed.
- Output and state writes are atomic.
- Temporary directories require a VibeCat ownership marker before deletion.
- Process shutdown requires PID and command-line ownership proof.

## Development and Verification

```powershell
npm run lint
npm run typecheck
npm test
npm run check
npm run benchmark
```

The test suite covers builds, metadata, type failures, incremental recovery, CLI JSON purity, bootstrap, lifecycle ownership, installation, cross-shell paths, ScriptCat protocol behavior, browser authentication, DOM inspection, selector assistance, mutations, screenshots, and exact-build validation.

See [the agent operating contract](skills/sync-scriptcat-userscripts/SKILL.md), [architecture](docs/ARCHITECTURE.md), [benchmarks](docs/BENCHMARKS.md), [change journal](docs/CHANGELOG.agent.md), and [execution log](docs/EXECUTION_LOGS.md).
