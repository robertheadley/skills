/**
 * Standalone Userscript Hot-Reload & Sync Client
 * 
 * Drop this code block inside your userscript (or at the very end).
 * This client is fully dependency-free and does not require any @grant headers.
 */
(function() {
    'use strict';

    const SYNC_SERVER_WS = 'ws://127.0.0.1:8642';
    const SYNC_BEARER_TOKEN = ''; // Set token value here if server has process.env.SYNC_BEARER_TOKEN set
    const SYNC_FILENAME = 'unknown'; // Injected by server for multi-script routing
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
        
        const justUpdated = sessionStorage.getItem('__vibecat_just_updated') === 'true';
        sessionStorage.removeItem('__vibecat_just_updated');

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
        
        const borderColor = justUpdated ? 'rgba(16, 185, 129, 0.6)' : 'rgba(59, 130, 246, 0.5)';
        const dotColor = justUpdated ? '#10b981' : '#3b82f6';
        const msgText = justUpdated 
            ? `Sync Updated! <span style="color: #94a3b8; font-weight: normal;">Hot-reloaded to version ${version || 'development'}.</span>`
            : `Sync Connected! <span style="color: #94a3b8; font-weight: normal;">Running version ${version || 'development'}.</span>`;

        banner.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(30, 41, 59, 0.95);
            backdrop-filter: blur(8px);
            border: 1px solid ${borderColor};
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
            <span style="color: ${dotColor}; display: flex; align-items: center; animation: pulse 2s infinite;">●</span>
            <span>${msgText}</span>
        `;
        document.body.appendChild(banner);

        setTimeout(() => {
            banner.style.animation = 'sync-slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards';
            setTimeout(() => banner.remove(), 400);
        }, 3000);
    }

    let receivedInitialHandshake = false;

    let pickerInstance = null;

    class VibeCatElementPicker {
        constructor(promptText) {
            this.promptText = promptText || 'Select an element on the page';
            this.activeElement = null;
            this.hoveredElement = null;
            this.isLocked = false;
            
            this.overlay = null;
            this.banner = null;
            this.styleEl = null;
            
            this.handleMouseOver = this.handleMouseOver.bind(this);
            this.handleClick = this.handleClick.bind(this);
            this.handleKeyDown = this.handleKeyDown.bind(this);
        }
        
        start() {
            if (pickerInstance) pickerInstance.destroy();
            pickerInstance = this;
            
            this.injectStyles();
            this.createUI();
            
            document.addEventListener('mouseover', this.handleMouseOver, true);
            document.addEventListener('click', this.handleClick, true);
            document.addEventListener('keydown', this.handleKeyDown, true);
        }
        
        destroy() {
            document.removeEventListener('mouseover', this.handleMouseOver, true);
            document.removeEventListener('click', this.handleClick, true);
            document.removeEventListener('keydown', this.handleKeyDown, true);
            
            if (this.overlay) this.overlay.remove();
            if (this.banner) this.banner.remove();
            if (this.styleEl) this.styleEl.remove();
            
            if (pickerInstance === this) pickerInstance = null;
        }
        
        injectStyles() {
            this.styleEl = document.createElement('style');
            this.styleEl.id = '__vibecat_picker_styles';
            this.styleEl.textContent = `
                .__vibecat_overlay {
                    position: fixed;
                    pointer-events: none;
                    z-index: 9999998;
                    background: rgba(59, 130, 246, 0.15);
                    border: 2px dashed #3b82f6;
                    border-radius: 4px;
                    transition: all 0.08s ease-out;
                    box-sizing: border-box;
                }
                .__vibecat_overlay.locked {
                    background: rgba(16, 185, 129, 0.15);
                    border: 2px solid #10b981;
                }
                .__vibecat_tooltip {
                    position: absolute;
                    bottom: calc(100% + 6px);
                    left: 0;
                    background: #1e293b;
                    color: #3b82f6;
                    border: 1px solid rgba(59, 130, 246, 0.3);
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                    white-space: nowrap;
                    box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
                    pointer-events: none;
                }
                .__vibecat_overlay.locked .__vibecat_tooltip {
                    color: #10b981;
                    border-color: rgba(16, 185, 129, 0.3);
                }
                .__vibecat_banner {
                    position: fixed;
                    top: 20px;
                    left: 50%;
                    transform: translateX(-50%);
                    z-index: 9999999;
                    background: rgba(15, 23, 42, 0.85);
                    backdrop-filter: blur(12px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    color: #f8fafc;
                    padding: 12px 20px;
                    border-radius: 12px;
                    font-family: system-ui, -apple-system, sans-serif;
                    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.5);
                    display: flex;
                    align-items: center;
                    gap: 16px;
                    font-size: 13px;
                    width: max-content;
                    max-width: 90vw;
                    box-sizing: border-box;
                    animation: vibecat-slide-down 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
                }
                @keyframes vibecat-slide-down {
                    0% { transform: translate(-50%, -120%); opacity: 0; }
                    100% { transform: translate(-50%, 0); opacity: 1; }
                }
                .__vibecat_banner_input {
                    background: rgba(255, 255, 255, 0.08);
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    border-radius: 6px;
                    color: #fff;
                    padding: 6px 12px;
                    font-size: 13px;
                    width: 250px;
                    outline: none;
                    transition: border-color 0.2s, background 0.2s;
                }
                .__vibecat_banner_input:focus {
                    border-color: #3b82f6;
                    background: rgba(255, 255, 255, 0.12);
                }
                .__vibecat_banner_input:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                .__vibecat_banner_btn {
                    background: #3b82f6;
                    color: #fff;
                    border: none;
                    border-radius: 6px;
                    padding: 6px 14px;
                    font-size: 13px;
                    font-weight: 500;
                    cursor: pointer;
                    transition: background 0.2s;
                }
                .__vibecat_banner_btn:hover {
                    background: #2563eb;
                }
                .__vibecat_banner_btn:disabled {
                    background: rgba(255, 255, 255, 0.1);
                    color: rgba(255, 255, 255, 0.3);
                    cursor: not-allowed;
                }
                .__vibecat_banner_close {
                    background: none;
                    border: none;
                    color: #94a3b8;
                    cursor: pointer;
                    font-size: 16px;
                    padding: 0 4px;
                }
                .__vibecat_banner_close:hover {
                    color: #f8fafc;
                }
            `;
            (document.head || document.documentElement).appendChild(this.styleEl);
        }
        
        createUI() {
            this.overlay = document.createElement('div');
            this.overlay.className = '__vibecat_overlay';
            this.overlay.style.display = 'none';
            
            this.tooltip = document.createElement('div');
            this.tooltip.className = '__vibecat_tooltip';
            this.overlay.appendChild(this.tooltip);
            document.body.appendChild(this.overlay);
            
            this.banner = document.createElement('div');
            this.banner.className = '__vibecat_banner';
            this.banner.innerHTML = `
                <span style="color: #3b82f6; display: flex; align-items: center; transition: color 0.3s;">●</span>
                <span style="font-weight: 500;">${this.promptText}</span>
                <input type="text" class="__vibecat_banner_input" placeholder="Type instructions for the agent..." disabled />
                <button class="__vibecat_banner_btn" disabled>Send to Agent</button>
                <button class="__vibecat_banner_close" title="Cancel (Esc)">×</button>
            `;
            
            this.inputEl = this.banner.querySelector('.__vibecat_banner_input');
            this.btnEl = this.banner.querySelector('.__vibecat_banner_btn');
            this.closeEl = this.banner.querySelector('.__vibecat_banner_close');
            
            this.btnEl.onclick = () => this.submit();
            this.closeEl.onclick = () => this.cancel();
            
            this.inputEl.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.submit();
                } else if (e.key === 'Escape') {
                    this.cancel();
                }
            };
            
            document.body.appendChild(this.banner);
        }
        
        handleMouseOver(e) {
            if (this.isLocked) return;
            
            const target = e.target;
            if (target === this.overlay || target === this.banner || this.banner.contains(target)) {
                return;
            }
            
            this.hoveredElement = target;
            this.updateOverlay(target);
        }
        
        updateOverlay(el) {
            const rect = el.getBoundingClientRect();
            const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            
            this.overlay.style.width = `${rect.width}px`;
            this.overlay.style.height = `${rect.height}px`;
            this.overlay.style.left = `${rect.left + scrollLeft}px`;
            this.overlay.style.top = `${rect.top + scrollTop}px`;
            this.overlay.style.display = 'block';
            
            const selector = this.getSelector(el);
            this.tooltip.textContent = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} | ${selector}`;
        }
        
        handleClick(e) {
            const target = e.target;
            if (target === this.banner || this.banner.contains(target)) {
                return;
            }
            
            e.preventDefault();
            e.stopPropagation();
            
            if (target === this.overlay) {
                if (this.hoveredElement) {
                    this.lockElement(this.hoveredElement);
                }
                return;
            }
            
            this.lockElement(target);
        }
        
        lockElement(el) {
            this.activeElement = el;
            this.isLocked = true;
            this.overlay.className = '__vibecat_overlay locked';
            this.updateOverlay(el);
            
            this.inputEl.removeAttribute('disabled');
            this.btnEl.removeAttribute('disabled');
            this.inputEl.focus();
            
            const dot = this.banner.querySelector('span');
            if (dot) dot.style.color = '#10b981';
        }
        
        handleKeyDown(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this.cancel();
            }
        }
        
        getSelector(el) {
            if (!(el instanceof Element)) return '';
            const path = [];
            let current = el;
            while (current && current.nodeType === Node.ELEMENT_NODE) {
                let selector = current.nodeName.toLowerCase();
                if (current.id) {
                    try {
                        if (document.querySelectorAll('#' + CSS.escape(current.id)).length === 1) {
                            selector = '#' + CSS.escape(current.id);
                            path.unshift(selector);
                            break;
                        }
                    } catch(e) {}
                }
                
                let className = '';
                if (current.classList && current.classList.length > 0) {
                    const classes = Array.from(current.classList)
                        .filter(c => !c.startsWith('__vibecat'))
                        .map(c => '.' + CSS.escape(c))
                        .join('');
                    if (classes) {
                        selector += classes;
                    }
                }
                
                let sib = current;
                let nth = 1;
                while (sib = sib.previousElementSibling) {
                    if (sib.nodeName.toLowerCase() === current.nodeName.toLowerCase()) {
                        nth++;
                    }
                }
                
                let parent = current.parentElement;
                if (parent) {
                    const siblings = Array.from(parent.children).filter(child => child.nodeName === current.nodeName);
                    if (siblings.length > 1) {
                        selector += `:nth-of-type(${nth})`;
                    }
                }
                
                path.unshift(selector);
                current = current.parentElement;
            }
            return path.join(' > ');
        }
        
        submit() {
            if (!this.activeElement) return;
            
            const selector = this.getSelector(this.activeElement);
            const userMsg = this.inputEl.value.trim();
            const tagName = this.activeElement.tagName;
            const textContent = this.activeElement.textContent ? this.activeElement.textContent.trim().substring(0, 100) : '';
            
            socket.send(JSON.stringify({
                action: 'element_selected',
                data: {
                    status: 'success',
                    selector: selector,
                    message: userMsg,
                    tagName: tagName,
                    textContent: textContent
                }
            }));
            
            this.destroy();
        }
        
        cancel() {
            socket.send(JSON.stringify({
                action: 'element_selected',
                data: {
                    status: 'cancelled',
                    message: 'Selection cancelled by user'
                }
            }));
            
            this.destroy();
        }
    }

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

            if (message.action === 'select_element') {
                const promptText = message.data ? message.data.prompt : null;
                const picker = new VibeCatElementPicker(promptText);
                picker.start();
                return;
            }

            if (message.action === 'eval') {
                try {
                    const result = window.eval(message.data.code);
                    socket.send(JSON.stringify({
                        action: 'eval_result',
                        data: {
                            result: String(result),
                            status: 'success'
                        }
                    }));
                } catch (e) {
                    socket.send(JSON.stringify({
                        action: 'eval_result',
                        data: {
                            result: e.message + '\n' + e.stack,
                            status: 'error'
                        }
                    }));
                }
                return;
            }

            if (message.action === 'onchange' || message.action === 'push') {
                if (SYNC_FILENAME !== 'unknown' && message.data.filename && message.data.filename !== SYNC_FILENAME) {
                    // Ignore other userscripts' reload events in multi-script workspace
                    return;
                }

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
                    sessionStorage.setItem('__vibecat_just_updated', 'true');
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
