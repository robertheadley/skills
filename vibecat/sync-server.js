const fs = require('fs');
const path = require('path');
const url = require('url');
const http = require('http');
const crypto = require('crypto');

let WebSocket;
try {
    WebSocket = require('ws');
} catch (e) {
    console.error('\x1b[31mError: The "ws" (websockets) package is not installed.\x1b[0m');
    console.log('To install it, run:');
    console.log('  npm install ws');
    process.exit(1);
}

let PORT = 8642;
const HOST = '127.0.0.1'; // Strictly local loopback

// Parse CLI Arguments
const args = process.argv.slice(2);
const noConsole = args.includes('--no-console');
const noInject = args.includes('--no-inject');
let fileToWatch = args.find(arg => !arg.startsWith('-'));

if (!fileToWatch) {
    // Auto-detect a .user.js file in the current directory
    const files = fs.readdirSync(process.cwd())
        .filter(f => f.endsWith('.user.js'));
    
    if (files.length === 1) {
        fileToWatch = path.join(process.cwd(), files[0]);
    } else if (files.length > 1) {
        console.error(`\x1b[33mMultiple userscripts found in current directory:\x1b[0m`);
        files.forEach(f => console.log(`  - ${f}`));
        console.error(`Please specify which one to watch:`);
        console.error(`  node sync-server.js <filename.user.js>`);
        process.exit(1);
    } else {
        console.error(`\x1b[31mError: No userscript specified and none found in the current directory.\x1b[0m`);
        console.log('Usage:');
        console.log('  node sync-server.js [--no-console] [--no-inject] <path-to-script.user.js>');
        process.exit(1);
    }
} else {
    fileToWatch = path.resolve(process.cwd(), fileToWatch);
}

if (!fs.existsSync(fileToWatch)) {
    console.error(`\x1b[31mError: File or directory not found: ${fileToWatch}\x1b[0m`);
    process.exit(1);
}

const isDirectoryMode = fs.statSync(fileToWatch).isDirectory();
const projectDir = __dirname;
const runtimeDir = path.join(projectDir, '.runtime');
const consoleLogPath = path.join(runtimeDir, 'userscript-console.jsonl');

// Environment token
const bearerToken = process.env.SYNC_BEARER_TOKEN;

function getScriptInfo(code) {
    const meta = code.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
    if (!meta) return null;

    const info = { name: '', namespace: '', uuid: '', version: '', matches: [], includes: [] };
    const lines = meta[1].split('\n');
    for (let line of lines) {
        line = line.trim();
        if (line.startsWith('// @name ')) {
            info.name = line.replace('// @name ', '').trim();
        } else if (line.startsWith('// @namespace ')) {
            info.namespace = line.replace('// @namespace ', '').trim();
        } else if (line.startsWith('// @uuid ')) {
            info.uuid = line.replace('// @uuid ', '').trim();
        } else if (line.startsWith('// @version ')) {
            info.version = line.replace('// @version ', '').trim();
        } else if (line.startsWith('// @match ')) {
            info.matches.push(line.replace('// @match ', '').trim());
        } else if (line.startsWith('// @include ')) {
            info.includes.push(line.replace('// @include ', '').trim());
        }
    }
    return info;
}

function matchPatternToRegex(pattern) {
    try {
        const parts = pattern.split('://');
        if (parts.length < 2) return null;
        const scheme = parts[0];
        const hostAndPath = parts[1];
        const firstSlash = hostAndPath.indexOf('/');
        const host = firstSlash === -1 ? hostAndPath : hostAndPath.substring(0, firstSlash);
        
        let schemeRegex = scheme === '*' ? 'https?' : scheme;
        let hostRegex = host.replace(/\./g, '\\.').replace(/\*/g, '[^/]*');
        return new RegExp(`^${schemeRegex}://${hostRegex}$`, 'i');
    } catch (e) {
        return null;
    }
}

function getSha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function getFinalCodeForFile(rawCode, filePath) {
    const code = rawCode;
    const info = getScriptInfo(code) || {};
    
    let finalCode = code;
    const clientTemplatePath = path.join(projectDir, 'sync-client-template.js');

    if (!noInject && fs.existsSync(clientTemplatePath)) {
        const alreadyInjected = code.includes('[Sync Client]');
        if (!alreadyInjected) {
            let clientCode = fs.readFileSync(clientTemplatePath, 'utf-8');
            clientCode = clientCode.replace(
                /const SYNC_SERVER_WS = 'ws:\/\/127\.0\.0\.1:8642';/,
                `const SYNC_SERVER_WS = 'ws://${HOST}:${activePort}';`
            );
            if (bearerToken) {
                clientCode = clientCode.replace(
                    /const SYNC_BEARER_TOKEN = '';/,
                    `const SYNC_BEARER_TOKEN = '${bearerToken}';`
                );
            }
            const filename = path.basename(filePath);
            clientCode = clientCode.replace(
                /const SYNC_FILENAME = 'unknown';/,
                `const SYNC_FILENAME = '${filename}';`
            );
            const sha256 = getSha256(code);
            clientCode = clientCode.replace(
                /let scriptHash = 'unknown';/,
                `let scriptHash = '${sha256}';`
            );
            // Try to inject inside the main IIFE if one exists at the end of the userscript code
            const iifeMatch = code.trim().match(/(\}\)\s*\(\s*\)\s*;?\s*)$/);
            if (iifeMatch) {
                const trimmedCode = code.trim();
                const index = trimmedCode.lastIndexOf(iifeMatch[1]);
                finalCode = trimmedCode.substring(0, index) + '\n\n// --- VibeCat Auto-Injected Sync Client ---\n' + clientCode + '\n' + iifeMatch[1] + '\n';
            } else {
                finalCode = code + '\n\n// --- VibeCat Auto-Injected Sync Client ---\n' + clientCode;
            }
        }
    }
    return { code: finalCode, info };
}

const clients = new Set();

// Create HTTP Server to serve health status and share port with WebSocket
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url);
    if (parsedUrl.pathname === '/debug/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            watched_file: fileToWatch,
            isDirectoryMode: isDirectoryMode,
            websocket_clients: clients.size,
            console_diagnostics: {
                enabled: !noConsole,
                buffered_events: 0,
                dropped_events: 0,
                last_event_at: null
            }
        }));
    } else {
        res.writeHead(404);
        res.end();
    }
});

// Create WebSocket Server sharing the HTTP port
const wss = new WebSocket.WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    // 1. Authenticate connection
    const parsedUrl = url.parse(req.url, true);
    const clientToken = parsedUrl.query.token || parsedUrl.query.key || req.headers['sec-websocket-protocol'];
    const origin = req.headers.origin;

    if (bearerToken) {
        // Enforce strict token matching if bearertoken is set in process environment
        if (clientToken !== bearerToken) {
            console.warn('⚠️ Rejected connection due to missing or invalid bearer token');
            ws.close(4003, 'Unauthorized');
            return;
        }
    } else if (origin) {
        // Fallback to origin validation to protect development environments
        const originUrl = url.parse(origin);
        const allowedHosts = ['news.ycombinator.com', 'iptorrents.com', 'iptorrents.ru', 'localhost', '127.0.0.1'];
        const host = originUrl.hostname;
        const isAllowed = allowedHosts.some(h => host === h || host.endsWith('.' + h)) || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
        if (!isAllowed) {
            console.warn(`⚠️ Rejected connection from unauthorized origin: ${origin}`);
            ws.close(4001, 'Forbidden Origin');
            return;
        }
    }

    const clientPathname = parsedUrl.pathname.replace(/^\//, '');
    let clientFilename = null;
    if (clientPathname.endsWith('.user.js')) {
        clientFilename = clientPathname;
    }
    ws.requestedFilename = clientFilename;

    if (bearerToken) {
        // Enforce strict token matching if bearertoken is set in process environment
        if (clientToken !== bearerToken) {
            console.warn('⚠️ Rejected connection due to missing or invalid bearer token');
            ws.close(4003, 'Unauthorized');
            return;
        }
    } else if (origin) {
        // Fallback to origin validation to protect development environments
        const originUrl = url.parse(origin);
        const allowedHosts = ['news.ycombinator.com', 'iptorrents.com', 'iptorrents.ru', 'localhost', '127.0.0.1'];
        const host = originUrl.hostname;
        let isAllowed = allowedHosts.some(h => host === h || host.endsWith('.' + h)) || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
        
        if (!isAllowed) {
            let targetFile = fileToWatch;
            if (isDirectoryMode) {
                if (clientFilename) {
                    targetFile = path.join(fileToWatch, clientFilename);
                } else {
                    const files = fs.readdirSync(fileToWatch).filter(f => f.endsWith('.user.js'));
                    if (files.length > 0) {
                        targetFile = path.join(fileToWatch, files[0]);
                    }
                }
            }
            if (fs.existsSync(targetFile)) {
                try {
                    const rawCode = fs.readFileSync(targetFile, 'utf-8');
                    const info = getScriptInfo(rawCode);
                    if (info) {
                        const patterns = [...(info.matches || []), ...(info.includes || [])];
                        for (const pattern of patterns) {
                            if (pattern === '*://*/*' || pattern === '*://*' || pattern === '*' || pattern.includes('://*')) {
                                isAllowed = true;
                                break;
                            }
                            const regex = matchPatternToRegex(pattern);
                            if (regex && regex.test(origin)) {
                                isAllowed = true;
                                break;
                            }
                        }
                    }
                } catch (e) {
                    console.error('Error reading matches for origin validation:', e);
                }
            }
        }

        if (!isAllowed) {
            console.warn(`⚠️ Rejected connection from unauthorized origin: ${origin}`);
            ws.close(4001, 'Forbidden Origin');
            return;
        }
    }

    clients.add(ws);
    const ip = req.socket.remoteAddress;
    console.log(`🔌 Client browser connected from IP: ${ip} (Requested: ${clientFilename || 'all scripts'})`);

    // Determine target userscript file
    let targetFile = fileToWatch;
    if (isDirectoryMode) {
        if (clientFilename) {
            targetFile = path.join(fileToWatch, clientFilename);
        } else {
            // Default to first userscript in directory
            const files = fs.readdirSync(fileToWatch).filter(f => f.endsWith('.user.js'));
            if (files.length > 0) {
                targetFile = path.join(fileToWatch, files[0]);
            }
        }
    }

    if (fs.existsSync(targetFile)) {
        const rawCode = fs.readFileSync(targetFile, 'utf-8');
        const { info } = getFinalCodeForFile(rawCode, targetFile);
        const sha256 = getSha256(rawCode);

        ws.send(JSON.stringify({
            action: 'hello',
            version: info.version || '0.1',
            hash: sha256
        }));

        console.log('ScriptCat handshake confirmed');
        pushCode(ws, targetFile);
    }

    ws.on('close', () => {
        clients.delete(ws);
        console.log('🔌 Client browser disconnected');
    });

    ws.on('error', (err) => {
        console.error('❌ Connection error:', err);
    });

    ws.on('message', (message) => {
        try {
            const raw = message.toString();
            const data = JSON.parse(raw);
            
            if (data.action === 'ping') {
                ws.send(JSON.stringify({ action: 'pong' }));
            } else if (data.action === 'console' && !noConsole) {
                // Ensure runtime directory exists
                if (!fs.existsSync(runtimeDir)) {
                    fs.mkdirSync(runtimeDir, { recursive: true });
                }

                const logRecord = {
                    uri: data.data.uri || '',
                    version: data.data.version || '',
                    hash: data.data.hash || '',
                    level: data.data.level || 'log',
                    message: data.data.message || '',
                    received_at: new Date().toISOString()
                };

                fs.appendFileSync(consoleLogPath, JSON.stringify(logRecord) + '\n');

                // Live Terminal Console Relay (Filtered to avoid context window flooding)
                const isError = logRecord.level === 'error' || logRecord.level === 'unhandledrejection';
                const isUserscriptLog = logRecord.message.startsWith('[') || logRecord.message.includes('[Sync Client]');

                if (isError || isUserscriptLog) {
                    const level = logRecord.level;
                    const msgText = logRecord.message;
                    const timeStr = new Date().toLocaleTimeString();
                    let color = '\x1b[0m'; // Default reset
                    if (level === 'error') color = '\x1b[31m'; // Red
                    else if (level === 'warn') color = '\x1b[33m'; // Yellow
                    else if (level === 'info') color = '\x1b[36m'; // Cyan
                    else if (level === 'log') color = '\x1b[32m'; // Green
                    else if (level === 'unhandledrejection') color = '\x1b[35m'; // Magenta

                    console.log(`[Browser Console ${timeStr}] [${level.toUpperCase()}] ${color}${msgText}\x1b[0m`);
                }

            } else if (data.action === 'eval_result') {
                const status = data.data.status;
                const result = data.data.result;
                const color = status === 'success' ? '\x1b[32m' : '\x1b[31m';
                const prefix = status === 'success' ? '✔ Result:' : '❌ Error:';
                console.log(`[REPL Result] ${color}${prefix} ${result}\x1b[0m`);

            } else if (data.action === 'element_selected') {
                const status = data.data.status;
                if (status === 'success') {
                    const selector = data.data.selector;
                    const message = data.data.message || '(no instructions)';
                    const tagName = data.data.tagName || '';
                    const text = data.data.textContent || '';
                    console.log(`\n\x1b[32m[Element Picker] 🎯 Selector: ${selector}\x1b[0m`);
                    console.log(`\x1b[36m[Element Picker] 💬 Message:  ${message}\x1b[0m`);
                    console.log(`\x1b[90m[Element Picker] Element:   <${tagName.toLowerCase()}> "${text}"\x1b[0m\n`);
                } else {
                    console.log(`\n\x1b[31m[Element Picker] ❌ Selection cancelled: ${data.data.message}\x1b[0m\n`);
                }

            } else if (data.action === 'dom_report') {
                // Safely accept and write DOM snapshot report
                const filename = ws.requestedFilename || (isDirectoryMode ? 'userscript' : path.basename(fileToWatch, '.user.js'));
                const basename = filename.endsWith('.user.js') ? path.basename(filename, '.user.js') : filename;
                const outputDir = isDirectoryMode ? fileToWatch : path.dirname(fileToWatch);
                const reportPath = path.join(outputDir, `${basename}_dom_report.json`);
                fs.writeFileSync(reportPath, JSON.stringify(data.data, null, 2));
                console.log(`💾 Saved DOM Report to: ${reportPath}`);
            }
        } catch (err) {
            console.error('❌ Error handling message:', err);
        }
    });
});

function pushCode(client, targetFile) {
    try {
        let filesToPush = [];
        if (targetFile) {
            filesToPush = [targetFile];
        } else if (isDirectoryMode) {
            filesToPush = fs.readdirSync(fileToWatch)
                .filter(f => f.endsWith('.user.js'))
                .map(f => path.join(fileToWatch, f));
        } else {
            filesToPush = [fileToWatch];
        }

        for (const filePath of filesToPush) {
            if (!fs.existsSync(filePath)) continue;

            const rawCode = fs.readFileSync(filePath, 'utf-8');
            const info = getScriptInfo(rawCode);
            if (!info) continue;

            const { code: finalCode } = getFinalCodeForFile(rawCode, filePath);
            const sha256 = getSha256(rawCode);
            const fileUri = url.pathToFileURL(filePath).href;
            const filename = path.basename(filePath);

            const payloadOnChange = JSON.stringify({
                action: 'onchange',
                data: {
                    script: finalCode,
                    uri: fileUri,
                    filename: filename,
                    version: info.version || '0.1',
                    hash: sha256
                }
            });

            const payloadPush = JSON.stringify({
                action: 'push',
                data: {
                    code: finalCode,
                    filename: filename,
                    name: info.name || 'Synced Userscript',
                    namespace: info.namespace || 'userscript-sync',
                    uuid: info.uuid || 'userscript-sync-uuid',
                    version: info.version || '0.1',
                    hash: sha256
                }
            });

            const sendToClient = (c) => {
                if (c.readyState === WebSocket.OPEN) {
                    if (!c.requestedFilename || c.requestedFilename === filename) {
                        c.send(payloadOnChange);
                        c.send(payloadPush);
                    }
                }
            };

            if (client) {
                sendToClient(client);
            } else {
                clients.forEach(c => sendToClient(c));
            }

            console.log(`Synced ${filename} (${client ? '1' : clients.size} client(s), sha256:${sha256})`);
        }
    } catch (err) {
        console.error('❌ Error reading/pushing script:', err);
    }
}

// Watch userscript file/directory for changes
let watchTimeout = null;
if (isDirectoryMode) {
    fs.watch(fileToWatch, { recursive: true }, (eventType, filename) => {
        if (filename && filename.endsWith('.user.js')) {
            clearTimeout(watchTimeout);
            watchTimeout = setTimeout(() => {
                const fullPath = path.join(fileToWatch, filename);
                console.log(`📝 Local userscript modified: ${filename}! Syncing...`);
                pushCode(null, fullPath);
            }, 100);
        }
    });
} else {
    fs.watch(fileToWatch, (eventType) => {
        if (eventType === 'change') {
            clearTimeout(watchTimeout);
            watchTimeout = setTimeout(() => {
                console.log('📝 Local userscript modified! Syncing...');
                pushCode();
            }, 100);
        }
    });
}

// Interactive Live-Command Console (REPL) Standard Input Stream Reader
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (data) => {
    const code = data.trim();
    if (!code) return;

    if (code.startsWith('/select')) {
        const promptText = code.substring(7).trim() || 'Select an element on the page';
        console.log(`\x1b[34m[REPL] Activating Element Picker: "${promptText}"\x1b[0m`);
        let clientCount = 0;
        for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    action: 'select_element',
                    data: { prompt: promptText }
                }));
                clientCount++;
            }
        }
        if (clientCount === 0) {
            console.log(`\x1b[33m⚠️ No active clients connected to activate picker.\x1b[0m`);
        }
        return;
    }

    console.log(`\x1b[34m[REPL] Sending JavaScript to clients: ${code}\x1b[0m`);
    
    let clientCount = 0;
    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                action: 'eval',
                data: { code: code }
            }));
            clientCount++;
        }
    }
    if (clientCount === 0) {
        console.log(`\x1b[33m⚠️ No active clients connected to execute command.\x1b[0m`);
    }
});

let activePort = PORT;

function startServer(port) {
    server.listen(port, HOST, () => {
        console.log(`\x1b[32m🚀 Userscript Development Sync Server started on http://${HOST}:${port}\x1b[0m`);
        console.log(`👀 Watching path: ${fileToWatch} (Mode: ${isDirectoryMode ? 'Directory' : 'File'})`);
        console.log(`💬 Type JavaScript into this terminal to execute it on active browser pages (REPL mode).\n`);

        // Write active port configuration to .runtime/active-port.json
        const runtimeDir = path.join(projectDir, '.runtime');
        if (!fs.existsSync(runtimeDir)) {
            fs.mkdirSync(runtimeDir, { recursive: true });
        }
        fs.writeFileSync(
            path.join(runtimeDir, 'active-port.json'),
            JSON.stringify({ port: port, host: HOST, pid: process.pid })
        );
    });
}

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`⚠️ Port ${activePort} is in use, trying next port...`);
        activePort++;
        startServer(activePort);
    } else {
        console.error('❌ Server error:', err);
    }
});

startServer(activePort);
