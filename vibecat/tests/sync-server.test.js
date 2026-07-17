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
