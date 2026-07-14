const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 8642;
const HOST = '127.0.0.1';

// Setup paths relative to the script's folder (scripts/)
const projectPath = path.resolve(__dirname, '..');
const serverPath = path.join(projectPath, 'sync-server.js');
const runtimePath = path.join(projectPath, '.runtime');
const pidFile = path.join(runtimePath, 'sync-server.pid');
const stdoutFile = path.join(runtimePath, 'sync-server.stdout.log');
const stderrFile = path.join(runtimePath, 'sync-server.stderr.log');
const activeScriptFile = path.join(runtimePath, 'active-script.txt');
const consoleLogFile = path.join(runtimePath, 'userscript-console.jsonl');

const action = process.argv[2];
const scriptPathArg = process.argv[3];

if (!action || !['start', 'status', 'health', 'stop'].includes(action)) {
    console.error('Usage: node manage-sync.js <start|status|health|stop> [scriptPath]');
    process.exit(1);
}

function getVerifiedProcess() {
    if (!fs.existsSync(pidFile)) return null;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (isNaN(pid)) return null;

    try {
        // Send signal 0 to check if process exists
        process.kill(pid, 0);
        return pid;
    } catch (e) {
        return null;
    }
}

function getHealth() {
    return new Promise((resolve) => {
        const req = http.get(`http://${HOST}:${PORT}/debug/health`, { timeout: 1500 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
    });
}

async function getStatus() {
    const pid = getVerifiedProcess();
    const health = await getHealth();
    let activeScript = null;
    if (fs.existsSync(activeScriptFile)) {
        activeScript = fs.readFileSync(activeScriptFile, 'utf8').trim();
    } else if (health) {
        activeScript = health.watched_file;
    }

    return {
        project_path: projectPath,
        running: !!pid,
        pid: pid || null,
        port: PORT,
        active_script: activeScript,
        health: health,
        stdout_log: stdoutFile,
        stderr_log: stderrFile,
        console_log: consoleLogFile
    };
}

async function run() {
    switch (action) {
        case 'status':
            const status = await getStatus();
            console.log(JSON.stringify(status));
            break;

        case 'health':
            const health = await getHealth();
            if (!health) {
                console.error(JSON.stringify({ status: 'offline', error: 'Sync health endpoint is unavailable' }));
                process.exit(1);
            }
            console.log(JSON.stringify(health));
            break;

        case 'start':
            const existingPid = getVerifiedProcess();
            if (existingPid) {
                const s = await getStatus();
                console.log(JSON.stringify(s));
                break;
            }

            if (!scriptPathArg) {
                console.error('Error: scriptPath is required when starting the server.');
                process.exit(1);
            }

            const targetScript = path.resolve(projectPath, scriptPathArg);
            if (!fs.existsSync(targetScript)) {
                console.error(`Error: Userscript not found: ${targetScript}`);
                process.exit(1);
            }

            if (!targetScript.endsWith('.user.js')) {
                console.error(`Error: Expected an executable .user.js target, got: ${targetScript}`);
                process.exit(1);
            }

            // Ensure runtime dir exists
            if (!fs.existsSync(runtimePath)) {
                fs.mkdirSync(runtimePath, { recursive: true });
            }

            // Open redirect streams
            const outFd = fs.openSync(stdoutFile, 'w');
            const errFd = fs.openSync(stderrFile, 'w');

            // Spawn detached server process
            const child = spawn(process.execPath, [serverPath, targetScript], {
                detached: true,
                stdio: ['ignore', outFd, errFd],
                cwd: projectPath,
                env: process.env // pass parent environment (to inherit SYNC_BEARER_TOKEN if set)
            });

            const spawnedPid = child.pid;
            fs.writeFileSync(pidFile, spawnedPid.toString(), 'utf8');
            fs.writeFileSync(activeScriptFile, targetScript, 'utf8');

            // Unreference child so parent process can exit independently
            child.unref();

            // Wait for health endpoint to become available
            let verifiedHealth = null;
            const start = Date.now();
            const timeout = 8000;

            while (Date.now() - start < timeout) {
                await new Promise(r => setTimeout(r, 150));
                // Check if child exited early
                try {
                    process.kill(spawnedPid, 0);
                } catch (e) {
                    const errOutput = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8') : '';
                    console.error(`Error: Sync server exited early: ${errOutput}`);
                    process.exit(1);
                }

                verifiedHealth = await getHealth();
                if (verifiedHealth) break;
            }

            if (!verifiedHealth) {
                console.error('Error: Sync server started but health did not become available within 8 seconds.');
                process.exit(1);
            }

            const finalStatus = await getStatus();
            console.log(JSON.stringify(finalStatus));
            break;

        case 'stop':
            const pidToKill = getVerifiedProcess();
            if (pidToKill) {
                try {
                    process.kill(pidToKill, 'SIGTERM');
                    // Wait a bit to ensure it terminates
                    for (let i = 0; i < 20; i++) {
                        await new Promise(r => setTimeout(r, 100));
                        try {
                            process.kill(pidToKill, 0);
                        } catch (e) {
                            break;
                        }
                    }
                } catch (e) {}
            }

            if (fs.existsSync(pidFile)) {
                try { fs.unlinkSync(pidFile); } catch (e) {}
            }

            const stoppedStatus = await getStatus();
            console.log(JSON.stringify(stoppedStatus));
            break;
    }
}

run();
