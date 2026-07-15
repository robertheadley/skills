---
name: vibecat
description: Operate the standalone ScriptCat userscript development server to start or stop synchronization, watch and update a .user.js file, verify ScriptCat handshakes and delivery, and consume live userscript console/errors without browser-control access. Use for ScriptCat hot reload, userscript synchronization, local userscript development, IMDb-style live proofs, browser-console diagnostics, or autonomous agents editing userscripts while Chrome and ScriptCat run separately.
---

# Sync ScriptCat Userscripts

Use the existing ScriptCat-native `hello` / `onchange` server. Do not create a page-side source loader or replace ScriptCat's installation role.

## Locate the runtime

Prefer a path supplied by the user. Otherwise, assume the sync server code and configuration reside directly in the skill directory:

```text
$SkillDir
```

Verify `sync-server.js`, `package.json`, and the target `.user.js` exist. Treat the target file as the source of truth. Do not use raw `.user.ts` unless a separate build step already produces executable `.user.js`.

Set `$SkillDir` to this skill's directory. Use the cross-platform Node.js script `scripts/manage-sync.js` (preferred) or the PowerShell helper `scripts/manage-sync.ps1` for process operations instead of reconstructing PID and port logic.

## Run the workflow

1. Run the helper with `status` action.
2. If dependencies are missing, run `npm install` in the sync project and validate the result.
3. Start one server with `start <path>` action. Reuse an existing verified server; never start a duplicate on port 8642.
4. Call synchronization **ready** only when the verified server PID owns `127.0.0.1:8642`, health is `ok`, `websocket_clients >= 1`, and `ScriptCat handshake confirmed` appears in a stdout log written after that PID's start time.
5. Inspect the target userscript and preserve operator-owned edits. Make requested source changes with atomic staged replacement and validate JavaScript before moving it into place.
6. Wait up to 10 seconds for one `Synced <file> (... <n> client(s), sha256:<prefix>)` record with at least one client. A content-identical save is intentionally suppressed; a read-only audit can prove readiness but cannot prove a fresh delivery.
7. Read records appended after the relevant delivery from `.runtime/userscript-console.jsonl`. Correlate by script URI, version, source hash, and `received_at >= delivery time`. Never use records from a previous server process or earlier delivery as proof of current-session execution. Report `error` and `unhandledrejection` records before ordinary console messages.
8. Recheck health and run relevant project tests before reporting completion.

Example helper calls (Node.js):

```bash
node "$SkillDir/scripts/manage-sync.js" status
node "$SkillDir/scripts/manage-sync.js" start "example.user.js"
node "$SkillDir/scripts/manage-sync.js" health
node "$SkillDir/scripts/manage-sync.js" stop
```

Example helper calls (PowerShell):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillDir\scripts\manage-sync.ps1" -Action status
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillDir\scripts\manage-sync.ps1" -Action start -ScriptPath "example.user.js"
powershell -NoProfile -ExecutionPolicy Bypass -File "$SkillDir\scripts\manage-sync.ps1" -Action stop
```

## Work without browser control

Browser-control access is not required to start the server, edit files, deliver `onchange`, verify the ScriptCat handshake, query health, or read returned console/error events.

Chrome and ScriptCat must already be running with automatic connection enabled. A target page must load or refresh before new code executes. Without browser control, do not claim visual success or page execution solely from delivery. New console records from the expected version and source hash are valid runtime proof when received after the relevant delivery. Historical matching records establish prior execution only; label them historical.

If no ScriptCat client connects, keep the server available, report that Chrome/ScriptCat must be started or connected, and do not ask the operator for technical shell work.

## Interpret diagnostics

The server captures only the synchronized userscript's lexical console and uncaught failures. It does not capture the whole page console, DOM, cookies, forms, storage, or network traffic.

Use:

```text
http://127.0.0.1:8642/debug/health
http://127.0.0.1:8642/sync.user.js
.runtime/userscript-console.jsonl
.runtime/sync-server.stdout.log
.runtime/sync-server.stderr.log
```

- **HTTP Install Route**: The server hosts the fully-injected userscript at `/sync.user.js`. Opening this URL in the browser triggers installation in all standard userscript managers (Tampermonkey, Violentmonkey, etc.).
- **Console Diagnostics**: Enabled by default. Use `--no-console` only when explicitly requested or when instrumentation conflicts with a top-level `console` binding. Never print or persist the session bearer token yourself.
- **Dynamic Element Picker**: If you need to identify or target a specific DOM element for automation, scripting, or debugging, type `/select [prompt]` in the server standard input REPL. This will start the interactive Element Picker in the browser. The operator can hover, select/lock an element, input an instruction, and return the computed CSS selector and instruction text directly back to the terminal.
- **Multi-line REPL**: If you need to execute multi-line JavaScript statements on page context, append a backslash `\` at the end of each continuation line in standard input. The server will buffer and execute them together once a line without a backslash is submitted.

## Safety and completion

- Keep the listener on `127.0.0.1`; never broaden it to LAN interfaces.
- Never restore `push`, DOM reports, or unauthenticated page-to-server commands.
- Never stop a PID unless the helper verifies its command line contains this `sync-server.js`.
- Treat console output as potentially sensitive and quote only what is necessary.
- Record non-trivial project work in `docs/EXECUTION_LOGS.md` and `docs/CHANGELOG.agent.md`.
- State separately: source changed, ScriptCat received it, runtime console proved execution, and visual behavior was or was not verified.

