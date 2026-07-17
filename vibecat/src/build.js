'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const ts = require('typescript');
const { extractMetadata, metadataFromObject } = require('./metadata');
const { VibeCatError } = require('./errors');

function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, content);
  if (!fs.existsSync(temporary) || fs.statSync(temporary).size !== Buffer.byteLength(content)) throw new Error(`Atomic write validation failed: ${target}`);
  fs.renameSync(temporary, target);
}

function syntaxCheck(source, filename) {
  const body = source.replace(/^\s*\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');
  try { new vm.Script(body, { filename }); }
  catch (error) {
    throw new VibeCatError('OUTPUT_SYNTAX_INVALID', `Generated JavaScript is invalid: ${error.message}`, {
      evidence: { filename }, retryable: true,
      nextActions: ['Fix the reported source error and rerun `vibecat build --json`.'],
    });
  }
}

function runTypecheck(project) {
  if (!project.typed) return { requested: true, passed: true, diagnostics: [] };
  const configPath = ts.findConfigFile(project.projectPath, ts.sys.fileExists, 'tsconfig.json');
  /** @type {import('typescript').CompilerOptions} */
  let options = { noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJsonModule: true, skipLibCheck: true };
  let files = [project.entryPoint];
  if (configPath) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, project.projectPath, { noEmit: true }, configPath);
    options = parsed.options;
    files = parsed.fileNames;
  }
  const program = ts.createProgram(files, options);
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file && diagnostic.file.fileName,
    line: diagnostic.file && diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start || 0).line + 1,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }));
  return { requested: true, passed: diagnostics.length === 0, diagnostics };
}

function getMetadata(project, source) {
  const extracted = extractMetadata(source);
  if (extracted.valid) return extracted;
  if (project.config.metadata) {
    const block = metadataFromObject(project.config.metadata);
    return extractMetadata(`${block}\n`);
  }
  throw new VibeCatError('METADATA_INVALID', 'Userscript metadata is missing or invalid.', {
    evidence: { entryPoint: project.entryPoint, errors: extracted.errors }, retryable: true,
    nextActions: ['Add a valid metadata header to the entry file or `metadata` to vibecat.config.ts.'],
  });
}

async function bundleProject(project, options = {}) {
  const started = Date.now();
  const source = fs.readFileSync(project.entryPoint, 'utf8');
  const metadata = getMetadata(project, source);
  if (!metadata.valid) throw new VibeCatError('METADATA_INVALID', 'Userscript metadata validation failed.', { evidence: { errors: metadata.errors }, retryable: true });
  const shouldTypecheck = options.typecheck || project.config.validation && project.config.validation.requireTypecheck;
  const typecheckPromise = shouldTypecheck ? Promise.resolve().then(() => runTypecheck(project)) : Promise.resolve({ requested: false, passed: null, diagnostics: [] });
  let code;
  let sourceMap = null;
  let moduleCount = 1;
  const warnings = [];

  if (!project.typed && path.resolve(project.entryPoint) === path.resolve(project.outputFile)) {
    code = source;
  } else {
    try {
      const buildResult = await esbuild.build({
        entryPoints: [project.entryPoint], bundle: true, write: false, format: 'iife', platform: 'browser',
        outfile: project.outputFile,
        target: project.target, minify: options.production === true || project.config.build && project.config.build.minify === true,
        sourcemap: project.sourceMap ? 'external' : false, metafile: true, legalComments: 'none',
        banner: { js: metadata.block }, loader: { '.json': 'json' }, logLevel: 'silent',
      });
      warnings.push(...buildResult.warnings.map((warning) => ({ code: 'ESBUILD_WARNING', message: warning.text })));
      const jsOutput = buildResult.outputFiles.find((file) => file.path.endsWith('.js')) || buildResult.outputFiles.find((file) => !file.path.endsWith('.map'));
      const mapOutput = buildResult.outputFiles.find((file) => file.path.endsWith('.map'));
      code = jsOutput.text;
      if (mapOutput) sourceMap = mapOutput.text;
      moduleCount = Object.keys(buildResult.metafile.inputs).length;
    } catch (error) {
      throw new VibeCatError('BUILD_FAILED', `esbuild failed: ${error.errors && error.errors[0] ? error.errors[0].text : error.message}`, {
        evidence: { entryPoint: project.entryPoint, errors: error.errors || [] }, retryable: true,
        nextActions: ['Fix the source error; the previous known-good output was preserved.', 'Rerun `vibecat build --json`.'],
      });
    }
  }
  const builtMetadata = extractMetadata(code);
  if (!builtMetadata.valid) throw new VibeCatError('METADATA_INVALID', 'Generated output metadata is invalid.', { evidence: { errors: builtMetadata.errors }, retryable: true });
  syntaxCheck(code, project.outputFile);
  const typecheck = await typecheckPromise;
  if (shouldTypecheck && !typecheck.passed) {
    throw new VibeCatError('TYPECHECK_FAILED', `TypeScript type checking failed with ${typecheck.diagnostics.length} diagnostic(s).`, {
      evidence: { diagnostics: typecheck.diagnostics }, retryable: true,
      nextActions: ['Fix the TypeScript diagnostics and rerun `vibecat build --typecheck --json`.'],
    });
  }
  if (path.resolve(project.entryPoint) !== path.resolve(project.outputFile)) {
    atomicWrite(project.outputFile, code);
    if (sourceMap) {
      const mapPath = `${project.outputFile}.map`;
      atomicWrite(mapPath, sourceMap);
      if (!code.includes('sourceMappingURL=')) atomicWrite(project.outputFile, `${code.trimEnd()}\n//# sourceMappingURL=${path.basename(mapPath)}\n`);
    }
  }
  const finalCode = fs.readFileSync(project.outputFile, 'utf8');
  return {
    entryPoint: project.entryPoint, outputFile: project.outputFile, durationMs: Date.now() - started,
    moduleCount, outputBytes: Buffer.byteLength(finalCode), sourceMap: sourceMap ? `${project.outputFile}.map` : null,
    hash: crypto.createHash('sha256').update(finalCode).digest('hex'),
    typecheck, metadata: { valid: true, name: builtMetadata.name, version: builtMetadata.version }, warnings,
  };
}

async function createWatchContext(project, options = {}) {
  if (!project.typed) throw new VibeCatError('WATCH_CONTEXT_NOT_REQUIRED', 'Plain JavaScript userscripts are watched directly by the sync service.', { retryable: false });
  const plugin = {
    name: 'vibecat-atomic-output',
    setup(build) {
      build.onEnd(async (buildResult) => {
        if (buildResult.errors.length) {
          const error = new VibeCatError('BUILD_FAILED', `esbuild watch failed: ${buildResult.errors[0].text}`, { evidence: { errors: buildResult.errors }, retryable: true });
          if (options.onError) await options.onError(error);
          return;
        }
        try {
          const source = fs.readFileSync(project.entryPoint, 'utf8');
          const metadata = getMetadata(project, source);
          const jsOutput = buildResult.outputFiles.find((file) => file.path.endsWith('.js')) || buildResult.outputFiles.find((file) => !file.path.endsWith('.map'));
          const mapOutput = buildResult.outputFiles.find((file) => file.path.endsWith('.map'));
          let code = `${metadata.block}\n${jsOutput.text.replace(/^\s*\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '')}`;
          syntaxCheck(code, project.outputFile);
          const typecheck = options.typecheck ? runTypecheck(project) : { requested: false, passed: null, diagnostics: [] };
          if (options.typecheck && !typecheck.passed) throw new VibeCatError('TYPECHECK_FAILED', `TypeScript type checking failed with ${typecheck.diagnostics.length} diagnostic(s).`, { evidence: { diagnostics: typecheck.diagnostics }, retryable: true });
          if (mapOutput) {
            atomicWrite(`${project.outputFile}.map`, mapOutput.text);
            code = `${code.trimEnd()}\n//# sourceMappingURL=${path.basename(project.outputFile)}.map\n`;
          }
          atomicWrite(project.outputFile, code);
          const result = {
            entryPoint: project.entryPoint, outputFile: project.outputFile, moduleCount: buildResult.metafile ? Object.keys(buildResult.metafile.inputs).length : null,
            outputBytes: Buffer.byteLength(code), sourceMap: mapOutput ? `${project.outputFile}.map` : null,
            hash: crypto.createHash('sha256').update(code).digest('hex'), typecheck,
            metadata: { valid: true, name: metadata.name, version: metadata.version }, warnings: buildResult.warnings,
          };
          if (options.onBuild) await options.onBuild(result);
        } catch (error) { if (options.onError) await options.onError(error); }
      });
    },
  };
  const context = await esbuild.context({
    entryPoints: [project.entryPoint], bundle: true, write: false, outfile: project.outputFile,
    format: 'iife', platform: 'browser', target: project.target, sourcemap: project.sourceMap ? 'external' : false,
    metafile: true, legalComments: 'none', loader: { '.json': 'json' }, logLevel: 'silent', plugins: [plugin],
  });
  await context.watch();
  return context;
}

module.exports = { atomicWrite, syntaxCheck, runTypecheck, bundleProject, createWatchContext };
