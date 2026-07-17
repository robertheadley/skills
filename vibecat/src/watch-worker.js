#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveProject } = require('./project');
const { bundleProject, createWatchContext } = require('./build');
const { writeState } = require('./state');

async function main() {
  const projectPath = process.argv[2];
  if (!projectPath) throw new Error('A project path is required.');
  const project = resolveProject(projectPath);
  const typecheck = process.argv.includes('--typecheck');
  let building = false; let queued = false; let timer = null; let context = null;
  async function rebuild(reason) {
    if (building) { queued = true; return; }
    building = true; writeState(project.projectPath, { state: 'BUILDING', lastWatchReason: reason });
    try {
      const build = await bundleProject(project, { typecheck });
      writeState(project.projectPath, { state: 'WATCHING', lastBuild: build, lastBuildError: null });
      process.stdout.write(`${JSON.stringify({ event: 'build', ok: true, reason, ...build })}\n`);
    } catch (error) {
      writeState(project.projectPath, { state: 'DIRTY', lastBuildError: { code: error.code || 'BUILD_FAILED', message: error.message } });
      process.stderr.write(`${JSON.stringify({ event: 'build', ok: false, reason, error: { code: error.code || 'BUILD_FAILED', message: error.message } })}\n`);
    } finally { building = false; if (queued) { queued = false; rebuild('queued-change'); } }
  }
  let watchers = [];
  if (project.typed) {
    context = await createWatchContext(project, {
      typecheck,
      onBuild: async (build) => { writeState(project.projectPath, { state: 'WATCHING', lastBuild: build, lastBuildError: null }); process.stdout.write(`${JSON.stringify({ event: 'build', ok: true, ...build })}\n`); },
      onError: async (error) => { writeState(project.projectPath, { state: 'DIRTY', lastBuildError: { code: error.code || 'BUILD_FAILED', message: error.message } }); process.stderr.write(`${JSON.stringify({ event: 'build', ok: false, error: { code: error.code || 'BUILD_FAILED', message: error.message } })}\n`); },
    });
  } else {
    await rebuild('initial');
    watchers = [fs.watch(path.dirname(project.entryPoint), (_event, filename) => { if (filename && filename.toString() !== path.basename(project.entryPoint)) return; clearTimeout(timer); timer = setTimeout(() => rebuild(filename ? filename.toString() : 'source-change'), 80); })];
  }
  const stop = async () => { clearTimeout(timer); watchers.forEach((watcher) => watcher.close()); if (context) await context.dispose(); writeState(project.projectPath, { state: 'STOPPED', watcherPid: null }); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
