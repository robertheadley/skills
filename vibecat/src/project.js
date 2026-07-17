'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const { normalizePath } = require('./paths');
const { VibeCatError } = require('./errors');

const CONFIG_NAMES = ['vibecat.config.ts', 'vibecat.config.js', 'vibecat.config.cjs', 'vibecat.config.json'];
const ENTRY_CANDIDATES = ['src/main.ts', 'src/main.tsx', 'src/main.js', 'src/main.jsx', 'index.ts', 'index.js'];

function loadConfig(projectPath) {
  const configPath = CONFIG_NAMES.map((name) => path.join(projectPath, name)).find(fs.existsSync);
  if (!configPath) return { config: {}, configPath: null };
  try {
    if (configPath.endsWith('.json')) return { config: JSON.parse(fs.readFileSync(configPath, 'utf8')), configPath };
    if (configPath.endsWith('.cjs')) {
      delete require.cache[require.resolve(configPath)];
      return { config: require(configPath), configPath };
    }
    const built = esbuild.buildSync({
      entryPoints: [configPath], bundle: true, write: false, platform: 'node', format: 'cjs',
      target: `node${process.versions.node.split('.')[0]}`, logLevel: 'silent',
    });
    /** @type {any} */
    const ModuleInternal = Module;
    const compiled = new ModuleInternal(configPath, require.main);
    compiled.filename = configPath;
    compiled.paths = ModuleInternal._nodeModulePaths(path.dirname(configPath));
    compiled._compile(built.outputFiles[0].text, configPath);
    return { config: compiled.exports.default || compiled.exports, configPath };
  } catch (error) {
    throw new VibeCatError('CONFIG_INVALID', `Unable to load ${configPath}: ${error.message}`, {
      evidence: { configPath }, retryable: true,
      nextActions: ['Fix the VibeCat configuration and rerun `vibecat doctor --json`.'],
    });
  }
}

function resolveProject(input, options = {}) {
  const projectPath = normalizePath(input || options.cwd || process.cwd(), { cwd: options.cwd });
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    throw new VibeCatError('PROJECT_NOT_FOUND', `Project directory does not exist: ${projectPath}`, {
      evidence: { projectPath }, retryable: true,
      nextActions: ['Pass an existing absolute directory with `--project <path>`.'],
    });
  }
  const { config, configPath } = loadConfig(projectPath);
  let entry = options.entry || config.entry;
  if (entry) entry = path.resolve(projectPath, entry);
  if (!entry) entry = ENTRY_CANDIDATES.map((candidate) => path.join(projectPath, candidate)).find(fs.existsSync);
  if (!entry) {
    const userscripts = fs.readdirSync(projectPath).filter((name) => name.endsWith('.user.js'));
    if (userscripts.length === 1) entry = path.join(projectPath, userscripts[0]);
    else if (userscripts.length > 1) {
      throw new VibeCatError('PROJECT_ENTRY_AMBIGUOUS', `Multiple userscripts were found in ${projectPath}.`, {
        evidence: { candidates: userscripts }, retryable: true,
        nextActions: ['Set `entry` in vibecat.config.ts or pass `--file <path>`.'],
      });
    }
  }
  if (!entry || !fs.existsSync(entry)) {
    throw new VibeCatError('PROJECT_ENTRY_MISSING', `No userscript entry point was found in ${projectPath}.`, {
      evidence: { searched: [...ENTRY_CANDIDATES, '*.user.js'] }, retryable: true,
      nextActions: ['Create src/main.ts, add one .user.js file, or configure `entry`.'],
    });
  }
  const typed = /\.tsx?$/.test(entry);
  const defaultName = typed ? `${path.basename(projectPath).replace(/\s+/g, '-').toLowerCase()}.user.js` : path.basename(entry);
  const output = path.resolve(projectPath, config.output || (typed ? path.join('dist', defaultName) : path.relative(projectPath, entry)));
  return {
    projectPath, config, configPath, entryPoint: entry, outputFile: output,
    typed, sourceMap: config.build && config.build.sourcemap !== undefined ? config.build.sourcemap : typed,
    target: config.build && config.build.target || 'chrome120',
    port: Number(config.service && config.service.port || 8642),
  };
}

module.exports = { CONFIG_NAMES, ENTRY_CANDIDATES, loadConfig, resolveProject };
