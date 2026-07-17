'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveProject } = require('../src/project');
const { bundleProject, createWatchContext } = require('../src/build');
const { extractMetadata } = require('../src/metadata');

function tempProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecat-build-test-')); }
function write(directory, relative, content) { const target = path.join(directory, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); return target; }
const HEADER = `// ==UserScript==\n// @name Build Test\n// @namespace test\n// @version 1.0.0\n// @match https://example.com/*\n// ==/UserScript==`;

test('bundles modular TypeScript and JSON imports with metadata first and source maps', async (t) => {
  const directory = tempProject(); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  write(directory, 'src/value.ts', 'export const value: number = 42;'); write(directory, 'src/data.json', '{"label":"ready"}');
  write(directory, 'src/main.ts', `${HEADER}\nimport { value } from './value'; import data from './data.json'; document.body.dataset.result = data.label + value;`);
  write(directory, 'vibecat.config.ts', `export default { entry: 'src/main.ts', output: 'dist/test.user.js', build: { sourcemap: true, target: 'chrome120' } };`);
  write(directory, 'tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', resolveJsonModule: true, strict: true }, include: ['src'] }));
  const project = resolveProject(directory); const result = await bundleProject(project, { typecheck: true }); const output = fs.readFileSync(result.outputFile, 'utf8');
  assert.equal(output.startsWith('// ==UserScript=='), true); assert.equal(output.match(/==UserScript==/g).length, 1); assert.equal(result.moduleCount, 3); assert.equal(result.typecheck.passed, true);
  assert.equal(fs.existsSync(`${result.outputFile}.map`), true); assert.match(output, /sourceMappingURL=test\.user\.js\.map/); assert.equal(extractMetadata(output).valid, true);
});

test('production builds optionally minify without moving metadata', async (t) => {
  const directory = tempProject(); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  write(directory, 'src/main.ts', `${HEADER}\nconst veryLongVariableName: string = 'hello'; console.log(veryLongVariableName);`);
  write(directory, 'vibecat.config.cjs', `module.exports={entry:'src/main.ts',output:'dist/out.user.js',build:{sourcemap:false}}`);
  const project = resolveProject(directory); const development = await bundleProject(project); const devBytes = development.outputBytes; const production = await bundleProject(project, { production: true });
  assert.equal(production.outputBytes < devBytes, true); assert.equal(fs.readFileSync(production.outputFile, 'utf8').startsWith('// ==UserScript=='), true);
});

test('type errors fail separately from successful esbuild transpilation', async (t) => {
  const directory = tempProject(); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  write(directory, 'src/main.ts', `${HEADER}\nconst count: number = 'wrong'; console.log(count);`); write(directory, 'vibecat.config.cjs', `module.exports={entry:'src/main.ts',output:'dist/out.user.js'}`);
  const project = resolveProject(directory); const transpiled = await bundleProject(project); assert.equal(transpiled.typecheck.requested, false);
  await assert.rejects(() => bundleProject(project, { typecheck: true }), (error) => error.code === 'TYPECHECK_FAILED' && error.evidence.diagnostics.length > 0);
});

test('syntax failure preserves the previous known-good bundle', async (t) => {
  const directory = tempProject(); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entry = write(directory, 'src/main.ts', `${HEADER}\nconsole.log('good');`); write(directory, 'vibecat.config.cjs', `module.exports={entry:'src/main.ts',output:'dist/out.user.js'}`);
  const project = resolveProject(directory); await bundleProject(project); const previous = fs.readFileSync(project.outputFile, 'utf8'); fs.writeFileSync(entry, `${HEADER}\nconst broken = ;`);
  await assert.rejects(() => bundleProject(project), (error) => error.code === 'BUILD_FAILED'); assert.equal(fs.readFileSync(project.outputFile, 'utf8'), previous);
});

test('plain JavaScript userscripts remain source-compatible and unmodified', async (t) => {
  const directory = tempProject(); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = `${HEADER}\nconsole.log('plain');\n`; const entry = write(directory, 'plain.user.js', source); const project = resolveProject(directory); const result = await bundleProject(project);
  assert.equal(result.outputFile, entry); assert.equal(fs.readFileSync(entry, 'utf8'), source);
});

test('metadata generation and duplicate singleton validation are deterministic', async (t) => {
  const directory = tempProject(); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  write(directory, 'src/main.ts', `console.log('generated');`); write(directory, 'vibecat.config.cjs', `module.exports={entry:'src/main.ts',output:'dist/out.user.js',metadata:{name:'Generated',version:'1.0.0',match:['https://example.com/*'],grant:['none']}}`);
  const result = await bundleProject(resolveProject(directory)); assert.equal(extractMetadata(fs.readFileSync(result.outputFile, 'utf8')).name, 'Generated');
  const invalid = extractMetadata(`${HEADER.replace('@version 1.0.0', '@version 1.0.0\n// @version 2.0.0')}\n`); assert.equal(invalid.valid, false); assert.equal(invalid.errors.some((error) => error.code === 'METADATA_DUPLICATE'), true);
});

test('incremental esbuild context survives a syntax error and recovers on the next save', async (t) => {
  const directory = tempProject(); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entry = write(directory, 'src/main.ts', `${HEADER}\nconsole.log('first');`); write(directory, 'vibecat.config.cjs', `module.exports={entry:'src/main.ts',output:'dist/out.user.js',build:{sourcemap:false}}`);
  const project = resolveProject(directory); const builds = []; const errors = [];
  let notify; const changed = () => new Promise((resolve) => { notify = resolve; }); let event = changed();
  const context = await createWatchContext(project, { onBuild(value) { builds.push(value); if (notify) notify(); }, onError(error) { errors.push(error); if (notify) notify(); } });
  t.after(() => context.dispose()); await event; assert.equal(builds.length, 1);
  event = changed(); fs.writeFileSync(entry, `${HEADER}\nconst broken = ;`); await event; assert.equal(errors.some((error) => error.code === 'BUILD_FAILED'), true);
  event = changed(); fs.writeFileSync(entry, `${HEADER}\nconsole.log('recovered');`); await event; assert.equal(builds.length >= 2, true); assert.match(fs.readFileSync(project.outputFile, 'utf8'), /recovered/);
});
