'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { VibeCatError } = require('./errors');

function detectEnvironment(env = process.env, platform = process.platform) {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return 'wsl';
  if (env.MSYSTEM || env.MINGW_PREFIX || env.SHELL && /(?:msys|mingw|git)[^/]*\.exe$/i.test(env.SHELL)) return 'msys';
  if (platform === 'win32') return env.ComSpec && /cmd\.exe$/i.test(env.ComSpec) && !env.PSModulePath ? 'cmd' : 'windows';
  return platform === 'darwin' ? 'macos' : 'unix';
}

function expandHome(input, env = process.env) {
  if (input === '~' || input.startsWith('~/') || input.startsWith('~\\')) {
    const home = os.homedir();
    return path.join(home, input.slice(2));
  }
  return input;
}

function msysToWindows(input) {
  const match = input.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
  if (!match) return null;
  return `${match[1].toUpperCase()}:\\${(match[2] || '').replace(/\//g, '\\')}`;
}

function normalizePath(input, options = {}) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new VibeCatError('INVALID_PATH', 'A non-empty path is required.', {
      evidence: { input }, retryable: true, nextActions: ['Provide an absolute project path with `--project <path>`.'],
    });
  }
  const environment = options.environment || detectEnvironment(options.env, options.platform);
  let value = expandHome(input.trim(), options.env);
  const isMsysPath = /^\/[a-zA-Z](?:\/|$)/.test(value);
  const isWindowsDrive = /^[a-zA-Z]:[\\/]/.test(value);

  if (isMsysPath) {
    if (!['msys', 'windows', 'cmd'].includes(environment) && process.platform !== 'win32') {
      throw new VibeCatError('AMBIGUOUS_PATH_ENVIRONMENT', `Cannot safely convert MSYS path outside a detected Windows/MSYS environment: ${input}`, {
        evidence: { input, environment }, retryable: true,
        nextActions: ['Pass the native absolute path used by the current runtime.'],
      });
    }
    value = msysToWindows(value);
  } else if (isWindowsDrive && process.platform !== 'win32' && environment !== 'msys') {
    throw new VibeCatError('AMBIGUOUS_PATH_ENVIRONMENT', `Cannot safely convert a Windows drive path in ${environment}: ${input}`, {
      evidence: { input, environment }, retryable: true,
      nextActions: ['Pass the mounted native path visible to this runtime.'],
    });
  }

  if (process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value)) {
    value = value.replace(/\//g, '\\');
    return path.win32.normalize(path.win32.isAbsolute(value) ? value : path.win32.resolve(options.cwd || process.cwd(), value));
  }
  return path.resolve(options.cwd || process.cwd(), value);
}

function projectKey(projectPath) {
  return crypto.createHash('sha256').update(process.platform === 'win32' ? projectPath.toLowerCase() : projectPath).digest('hex').slice(0, 16);
}

function createOwnedTempDir(prefix = 'vibecat-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const marker = path.join(directory, '.vibecat-owned.json');
  fs.writeFileSync(marker, JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }), { mode: 0o600 });
  return directory;
}

function removeOwnedTempDir(directory) {
  const resolved = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  const marker = path.join(resolved, '.vibecat-owned.json');
  if (!resolved.startsWith(`${tempRoot}${path.sep}`) || !fs.existsSync(marker)) {
    throw new VibeCatError('TEMP_OWNERSHIP_MISMATCH', 'Refusing to remove a directory not proven to be VibeCat-owned.', {
      evidence: { directory: resolved, tempRoot }, retryable: false,
    });
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

module.exports = { detectEnvironment, normalizePath, msysToWindows, projectKey, createOwnedTempDir, removeOwnedTempDir };
