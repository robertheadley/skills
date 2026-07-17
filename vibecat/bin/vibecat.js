#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const pkg = require('../package.json');
const { APP_ROOT } = require('../src/constants');
const { result, failedResult } = require('../src/result');
const { asVibeCatError, VibeCatError } = require('../src/errors');
const { normalizePath } = require('../src/paths');
const { resolveProject } = require('../src/project');
const { readState, writeState, stateDir } = require('../src/state');
const {
  locateInstallation, resolveContext, statusProject, startSession, stopSession,
  commandBrowser, pushProject, runDoctor, bundleProject, getHealth,
} = require('../src/services');

const HELP = `VibeCat ${pkg.version}

Usage: vibecat <command> [options]

Core:       help, version, locate, install, update, uninstall, doctor
Lifecycle:  bootstrap, start, status, connect, stop
Build:      build, watch, push, validate
Inspect:    inspect page|landmarks|tree|element, query, query-xpath
Element:    attributes, text, styles, rect, highlight
Selectors:  selector suggest|test|compare
Mutations:  mutations start|read|clear|stop
Capture:    screenshot

Common options:
  --project <absolute-path>  Target userscript project
  --json                     Emit one JSON result on stdout
  --help                     Show help
`;

function parseArgs(argv) {
  const options = {}; const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const equal = value.indexOf('=');
    if (equal > 0) { options[value.slice(2, equal)] = value.slice(equal + 1); continue; }
    const name = value.slice(2);
    if (index + 1 < argv.length && !argv[index + 1].startsWith('--') && !['json', 'plan', 'execute', 'force', 'typecheck', 'production', 'push', 'validate', 'browser', 'visible-only', 'minify', 'connect'].includes(name)) options[name] = argv[++index];
    else options[name] = true;
  }
  return { options, positionals };
}
function human(output) {
  const lines = [`VibeCat: ${output.state}`];
  if (output.projectPath) lines.push(`Project: ${output.projectPath}`);
  if (output.entryPoint) lines.push(`Entry: ${output.entryPoint}`);
  if (output.outputFile) lines.push(`Output: ${output.outputFile}`);
  if (output.browser) lines.push(`Browser: ${output.browser.connected ? 'CONNECTED' : 'DISCONNECTED'}`);
  for (const error of output.errors || []) lines.push(`Error ${error.code}: ${error.message}`);
  for (const action of output.nextActions || []) lines.push(`Next: ${action}`);
  return lines.join('\n');
}
function emit(output, json) { process.stdout.write(`${json ? JSON.stringify(output) : human(output)}\n`); }
function projectFrom(options) {
  if (options.file) {
    const entry = normalizePath(String(options.file), { cwd: options.project ? normalizePath(String(options.project)) : process.cwd() });
    return resolveProject(options.project ? String(options.project) : path.dirname(entry), { entry });
  }
  return resolveContext(options.project && String(options.project));
}
function numeric(options, name, fallback) { return options[name] === undefined ? fallback : Number(options[name]); }

function browserArgs(options) {
  /** @type {Record<string, any>} */
  const args = {
    ...(options.root ? { root: options.root } : {}), ...(options.handle ? { handle: options.handle } : {}),
    depth: numeric(options, 'depth', undefined), maxNodes: numeric(options, 'max-nodes', undefined),
    limit: numeric(options, 'limit', undefined), visibleOnly: options['visible-only'] === true,
  };
  return args;
}

async function startWatcher(project, options) {
  if (!fs.existsSync(project.outputFile) || project.typed) {
    const initialBuild = await bundleProject(project, { typecheck: options.typecheck });
    writeState(project.projectPath, { lastBuild: initialBuild });
  }
  let status = await statusProject(project);
  if (!status.health && options.push) status = await startSession(project);
  if (status.watcherOwned) return statusProject(project);
  const runtime = stateDir(project.projectPath); fs.mkdirSync(runtime, { recursive: true });
  const stdoutPath = path.join(runtime, 'watch.stdout.jsonl'); const stderrPath = path.join(runtime, 'watch.stderr.jsonl');
  const out = fs.openSync(stdoutPath, 'w'); const err = fs.openSync(stderrPath, 'w');
  const child = spawn(process.execPath, [path.join(APP_ROOT, 'src', 'watch-worker.js'), project.projectPath, ...(options.typecheck ? ['--typecheck'] : [])], {
    cwd: APP_ROOT, detached: true, stdio: ['ignore', out, err], windowsHide: true,
  });
  fs.closeSync(out); fs.closeSync(err); child.unref();
  writeState(project.projectPath, { state: 'WATCHING', watcherPid: child.pid, watcherStartedAt: new Date().toISOString(), watcherStdout: stdoutPath, watcherStderr: stderrPath });
  const deadline = Date.now() + 8000;
  do { await new Promise((resolve) => setTimeout(resolve, 100)); status = await statusProject(project); if (status.state && status.state.lastBuild) break; } while (Date.now() < deadline);
  if (!status.watcherOwned) throw new VibeCatError('WATCH_START_FAILED', 'The VibeCat watch worker exited before becoming active.', { evidence: { stderr: fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '' }, retryable: true });
  return status;
}

function npmCliPath() {
  return [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter(Boolean).find(fs.existsSync);
}
function atomicText(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true }); const temporary = `${target}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(temporary, content); fs.renameSync(temporary, target);
}
function launcherDescriptor(installationPath) {
  const npmCli = npmCliPath();
  const prefixResult = npmCli ? spawnSync(process.execPath, [npmCli, 'prefix', '-g'], { encoding: 'utf8', windowsHide: true }) : null;
  const prefix = prefixResult && prefixResult.status === 0 ? prefixResult.stdout.trim() : null;
  const launcherDir = prefix ? (process.platform === 'win32' ? prefix : path.join(prefix, 'bin')) : path.join(os.homedir(), '.local', 'bin');
  const launcherPath = path.join(launcherDir, process.platform === 'win32' ? 'vibecat.cmd' : 'vibecat');
  const content = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${path.join(installationPath, 'bin', 'vibecat.js')}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${path.join(installationPath, 'bin', 'vibecat.js')}" "$@"\n`;
  return { launcherDir, launcherPath, content };
}
function installLauncher(installationPath, force) {
  const { launcherDir, launcherPath, content } = launcherDescriptor(installationPath);
  if (fs.existsSync(launcherPath) && fs.readFileSync(launcherPath, 'utf8') !== content && !force) throw new VibeCatError('LAUNCHER_CONFLICT', `A different vibecat launcher already exists: ${launcherPath}`, { evidence: { launcherPath, installationPath }, retryable: true, nextActions: ['Inspect the existing launcher, then rerun update with `--force` if it is obsolete.'] });
  atomicText(launcherPath, content); if (process.platform !== 'win32') fs.chmodSync(launcherPath, 0o755);
  const pathEntries = (process.env.PATH || '').split(path.delimiter).map((entry) => path.resolve(entry).toLowerCase());
  return { launcherPath, onPath: pathEntries.includes(path.resolve(launcherDir).toLowerCase()) };
}
function copyInstallation(source, target, force, createLauncher = true) {
  const resolvedSource = normalizePath(source || APP_ROOT); const resolvedTarget = normalizePath(target || path.join(os.homedir(), '.vibecat'));
  if (resolvedSource === resolvedTarget) return { source: resolvedSource, target: resolvedTarget, changed: false };
  if (fs.existsSync(resolvedTarget) && !force) throw new VibeCatError('INSTALL_TARGET_EXISTS', `Installation target already exists: ${resolvedTarget}`, { retryable: true, nextActions: ['Rerun with `--force` only after confirming the target is a VibeCat installation.'] });
  if (createLauncher) {
    const planned = launcherDescriptor(resolvedTarget);
    if (fs.existsSync(planned.launcherPath) && fs.readFileSync(planned.launcherPath, 'utf8') !== planned.content && !force) throw new VibeCatError('LAUNCHER_CONFLICT', `A different vibecat launcher already exists: ${planned.launcherPath}`, { evidence: { launcherPath: planned.launcherPath, installationPath: resolvedTarget }, retryable: true, nextActions: ['Inspect the existing launcher, then rerun update with `--force` if it is obsolete.'] });
  }
  const parent = path.dirname(resolvedTarget); fs.mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(resolvedTarget)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.cpSync(resolvedSource, staging, { recursive: true, filter: (item) => !/[\\/](?:\.git|\.runtime|node_modules)(?:[\\/]|$)/.test(item) });
  if (!fs.existsSync(path.join(staging, 'bin', 'vibecat.js'))) { fs.rmSync(staging, { recursive: true, force: true }); throw new VibeCatError('INSTALL_SOURCE_INVALID', 'The installation source is incomplete.', { evidence: { source: resolvedSource }, retryable: false }); }
  const npmCli = npmCliPath();
  const installed = npmCli
    ? spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts=false'], { cwd: staging, encoding: 'utf8', windowsHide: true })
    : spawnSync(process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'npm.cmd') : 'npm', ['ci', '--omit=dev', '--ignore-scripts=false'], { cwd: staging, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
  if (installed.status !== 0 || !fs.existsSync(path.join(staging, 'node_modules', 'esbuild'))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new VibeCatError('INSTALL_DEPENDENCIES_FAILED', 'VibeCat dependencies could not be installed in the staged installation.', { evidence: { status: installed.status, error: installed.error && installed.error.message, stderr: installed.stderr && installed.stderr.slice(-2000) }, retryable: true, nextActions: ['Confirm npm can access the configured registry, then retry installation.'] });
  }
  if (fs.existsSync(resolvedTarget)) fs.rmSync(resolvedTarget, { recursive: true, force: true });
  fs.renameSync(staging, resolvedTarget);
  const launcher = createLauncher ? installLauncher(resolvedTarget, force) : null;
  return { source: resolvedSource, target: resolvedTarget, changed: true, launcher };
}

async function execute(positionals, options) {
  const command = positionals[0] || 'help'; const subcommand = positionals[1];
  if (options.help || command === 'help') return result('help', { state: 'INSTALLED', text: HELP, version: pkg.version, nextActions: ['Run `vibecat locate --json`.'] });
  if (command === 'version') return result('version', { state: 'INSTALLED', version: pkg.version, nextActions: [] });
  if (command === 'locate') {
    const located = locateInstallation();
    return result('locate', { state: located.selected ? 'INSTALLED' : 'UNAVAILABLE', ...located, warnings: located.candidates.length > 1 ? [{ code: 'DUPLICATE_INSTALLATION', message: `${located.candidates.length} VibeCat installations were detected.` }] : [], nextActions: located.selected ? [] : ['Run `vibecat install --from <path> --json`.'] });
  }
  if (['install', 'update'].includes(command)) {
    const action = copyInstallation(options.from || APP_ROOT, options.target || path.join(os.homedir(), '.vibecat'), options.force || command === 'update', !options['no-launcher']);
    return result(command, { state: 'INSTALLED', installation: action, evidence: { atomicStaging: true, launcherCreated: Boolean(action.launcher) }, warnings: action.launcher && !action.launcher.onPath ? [{ code: 'LAUNCHER_DIRECTORY_NOT_ON_PATH', message: `Launcher created at ${action.launcher.launcherPath}, but its directory is not present in this process PATH.` }] : [], nextActions: ['Run `vibecat locate --json` from an unrelated directory.', 'Run `vibecat doctor --project <path> --json`.'] });
  }
  if (command === 'uninstall') {
    const target = normalizePath(options.target || path.join(os.homedir(), '.vibecat'));
    if (target === APP_ROOT) throw new VibeCatError('UNINSTALL_ACTIVE_REPOSITORY_REFUSED', 'Refusing to remove the active source repository.', { retryable: false });
    if (!fs.existsSync(target)) return result('uninstall', { state: 'UNAVAILABLE', removed: false, nextActions: [] });
    if (!fs.existsSync(path.join(target, 'bin', 'vibecat.js'))) throw new VibeCatError('UNINSTALL_TARGET_INVALID', 'Refusing to remove a directory that is not a complete VibeCat installation.', { evidence: { target }, retryable: false });
    const launcher = launcherDescriptor(target).launcherPath;
    const launcherReferencesTarget = fs.existsSync(launcher) && fs.readFileSync(launcher, 'utf8').includes(path.join(target, 'bin', 'vibecat.js'));
    fs.rmSync(target, { recursive: true, force: true });
    if (launcherReferencesTarget) fs.rmSync(launcher, { force: true });
    return result('uninstall', { state: 'UNAVAILABLE', removed: true, target, launcherRemoved: launcherReferencesTarget, nextActions: [] });
  }

  const project = projectFrom(options);
  if (command === 'doctor') {
    const doctor = await runDoctor(project); return result('doctor', { ok: doctor.coreReady, state: doctor.coreReady ? 'READY' : 'ERROR', projectPath: project.projectPath, ...doctor, nextActions: doctor.coreReady ? doctor.browserReady ? ['Run `vibecat inspect landmarks --json`.'] : ['Run `vibecat bootstrap --project <path> --plan --json`.'] : ['Resolve every FAIL check and rerun `vibecat doctor --json`.'] });
  }
  if (command === 'status') {
    const status = await statusProject(project); return result('status', { state: status.lifecycle, projectPath: project.projectPath, sessionId: status.state && status.state.sessionId, browser: status.health && status.health.browser || { connected: false }, build: status.state && status.state.lastBuild || { status: 'idle', entryPoint: project.entryPoint, outputFile: project.outputFile }, service: status.health, warnings: status.warnings, nextActions: status.lifecycle === 'CONNECTED' || status.lifecycle === 'WATCHING' ? ['Run `vibecat inspect landmarks --json`.'] : status.lifecycle === 'RUNNING' ? ['Load or reload the userscript in the intended browser tab.'] : ['Run `vibecat start --json`.'] });
  }
  if (command === 'bootstrap') {
    const plan = { fileChanges: [{ path: project.outputFile, action: project.outputFile === project.entryPoint ? 'validate' : 'build' }], processActions: [{ action: 'start-service', host: '127.0.0.1', port: project.port }], permissionSensitive: ['write build output', 'start loopback service'] };
    if (options.plan || !options.execute) return result('bootstrap', { state: 'READY', projectPath: project.projectPath, plan, executed: false, nextActions: ['Review this plan, then run `vibecat bootstrap --execute --json`.'] });
    const build = await bundleProject(project, { typecheck: options.typecheck, production: options.production });
    const status = await startSession(project); writeState(project.projectPath, { lastBuild: build });
    return result('bootstrap', { state: status.lifecycle, projectPath: project.projectPath, sessionId: status.state && status.state.sessionId, plan, executed: true, build, browser: status.health && status.health.browser || { connected: false }, nextActions: status.health && status.health.browser.connected ? ['Run `vibecat inspect landmarks --json`.'] : ['Load or reload the userscript in the intended tab, then run `vibecat connect --json`.'] });
  }
  if (command === 'start') {
    if (!fs.existsSync(project.outputFile) || project.typed) { const build = await bundleProject(project, { typecheck: options.typecheck }); writeState(project.projectPath, { lastBuild: build }); }
    const status = await startSession(project); return result('start', { state: status.lifecycle, projectPath: project.projectPath, sessionId: status.state && status.state.sessionId, service: status.health, browser: status.health && status.health.browser || { connected: false }, nextActions: status.health && status.health.browser.connected ? ['Run `vibecat inspect landmarks --json`.'] : ['Load or reload the userscript in the intended tab, then run `vibecat connect --json`.'] });
  }
  if (command === 'connect') {
    const status = await statusProject(project);
    if (!status.health) throw new VibeCatError('SERVICE_NOT_RUNNING', 'The VibeCat service is not running.', { retryable: true, nextActions: ['Run `vibecat start --json`.'] });
    if (!status.health.browser.connected) throw new VibeCatError('BROWSER_NOT_CONNECTED', 'No browser tab has acknowledged the authenticated VibeCat bridge.', { evidence: { activeSessions: status.health.browser_sessions }, retryable: true, nextActions: ['Load or reload the synchronized userscript in the intended tab.', 'Rerun `vibecat connect --json`.'] });
    return result('connect', { state: 'CONNECTED', projectPath: project.projectPath, sessionId: status.state.sessionId, browser: status.health.browser, evidence: { authenticated: true, projectScoped: true }, nextActions: ['Run `vibecat inspect landmarks --json`.'] });
  }
  if (command === 'stop') {
    writeState(project.projectPath, { state: 'STOPPING' });
    const stopped = await stopSession(project); return result('stop', { state: 'STOPPED', projectPath: project.projectPath, ...stopped, nextActions: [] });
  }
  if (command === 'build') {
    writeState(project.projectPath, { state: 'BUILDING' });
    const build = await bundleProject(project, { typecheck: options.typecheck, production: options.production }); writeState(project.projectPath, { state: 'READY', lastBuild: build });
    let pushed = null; if (options.push) pushed = await pushProject(project);
    return result('build', { state: pushed ? 'PUSHED' : 'READY', projectPath: project.projectPath, ...build, pushed: Boolean(pushed), browserAcknowledged: pushed && pushed.browserAcknowledged || false, browser: pushed && pushed.browser, nextActions: [pushed ? 'Run `vibecat validate --json`.' : 'Run `vibecat watch --push --json` or `vibecat push --json`.'] });
  }
  if (command === 'watch') {
    const status = await startWatcher(project, options); return result('watch', { state: 'WATCHING', projectPath: project.projectPath, sessionId: status.state && status.state.sessionId, watcher: { pid: status.state.watcherPid, startedAt: status.state.watcherStartedAt, push: Boolean(options.push) }, build: status.state.lastBuild, browser: status.health && status.health.browser || { connected: false }, nextActions: status.health && status.health.browser.connected ? ['Edit source; VibeCat will rebuild and ScriptCat will receive valid output.'] : ['Load or reload the userscript in the intended tab.'] });
  }
  if (command === 'push') {
    writeState(project.projectPath, { state: 'PUSHING' });
    const pushed = await pushProject(project, { file: options.file, ackTimeoutMs: options['ack-timeout'] }); return result('push', { state: 'PUSHED', projectPath: project.projectPath, ...pushed.delivery, pushed: true, browserAcknowledged: true, browser: pushed.browser, nextActions: ['Run `vibecat validate --json`.'] });
  }

  const inspectionMap = {
    'inspect:page': 'page', 'inspect:landmarks': 'landmarks', 'inspect:tree': 'tree', 'inspect:element': 'element',
    query: 'query', 'query-xpath': 'queryXPath', attributes: 'attributes', text: 'text', styles: 'styles', rect: 'rect', highlight: 'highlight',
    'selector:suggest': 'selectorSuggest', 'selector:test': 'selectorTest', 'selector:compare': 'selectorCompare',
    'mutations:start': 'mutationsStart', 'mutations:read': 'mutationsRead', 'mutations:clear': 'mutationsClear', 'mutations:stop': 'mutationsStop', screenshot: 'screenshot',
  };
  const key = ['inspect', 'selector', 'mutations'].includes(command) ? `${command}:${subcommand}` : command;
  if (inspectionMap[key]) {
    const args = browserArgs(options);
    if (command === 'query') args.selector = positionals[1];
    if (command === 'query-xpath') args.xpath = positionals[1];
    if (['attributes', 'text', 'styles', 'rect', 'highlight'].includes(command)) args.handle = positionals[1];
    if (command === 'inspect' && subcommand === 'element') args.handle = positionals[2];
    if (command === 'selector' && subcommand === 'suggest') args.handle = positionals[2];
    if (command === 'selector' && subcommand === 'test') args.selector = positionals[2];
    if (command === 'selector' && subcommand === 'compare') args.handles = positionals.slice(2);
    if (command === 'screenshot' && options.element) args.handle = options.element;
    const browserResult = await commandBrowser(project, inspectionMap[key], args, command === 'screenshot' ? 15000 : 5000);
    let data = browserResult.data;
    if (command === 'screenshot') {
      const target = normalizePath(options.output || path.join(project.projectPath, '.vibecat', `screenshot-${Date.now()}.png`), { cwd: project.projectPath });
      const match = data.dataUrl && data.dataUrl.match(/^data:image\/png;base64,(.*)$/);
      if (!match) throw new VibeCatError('SCREENSHOT_INVALID', 'The browser did not return a valid PNG capture.', { retryable: true });
      fs.mkdirSync(path.dirname(target), { recursive: true }); const temporary = `${target}.${process.pid}.tmp`; fs.writeFileSync(temporary, Buffer.from(match[1], 'base64')); fs.renameSync(temporary, target);
      data = { outputPath: target, width: data.width, height: data.height, method: data.method, bytes: fs.statSync(target).size };
    }
    return result(key, { state: 'CONNECTED', projectPath: project.projectPath, browser: browserResult.health.browser, data, evidence: { live: true, capturedAt: new Date().toISOString() }, nextActions: command === 'inspect' && subcommand === 'page' ? ['Run `vibecat inspect landmarks --json`.'] : [] });
  }
  if (command === 'validate') {
    writeState(project.projectPath, { state: 'VALIDATING' });
    const build = await bundleProject(project, { typecheck: options.typecheck || project.config.validation && project.config.validation.requireTypecheck });
    /** @type {Array<Record<string, any>>} */
    const checks = [{ name: 'build', status: 'PASS', evidence: { hash: build.hash } }, { name: 'metadata', status: 'PASS', evidence: build.metadata }, { name: 'syntax', status: 'PASS', evidence: { outputFile: build.outputFile } }];
    const status = await statusProject(project); const requireBrowser = options.browser || Boolean(project.config.browser || project.config.validation && (project.config.validation.selectors || project.config.validation.assertions));
    if (requireBrowser && !(status.health && status.health.browser.connected)) throw new VibeCatError('BROWSER_NOT_CONNECTED', 'Browser validation was required but no live tab is connected.', { evidence: { checks }, retryable: true, nextActions: ['Load the intended page and run `vibecat connect --json`.', 'Rerun `vibecat validate --browser --json`.'] });
    if (status.health && status.health.browser.connected) {
      checks.push({ name: 'browser-session', status: 'PASS', evidence: status.health.browser });
      if (status.health.browser.hash !== build.hash) throw new VibeCatError('STALE_BUILD', 'The connected page is not running the latest build.', { evidence: { builtHash: build.hash, browserHash: status.health.browser.hash }, retryable: true, nextActions: ['Run `vibecat push --json` and reload the page.'] });
      checks.push({ name: 'execution-acknowledgement', status: 'PASS', evidence: { hash: build.hash, tabHandle: status.health.browser.tabHandle } });
      for (const item of project.config.validation && project.config.validation.selectors || []) {
        const queried = await commandBrowser(project, 'selectorTest', { selector: item.selector }); const count = queried.data.matches;
        if (count < Number(item.minimumMatches || 1)) throw new VibeCatError('SELECTOR_ASSERTION_FAILED', `Selector ${item.selector} matched ${count} element(s).`, { evidence: { selector: item.selector, count, minimumMatches: item.minimumMatches || 1 }, retryable: true });
        checks.push({ name: `selector:${item.selector}`, status: 'PASS', evidence: { count } });
      }
      for (const assertion of project.config.validation && project.config.validation.assertions || []) {
        const queried = await commandBrowser(project, 'query', { selector: assertion.selector, limit: 1 });
        if (!queried.data.length) throw new VibeCatError('ASSERTION_TARGET_MISSING', `Assertion selector matched no elements: ${assertion.selector}`, { retryable: true });
        const handle = queried.data[0].handle;
        if (assertion.type === 'attribute') { const attributes = (await commandBrowser(project, 'attributes', { handle })).data; if (!Object.hasOwn(attributes, assertion.attribute)) throw new VibeCatError('ATTRIBUTE_ASSERTION_FAILED', `Expected attribute ${assertion.attribute} was not observed.`, { evidence: { selector: assertion.selector, attributes }, retryable: true }); }
        if (assertion.type === 'style') { const styles = (await commandBrowser(project, 'styles', { handle, properties: [assertion.property] })).data; if (styles[assertion.property] !== assertion.equals) throw new VibeCatError('STYLE_ASSERTION_FAILED', `Expected ${assertion.property} to equal ${assertion.equals}.`, { evidence: { observed: styles[assertion.property] }, retryable: true }); }
        checks.push({ name: `${assertion.type}:${assertion.selector}`, status: 'PASS', evidence: assertion });
      }
    }
    const eventLog = status.state && status.state.eventLog; const fatal = eventLog && fs.existsSync(eventLog) ? fs.readFileSync(eventLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((event) => ['error', 'unhandledrejection'].includes(event.level) && event.hash === build.hash) : [];
    if (fatal.length) throw new VibeCatError('BROWSER_RUNTIME_ERROR', `The latest build reported ${fatal.length} fatal runtime error(s).`, { evidence: { events: fatal.slice(-10) }, retryable: true });
    checks.push({ name: 'runtime-errors', status: 'PASS', evidence: { fatal: 0 } }); writeState(project.projectPath, { state: 'VALIDATED', lastValidation: { hash: build.hash, timestamp: new Date().toISOString(), checks } });
    return result('validate', { state: 'VALIDATED', projectPath: project.projectPath, build, checks, browser: status.health && status.health.browser || { connected: false }, guarantees: { built: true, typechecked: build.typecheck.requested ? build.typecheck.passed : null, metadataValid: true, syntaxValid: true, browserExecution: Boolean(status.health && status.health.browser.connected), runtimeErrors: 0 }, nextActions: [] });
  }
  throw new VibeCatError('COMMAND_UNKNOWN', `Unknown VibeCat command: ${positionals.join(' ')}`, { evidence: { command, subcommand }, retryable: true, nextActions: ['Run `vibecat help`.'] });
}

async function main(argv = process.argv.slice(2)) {
  const { options, positionals } = parseArgs(argv); const json = options.json === true;
  try {
    /** @type {any} */
    const output = await execute(positionals, options);
    if (output.text && !json) process.stdout.write(output.text); else emit(output, json);
    return 0;
  } catch (rawError) {
    const error = asVibeCatError(rawError); const command = positionals.slice(0, 2).join(' ') || 'unknown'; const context = {};
    try { if (options.project) context.projectPath = normalizePath(String(options.project)); } catch {}
    if (options.project && ['bootstrap', 'start', 'connect', 'build', 'watch', 'push', 'validate'].includes(positionals[0])) {
      try { const project = projectFrom(options); writeState(project.projectPath, { state: 'ERROR', lastError: { code: error.code, message: error.message, timestamp: new Date().toISOString() } }); } catch {}
    }
    emit(failedResult(command, error, context), json);
    return error.exitCode || 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });
module.exports = { main, parseArgs, execute };
