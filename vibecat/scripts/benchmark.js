#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const scriptDir = __dirname;
const projectDir = path.join(scriptDir, '..');
const clientTemplatePath = path.join(projectDir, 'sync-client-template.js');
const serverPath = path.join(projectDir, 'sync-server.js');
const runtimeDir = path.join(projectDir, '.runtime');
const resultsPath = path.join(runtimeDir, 'benchmark-results.json');

const PORT = 18642; // Use a non-default port to avoid colliding with a running server
const HOST = '127.0.0.1';

// ---------------------------------------------------------------------------
// Helpers shared with sync-server.js (duplicated to keep benchmark standalone)
// ---------------------------------------------------------------------------
function getScriptInfo(code) {
    const meta = code.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
    if (!meta) return null;
    const info = { name: '', namespace: '', uuid: '', version: '' };
    for (let line of meta[1].split('\n')) {
        line = line.trim();
        if (line.startsWith('// @name '))      info.name      = line.replace('// @name ', '').trim();
        else if (line.startsWith('// @namespace ')) info.namespace = line.replace('// @namespace ', '').trim();
        else if (line.startsWith('// @uuid '))      info.uuid      = line.replace('// @uuid ', '').trim();
        else if (line.startsWith('// @version '))   info.version   = line.replace('// @version ', '').trim();
    }
    return info;
}

function getSha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function getFinalCode(rawCode, filePath) {
    const info = getScriptInfo(rawCode) || {};
    let finalCode = rawCode;
    if (fs.existsSync(clientTemplatePath)) {
        const alreadyInjected = rawCode.includes('[Sync Client]');
        if (!alreadyInjected) {
            let clientCode = fs.readFileSync(clientTemplatePath, 'utf-8');
            clientCode = clientCode.replace(
                /const SYNC_SERVER_WS = 'ws:\/\/127\.0\.0\.1:8642';/,
                `const SYNC_SERVER_WS = 'ws://${HOST}:${PORT}';`
            );
            const filename = path.basename(filePath);
            clientCode = clientCode.replace(
                /const SYNC_FILENAME = 'unknown';/,
                `const SYNC_FILENAME = '${filename}';`
            );
            const sha256 = getSha256(rawCode);
            clientCode = clientCode.replace(
                /let scriptHash = 'unknown';/,
                `let scriptHash = '${sha256}';`
            );
            const iifeMatch = rawCode.trim().match(/(\}\)\s*\(\s*\)\s*;?\s*)$/);
            if (iifeMatch) {
                const trimmedCode = rawCode.trim();
                const index = trimmedCode.lastIndexOf(iifeMatch[1]);
                finalCode = trimmedCode.substring(0, index) + '\n\n// --- VibeCat Auto-Injected Sync Client ---\n' + clientCode + '\n' + iifeMatch[1] + '\n';
            } else {
                finalCode = rawCode + '\n\n// --- VibeCat Auto-Injected Sync Client ---\n' + clientCode;
            }
        }
    }
    return { code: finalCode, info };
}

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------
function percentile(sortedArr, p) {
    const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
    return sortedArr[Math.max(0, idx)];
}

function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
        min:  sorted[0],
        max:  sorted[sorted.length - 1],
        mean: sum / sorted.length,
        p50:  percentile(sorted, 50),
        p95:  percentile(sorted, 95),
        p99:  percentile(sorted, 99),
    };
}

// ---------------------------------------------------------------------------
// SECTION 1 — Compilation Benchmark (offline, no server)
// ---------------------------------------------------------------------------
function runCompilationBenchmark(rawCode, filePath, runs) {
    const timings = [];
    let finalCodeSize = 0;

    for (let i = 0; i < runs; i++) {
        const start = process.hrtime.bigint();
        const { code } = getFinalCode(rawCode, filePath);
        const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
        timings.push(elapsed);
        if (i === 0) finalCodeSize = Buffer.byteLength(code, 'utf8');
    }

    return {
        runs,
        timings: stats(timings),
        rawSizeBytes: Buffer.byteLength(rawCode, 'utf8'),
        compiledSizeBytes: finalCodeSize,
    };
}

// ---------------------------------------------------------------------------
// SECTION 2 — WebSocket Round-Trip Benchmark (requires starting a temp server)
// ---------------------------------------------------------------------------
function waitForHealth(port, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const attempt = () => {
            if (Date.now() > deadline) return reject(new Error('Health timeout'));
            const req = http.get(`http://${HOST}:${port}/debug/health`, { timeout: 1500 }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad health JSON')); }
                });
            });
            req.on('error', () => setTimeout(attempt, 150));
            req.on('timeout', () => { req.destroy(); setTimeout(attempt, 150); });
        };
        attempt();
    });
}

async function runWebSocketBenchmark(mockScriptPath, runs) {
    let WebSocket;
    try {
        WebSocket = require('ws');
    } catch {
        return { error: 'ws package not installed — skipping WebSocket benchmark' };
    }

    // Start a temporary sync server on the benchmark port
    if (!fs.existsSync(runtimeDir)) fs.mkdirSync(runtimeDir, { recursive: true });
    const stdoutFd = fs.openSync(path.join(runtimeDir, 'bench-server.stdout.log'), 'w');
    const stderrFd = fs.openSync(path.join(runtimeDir, 'bench-server.stderr.log'), 'w');

    const serverEnv = { ...process.env };
    // Force port via environment — but sync-server.js reads PORT constant internally.
    // We pass the script path as the positional arg; the server will try 8642 first.
    // To isolate, we rely on the server's auto-increment if 8642 is busy, but for
    // benchmark determinism we need a known port. We'll just accept the server's port
    // from health.

    const child = spawn(process.execPath, [serverPath, '--no-console', mockScriptPath], {
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        cwd: projectDir,
        env: serverEnv,
    });
    child.unref();

    let serverPort;
    try {
        // Try default port first
        const health = await waitForHealth(8642, 5000).catch(() => null);
        if (health && health.watched_file && health.watched_file.includes(path.basename(mockScriptPath))) {
            serverPort = 8642;
        } else {
            // Read active-port.json written by server
            const activePortPath = path.join(runtimeDir, 'active-port.json');
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 200));
                if (fs.existsSync(activePortPath)) {
                    const info = JSON.parse(fs.readFileSync(activePortPath, 'utf-8'));
                    serverPort = info.port;
                    break;
                }
            }
            if (!serverPort) throw new Error('Could not determine server port');
            await waitForHealth(serverPort, 5000);
        }
    } catch (err) {
        try { process.kill(child.pid, 'SIGTERM'); } catch {}
        return { error: `Server startup failed: ${err.message}` };
    }

    const wsUrl = `ws://${HOST}:${serverPort}`;

    // --- Sub-benchmark A: Connection + Handshake latency ---
    const connectTimings = [];
    const handshakeTimings = [];
    const deliveryTimings = [];
    const pingTimings = [];

    for (let i = 0; i < runs; i++) {
        const tConnStart = process.hrtime.bigint();
        const ws = await new Promise((resolve, reject) => {
            const sock = new WebSocket(wsUrl);
            sock.on('open', () => resolve(sock));
            sock.on('error', reject);
        });
        connectTimings.push(Number(process.hrtime.bigint() - tConnStart) / 1e6);

        // Collect handshake + delivery in one pass
        const { helloMs, deliveryMs } = await new Promise((resolve) => {
            let helloTime = null;
            let firstDelivery = null;
            const tWait = process.hrtime.bigint();
            ws.on('message', (raw) => {
                const msg = JSON.parse(raw.toString());
                const now = process.hrtime.bigint();
                if (msg.action === 'hello' && !helloTime) {
                    helloTime = Number(now - tWait) / 1e6;
                }
                if ((msg.action === 'onchange' || msg.action === 'push') && !firstDelivery) {
                    firstDelivery = Number(now - tWait) / 1e6;
                }
                if (helloTime && firstDelivery) {
                    resolve({ helloMs: helloTime, deliveryMs: firstDelivery });
                }
            });
        });
        handshakeTimings.push(helloMs);
        deliveryTimings.push(deliveryMs);

        // Ping/Pong RTT
        const tPing = process.hrtime.bigint();
        ws.send(JSON.stringify({ action: 'ping' }));
        await new Promise((resolve) => {
            ws.on('message', (raw) => {
                const msg = JSON.parse(raw.toString());
                if (msg.action === 'pong') {
                    pingTimings.push(Number(process.hrtime.bigint() - tPing) / 1e6);
                    resolve();
                }
            });
        });

        ws.close();
        // Brief cooldown between iterations
        await new Promise(r => setTimeout(r, 20));
    }

    // --- Sub-benchmark B: File-change propagation latency ---
    const fileChangeTimings = [];
    const fileChangeRuns = Math.min(runs, 50); // Cap file-change runs to avoid thrashing

    const ws = await new Promise((resolve, reject) => {
        const sock = new WebSocket(wsUrl);
        sock.on('open', () => resolve(sock));
        sock.on('error', reject);
    });

    // Drain initial hello + delivery
    await new Promise((resolve) => {
        let got = 0;
        ws.on('message', () => { got++; if (got >= 2) resolve(); });
    });

    const rawCode = fs.readFileSync(mockScriptPath, 'utf-8');
    for (let i = 0; i < fileChangeRuns; i++) {
        // Mutate the file with a version bump to ensure the watcher triggers
        const mutated = rawCode.replace(
            /\/\/ @version\s+.*/,
            `// @version      bench-${i}-${Date.now()}`
        );

        const tWrite = process.hrtime.bigint();
        fs.writeFileSync(mockScriptPath, mutated, 'utf-8');

        await new Promise((resolve) => {
            const onMsg = (raw) => {
                const msg = JSON.parse(raw.toString());
                if (msg.action === 'onchange' || msg.action === 'push') {
                    fileChangeTimings.push(Number(process.hrtime.bigint() - tWrite) / 1e6);
                    ws.removeListener('message', onMsg);
                    resolve();
                }
            };
            ws.on('message', onMsg);
        });

        await new Promise(r => setTimeout(r, 150)); // respect fs.watch debounce
    }

    // Restore original file
    fs.writeFileSync(mockScriptPath, rawCode, 'utf-8');
    ws.close();

    // Collect server memory via health endpoint
    let serverMemory = null;
    try {
        const healthRes = await new Promise((resolve) => {
            http.get(`http://${HOST}:${serverPort}/debug/health`, (res) => {
                let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
            }).on('error', () => resolve(null));
        });
        serverMemory = healthRes;
    } catch {}

    // Kill the benchmark server
    try { process.kill(child.pid, 'SIGTERM'); } catch {}

    return {
        runs,
        fileChangeRuns,
        connect: stats(connectTimings),
        handshake: stats(handshakeTimings),
        delivery: stats(deliveryTimings),
        ping: stats(pingTimings),
        fileChange: fileChangeTimings.length > 0 ? stats(fileChangeTimings) : null,
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  VibeCat Performance Benchmark Suite');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Locate or create a target userscript
    let targetScript = path.join('d:', 'AI', 'AIProjects', 'Iptorents userscript', 'iptorrents-thumbnails.user.js');
    let usingMock = false;

    if (!fs.existsSync(targetScript)) {
        usingMock = true;
        const mockLines = [
            '// ==UserScript==',
            '// @name         Benchmark Mock Script',
            '// @namespace    vibecat-bench',
            '// @version      1.0.0',
            '// @description  Auto-generated mock for benchmarking',
            '// @match        *://*.example.com/*',
            '// ==/UserScript==',
            '(function() {',
            '    \'use strict\';',
        ];
        for (let i = 0; i < 1000; i++) {
            mockLines.push(`    console.log("Benchmark line ${i}");`);
        }
        mockLines.push('})();');

        targetScript = path.join(projectDir, '.runtime', 'mock-benchmark.user.js');
        if (!fs.existsSync(runtimeDir)) fs.mkdirSync(runtimeDir, { recursive: true });
        fs.writeFileSync(targetScript, mockLines.join('\n'), 'utf-8');
    }

    const rawCode = fs.readFileSync(targetScript, 'utf-8');
    const rawSizeKb = (Buffer.byteLength(rawCode, 'utf8') / 1024).toFixed(2);
    const lineCount = rawCode.split('\n').length;

    console.log(`  Target: ${path.basename(targetScript)}${usingMock ? ' (mock)' : ''}`);
    console.log(`  Lines:  ${lineCount}    Size: ${rawSizeKb} KB\n`);

    // ── Section 1: Compilation ──
    const COMPILE_RUNS = 1000;
    console.log(`── Compilation Benchmark (${COMPILE_RUNS} iterations) ──\n`);
    const comp = runCompilationBenchmark(rawCode, targetScript, COMPILE_RUNS);

    console.log(`  Metadata Parse + Client Injection:`);
    console.log(`    Mean:  ${comp.timings.mean.toFixed(3)} ms`);
    console.log(`    P50:   ${comp.timings.p50.toFixed(3)} ms`);
    console.log(`    P95:   ${comp.timings.p95.toFixed(3)} ms`);
    console.log(`    P99:   ${comp.timings.p99.toFixed(3)} ms`);
    console.log(`  Raw Size:      ${(comp.rawSizeBytes / 1024).toFixed(2)} KB`);
    console.log(`  Compiled Size: ${(comp.compiledSizeBytes / 1024).toFixed(2)} KB`);
    console.log(`  Injection Overhead: +${((comp.compiledSizeBytes - comp.rawSizeBytes) / 1024).toFixed(2)} KB\n`);

    // ── Section 2: WebSocket Round-Trip ──
    const WS_RUNS = 50;
    console.log(`── WebSocket Round-Trip Benchmark (${WS_RUNS} iterations) ──\n`);
    const ws = await runWebSocketBenchmark(targetScript, WS_RUNS);

    if (ws.error) {
        console.log(`  ⚠ ${ws.error}\n`);
    } else {
        console.log(`  TCP Connect:`);
        console.log(`    Mean: ${ws.connect.mean.toFixed(2)} ms    P95: ${ws.connect.p95.toFixed(2)} ms`);
        console.log(`  Hello Handshake:`);
        console.log(`    Mean: ${ws.handshake.mean.toFixed(2)} ms    P95: ${ws.handshake.p95.toFixed(2)} ms`);
        console.log(`  Initial Code Delivery:`);
        console.log(`    Mean: ${ws.delivery.mean.toFixed(2)} ms    P95: ${ws.delivery.p95.toFixed(2)} ms`);
        console.log(`  Ping/Pong RTT:`);
        console.log(`    Mean: ${ws.ping.mean.toFixed(2)} ms    P95: ${ws.ping.p95.toFixed(2)} ms`);
        if (ws.fileChange) {
            console.log(`  File-Change → Delivery (${ws.fileChangeRuns} writes):`);
            console.log(`    Mean: ${ws.fileChange.mean.toFixed(2)} ms    P95: ${ws.fileChange.p95.toFixed(2)} ms`);
        }
        console.log();
    }

    // ── Section 3: Process Memory ──
    const mem = process.memoryUsage();
    console.log('── Process Resource Footprint ──\n');
    console.log(`  RSS:       ${(mem.rss / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Heap Used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Heap Total: ${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  External:  ${(mem.external / 1024 / 1024).toFixed(2)} MB\n`);

    // ── Save Results ──
    const results = {
        timestamp: new Date().toISOString(),
        target: {
            file: path.basename(targetScript),
            mock: usingMock,
            lines: lineCount,
            sizeKb: parseFloat(rawSizeKb),
        },
        compilation: comp,
        websocket: ws.error ? { error: ws.error } : ws,
        memory: {
            rss_mb: parseFloat((mem.rss / 1024 / 1024).toFixed(2)),
            heapUsed_mb: parseFloat((mem.heapUsed / 1024 / 1024).toFixed(2)),
            heapTotal_mb: parseFloat((mem.heapTotal / 1024 / 1024).toFixed(2)),
            external_mb: parseFloat((mem.external / 1024 / 1024).toFixed(2)),
        },
    };

    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    console.log(`  Results saved to: ${resultsPath}`);

    // ── Cleanup ──
    if (usingMock) {
        try { fs.unlinkSync(targetScript); } catch {}
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Benchmark complete.');
    console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});
