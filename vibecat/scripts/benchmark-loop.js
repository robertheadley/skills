#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const { createSyncServer } = require('../src/server');

function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { runs: values.length, minMs: +sorted[0].toFixed(2), medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2), maxMs: +sorted.at(-1).toFixed(2), meanMs: +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2) };
}
const bin = path.join(__dirname, '..', 'bin', 'vibecat.js');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecat-loop-benchmark-'));
  try {
    const coldStart = [];
    for (let index = 0; index < 5; index += 1) { const started = performance.now(); spawnSync(process.execPath, [bin, 'version'], { encoding: 'utf8' }); coldStart.push(performance.now() - started); }
    const filePath = path.join(directory, 'loop.user.js');
    const header = '// ==UserScript==\n// @name Loop\n// @version 1.0.0\n// @match https://example.com/*\n// ==/UserScript==';
    fs.writeFileSync(filePath, `${header}\nconsole.log(0);`);
    const server = await createSyncServer({ filePath, port: 0, watch: false, logger: { info() {}, warn() {}, error() {} } });
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { headers: { Origin: 'chrome-extension://bench' } });
    const helloPromise = new Promise((resolve) => socket.once('message', resolve));
    await new Promise((resolve) => socket.once('open', resolve)); await helloPromise; // drain server hello before measuring
    const delivery = [];
    for (let index = 1; index <= 10; index += 1) {
      fs.writeFileSync(filePath, `${header}\nconsole.log(${index});`);
      const received = new Promise((resolve) => socket.once('message', resolve));
      const started = performance.now(); await server.syncNow('bench'); await received; delivery.push(performance.now() - started);
    }
    socket.close(); await server.close();
    process.stdout.write(`${JSON.stringify({ scenario: 'rapid iteration loop: CLI cold start and server delivery to a connected ScriptCat peer', coldStart: stats(coldStart), deliveryToPeer: stats(delivery), environment: { platform: process.platform, node: process.version }, note: 'page reload and execution acknowledgment require a live browser bridge and are not measured here' }, null, 2)}\n`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
