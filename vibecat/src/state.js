'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { APP_ROOT } = require('./constants');
const { projectKey } = require('./paths');

function runtimeRoot() { return process.env.VIBECAT_RUNTIME_DIR ? path.resolve(process.env.VIBECAT_RUNTIME_DIR) : path.join(APP_ROOT, '.runtime', 'projects'); }
function stateDir(projectPath) { return path.join(runtimeRoot(), projectKey(projectPath)); }
function statePath(projectPath) { return path.join(stateDir(projectPath), 'session.json'); }

function atomicWriteJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  JSON.parse(fs.readFileSync(temporary, 'utf8'));
  fs.renameSync(temporary, target);
}

function readState(projectPath) {
  const target = statePath(projectPath);
  if (!fs.existsSync(target)) return null;
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch { return null; }
}

function writeState(projectPath, patch) {
  const existing = readState(projectPath) || {};
  const next = { ...existing, ...patch, projectPath, updatedAt: new Date().toISOString() };
  atomicWriteJson(statePath(projectPath), next);
  return next;
}

function removeState(projectPath) {
  const directory = stateDir(projectPath);
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
}

function listStates() {
  const root = runtimeRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const target = path.join(root, entry.name, 'session.json');
    try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

module.exports = { runtimeRoot, stateDir, statePath, atomicWriteJson, readState, writeState, removeState, listStates };
