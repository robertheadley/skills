'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { detectEnvironment, normalizePath, msysToWindows, createOwnedTempDir, removeOwnedTempDir } = require('../src/paths');

test('detects MSYS and WSL explicitly', () => {
  assert.equal(detectEnvironment({ MSYSTEM: 'MINGW64' }, 'win32'), 'msys');
  assert.equal(detectEnvironment({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux'), 'wsl');
});
test('normalizes Windows native, slash, space, and MSYS drive paths', () => {
  assert.equal(normalizePath('C:\\Users\\Test User\\project', { environment: 'windows' }), 'C:\\Users\\Test User\\project');
  assert.equal(normalizePath('C:/Users/Test User/project', { environment: 'windows' }), 'C:\\Users\\Test User\\project');
  assert.equal(msysToWindows('/c/Users/Test User/project'), 'C:\\Users\\Test User\\project');
  assert.equal(normalizePath('/c/Users/Test User/project', { environment: 'msys' }), 'C:\\Users\\Test User\\project');
});
test('preserves UNC WSL paths when running on Windows', { skip: process.platform !== 'win32' }, () => {
  assert.equal(normalizePath('\\\\wsl$\\Ubuntu\\home\\user\\project', { environment: 'windows' }), '\\\\wsl$\\Ubuntu\\home\\user\\project');
});
test('refuses ambiguous cross-environment path conversion', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => normalizePath('C:\\Users\\x', { environment: 'unix' }), (error) => error.code === 'AMBIGUOUS_PATH_ENVIRONMENT');
});
test('temporary directories are native, uniquely owned, and safely cleaned', () => {
  const first = createOwnedTempDir(); const second = createOwnedTempDir(); assert.notEqual(first, second);
  assert.equal(first.startsWith(os.tmpdir()), true); assert.equal(fs.existsSync(path.join(first, '.vibecat-owned.json')), true);
  removeOwnedTempDir(first); removeOwnedTempDir(second); assert.equal(fs.existsSync(first), false);
});
test('cleanup refuses an unowned temporary directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'not-vibecat-'));
  try { assert.throws(() => removeOwnedTempDir(directory), (error) => error.code === 'TEMP_OWNERSHIP_MISMATCH'); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
