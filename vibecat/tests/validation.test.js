'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const WebSocket = require('ws');
const { resolveProject } = require('../src/project');
const { bundleProject } = require('../src/build');
const { startSession, stopSession, pushProject } = require('../src/services');
const { writeState } = require('../src/state');
const { execute } = require('../bin/vibecat');

function availablePort() { return new Promise((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
function nextUpdate(socket) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Timed out waiting for update.')), 5000); socket.on('message', function handler(raw) { const message = JSON.parse(raw.toString()); if (message.action !== 'onchange') return; clearTimeout(timer); socket.off('message', handler); resolve(message); }); }); }

test('full validation proves exact build execution and configured DOM assertions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecat-validation-')); const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecat-validation-runtime-')); const previousRuntime = process.env.VIBECAT_RUNTIME_DIR; process.env.VIBECAT_RUNTIME_DIR = runtime;
  let project; let extension; let dom;
  t.after(async () => { if (extension) extension.close(); if (dom) dom.window.close(); if (project) await stopSession(project).catch(() => {}); if (previousRuntime === undefined) delete process.env.VIBECAT_RUNTIME_DIR; else process.env.VIBECAT_RUNTIME_DIR = previousRuntime; fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(runtime, { recursive: true, force: true }); });
  const port = await availablePort(); fs.mkdirSync(path.join(directory, 'src'));
  fs.writeFileSync(path.join(directory, 'src', 'main.ts'), `// ==UserScript==\n// @name Validation Test\n// @version 1.0.0\n// @match https://example.com/*\n// ==/UserScript==\ndocument.body.setAttribute('data-vibecat-ready','yes'); document.body.style.borderLeftStyle='solid';`);
  fs.writeFileSync(path.join(directory, 'vibecat.config.cjs'), `module.exports={entry:'src/main.ts',output:'dist/test.user.js',service:{port:${port}},browser:{urlPattern:'https://example.com/*'},validation:{requireTypecheck:true,selectors:[{selector:'[data-vibecat-ready]',minimumMatches:1}],assertions:[{type:'attribute',selector:'[data-vibecat-ready]',attribute:'data-vibecat-ready'},{type:'style',selector:'[data-vibecat-ready]',property:'border-left-style',equals:'solid'}]}}`);
  project = resolveProject(directory); const build = await bundleProject(project, { typecheck: true }); writeState(project.projectPath, { lastBuild: build }); await startSession(project);
  extension = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: 'chrome-extension://test' } }); await new Promise((resolve) => extension.once('open', resolve));
  const updatePromise = nextUpdate(extension); const pushPromise = pushProject(project, { ackTimeoutMs: 8000 }); const update = await updatePromise;
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/page', runScripts: 'outside-only', pretendToBeVisual: true }); dom.window.WebSocket = WebSocket;
  dom.window.eval(update.data.script.replace(/^\s*\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, ''));
  const pushed = await pushPromise; assert.equal(pushed.browserAcknowledged, true);
  const validated = await execute(['validate'], { project: directory, browser: true, typecheck: true }); assert.equal(validated.state, 'VALIDATED'); assert.equal(validated.guarantees.browserExecution, true); assert.equal(validated.checks.some((check) => check.name.startsWith('style:')), true);
});
