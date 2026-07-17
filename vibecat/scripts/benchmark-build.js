#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { resolveProject } = require('../src/project');
const { bundleProject, createWatchContext } = require('../src/build');

function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { runs: values.length, minMs: +sorted[0].toFixed(2), medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2), maxMs: +sorted.at(-1).toFixed(2), meanMs: +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2) };
}
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecat-benchmark-'));
  try {
    fs.mkdirSync(path.join(directory, 'src'));
    const entry = path.join(directory, 'src', 'main.ts');
    const header = `// ==UserScript==\n// @name Benchmark\n// @version 1.0.0\n// @match https://example.com/*\n// ==/UserScript==`;
    fs.writeFileSync(entry, `${header}\nimport { value } from './value'; console.log(value);`); fs.writeFileSync(path.join(directory, 'src', 'value.ts'), 'export const value = 0;');
    fs.writeFileSync(path.join(directory, 'vibecat.config.cjs'), `module.exports={entry:'src/main.ts',output:'dist/benchmark.user.js',build:{sourcemap:true,target:'chrome120'}}`);
    const project = resolveProject(directory); const cold = [];
    for (let index = 0; index < 10; index += 1) { const started = performance.now(); await bundleProject(project); cold.push(performance.now() - started); }
    const incremental = []; let resolveBuild; let started;
    const context = await createWatchContext(project, { onBuild() { if (resolveBuild) { incremental.push(performance.now() - started); resolveBuild(); resolveBuild = null; } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (let index = 1; index <= 10; index += 1) {
      const complete = new Promise((resolve) => { resolveBuild = resolve; }); started = performance.now(); fs.writeFileSync(path.join(directory, 'src', 'value.ts'), `export const value = ${index};`); await complete;
    }
    await context.dispose();
    const memory = process.memoryUsage();
    process.stdout.write(`${JSON.stringify({ scenario: 'two-module TypeScript userscript with source map', method: '10 programmatic clean builds followed by 10 edits on one esbuild watch context', environment: { platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0].model, logicalCpus: os.cpus().length }, coldBuild: stats(cold), incrementalRebuild: stats(incremental), memoryMiB: { rss: +(memory.rss / 1048576).toFixed(1), heapUsed: +(memory.heapUsed / 1048576).toFixed(1) }, cpu: 'not isolated', eventLoopLag: 'not sampled for sub-100ms build operations' }, null, 2)}\n`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
