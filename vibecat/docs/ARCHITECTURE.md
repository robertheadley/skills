# Architecture

## Components

- The skill defines permissions, exact workflows, success evidence, recovery, and cross-agent behavior.
- `bin/vibecat.js` parses commands, calls application services, and formats stable human or JSON output. Command handlers contain no service lifecycle or browser protocol logic.
- `src/` owns installation discovery, shell-aware paths, project resolution, metadata, builds, state, process ownership, browser commands, and validation inputs.
- `sync-server.js` is the legacy executable wrapper around `src/server.js`. The local service binds to `127.0.0.1`, preserves ScriptCat `hello`/`onchange`, and provides authenticated command routing.
- `src/build.js` uses esbuild's programmatic API. TypeScript watch mode keeps one incremental context; TypeScript compiler diagnostics remain a separate path.
- The injected browser bridge authenticates with a random per-service token, scopes itself to one project/tab session, acknowledges the executed hash, and implements named bounded DOM operations.
- Validation joins build evidence, metadata/syntax/type results, the current browser hash, selector assertions, observable attributes/styles, and exact-build runtime errors.

The browser bridge has no unrestricted expression command. Read operations cannot access cookies, storage, headers, other tabs, password values, or token-like fields. Highlight and screenshot are explicit mutations; highlight cleanup is time-bounded.

## State and ownership

Runtime state is keyed by a normalized-project SHA-256 prefix under `.runtime/projects` or `VIBECAT_RUNTIME_DIR`. It records project/output paths, owned PIDs, port, lifecycle state, build evidence, and a session secret readable only by local CLI processes. JSON responses never expose the secret.

Stopping a process requires both a recorded PID and command-line proof matching the expected VibeCat entry point and project. Port or executable name alone is insufficient. State writes use same-directory temporary files, JSON validation, and rename.

## Delivery and acknowledgement

ScriptCat is an extension peer. It receives instrumented output through `onchange`. The page bridge is a distinct authenticated peer created only when that delivered userscript executes. Therefore extension delivery and page execution are separate facts. `push` reports success only when both the extension peer existed and the page bridge returned the exact delivered hash.

## Compatibility boundary

The stable public interfaces are the `vibecat` CLI, JSON envelope, ScriptCat `hello`/`onchange`, loopback health endpoint, and existing legacy wrappers. Single-file `.user.js` projects bypass bundling and remain source-identical. No transport-specific logic is embedded in command parsing.
