'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const CLI = path.resolve(__dirname, '..', 'bin', 'vibecat.js');
const HEADER = `// ==UserScript==\n// @name CLI Test\n// @version 1.0.0\n// @match https://example.com/*\n// ==/UserScript==`;
function availablePort() { return new Promise((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
async function fixture(t, typed = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecat-cli-test-')); const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecat-cli-runtime-')); const port = await availablePort();
  if (typed) { fs.mkdirSync(path.join(directory, 'src')); fs.writeFileSync(path.join(directory, 'src', 'main.ts'), `${HEADER}\nconsole.log('typed');`); fs.writeFileSync(path.join(directory, 'vibecat.config.cjs'), `module.exports={entry:'src/main.ts',output:'dist/test.user.js',service:{port:${port}}}`); }
  else { fs.writeFileSync(path.join(directory, 'test.user.js'), `${HEADER}\nconsole.log('plain');`); fs.writeFileSync(path.join(directory, 'vibecat.config.cjs'), `module.exports={entry:'test.user.js',output:'test.user.js',service:{port:${port}}}`); }
  const env = { ...process.env, VIBECAT_RUNTIME_DIR: runtime };
  function run(args) { const child = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 20000, windowsHide: true }); return { ...child, json: child.stdout.trim() ? JSON.parse(child.stdout) : null }; }
  t.after(() => { try { run(['stop', '--project', directory, '--json']); } catch {} fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(runtime, { recursive: true, force: true }); });
  return { directory, runtime, port, run };
}

test('help, version, and locate emit one valid JSON document', async (t) => {
  const f = await fixture(t); for (const args of [['help', '--json'], ['version', '--json'], ['locate', '--json']]) { const run = f.run(args); assert.equal(run.status, 0); assert.equal(run.stderr, ''); assert.equal(run.json.ok, true); assert.doesNotThrow(() => JSON.parse(run.stdout)); }
});

test('doctor distinguishes core readiness from optional browser readiness', async (t) => {
  const f = await fixture(t); const run = f.run(['doctor', '--project', f.directory, '--json']); assert.equal(run.status, 0); assert.equal(run.json.coreReady, true); assert.equal(run.json.browserReady, false);
  assert.equal(run.json.checks.find((check) => check.name === 'browser-bridge').status, 'WARN'); assert.equal(run.json.nextActions.length > 0, true);
});

test('bootstrap plan is non-mutating and execute starts an owned service', async (t) => {
  const f = await fixture(t, true); const output = path.join(f.directory, 'dist', 'test.user.js');
  const plan = f.run(['bootstrap', '--project', f.directory, '--plan', '--json']); assert.equal(plan.status, 0); assert.equal(plan.json.executed, false); assert.equal(fs.existsSync(output), false);
  const execute = f.run(['bootstrap', '--project', f.directory, '--execute', '--json']); assert.equal(execute.status, 0); assert.equal(execute.json.executed, true); assert.equal(fs.existsSync(output), true); assert.equal(execute.json.state, 'RUNNING');
  const status = f.run(['status', '--project', f.directory, '--json']); assert.equal(status.json.state, 'RUNNING'); assert.equal(status.json.service.pid > 0, true);
});

test('stop terminates only recorded owned processes and is idempotent', async (t) => {
  const f = await fixture(t); assert.equal(f.run(['start', '--project', f.directory, '--json']).status, 0);
  const first = f.run(['stop', '--project', f.directory, '--json']); assert.equal(first.status, 0); assert.equal(first.json.stopped.some((item) => item.kind === 'service'), true);
  const second = f.run(['stop', '--project', f.directory, '--json']); assert.equal(second.status, 0); assert.equal(second.json.idempotent, true); assert.equal(second.json.state, 'STOPPED');
});

test('watch starts a persistent rebuild worker and stop cleans it with the service', async (t) => {
  const f = await fixture(t, true); const watch = f.run(['watch', '--project', f.directory, '--push', '--json']); assert.equal(watch.status, 0); assert.equal(watch.json.state, 'WATCHING'); assert.equal(watch.json.watcher.pid > 0, true);
  fs.writeFileSync(path.join(f.directory, 'src', 'main.ts'), `${HEADER}\nconsole.log('changed');`); await new Promise((resolve) => setTimeout(resolve, 600));
  const status = f.run(['status', '--project', f.directory, '--json']); assert.equal(status.json.state, 'WATCHING'); assert.equal(status.json.build.hash.length, 64);
  const stop = f.run(['stop', '--project', f.directory, '--json']); assert.equal(stop.json.stopped.some((item) => item.kind === 'watcher'), true); assert.equal(stop.json.stopped.some((item) => item.kind === 'service'), true);
});

test('failures use a stable error schema, nonzero exit, and next actions', async (t) => {
  const f = await fixture(t); const run = f.run(['query', '#missing', '--project', f.directory, '--json']); assert.notEqual(run.status, 0); assert.equal(run.json.ok, false); assert.equal(run.json.state, 'ERROR'); assert.equal(run.json.errors[0].code, 'SERVICE_NOT_RUNNING'); assert.equal(run.json.errors[0].retryable, true); assert.equal(run.json.nextActions.length > 0, true);
});

test('installation is staged, repeat-safe, force-updatable, discoverable, and removable', async (t) => {
  const f = await fixture(t); const target = path.join(f.directory, 'installed-vibecat');
  const installed = f.run(['install', '--from', path.resolve(__dirname, '..'), '--target', target, '--no-launcher', '--json']); assert.equal(installed.status, 0); assert.equal(installed.json.installation.changed, true); assert.equal(fs.existsSync(path.join(target, 'node_modules', 'esbuild')), true);
  const repeated = f.run(['install', '--from', path.resolve(__dirname, '..'), '--target', target, '--no-launcher', '--json']); assert.notEqual(repeated.status, 0); assert.equal(repeated.json.errors[0].code, 'INSTALL_TARGET_EXISTS');
  const updated = f.run(['update', '--from', path.resolve(__dirname, '..'), '--target', target, '--no-launcher', '--json']); assert.equal(updated.status, 0); assert.equal(updated.json.state, 'INSTALLED');
  const removed = f.run(['uninstall', '--target', target, '--json']); assert.equal(removed.status, 0); assert.equal(removed.json.removed, true); assert.equal(fs.existsSync(target), false);
});

test('browser-required validation fails rather than claiming offline success', async (t) => {
  const f = await fixture(t); const run = f.run(['validate', '--project', f.directory, '--browser', '--json']); assert.notEqual(run.status, 0); assert.equal(run.json.errors[0].code, 'BROWSER_NOT_CONNECTED'); assert.equal(run.json.state, 'ERROR');
});
