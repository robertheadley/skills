'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const esbuild = require('esbuild');
const ts = require('typescript');
const { APP_ROOT, DEFAULT_HOST } = require('./constants');
const { resolveProject } = require('./project');
const { projectKey, detectEnvironment, normalizePath } = require('./paths');
const { readState, writeState, removeState, listStates, stateDir } = require('./state');
const { bundleProject, syntaxCheck, atomicWrite } = require('./build');
const { extractMetadata } = require('./metadata');
const { requestJson } = require('./http-client');
const { VibeCatError } = require('./errors');

function candidate(pathValue, source) {
  if (!pathValue) return null;
  const resolved = path.resolve(pathValue);
  if (!fs.existsSync(path.join(resolved, 'package.json'))) return null;
  try { const value = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8')); return { path: resolved, source, version: value.version || null, complete: fs.existsSync(path.join(resolved, 'bin', 'vibecat.js')) && fs.existsSync(path.join(resolved, 'src', 'services.js')) }; } catch { return { path: resolved, source, version: null, complete: false }; }
}

function locateInstallation() {
  const homes = [
    candidate(APP_ROOT, 'repository'), candidate(process.env.VIBECAT_HOME, 'environment'),
    candidate(path.join(os.homedir(), '.vibecat'), 'user-home'),
    candidate(path.join(os.homedir(), '.hermes', 'skills', 'vibecat'), 'hermes-skills'),
    candidate(path.join(os.homedir(), '.codex', 'skills', 'vibecat'), 'codex-skills'),
    candidate(path.join(os.homedir(), '.gemini', 'antigravity', 'skills', 'vibecat'), 'antigravity-skills'),
  ].filter(Boolean);
  const unique = Array.from(new Map(homes.map((item) => [item.path.toLowerCase(), item])).values());
  const selected = unique.find((item) => item.path === APP_ROOT) || unique.find((item) => item.complete) || null;
  return { selected: selected ? { ...selected, active: true } : null, candidates: unique.map((item) => ({ ...item, active: selected && item.path === selected.path })) };
}

function processExists(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function processCommandLine(pid) {
  if (!pid) return null;
  if (process.platform === 'win32') {
    const escaped = String(Number(pid));
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${escaped}" -ErrorAction SilentlyContinue).CommandLine`], { encoding: 'utf8', windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  }
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  }
}
function verifiedOwnedProcess(state, kind = 'service') {
  const pid = kind === 'watcher' ? state && state.watcherPid : state && state.pid;
  if (!pid || !processExists(pid)) return null;
  const commandLine = processCommandLine(pid);
  const marker = kind === 'watcher' ? 'watch-worker.js' : 'sync-server.js';
  if (!commandLine || !commandLine.includes(marker) || !commandLine.includes(state.projectPath)) {
    throw new VibeCatError('PROCESS_OWNERSHIP_MISMATCH', `PID ${pid} exists but is not the recorded VibeCat ${kind}.`, {
      evidence: { pid, kind, commandLine: commandLine && commandLine.replace(/token=[^\s]+/g, 'token=[REDACTED]') }, retryable: false,
      nextActions: ['Run `vibecat doctor --json` and inspect the stale state warning.'],
    });
  }
  return { pid, commandLine };
}
function portAvailable(port) {
  return new Promise((resolve) => { const server = net.createServer(); server.once('error', () => resolve(false)); server.listen(port, DEFAULT_HOST, () => server.close(() => resolve(true))); });
}
async function getHealth(state) {
  if (!state || !state.port) return null;
  try { const response = await requestJson({ port: state.port, pathname: '/debug/health', timeoutMs: 1200 }); return response.status === 200 ? response.body : null; } catch { return null; }
}
function resolveContext(projectInput, cwd = process.cwd()) {
  if (projectInput) return resolveProject(projectInput, { cwd });
  try { return resolveProject(cwd, { cwd }); } catch (error) {
    const active = listStates().filter((state) => state.projectPath && (state.pid || state.watcherPid));
    if (active.length === 1) return resolveProject(active[0].projectPath);
    throw error;
  }
}

async function statusProject(project) {
  const state = readState(project.projectPath);
  const health = await getHealth(state);
  let serviceOwned = false; let watcherOwned = false; const warnings = [];
  try { serviceOwned = Boolean(verifiedOwnedProcess(state)); } catch (error) { warnings.push(error.toJSON()); }
  try { watcherOwned = Boolean(verifiedOwnedProcess(state, 'watcher')); } catch (error) { warnings.push(error.toJSON()); }
  let lifecycle = 'READY';
  if (health && health.browser && health.browser.connected) lifecycle = watcherOwned ? 'WATCHING' : 'CONNECTED';
  else if (watcherOwned) lifecycle = 'WATCHING';
  else if (health && serviceOwned) lifecycle = 'RUNNING';
  else if (state && state.state === 'STOPPED') lifecycle = 'STOPPED';
  else if (state && state.pid && !serviceOwned) { lifecycle = 'ERROR'; warnings.push({ code: 'STALE_PID', message: `Recorded service PID ${state.pid} is not running.` }); }
  return { lifecycle, state, health, serviceOwned, watcherOwned, warnings };
}

async function startSession(project, options = {}) {
  const existing = await statusProject(project);
  if (existing.health && existing.serviceOwned) return existing;
  if (!(await portAvailable(project.port))) throw new VibeCatError('PORT_OCCUPIED', `Port ${project.port} is already in use by an unverified process.`, {
    evidence: { host: DEFAULT_HOST, port: project.port }, retryable: true,
    nextActions: ['Stop the process that owns the port or configure service.port to an available port.', 'Rerun `vibecat start --json`.'],
  });
  const runtime = stateDir(project.projectPath); fs.mkdirSync(runtime, { recursive: true });
  const token = crypto.randomBytes(32).toString('hex');
  const sessionId = `session_${crypto.randomBytes(8).toString('hex')}`;
  const ownerNonce = crypto.randomBytes(12).toString('hex');
  const stdoutPath = path.join(runtime, 'service.stdout.log'); const stderrPath = path.join(runtime, 'service.stderr.log'); const eventLog = path.join(runtime, 'browser-events.jsonl');
  const out = fs.openSync(stdoutPath, 'w'); const err = fs.openSync(stderrPath, 'w');
  writeState(project.projectPath, { state: 'STARTING', sessionId, token, ownerNonce, port: project.port, outputFile: project.outputFile, stdoutPath, stderrPath, eventLog });
  const child = spawn(process.execPath, [path.join(APP_ROOT, 'sync-server.js'), project.outputFile, '--owner', ownerNonce], {
    cwd: APP_ROOT, detached: true, stdio: ['ignore', out, err], windowsHide: true,
    env: { ...process.env, VIBECAT_PORT: String(project.port), VIBECAT_SESSION_TOKEN: token, VIBECAT_PROJECT_ID: projectKey(project.projectPath), VIBECAT_EVENT_LOG: eventLog },
  });
  fs.closeSync(out); fs.closeSync(err); child.unref();
  writeState(project.projectPath, { state: 'STARTING', pid: child.pid, startedAt: new Date().toISOString() });
  const deadline = Date.now() + 8000; let health = null;
  while (Date.now() < deadline && !health) { await new Promise((resolve) => setTimeout(resolve, 100)); if (!processExists(child.pid)) break; health = await getHealth({ port: project.port }); }
  if (!health) {
    const errorText = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8').slice(-4000) : '';
    writeState(project.projectPath, { state: 'ERROR', lastError: errorText || 'Health endpoint unavailable.' });
    throw new VibeCatError('SERVICE_START_FAILED', 'VibeCat service did not become healthy within 8 seconds.', { evidence: { pid: child.pid, stderr: errorText }, retryable: true, nextActions: ['Run `vibecat doctor --json`.', 'Run `vibecat stop --json` before retrying.'] });
  }
  writeState(project.projectPath, { state: 'RUNNING' });
  return statusProject(project);
}

async function stopSession(project) {
  const state = readState(project.projectPath);
  const stopped = []; const removed = [];
  if (!state) return { stopped, removed, idempotent: true };
  for (const kind of ['watcher', 'service']) {
    const owned = verifiedOwnedProcess(state, kind);
    if (!owned) continue;
    process.kill(owned.pid, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && processExists(owned.pid)) await new Promise((resolve) => setTimeout(resolve, 100));
    if (processExists(owned.pid)) throw new VibeCatError('PROCESS_STOP_TIMEOUT', `Owned ${kind} PID ${owned.pid} did not stop within 5 seconds.`, { evidence: { pid: owned.pid, kind }, retryable: true });
    stopped.push({ kind, pid: owned.pid });
  }
  const preserved = { projectPath: project.projectPath, state: 'STOPPED', stoppedAt: new Date().toISOString(), port: state.port, outputFile: state.outputFile };
  removeState(project.projectPath); writeState(project.projectPath, preserved); removed.push('session token', 'PID ownership records');
  return { stopped, removed, idempotent: stopped.length === 0 };
}

async function commandBrowser(project, operation, args = {}, timeoutMs = 5000) {
  const state = readState(project.projectPath);
  const health = await getHealth(state);
  if (!state || !health) throw new VibeCatError('SERVICE_NOT_RUNNING', 'The VibeCat service is not running for this project.', { evidence: { projectPath: project.projectPath }, retryable: true, nextActions: ['Run `vibecat start --project <path> --json`.'] });
  const response = await requestJson({ port: state.port, pathname: '/api/command', method: 'POST', token: state.token, body: { operation, args, timeoutMs }, timeoutMs: timeoutMs + 1000 });
  if (!response.body || !response.body.ok) {
    const error = response.body && response.body.error || { code: 'BROWSER_COMMAND_FAILED', message: 'The browser command failed.' };
    throw new VibeCatError(error.code, error.message, { evidence: { operation, browser: health.browser }, retryable: true, nextActions: ['Confirm the userscript is loaded in the intended tab.', 'Run `vibecat status --json` and retry.'] });
  }
  return { data: response.body.data, health };
}

async function pushProject(project, options = {}) {
  const state = readState(project.projectPath);
  if (!state || !(await getHealth(state))) throw new VibeCatError('SERVICE_NOT_RUNNING', 'Cannot push because the VibeCat service is not running.', { retryable: true, nextActions: ['Run `vibecat start --json`.'] });
  const filePath = options.file ? normalizePath(options.file, { cwd: project.projectPath }) : project.outputFile;
  if (!fs.existsSync(filePath)) throw new VibeCatError('BUNDLE_MISSING', `Bundle does not exist: ${filePath}`, { retryable: true, nextActions: ['Run `vibecat build --json`.'] });
  const source = fs.readFileSync(filePath, 'utf8'); const metadata = extractMetadata(source);
  if (!metadata.valid) throw new VibeCatError('METADATA_INVALID', 'Bundle metadata is invalid.', { evidence: { errors: metadata.errors }, retryable: true });
  syntaxCheck(source, filePath);
  if (path.resolve(filePath) !== path.resolve(state.outputFile)) throw new VibeCatError('PUSH_FILE_MISMATCH', 'The running service watches a different output file.', { evidence: { requested: filePath, watched: state.outputFile }, retryable: true, nextActions: ['Stop and restart VibeCat with the requested project output.'] });
  const response = await requestJson({ port: state.port, pathname: '/api/push', method: 'POST', token: state.token, body: {}, timeoutMs: 5000 });
  if (!response.body || !response.body.ok) throw new VibeCatError('PUSH_FAILED', response.body && response.body.error && response.body.error.message || 'Push failed.', { retryable: true });
  const delivery = response.body.data; const deadline = Date.now() + Number(options.ackTimeoutMs || 5000); let health;
  do { health = await getHealth(state); if (health && health.browser && health.browser.connected && health.browser.hash === delivery.hash) break; await new Promise((resolve) => setTimeout(resolve, 150)); } while (Date.now() < deadline);
  const acknowledged = Boolean(health && health.browser && health.browser.connected && health.browser.hash === delivery.hash);
  if (!delivery.sent) throw new VibeCatError('SCRIPTCAT_NOT_CONNECTED', 'No ScriptCat extension client acknowledged a live connection, so the bundle was not delivered.', { evidence: { delivery, browser: health && health.browser }, retryable: true, nextActions: ['Enable ScriptCat development synchronization for this VibeCat service.', 'Run `vibecat status --json` and retry.'] });
  if (!acknowledged) throw new VibeCatError('BROWSER_EXECUTION_NOT_ACKNOWLEDGED', 'ScriptCat received the bundle, but no connected page executed the matching build before timeout.', { evidence: { delivery, browser: health && health.browser }, retryable: true, nextActions: ['Reload the intended page so ScriptCat executes the updated userscript.', 'Run `vibecat push --json` again.'] });
  writeState(project.projectPath, { state: 'PUSHED', lastPush: { ...delivery, acknowledged: true, tabHandle: health.browser.tabHandle } });
  return { delivery, browser: health.browser, browserAcknowledged: true };
}

async function runDoctor(project) {
  const checks = [];
  const add = (name, status, observed, why, remediation, retryable = true) => checks.push({ name, status, observed, why, remediation, retryable });
  add('node-runtime', Number(process.versions.node.split('.')[0]) >= 20 ? 'PASS' : 'FAIL', process.version, 'VibeCat requires a maintained Node.js runtime.', 'Install Node.js 20 or newer.');
  add('installation', fs.existsSync(path.join(APP_ROOT, 'bin', 'vibecat.js')) ? 'PASS' : 'FAIL', APP_ROOT, 'The canonical CLI must be complete.', 'Repair or reinstall VibeCat.');
  add('platform', 'PASS', { platform: process.platform, shell: detectEnvironment() }, 'Path conversion is environment-sensitive.', 'No action required.', false);
  add('native-path-conversion', normalizePath(project.projectPath) === project.projectPath ? 'PASS' : 'WARN', { input: project.projectPath, normalized: normalizePath(project.projectPath) }, 'All tools must agree on the native project path.', 'Reuse the returned canonical projectPath in later commands.');
  const located = locateInstallation();
  add('duplicate-installations', located.candidates.length > 1 ? 'WARN' : 'PASS', { selected: located.selected, candidates: located.candidates.map((item) => item.path) }, 'Multiple copies can cause agents to execute a stale CLI.', 'Use the selected installation from `vibecat locate --json` and remove obsolete copies explicitly.');
  add('project-path', fs.existsSync(project.projectPath) ? 'PASS' : 'FAIL', project.projectPath, 'The source project must exist.', 'Pass a valid absolute project path.');
  let writable = true; try { fs.accessSync(project.projectPath, fs.constants.W_OK); } catch { writable = false; }
  add('project-writable', writable ? 'PASS' : 'FAIL', { writable }, 'Build and configuration output require write access.', 'Grant the current user write access to the project.');
  add('configuration', 'PASS', project.configPath || 'implicit defaults', 'Project settings must load deterministically.', 'Fix vibecat.config.*.');
  add('entry-point', fs.existsSync(project.entryPoint) ? 'PASS' : 'FAIL', project.entryPoint, 'A source entry is required.', 'Configure `entry` or create src/main.ts.');
  add('typescript', project.typed && !ts.version ? 'FAIL' : 'PASS', { requested: project.typed, version: ts.version }, 'TypeScript projects need compiler diagnostics.', 'Run npm install in the VibeCat installation.');
  add('esbuild', esbuild.version ? 'PASS' : 'FAIL', { version: esbuild.version }, 'Module bundling requires esbuild.', 'Run npm install in the VibeCat installation.');
  const metadata = extractMetadata(fs.readFileSync(project.entryPoint, 'utf8'));
  add('metadata', metadata.valid || Boolean(project.config.metadata) ? 'PASS' : 'FAIL', { errors: metadata.errors }, 'ScriptCat requires a valid first metadata block.', 'Add valid @name and @version metadata or configuration metadata.');
  if (fs.existsSync(project.outputFile)) {
    const outputSource = fs.readFileSync(project.outputFile, 'utf8'); const outputMetadata = extractMetadata(outputSource); let outputSyntax = true; let outputError = null;
    try { syntaxCheck(outputSource, project.outputFile); } catch (error) { outputSyntax = false; outputError = error.message; }
    add('build-output', outputMetadata.valid && outputSyntax ? 'PASS' : 'FAIL', { outputFile: project.outputFile, metadataValid: outputMetadata.valid, syntaxValid: outputSyntax, error: outputError }, 'Push requires a syntactically valid userscript bundle.', 'Run `vibecat build --json` and fix reported failures.');
  } else add('build-output', 'WARN', { outputFile: project.outputFile, exists: false }, 'A build output is required before startup or push.', 'Run `vibecat build --json`.');
  const current = await statusProject(project);
  add('service', current.health ? 'PASS' : 'WARN', current.health || { running: false }, 'The service is optional for build but required for browser work.', 'Run `vibecat start --json` when browser operations are needed.');
  add('browser-bridge', current.health && current.health.browser.connected ? 'PASS' : 'WARN', current.health && current.health.browser || { connected: false }, 'DOM inspection and execution proof require an active page bridge.', 'Load or reload the userscript in the intended tab after starting VibeCat.');
  add('scriptcat-client', current.health && current.health.websocket_clients > 0 ? 'PASS' : 'WARN', { clients: current.health && current.health.websocket_clients || 0 }, 'Push delivery requires ScriptCat synchronization.', 'Enable ScriptCat development synchronization and connect it to ws://127.0.0.1:<port>.');
  add('script-injection-permission', current.health && current.health.browser.connected ? 'PASS' : 'WARN', current.health && current.health.browser || { observed: false }, 'Only an executed authenticated page bridge proves userscript injection is allowed.', 'Load or reload the intended page and rerun doctor.');
  const samePortStates = listStates().filter((state) => state.projectPath !== project.projectPath && state.port === project.port && state.pid);
  add('duplicate-instances', samePortStates.length ? 'FAIL' : 'PASS', { conflictingStates: samePortStates.map((state) => ({ projectPath: state.projectPath, pid: state.pid, port: state.port })) }, 'Two recorded services must not compete for one port.', 'Stop the conflicting VibeCat project or configure a distinct port.');
  if (!current.health) add('port', await portAvailable(project.port) ? 'PASS' : 'FAIL', { host: DEFAULT_HOST, port: project.port }, 'The local service requires an available loopback port.', 'Stop the verified owner or configure a different port.');
  else add('port', 'PASS', { host: DEFAULT_HOST, port: project.port, ownerPid: current.health.pid }, 'The port is owned by the current VibeCat service.', 'No action required.', false);
  if (current.warnings.some((warning) => warning.code === 'STALE_PID')) add('stale-state', 'WARN', current.warnings, 'Stale PID records make lifecycle state unreliable.', 'Run `vibecat stop --json` to clean owned state.');
  else add('stale-state', 'PASS', { stale: false }, 'Lifecycle state is current.', 'No action required.', false);
  return { checks, coreReady: !checks.some((check) => check.status === 'FAIL' && !['browser-bridge', 'scriptcat-client'].includes(check.name)), browserReady: checks.filter((check) => ['browser-bridge', 'scriptcat-client'].includes(check.name)).every((check) => check.status === 'PASS') };
}

module.exports = { locateInstallation, resolveContext, statusProject, startSession, stopSession, commandBrowser, pushProject, runDoctor, bundleProject, verifiedOwnedProcess, getHealth, portAvailable };
