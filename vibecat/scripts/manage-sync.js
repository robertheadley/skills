#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const action = process.argv[2];
const scriptPath = process.argv[3];
if (!['start', 'status', 'health', 'stop'].includes(action)) {
  console.error('Usage: node manage-sync.js <start|status|health|stop> [scriptPath]');
  process.exit(1);
}
const command = action === 'health' ? 'status' : action;
const args = [path.join(__dirname, '..', 'bin', 'vibecat.js'), command, '--json'];
if (scriptPath) args.push('--file', path.resolve(scriptPath));
const child = spawnSync(process.execPath, args, { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true });
if (child.stderr) process.stderr.write(child.stderr);
if (child.stdout) process.stdout.write(child.stdout);
process.exit(child.status === null ? 1 : child.status);
