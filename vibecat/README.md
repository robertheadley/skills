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
    *   **Multi-line Statements**: If a line ends with a backslash `\`, VibeCat buffers the input and displays a continuation prompt `... ` so you can write function blocks, loops, or complex statements before evaluation.
*   **Why it exists**: Allows developers and autonomous agents to query page state, trigger button clicks, read storage, and modify variables dynamically directly from a terminal prompt without switching contexts to the browser window.

### 5. Stdout Color Logger & Context Filter
*   **What it is**: Capture and forward browser `console` streams (logs, warnings, errors, and uncaught exceptions) to a local structured JSON Lines log (`.runtime/userscript-console.jsonl`) and color-print them to stdout.
*   **Why it exists**: Developers and AI agents need runtime logs to debug failures. To prevent AI context window bloat during agentic loops, the server filters stdout logs to print **only** critical error events and direct userscript logs (which begin with a bracketed tag, like `[ScriptName]`). Full log details remain fully preserved on disk in the log file.

### 6. Production Build Export Utility ("Save Without Debug")
*   **What it is**: A CLI tool (`scripts/export-production.js`) that automatically strips developer-only blocks (marked between `// DEVONLY_START` and `// DEVONLY_END`), disables the hot-reload flag, and saves a clean userscript output to a `dist/` directory.
*   **Why it exists**: Ensures that when your script is ready for public release, all local server connection hooks, diagnostic console overrides, and test banners are cleanly removed, reducing bundle size and protecting credentials.

### 7. Interactive Element Picker & Instruction Loop
*   **What it is**: Start the element picker by entering `/select [optional prompt]` in the server's standard input REPL. Connected browsers display a glassmorphism floating banner and draw a dynamic bounding box outline around hovered elements. Clicking an element locks it and opens a text input field for instructions (e.g., "Change this text to red"). Pressing Enter sends the element's CSS selector, tag name, text content snippet, and instructions directly back to the local terminal.
*   **Why it exists**: Streamlines human-in-the-loop automation. Instead of guessing classes or IDs, the agent can prompt the operator to pick a target element and describe what needs to be changed, automatically piping the selector and task instructions back to the agent's context.

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

VibeCat is fully dependency-free and does not require any special `@grant` headers to run.

### Option A: ScriptCat (Automatic Synchronization)
1. Open the ScriptCat dashboard, navigate to settings, and verify **Developer Mode Connection** is active (defaulting to port `8642`).
2. Run the sync server. ScriptCat will automatically discover VibeCat, receive the compiled userscript payload (with the client pre-injected), and install/update it in the browser dashboard.

### Option B: Tampermonkey / Violentmonkey (Universal Setup)
1. Run the sync server watching your local userscript.
2. In your web browser, navigate to the local install endpoint:
   `http://127.0.0.1:8642/sync.user.js`
3. Your userscript manager will automatically intercept the javascript request, display the script installation/update confirmation page, and begin tracking code saves.

### Manual Injection (Optional)
If you prefer not to use automatic injection, you can copy the contents of [sync-client-template.js](sync-client-template.js) and paste them directly at the bottom of your userscript file. If the userscript is wrapped in an IIFE, paste it inside the closing brackets (`})();`) so console overrides bind correctly.
* To export a clean, production-ready script with all VibeCat debugger code automatically stripped out, run:
  ```bash
  node scripts/export-production.js path/to/your-script.user.js
  ```

---

## 📊 Performance Benchmarks

VibeCat is designed to be highly lightweight and fast, running with zero noticeable footprint on development machines. The benchmark suite validates three distinct layers of the pipeline: offline compilation, live WebSocket round-trip to ScriptCat, and process resource footprint.

All measurements below are from a real-world 1,381-line userscript (~58 KB) on Windows/Node.js. Compilation stats are averaged over 1,000 iterations; WebSocket stats over 50 iterations.

### 1. Compilation Pipeline

The server-side compilation step parses the userscript's `==UserScript==` metadata header, computes a SHA-256 content hash, and injects the sync client template into the IIFE boundary — all without touching disk beyond the initial read.

| Metric | Mean | P50 | P95 | P99 |
| :--- | ---: | ---: | ---: | ---: |
| **Metadata Parse + Client Injection** | **0.33 ms** | 0.30 ms | 0.46 ms | 0.55 ms |

| Metric | Value |
| :--- | ---: |
| Raw Source Size | 57.63 KB |
| Compiled Payload Size | 67.86 KB |
| Injection Overhead | +10.23 KB |

> [!NOTE]
> The 10 KB injection overhead is the sync client template (WebSocket reconnect handler, console intercept hooks, REPL eval listener, and status banner). It is stripped automatically by the production export tool (`scripts/export-production.js`).

### 2. WebSocket Round-Trip (ScriptCat Connection)

These metrics measure the full live path between VibeCat and a ScriptCat browser client: TCP socket establishment, the ScriptCat `hello` handshake, initial code delivery via `onchange`/`push`, and steady-state keepalive.

| Metric | Mean | P95 |
| :--- | ---: | ---: |
| **TCP Connect** | 1.46 ms | 1.91 ms |
| **Hello Handshake** | 1.30 ms | 2.02 ms |
| **Initial Code Delivery** | 3.63 ms | 4.88 ms |
| **Ping/Pong RTT** | 0.92 ms | 1.58 ms |
| **File Save → Delivery** | 110.05 ms | 115.07 ms |

> [!TIP]
> The **File Save → Delivery** latency includes a deliberate **100 ms debounce** in the `fs.watch` handler to coalesce rapid successive saves (e.g., editor auto-save). The actual network propagation overhead above the debounce is ~10 ms.

**What this means in practice**: From the moment you press Ctrl+S in your editor to the moment ScriptCat receives the compiled payload and triggers a page reload, the total wall-clock time is ~110 ms — faster than a single frame at 60 fps after the debounce window.

### 3. Process Resource Footprint

| Metric | Value |
| :--- | ---: |
| RSS (Resident Set Size) | 50.09 MB |
| Heap Used | 8.19 MB |
| Heap Total | 9.79 MB |
| External (Buffers) | 2.97 MB |
| CPU Idle Overhead | 0% |

The server is event-driven and fully idle between file-change events. It consumes zero CPU cycles when no files are being edited and no WebSocket messages are in flight.

### Running the Benchmark

```bash
node scripts/benchmark.js
```

Results are printed to stdout and saved as machine-parsable JSON to `.runtime/benchmark-results.json`.
