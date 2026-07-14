# VibeCat: Standalone ScriptCat Userscript Live-Sync & Hot-Reload Server

VibeCat is a standalone ScriptCat userscript live-sync and hot-reload server. Designed specifically for developers and autonomous AI agents, it implements ScriptCat's VS Code synchronization protocol (specifically its `hello` and `onchange` WebSocket messages) to establish an instant, direct hot-reload link between local workspace files and the browser userscript manager without requiring official editor extensions.

---

## 🎨 Core Features & Rationale ("The Why")

### 1. WebSocket Hot-Reload Synchronization
*   **What it is**: Instant push delivery of local workspace code to the browser on file save.
*   **Why it exists**: Traditional userscript development requires copying code from your editor, opening the browser dashboard, pasting it, and saving for every change. This automation removes all manual friction by linking your editor's file saves directly to the browser runtime.
*   **When to use**: During active development when you want to see code modifications reflect in the browser instantly without manual copy-paste cycles.

### 2. Strict Loopback Binding & Origin Whitelisting
*   **What it is**: The server binds exclusively to `127.0.0.1` and filters incoming connections based on a domain whitelist (`localhost`, `news.ycombinator.com`, `iptorrents.com`, browser extensions, etc.).
*   **Why it exists**: WebSocket servers bypass the browser's Same-Origin Policy (SOP), meaning any malicious website you visit could connect to a local port (like `localhost:8642`) and extract code or trigger tasks (Cross-Site WebSocket Hijacking). Restricting binding and validating origins secures your development machine against external web-based attacks.
*   **When to use**: Always active by default to enforce a baseline secure coding sandbox.

### 3. Secure Cryptographic Token Gate (`SYNC_BEARER_TOKEN`)
*   **What it is**: Strict handshake validation requiring a match against the environment variable `SYNC_BEARER_TOKEN`.
*   **Why it exists**: Prevents unauthenticated scripts from making connection attempts. By supplying a private bearer token to the WebSocket handshake, you guarantee that only your specific, trusted userscript instance can stream logs or interact with the server.
*   **When to use**: Mandatory during automated or remote agent-driven tasks where multiple scripts or services reside on the host.

### 4. Headless Console & Error Logging Relay
*   **What it is**: Capture and forward browser `console` streams (logs, warnings, errors, and uncaught window exceptions) to a local structured JSON Lines log (`.runtime/userscript-console.jsonl`).
*   **Why it exists**: Debugging userscripts usually requires keeping browser DevTools open. For autonomous AI agents or command-line scripts operating headlessly, browser UI access is unavailable. Relaying logs directly to local file logs lets agents trace failures, debug logic, and verify runtime execution programmatically without needing browser-control access.
*   **When to use**: Essential for remote testing, head-free agent execution, and parsing errors programmatically during iterations.

### 5. Secure DOM Snapshot Reporting
*   **What it is**: Automated capturing of active webpage DOM tables and layouts, saved to `<script>_dom_report.json` on the host.
*   **Why it exists**: To write correct page scrapers or enhancements, developers and AI agents must know the structure of the target page. Pushing the DOM securely back to the host lets agents analyze elements, identify class names, and build precise selectors offline without browser-driving tools.
*   **When to use**: When targeting new layout sections or debugging selector mismatches on pages that require user login or manual state setup.

---

## 📦 File Layout

1.  **`sync-server.js`**: The Node.js server. Binds to `127.0.0.1:8642`, serves the `/debug/health` check API, acts as a WebSocket hub, manages token/origin validation, and writes logs/reports.
2.  **`sync-client-template.js`**: Copy-pasteable client code containing the WebSocket reconnect handler, slide-down status banner, console intercept hooks, and DOM capture functions.
3.  **`package.json`**: NPM package configuration declaring dependencies (e.g. `ws`).
4.  **`docs/`**: Logging records (`EXECUTION_LOGS.md` and `CHANGELOG.agent.md`) documenting development history.

---

## 🚀 Quick Start (Server Setup)

### 1. Install Dependencies
Navigate to this directory in your terminal and run:
```bash
npm install
```

### 2. Run the Sync Server
To run the server and automatically watch a userscript file:
```bash
# Explicit path targeting
node sync-server.js path/to/your-script.user.js

# Disable console forwarding diagnostics
node sync-server.js --no-console path/to/your-script.user.js

# Auto-detects userscripts if running directly inside the target directory
node sync-server.js
```

The server will watch the file and boot the gateway at `ws://127.0.0.1:8642` and health endpoint at `http://127.0.0.1:8642/debug/health`.

---

## 🔍 Diagnostics & Health Checks

### 1. HTTP Health Endpoint
Check server status by querying:
`GET http://127.0.0.1:8642/debug/health`

Response format:
```json
{
  "status": "ok",
  "watched_file": "/absolute/path/to/mock-script.user.js",
  "websocket_clients": 1,
  "console_diagnostics": {
    "enabled": true,
    "buffered_events": 0,
    "dropped_events": 0,
    "last_event_at": null
  }
}
```

### 2. Console Logging Diagnostics
The server appends all lexical console events from the browser client to `.runtime/userscript-console.jsonl`.

Format of each logged record:
```json
{
  "uri": "https://news.ycombinator.com/",
  "version": "1.0",
  "hash": "7ab2c08...",
  "level": "log",
  "message": "HN Enhancer: Initialized!",
  "received_at": "2026-07-14T19:12:00.000Z"
}
```

---

## 🔌 Browser Client Integration

### 1. Header Metadata Requirement
Verify the following headers are present in your script's metadata block:
```javascript
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
```

### 2. Insert Client Module
Copy the contents of [sync-client-template.js](sync-client-template.js) and paste it at the very bottom of your userscript file. 

*   The script will automatically establish connection on load.
*   Every time you save the script locally, the sync server will push the changes and the browser page will instantly refresh after a `200ms` buffer.
