---
name: sync-scriptcat-userscripts
description: Operate VibeCat as a deterministic CLI-driven TypeScript or JavaScript userscript development environment with ScriptCat synchronization, authenticated browser acknowledgement, live bounded DOM inspection, and observable validation.
---

# VibeCat Userscript Development

VibeCat is the executable environment. This skill is the operating contract. ScriptCat remains the userscript installer and executor; VibeCat builds, watches, synchronizes, inspects, and validates.

## Start Here

1. Run `vibecat locate --json`.
2. Run `vibecat doctor --project "<absolute-project-path>" --json`.
3. Resolve every `FAIL` result using its `remediation` field.
4. Run `vibecat bootstrap --project "<absolute-project-path>" --plan --json`.
5. Review `fileChanges`, `processActions`, and `permissionSensitive` actions.
6. Run `vibecat bootstrap --project "<absolute-project-path>" --execute --json`.
7. Load or reload the intended page, then run `vibecat connect --project "<absolute-project-path>" --json`.
8. Confirm state `CONNECTED`; inspect the live page before writing selectors.
9. Run `vibecat watch --project "<absolute-project-path>" --push --json` and confirm `WATCHING`.
10. Run `vibecat validate --project "<absolute-project-path>" --browser --json` and require `VALIDATED`.
11. Run `vibecat stop --project "<absolute-project-path>" --json` when finished; repeated stops must remain successful.

Never search manually for this `SKILL.md` after `vibecat locate --json` succeeds. Never infer state from earlier prose; rerun `vibecat status --project "<path>" --json`.

## Success Contract

- Installation success: `locate.ok=true`, state `INSTALLED`, selected installation `complete=true`.
- Core readiness: `doctor.coreReady=true`; browser warnings do not block offline builds.
- Service success: state `RUNNING` and `/debug/health` evidence identifies the owned PID and output file.
- Browser success: state `CONNECTED`, with opaque `sessionId` and `tabHandle`, URL, title, and matching project scope.
- Build success: output metadata and JavaScript syntax pass; requested type checking passes; a SHA-256 build hash is returned.
- Watch success: state `WATCHING`, a verified watcher PID exists, and the previous bundle survives failed rebuilds.
- Push success: ScriptCat has a connected synchronization peer and the intended page reports execution of the exact bundle hash.
- Validation success: state `VALIDATED`; required build, metadata, syntax, type, browser, selector, attribute, style, and runtime-error checks pass.
- Shutdown success: state `STOPPED`; only command-line-verified VibeCat-owned PIDs were terminated and secret/PID state was removed.

## CLI and JSON Rules

Use the stable `vibecat` executable from any directory. Pass `--project` when the current directory is not the target project. Important commands accept `--json`; stdout contains exactly one JSON document and diagnostics remain out of stdout. A nonzero exit means the command did not meet its guarantee.

Every result includes `ok`, `command`, `state`, `warnings`, `errors`, `evidence`, and `nextActions`. Errors include `code`, `message`, `evidence`, `retryable`, and exact recovery actions. Do not claim success if `ok=false`, even when an earlier phase such as delivery succeeded.

Core commands:

```text
vibecat help
vibecat version
vibecat locate --json
vibecat install --from "<source>" --json
vibecat update --from "<source>" --json
vibecat uninstall --target "<installed-path>" --json
vibecat doctor --project "<path>" --json
vibecat bootstrap --project "<path>" --plan --json
vibecat bootstrap --project "<path>" --execute --json
vibecat start --project "<path>" --json
vibecat status --project "<path>" --json
vibecat connect --project "<path>" --json
vibecat stop --project "<path>" --json
vibecat build --project "<path>" --typecheck --json
vibecat watch --project "<path>" --typecheck --push --json
vibecat push --project "<path>" --json
vibecat validate --project "<path>" --typecheck --browser --json
```

Installation stages a complete copy and dependencies before replacement, then creates the `vibecat` launcher in the npm global prefix. Confirm `installation.launcher.onPath=true`, change to an unrelated directory, and rerun `vibecat locate --json`. Use `--no-launcher` only in isolated installation tests.

## Lifecycle

Public states are `UNAVAILABLE`, `INSTALLED`, `READY`, `STARTING`, `RUNNING`, `CONNECTED`, `BUILDING`, `WATCHING`, `DIRTY`, `PUSHING`, `PUSHED`, `VALIDATING`, `VALIDATED`, `STOPPING`, `STOPPED`, and `ERROR`.

Expected path:

```text
UNAVAILABLE -> INSTALLED -> READY -> STARTING -> RUNNING -> CONNECTED
READY -> BUILDING -> READY
RUNNING or CONNECTED -> WATCHING -> DIRTY -> WATCHING
CONNECTED -> PUSHING -> PUSHED -> VALIDATING -> VALIDATED
RUNNING or CONNECTED or WATCHING -> STOPPING -> STOPPED
any command failure -> ERROR -> follow nextActions -> retry from observed status
```

`stop` is idempotent. A stale PID never authorizes termination. VibeCat verifies the recorded PID command line contains the expected server or watcher entry and target project before stopping it.

## Projects, TypeScript, and esbuild

Existing projects may remain one `.user.js` file. VibeCat validates it in place and ScriptCat watches it directly.

Modular projects should use:

```text
project/
  src/main.ts
  src/dom/selectors.ts
  dist/script.user.js
  vibecat.config.ts
  tsconfig.json
```

Example `vibecat.config.ts`:

```ts
export default {
  entry: "src/main.ts",
  output: "dist/script.user.js",
  browser: { urlPattern: "https://www.example.com/*" },
  build: { sourcemap: true, target: "chrome120", minify: false },
  validation: {
    requireTypecheck: true,
    selectors: [{ selector: "[data-vibecat-ready]", minimumMatches: 1 }],
    assertions: [{ type: "attribute", selector: "[data-vibecat-ready]", attribute: "data-vibecat-ready" }]
  }
};
```

`build` resolves the entry, loads metadata, bundles local modules and JSON through esbuild, places metadata first, validates output syntax, atomically replaces the bundle, and optionally performs compiler-API type checking. `--production` enables configured or requested minification. Source maps default on for TypeScript. `watch` keeps one esbuild context alive, rebuilds incrementally, never publishes invalid output, and recovers after the next valid save.

Metadata may be the first block in the entry file or the typed `metadata` configuration. Required singleton fields are checked, repeatable fields remain repeatable, and the output always begins with `// ==UserScript==`. Do not put executable content before metadata.

## ScriptCat Connection and Push

VibeCat binds to `127.0.0.1`. ScriptCat connects through its native `hello`/`onchange` development protocol. The page bridge uses a random per-service token embedded only in the development payload. Tokens never appear in CLI JSON, logs, DOM results, or health output.

`push` verifies the bundle, metadata, syntax, connected ScriptCat peer, intended project output, and exact browser execution hash. Socket transmission alone is not success. If the result is `BROWSER_EXECUTION_NOT_ACKNOWLEDGED`, reload the intended tab and retry; do not relabel delivery as execution.

## Live DOM Inspection

Use progressive inspection and keep results bounded:

```text
vibecat inspect page --project "<path>" --json
vibecat inspect landmarks --project "<path>" --json
vibecat inspect tree --depth 3 --max-nodes 200 --project "<path>" --json
vibecat query "[role='listitem']" --limit 20 --visible-only --project "<path>" --json
vibecat query-xpath "//main//button" --limit 20 --project "<path>" --json
vibecat inspect element <handle> --project "<path>" --json
vibecat attributes <handle> --project "<path>" --json
vibecat text <handle> --limit 2000 --project "<path>" --json
vibecat styles <handle> --project "<path>" --json
vibecat rect <handle> --project "<path>" --json
vibecat highlight <handle> --project "<path>" --json
```

Handles are opaque and scoped to one project, browser session, and tab. `STALE_ELEMENT_HANDLE` means re-query the page. Inspection is read-only except the explicit temporary `highlight` overlay and screenshot rendering. There is no arbitrary expression evaluation.

Attributes are allowlisted. Passwords, hidden secret fields, token-like names and values, authorization material, API-key patterns, and credit-card-like values are redacted. Cookies and browser storage are not inspected. Unrelated tabs are never addressable.

## Selector, Mutation, and Screenshot Workflow

```text
vibecat selector suggest <handle> --project "<path>" --json
vibecat selector test "<selector>" --project "<path>" --json
vibecat selector compare <handle-a> <handle-b> --project "<path>" --json
vibecat mutations start --project "<path>" --json
vibecat mutations read --limit 100 --project "<path>" --json
vibecat mutations clear --project "<path>" --json
vibecat mutations stop --project "<path>" --json
vibecat screenshot --project "<path>" --output "<absolute.png>" --json
vibecat screenshot --element <handle> --project "<path>" --output "<absolute.png>" --json
```

Prefer stable IDs, roles, accessible names, and stable data attributes. Treat language-dependent text and generated-class warnings as instability evidence. Mutation records are bounded by retained events and serialized node/text limits. Screenshots capture a bounded DOM-rendered page or element image, not browser chrome; failures are explicit when the page cannot be serialized safely.

## Validation

`vibecat validate --typecheck --browser --json` proves the current source builds, metadata is first and valid, output JavaScript parses, requested types pass, the connected tab is current, its executed hash matches the build, configured selector/attribute/style assertions pass, and no fatal event for that exact hash was returned. Without `--browser` or browser-dependent project configuration, validation reports browser execution as false and proves only the offline guarantees.

Never report `VALIDATED` for a required browser workflow if the browser was disconnected, the tab was wrong, the build hash was stale, ScriptCat did not receive the bundle, or a runtime exception was observed.

## Platform Commands and Paths

Use absolute target paths. VibeCat distinguishes installation path from project path and uses the runtime-native temporary directory. It recognizes native Windows, forward-slash Windows, Git Bash `/c/...`, WSL UNC, WSL-native, Linux, and macOS forms. When conversion cannot be proven safe it returns `AMBIGUOUS_PATH_ENVIRONMENT`; pass the native path visible to the current runtime.

PowerShell:

```powershell
vibecat doctor --project "C:\Users\name\Documents\userscripts\demo" --json
```

CMD:

```bat
vibecat doctor --project "C:\Users\name\Documents\userscripts\demo" --json
```

Git Bash/MSYS:

```bash
vibecat doctor --project /c/Users/name/Documents/userscripts/demo --json
```

WSL:

```bash
vibecat doctor --project /home/name/userscripts/demo --json
```

Linux and macOS:

```bash
vibecat doctor --project /home/name/userscripts/demo --json
vibecat doctor --project /Users/name/userscripts/demo --json
```

Do not assume `/tmp`, `$HOME`, `%USERPROFILE%`, or one tool's path spelling is valid in another process. Copy the canonical `projectPath` returned by JSON into later commands.

## Agent Workflows

Native-skill agents must still use the CLI for lifecycle operations. The skill supplies permissions and success rules; persisted state and JSON supply facts.

Generic agents use:

```text
vibecat locate --json
vibecat doctor --project "<absolute-path>" --json
vibecat bootstrap --project "<absolute-path>" --plan --json
vibecat bootstrap --project "<absolute-path>" --execute --json
vibecat status --project "<canonical-projectPath>" --json
```

Hermes uses this complete canonical sequence and never searches for the skill directory:

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

This avoids manual skill discovery, literal `/tmp`, shell-path reconstruction, conversational state, inferred next steps, and hidden prompts.

## Recovery

- `PROJECT_ENTRY_AMBIGUOUS`: configure `entry` or pass `--file <absolute.user.js>`.
- `PORT_OCCUPIED`: do not kill by name or port; identify the owner or configure another project port.
- `STALE_PID` or `PROCESS_OWNERSHIP_MISMATCH`: run `doctor`; never terminate an unverified PID.
- `BUILD_FAILED` or `TYPECHECK_FAILED`: fix reported diagnostics; watch keeps the previous bundle and recovers on save.
- `SCRIPTCAT_NOT_CONNECTED`: enable ScriptCat development synchronization, confirm `status.service.websocket_clients > 0`, retry.
- `BROWSER_NOT_CONNECTED`: load/reload the intended tab after service startup, run `connect`, retry.
- `BROWSER_EXECUTION_NOT_ACKNOWLEDGED`: ScriptCat delivery occurred but page execution did not; reload and retry.
- `STALE_ELEMENT_HANDLE`: repeat the CSS/XPath query and use the new handle.
- `STALE_BUILD`: push the latest output, reload the intended page, and validate again.
- `BROWSER_RUNTIME_ERROR`: inspect the exact-hash event evidence, fix the source, rebuild, push, and revalidate.

Permission-sensitive operations are installation/update/removal, configuration creation, build-output writes, service/watcher process creation, temporary highlighting, and screenshot writes. Bootstrap plan mode reports its intended actions without performing them.

## Backward Compatibility

`node sync-server.js <file.user.js>`, `node scripts/manage-sync.js <action> [file]`, and the PowerShell `manage-sync.ps1` helper remain compatibility entry points and route through the shared core where applicable. Existing ScriptCat `hello`/`onchange` peers and single-file JavaScript userscripts remain supported. Prefer `vibecat` for every new workflow.
