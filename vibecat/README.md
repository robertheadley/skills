# VibeCat: Standalone ScriptCat Userscript Live-Sync & Hot-Reload Server

VibeCat is a standalone ScriptCat userscript live-sync and hot-reload server. Designed specifically for developers and autonomous AI agents, it implements ScriptCat's VS Code synchronization protocol (specifically its `hello` and `onchange` WebSocket messages) to establish an instant, direct hot-reload link between local workspace files and the browser userscript manager without requiring official editor extensions.

---

## 🎨 Core Features & Rationale ("The Why")

### 1. WebSocket Hot-Reload Synchronization
*   **What it is**: Instant push delivery of local workspace code to the browser on file save.
*   **Why it exists**: Traditional userscript development requires copying code from your editor, opening the browser dashboard, pasting it, and saving for every change. This automation removes all manual friction by linking your editor's file saves directly to the browser runtime.
*   **When to use**: During active development when you want to see code modifications reflect in the browser instantly without manual copy-paste cycles.

### 2. Multi-Script Directory Watching
*   **What it is**: The server detects if the target path is a directory and watches the entire folder recursively. Clients target specific files by specifying the filename in the WebSocket URL pathname (e.g. `ws://127.0.0.1:8642/my-script.user.js`).
*   **Why it exists**: Instead of starting multiple servers on different ports for each script you write, you can sync a whole suite of scripts through a single port. The server intelligently routes file updates to the corresponding page tabs, preventing cross-talk page reloads.

### 3. Automatic Port Negotiation & Autodiscovery
*   **What it is**: If the default port `8642` is in use, the server dynamically negotiates the next available port and writes its active state (port, host, and process ID) to `.runtime/active-port.json`.
*   **Why it exists**: Prevents process crashes caused by port address conflicts (`EADDRINUSE`) when multiple projects or local services are active.

### 4. Interactive Live-Command Console (REPL)
*   **What it is**: A two-way interactive command bridge. Any JavaScript statement typed into the sync server's terminal standard input (`stdin`) is broadcast to connected browser pages, executed in the page's global scope, and the returned evaluation result is logged back in the terminal.
*   **Why it exists**: Allows developers and autonomous agents to query page state, trigger button clicks, read storage, and modify variables dynamically directly from a terminal prompt without switching contexts to the browser window.

### 5. Stdout Color Logger & Context Filter
*   **What it is**: Capture and forward browser `console` streams (logs, warnings, errors, and uncaught exceptions) to a local structured JSON Lines log (`.runtime/userscript-console.jsonl`) and color-print them to stdout.
*   **Why it exists**: Developers and AI agents need runtime logs to debug failures. To prevent AI context window bloat during agentic loops, the server filters stdout logs to print **only** critical error events and direct userscript logs (which begin with a bracketed tag, like `[ScriptName]`). Full log details remain fully preserved on disk in the log file.

### 6. Production Build Export Utility ("Save Without Debug")
*   **What it is**: A CLI tool (`scripts/export-production.js`) that automatically strips developer-only blocks (marked between `// DEVONLY_START` and `// DEVONLY_END`), disables the hot-reload flag, and saves a clean userscript output to a `dist/` directory.
*   **Why it exists**: Ensures that when your script is ready for public release, all local server connection hooks, diagnostic console overrides, and test banners are cleanly removed, reducing bundle size and protecting credentials.

---

## 🛠️ Remote DevTools Bridge (Universal Browser Automation)

By deploying a userscript that applies globally to all websites (`// @match *://*/*` or `// @include *`) containing the VibeCat client, **VibeCat becomes a lightweight, persistent remote DevTools bridge**.

This allows developers and AI agents to:
*   Control, query, and scrape data from any active browser tab directly from a local terminal.
*   Execute cross-origin commands via userscript managers (leveraging browser session cookies and bypassing standard CORS restrictions).
*   Automate browser interactions in your **actual, headed browser profile** (maintaining active logins, passwords, extension state, and history) rather than a separate isolated test-runner window (like Puppeteer or Selenium).

---

## ⚠️ Security & Site Sensitivity Disclosure

> [!WARNING]
> Running a userscript with a wildcard match pattern (`*://*/*`) grants the script access to all sensitive websites you visit, including online banking, email portals, and cloud dashboards. 
> 
> *   **Local Loopback Protection**: VibeCat strictly binds its server to the local loopback address `127.0.0.1`. Under no circumstances should you expose the WebSocket server to the local area network (LAN) or public interfaces.
> *   **Cross-Site Hijacking Prevention**: Always enable the `SYNC_BEARER_TOKEN` gate in environments with other local running software to verify that only authorized local shells can send commands to your active browser tabs.
> *   **Production whitelists**: When deploying userscripts in production, strictly limit their execution scope by targeting specific whitelisted domains (e.g. `@match *://*.example.com/*`) rather than wildcard matching.

---

## 📦 File Layout

1.  **`sync-server.js`**: The Node.js server. Watches files/directories, manages WebSocket clients, negotiates ports, logs console stdout, and processes stdin REPL commands.
2.  **`sync-client-template.js`**: Copy-pasteable client code containing the WebSocket reconnect handler, slide-down status banner, console intercept hooks, and remote REPL `eval` listener.
3.  **`scripts/export-production.js`**: Compiles production-ready versions of userscripts by stripping debug blocks.
4.  **`package.json`**: NPM package configuration declaring dependencies (e.g. `ws`).
5.  **`docs/`**: Logging records (`EXECUTION_LOGS.md` and `docs/CHANGELOG.agent.md`) documenting development history.

---

## 🚀 Quick Start (Server Setup)

### 1. Install Dependencies
Navigate to this directory in your terminal and run:
```bash
npm install
```

### 2. Run the Sync Server
To run the server and watch a userscript file or workspace directory:
```bash
# Watch a single userscript
node sync-server.js path/to/your-script.user.js

# Watch an entire workspace directory containing multiple userscripts
node sync-server.js path/to/workspace-directory/

# Disable console forwarding diagnostics
node sync-server.js --no-console path/to/your-script.user.js
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
Copy the contents of [sync-client-template.js](sync-client-template.js) and paste it at the bottom of your userscript file. If the userscript is wrapped in an IIFE, paste it inside the closing IIFE brackets (`})();`) to ensure the sandboxed console overrides attach correctly.
*   Every time you save the script locally, the sync server will push the changes and the browser page will instantly refresh.
*   To export a clean version for production, run:
    ```bash
    node scripts/export-production.js path/to/your-script.user.js
    ```
