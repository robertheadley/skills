/**
 * Standalone Userscript Hot-Reload & Sync Client
 * 
 * Drop this code block inside your userscript (or at the very end).
 * Make sure the following metadata is included in your userscript headers:
 * // @grant        GM_xmlhttpRequest
 * // @grant        GM_addStyle
 */
(function() {
    'use strict';

    const SYNC_SERVER_WS = 'ws://127.0.0.1:8642';
    const SYNC_BEARER_TOKEN = ''; // Set token value here if server has process.env.SYNC_BEARER_TOKEN set
    const SHOW_CONFIRMATION_BANNER = true;
    const AUTO_RELOAD_ON_CHANGE = true;
    const ENABLE_CONSOLE_LOGGING = true; // Forwards userscript console events back to server logs
    const SEND_DOM_REPORT = true; // Captures and sends page HTML structure to the server

    console.log(`[Sync Client] Connecting to sync server at ${SYNC_SERVER_WS}...`);
    
    // Connect to WebSocket with authentication token if set
    const wsUrl = SYNC_SERVER_WS + (SYNC_BEARER_TOKEN ? `?token=${encodeURIComponent(SYNC_BEARER_TOKEN)}` : '');
    const socket = new WebSocket(wsUrl);

    let scriptVersion = '0.1';
    let scriptHash = 'unknown';

    // Show visual confirmation banner when sync is successfully established
    function showSyncBanner(version) {
        if (!SHOW_CONFIRMATION_BANNER) return;
        // Inject slide-down stylesheet
        const style = document.createElement('style');
        style.textContent = `
            @keyframes sync-slide-down {
                0% { transform: translate(-50%, -100%); opacity: 0; }
                100% { transform: translate(-50%, 0); opacity: 1; }
            }
            @keyframes sync-slide-up {
                0% { transform: translate(-50%, 0); opacity: 1; }
                100% { transform: translate(-50%, -100%); opacity: 0; }
            }
        `;
        (document.head || document.documentElement).appendChild(style);

        const banner = document.createElement('div');
        banner.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(30, 41, 59, 0.95);
            backdrop-filter: blur(8px);
            border: 1px solid rgba(59, 130, 246, 0.5);
            color: #f8fafc;
            padding: 10px 24px;
            border-radius: 9999px;
            font-size: 13px;
            font-family: system-ui, -apple-system, sans-serif;
            font-weight: 500;
            z-index: 999999;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
            display: flex;
            align-items: center;
            gap: 10px;
            animation: sync-slide-down 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        `;

        banner.innerHTML = `
            <span style="color: #3b82f6; display: flex; align-items: center; animation: pulse 2s infinite;">●</span>
            <span>Sync Connected! <span style="color: #94a3b8; font-weight: normal;">Running hot-reload version ${version || 'development'}.</span></span>
        `;
        document.body.appendChild(banner);

        setTimeout(() => {
            banner.style.animation = 'sync-slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards';
            setTimeout(() => banner.remove(), 400);
        }, 3000);
    }

    let receivedInitialHandshake = false;

    socket.onopen = () => {
        console.log('[Sync Client] Socket connection established.');
    };

    socket.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            
            if (message.action === 'hello') {
                console.log('[Sync Client] Handshake received.');
                scriptVersion = message.version || scriptVersion;
                scriptHash = message.hash || scriptHash;
                return;
            }

            if (message.action === 'onchange' || message.action === 'push') {
                const newVersion = message.data.version || scriptVersion;
                const newHash = message.data.hash || scriptHash;

                if (newHash && scriptHash !== 'unknown' && scriptHash === newHash) {
                    // Hash matches the current running code. Ignore this push to avoid a reboot loop.
                    return;
                }

                scriptVersion = newVersion;
                scriptHash = newHash;

                if (!receivedInitialHandshake) {
                    receivedInitialHandshake = true;
                    console.log('[Sync Client] Initial sync verified.');
                    showSyncBanner(scriptVersion);

                    // Send DOM report if requested
                    if (SEND_DOM_REPORT) {
                        sendDomReport();
                    }
                    return;
                }

                if (AUTO_RELOAD_ON_CHANGE) {
                    console.log('[Sync Client] Code changed detected! Reloading page...');
                    setTimeout(() => window.location.reload(), 200);
                }
            }
        } catch (e) {
            console.error('[Sync Client] Error handling sync message:', e);
        }
    };

    socket.onerror = (err) => {
        console.error('[Sync Client] Sync socket encountered an error:', err);
    };

    socket.onclose = () => {
        console.warn('[Sync Client] Sync socket connection closed.');
    };

    // DOM Reporting Diagnostics
    function sendDomReport() {
        setTimeout(() => {
            if (socket.readyState !== WebSocket.OPEN) return;
            try {
                const mainTable = document.querySelector('table') || document.querySelector('div');
                const tableHtml = mainTable ? mainTable.outerHTML : 'No table found';

                socket.send(JSON.stringify({
                    action: 'dom_report',
                    data: {
                        url: window.location.href,
                        html: document.body.innerHTML,
                        tableHtml: tableHtml
                    }
                }));
                console.log('[Sync Client] Sent DOM snapshot report to sync server.');
            } catch (e) {
                console.error('[Sync Client] Failed to package and send DOM report:', e);
            }
        }, 1500); // 1.5s delay to let client rendering settle
    }

    // Console Logging Diagnostics Hooking
    if (ENABLE_CONSOLE_LOGGING) {
        const originalConsole = {
            log: console.log,
            info: console.info,
            warn: console.warn,
            error: console.error
        };

        const sendConsoleEvent = (level, args) => {
            if (socket.readyState !== WebSocket.OPEN) return;
            try {
                const message = Array.from(args).map(arg => {
                    if (typeof arg === 'object') {
                        try { return JSON.stringify(arg); } catch (e) { return String(arg); }
                    }
                    return String(arg);
                }).join(' ');

                socket.send(JSON.stringify({
                    action: 'console',
                    data: {
                        uri: window.location.href,
                        version: scriptVersion,
                        hash: scriptHash,
                        level: level,
                        message: message
                    }
                }));
            } catch (e) {}
        };

        console.log = function() {
            originalConsole.log.apply(console, arguments);
            sendConsoleEvent('log', arguments);
        };
        console.info = function() {
            originalConsole.info.apply(console, arguments);
            sendConsoleEvent('info', arguments);
        };
        console.warn = function() {
            originalConsole.warn.apply(console, arguments);
            sendConsoleEvent('warn', arguments);
        };
        console.error = function() {
            originalConsole.error.apply(console, arguments);
            sendConsoleEvent('error', arguments);
        };

        window.addEventListener('error', (event) => {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    action: 'console',
                    data: {
                        uri: window.location.href,
                        version: scriptVersion,
                        hash: scriptHash,
                        level: 'error',
                        message: `Uncaught Error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`
                    }
                }));
            }
        });

        window.addEventListener('unhandledrejection', (event) => {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    action: 'console',
                    data: {
                        uri: window.location.href,
                        version: scriptVersion,
                        hash: scriptHash,
                        level: 'unhandledrejection',
                        message: `Unhandled Rejection: ${event.reason}`
                    }
                }));
            }
        });
    }
})();
