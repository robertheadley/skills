'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const WebSocket = require('ws');
const { createSyncServer, isAllowedOrigin } = require('../src/server');

function userscript(version, body = '') {
  return `// ==UserScript==\n// @name Test Script\n// @namespace test\n// @version ${version}\n// @match https://example.com/*\n// ==/UserScript==\n${body}\n`;
}
async function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecat-server-test-'));
  const filePath = path.join(directory, 'fixture.user.js'); fs.writeFileSync(filePath, userscript('1.0.0'));
  const logs = []; const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (message) => logs.push({ level, message })]));
  const server = await createSyncServer({ filePath, port: 0, watch: false, logger, debugLogPath: path.join(directory, 'events.jsonl'), ...options });
  return { directory, filePath, logs, server, async close() { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
function nextJson(socket, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', handler); reject(new Error('Timed out waiting for WebSocket message.')); }, timeoutMs);
    function handler(raw) { const message = JSON.parse(raw.toString()); if (!predicate(message)) return; clearTimeout(timer); socket.off('message', handler); resolve(message); }
    socket.on('message', handler);
  });
}
async function connectExtension(server, origin = 'chrome-extension://scriptcat-test') {
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { headers: origin ? { Origin: origin } : {} });
  const hello = await nextJson(socket); assert.deepEqual(hello, { action: 'hello' }); return socket;
}
async function executeDelivered(server, source) {
  const dom = new JSDOM('<!doctype html><html lang="en"><body><main role="main"><button id="save" aria-label="Save item">Save</button><input id="secret" type="password" value="hunter2"><ul><li role="listitem" data-testid="item-1">First</li></ul></main></body></html>', {
    url: 'https://example.com/page', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  dom.window.WebSocket = WebSocket;
  dom.window.URL.createObjectURL = () => 'blob:vibecat-test'; dom.window.URL.revokeObjectURL = () => {};
  dom.window.Image = class { set src(_value) { queueMicrotask(() => this.onload && this.onload()); } };
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  dom.window.HTMLCanvasElement.prototype.toDataURL = () => `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
  const executable = source.replace(/^\s*\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');
  dom.window.eval(executable);
  const deadline = Date.now() + 3000;
  while (!server.health().browser.connected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.health().browser.connected, true);
  return dom;
}

test('origin policy accepts native and extension peers but rejects ordinary pages', () => {
  assert.equal(isAllowedOrigin(undefined), true); assert.equal(isAllowedOrigin('chrome-extension://abc'), true);
  assert.equal(isAllowedOrigin('moz-extension://abc'), true); assert.equal(isAllowedOrigin('https://attacker.example'), false);
});

test('server binds to loopback and preserves ScriptCat hello/onchange compatibility', async (t) => {
  const f = await fixture(); t.after(() => f.close()); assert.equal(f.server.address().address, '127.0.0.1');
  const socket = await connectExtension(f.server); t.after(() => socket.close());
  fs.writeFileSync(f.filePath, userscript('1.0.1', 'console.log("updated");'));
  const updatePromise = nextJson(socket, (message) => message.action === 'onchange'); const delivery = await f.server.syncNow('test'); const update = await updatePromise;
  assert.equal(delivery.sent, true); assert.equal(update.data.script.startsWith('// ==UserScript=='), true);
  assert.equal(update.data.script.includes('__vibecatReport'), true); assert.equal(update.data.script.includes('action: \'push\''), false);
  assert.match(update.data.uri, /^file:\/\//); assert.equal(update.data.hash, delivery.hash);
});

test('ordinary web origins are rejected before source is disclosed', async (t) => {
  const f = await fixture(); t.after(() => f.close()); const socket = new WebSocket(`ws://127.0.0.1:${f.server.address().port}`, { headers: { Origin: 'https://attacker.example' } });
  const status = await new Promise((resolve, reject) => { socket.once('unexpected-response', (_request, response) => resolve(response.statusCode)); socket.once('open', () => reject(new Error('Unexpected connection.'))); socket.once('error', () => {}); });
  assert.equal(status, 403); socket.terminate();
});

test('unchanged content is suppressed outside an explicit API push', async (t) => {
  const f = await fixture(); t.after(() => f.close()); const first = await f.server.syncNow('initial'); const second = await f.server.syncNow('unchanged');
  assert.equal(first.reason, 'no_clients'); assert.equal(second.reason, 'unchanged'); assert.match(second.hash, /^[a-f0-9]{64}$/);
});

test('authenticated live browser bridge exposes bounded DOM operations and redaction', async (t) => {
  const f = await fixture(); t.after(() => f.close()); const extension = await connectExtension(f.server); t.after(() => extension.close());
  fs.writeFileSync(f.filePath, userscript('2.0.0', 'console.info("executed build");'));
  const updatePromise = nextJson(extension, (message) => message.action === 'onchange'); await f.server.syncNow('browser-test'); const update = await updatePromise;
  const dom = await executeDelivered(f.server, update.data.script); t.after(() => dom.window.close());
  const page = await f.server.sendCommand('page', {}, 2000); assert.equal(page.url, 'https://example.com/page'); assert.equal(page.language, 'en');
  const matches = await f.server.sendCommand('query', { selector: '[role="listitem"]', limit: 5 }, 2000); assert.equal(matches.length, 1); assert.equal(matches[0].text, 'First');
  const password = await f.server.sendCommand('query', { selector: '#secret' }, 2000); const attributes = await f.server.sendCommand('attributes', { handle: password[0].handle }, 2000); assert.equal(attributes.value, '[REDACTED]');
  const tree = await f.server.sendCommand('tree', { depth: 1, maxNodes: 2 }, 2000); assert.equal(tree.nodeCount <= 2, true); assert.equal(tree.maxDepth, 1);
  const suggestion = await f.server.sendCommand('selectorSuggest', { handle: matches[0].handle }, 2000); assert.equal(suggestion.generatedClassDependent, false); assert.match(suggestion.selector, /role|data-testid/);
  dom.window.document.querySelector('[role="listitem"]').remove();
  await assert.rejects(() => f.server.sendCommand('element', { handle: matches[0].handle }, 2000), (error) => error.code === 'STALE_ELEMENT_HANDLE');
});

test('callExposed invokes only functions the userscript explicitly exposed', async (t) => {
  const f = await fixture(); t.after(() => f.close()); const extension = await connectExtension(f.server); t.after(() => extension.close());
  fs.writeFileSync(f.filePath, userscript('3.0.0', '__vibecatExpose("buildSceneQueries", (site, performers) => performers.map((p) => site + "." + p.toLowerCase().replace(/\\s+/g, "-")));'));
  const updatePromise = nextJson(extension, (message) => message.action === 'onchange'); await f.server.syncNow('call-test'); const update = await updatePromise;
  const dom = await executeDelivered(f.server, update.data.script); t.after(() => dom.window.close());
  const called = await f.server.sendCommand('callExposed', { name: 'buildSceneQueries', args: ['brazzersexxtra', ['Emily Norman', 'Zac Wild']] }, 2000);
  assert.deepEqual(called.result, ['brazzersexxtra.emily-norman', 'brazzersexxtra.zac-wild']);
  const missing = await f.server.sendCommand('callExposed', { name: 'nope', args: [] }, 2000).catch((error) => error);
  assert.equal(missing.code, 'EXPOSED_FUNCTION_NOT_FOUND');
});

test('XPath, styles, rectangles, highlighting, mutations, and screenshots use named operations', async (t) => {
  const f = await fixture(); t.after(() => f.close()); const extension = await connectExtension(f.server); t.after(() => extension.close());
  const updatePromise = nextJson(extension, (message) => message.action === 'onchange'); await f.server.syncNow('inspection-test'); const update = await updatePromise;
  const dom = await executeDelivered(f.server, update.data.script); t.after(() => dom.window.close());
  const buttons = await f.server.sendCommand('queryXPath', { xpath: '//button' }, 2000); assert.equal(buttons.length, 1);
  const styles = await f.server.sendCommand('styles', { handle: buttons[0].handle, properties: ['display'] }, 2000); assert.equal(typeof styles.display, 'string');
  const rect = await f.server.sendCommand('rect', { handle: buttons[0].handle }, 2000); assert.equal(typeof rect.width, 'number');
  assert.equal((await f.server.sendCommand('highlight', { handle: buttons[0].handle, durationMs: 10 }, 2000)).highlighted, true);
  await f.server.sendCommand('mutationsStart', {}, 2000); const item = dom.window.document.createElement('p'); item.textContent = 'dynamic'; dom.window.document.body.appendChild(item); await new Promise((resolve) => setTimeout(resolve, 10));
  const mutationLog = await f.server.sendCommand('mutationsRead', { limit: 10 }, 2000); assert.equal(mutationLog.events.some((event) => event.added.some((added) => added.text === 'dynamic')), true);
  const screenshot = await f.server.sendCommand('screenshot', { handle: buttons[0].handle }, 3000); assert.match(screenshot.dataUrl, /^data:image\/png;base64,/); assert.equal(screenshot.method, 'dom-foreign-object');
  assert.equal((await f.server.sendCommand('mutationsStop', {}, 2000)).active, false);
});

test('browser bridge authentication and project scoping reject incorrect tokens and projects', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const denied = new WebSocket(`ws://127.0.0.1:${f.server.address().port}/?role=browser&token=wrong`);
  const deniedStatus = await new Promise((resolve) => { denied.once('unexpected-response', (_request, response) => resolve(response.statusCode)); denied.once('error', () => {}); }); assert.equal(deniedStatus, 401);
  const token = f.server.getDebugConfig().token; const wrongProject = new WebSocket(`ws://127.0.0.1:${f.server.address().port}/?role=browser&token=${token}`);
  await new Promise((resolve) => wrongProject.once('open', resolve)); wrongProject.send(JSON.stringify({ action: 'browserHello', data: { projectId: 'wrong', hash: 'x', url: 'https://example.com', title: 'x', sessionNonce: 'x' } }));
  const closeCode = await new Promise((resolve) => wrongProject.once('close', resolve)); assert.equal(closeCode, 4003);
});

async function connectBrowser(server, projectId) {
  const { token } = server.getDebugConfig();
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/?role=browser&token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ action: 'browserHello', data: { projectId, hash: 'pending', url: 'https://example.com/', title: 'Test Page', sessionNonce: 'nonce-1' } }));
  await nextJson(socket, (message) => message.action === 'browserAccepted');
  return socket;
}

test('browser bridge reload operation triggers a page reload', async (t) => {
  const f = await fixture({ projectId: 'bridge-reload-project' }); t.after(() => f.close()); const extension = await connectExtension(f.server); t.after(() => extension.close());
  fs.writeFileSync(f.filePath, userscript('2.0.3', 'console.info("executed");'));
  const updatePromise = nextJson(extension, (message) => message.action === 'onchange'); await f.server.syncNow('bridge-reload'); const update = await updatePromise;
  const dom = await executeDelivered(f.server, update.data.script); t.after(() => dom.window.close());
  const result = await f.server.sendCommand('reload', {}, 2000); assert.equal(result.reloading, true);
});

test('reload mode auto-reloads the connected page after every delivery', async (t) => {
  const f = await fixture({ reload: true, projectId: 'reload-test-project' }); t.after(() => f.close());
  const extension = await connectExtension(f.server); t.after(() => extension.close());
  const browser = await connectBrowser(f.server, 'reload-test-project'); t.after(() => browser.close());
  fs.writeFileSync(f.filePath, userscript('2.0.1', 'console.log("reload me");'));
  const reloadPromise = nextJson(browser, (message) => message.action === 'command' && message.operation === 'reload');
  await f.server.syncNow('reload-test');
  const command = await reloadPromise;
  assert.equal(command.operation, 'reload');
  assert.equal(f.server.health().reload, true);
});

test('without reload mode the page is not reloaded on delivery', async (t) => {
  const f = await fixture({ projectId: 'no-reload-project' }); t.after(() => f.close());
  const extension = await connectExtension(f.server); t.after(() => extension.close());
  const browser = await connectBrowser(f.server, 'no-reload-project'); t.after(() => browser.close());
  fs.writeFileSync(f.filePath, userscript('2.0.2', 'console.log("stay");'));
  let reloaded = false;
  const watcher = (raw) => { const message = JSON.parse(raw.toString()); if (message.action === 'command' && message.operation === 'reload') reloaded = true; };
  browser.on('message', watcher);
  await f.server.syncNow('no-reload-test');
  await new Promise((resolve) => setTimeout(resolve, 300));
  browser.off('message', watcher);
  assert.equal(reloaded, false);
  assert.equal(f.server.health().reload, false);
});

async function rawBrowser(server, projectId, hash) {
  const { token } = server.getDebugConfig();
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/?role=browser&token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ action: 'browserHello', data: { projectId, hash, url: 'https://example.com/', title: 'Tab', sessionNonce: `n-${Math.random()}` } }));
  await nextJson(socket, (message) => message.action === 'browserAccepted');
  return socket;
}

test('reload mode refreshes a connecting page that runs a stale build', async (t) => {
  const f = await fixture({ reload: true, projectId: 'stale-connect-project' }); t.after(() => f.close());
  const extension = await connectExtension(f.server); t.after(() => extension.close());
  fs.writeFileSync(f.filePath, userscript('3.0.0', 'console.log("latest");')); await f.server.syncNow('seed');
  const browser = await rawBrowser(f.server, 'stale-connect-project', 'stale-hash'); t.after(() => browser.close());
  const command = await nextJson(browser, (message) => message.action === 'command' && message.operation === 'reload');
  assert.equal(command.operation, 'reload');
});

test('reload mode leaves a connecting page running the current build alone', async (t) => {
  const f = await fixture({ reload: true, projectId: 'current-connect-project' }); t.after(() => f.close());
  const extension = await connectExtension(f.server); t.after(() => extension.close());
  fs.writeFileSync(f.filePath, userscript('3.0.1', 'console.log("current");')); const delivery = await f.server.syncNow('seed');
  const browser = await rawBrowser(f.server, 'current-connect-project', delivery.hash); t.after(() => browser.close());
  let reloaded = false;
  const watcher = (raw) => { const message = JSON.parse(raw.toString()); if (message.action === 'command' && message.operation === 'reload') reloaded = true; };
  browser.on('message', watcher);
  await new Promise((resolve) => setTimeout(resolve, 300));
  browser.off('message', watcher);
  assert.equal(reloaded, false);
});

test('default mode prompts the page to refresh after delivery (notify, no reload)', async (t) => {
  const f = await fixture({ projectId: 'notify-delivery-project' }); t.after(() => f.close());
  const extension = await connectExtension(f.server); t.after(() => extension.close());
  const browser = await rawBrowser(f.server, 'notify-delivery-project', 'pending'); t.after(() => browser.close());
  fs.writeFileSync(f.filePath, userscript('3.1.0', 'console.log("notify me");'));
  const notifyPromise = nextJson(browser, (message) => message.action === 'command' && message.operation === 'notify');
  await f.server.syncNow('notify-test');
  const command = await notifyPromise;
  assert.equal(command.operation, 'notify');
  assert.equal(typeof command.args.message, 'string');
  assert.equal(f.server.health().reload, false);
});

test('default mode prompts a page connecting on a stale build to refresh', async (t) => {
  const f = await fixture({ projectId: 'notify-stale-project' }); t.after(() => f.close());
  const extension = await connectExtension(f.server); t.after(() => extension.close());
  fs.writeFileSync(f.filePath, userscript('3.1.1', 'console.log("latest");')); await f.server.syncNow('seed');
  const browser = await rawBrowser(f.server, 'notify-stale-project', 'stale-hash'); t.after(() => browser.close());
  const command = await nextJson(browser, (message) => message.action === 'command' && message.operation === 'notify');
  assert.equal(command.operation, 'notify');
});

test('browser bridge notify operation shows a toast in the page', async (t) => {
  const f = await fixture({ projectId: 'notify-toast-project' }); t.after(() => f.close());
  const extension = await connectExtension(f.server); t.after(() => extension.close());
  fs.writeFileSync(f.filePath, userscript('3.1.2', 'console.info("executed");'));
  const updatePromise = nextJson(extension, (message) => message.action === 'onchange'); await f.server.syncNow('toast-test'); const update = await updatePromise;
  const dom = await executeDelivered(f.server, update.data.script); t.after(() => dom.window.close());
  const result = await f.server.sendCommand('notify', { message: 'Refresh me now' }, 2000);
  assert.equal(result.notified, true);
  const toast = dom.window.document.querySelector('[role="status"]');
  assert.equal(toast !== null, true);
  assert.equal(toast.textContent, 'Refresh me now');
});
