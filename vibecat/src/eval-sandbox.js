'use strict';

// `vibecat eval`: run a userscript function in a sandboxed, browser-less
// Node.js vm context and return its result. The sandbox provides minimal
// DOM/GM/location stubs so DOM-light code boots, network access is disabled,
// and top-level function declarations (after unwrapping the init-template
// IIFE wrapper) are reachable from the evaluated expression. This collapses
// the edit -> push -> reload -> events loop for pure-function testing
// (search-URL construction, query generation, date formatting, ...) to a
// single sub-second command.

const vm = require('node:vm');
const { extractMetadata } = require('./metadata');
const { VibeCatError } = require('./errors');

function elementStub() {
  return {
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, removeChild() {}, insertBefore() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getAttribute() { return null; }, hasAttribute() { return false; }, closest() { return null; },
    getBoundingClientRect() { return { x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }; },
    set textContent(_value) {}, get textContent() { return ''; },
    set innerHTML(_value) {}, get innerHTML() { return ''; },
    set innerText(_value) {}, get innerText() { return ''; },
    get children() { return []; }, get parentElement() { return null; }, get firstElementChild() { return null; },
  };
}

function makeSandbox() {
  const element = elementStub();
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder, JSON, Math, Date, RegExp, Error, TypeError, RangeError, String, Number, Boolean, Array, Object, Promise, Map, Set, WeakMap, WeakSet, Symbol, BigInt, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, escape, unescape,
    location: { href: 'about:blank', protocol: 'about:', hostname: '', pathname: '', search: '', hash: '', origin: 'null' },
    navigator: { userAgent: 'vibecat-eval' },
    document: {
      documentElement: { dataset: {}, style: {} }, body: element, head: { appendChild() {}, removeChild() {} },
      createElement: () => elementStub(), createTextNode: () => ({}), createDocumentFragment: () => elementStub(),
      querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, getElementsByClassName: () => [], getElementsByTagName: () => [],
      addEventListener() {}, removeEventListener() {}, readyState: 'complete',
    },
    GM: {
      getValue: async (_key, fallback) => fallback,
      setValue: async () => {},
      getValues: async () => ({}),
      getResourceText: async () => '',
      deleteValue: async () => {},
      xmlHttpRequest: (options) => {
        const error = new Error('Network access is disabled in the vibecat eval sandbox.');
        /** @type {any} */ (error).code = 'EVAL_NETWORK_DISABLED';
        if (options && typeof options.onerror === 'function') options.onerror(error);
        else throw error;
      },
    },
    fetch: () => Promise.reject(Object.assign(new Error('Network access is disabled in the vibecat eval sandbox.'), { code: 'EVAL_NETWORK_DISABLED' })),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

function unwrapIIFE(body) {
  const trimmed = body.replace(/^\s+/, '');
  const trailing = /\)\s*\(\)\s*;?\s*$/.test(trimmed);
  const leading = /^\(?function\s*\(\s*\)\s*\{/.test(trimmed) || /^;?\s*\(function\s*\(\s*\)\s*\{/.test(trimmed);
  if (!leading || !trailing) return { body, unwrapped: false };
  const start = trimmed.indexOf('{') + 1;
  const end = trimmed.lastIndexOf('})');
  if (end <= start) return { body, unwrapped: false };
  return { body: trimmed.slice(start, end), unwrapped: true };
}

function serialize(value) {
  const seen = new WeakSet();
  try {
    return JSON.parse(JSON.stringify(value, (key, item) => {
      if (typeof item === 'bigint') return `${item}n`;
      if (typeof item === 'function') return '[Function]';
      if (typeof item === 'symbol') return String(item);
      if (item instanceof Error) return `[Error: ${item.message}]`;
      if (item instanceof Date) return item.toISOString();
      if (item instanceof Map) return Object.fromEntries(item);
      if (item instanceof Set) return [...item];
      if (item === undefined) return null;
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }));
  } catch {
    return { __vibecat: 'unserializable', type: typeof value };
  }
}

async function runEval({ source, expr, timeoutMs = 3000 }) {
  const metadata = extractMetadata(source);
  if (!metadata.valid) {
    throw new VibeCatError('METADATA_INVALID', `Userscript metadata is invalid: ${metadata.errors.map((item) => item.message).join('; ')}`, { retryable: false, nextActions: ['Fix the @match/@grant metadata in the userscript header, then run `vibecat eval --json` again.'] });
  }
  const body = source.slice(metadata.block.length);
  const { body: unwrapped } = unwrapIIFE(body);
  const context = vm.createContext(makeSandbox());
  try {
    vm.runInContext(unwrapped, context, { filename: 'userscript-body.js', timeout: timeoutMs });
  } catch (error) {
    throw new VibeCatError('EVAL_BOOT_FAILED', `The userscript body threw while loading in the eval sandbox: ${error.message}`, { retryable: true, nextActions: ['Check the userscript body for a load-time error (undefined reference, syntax issue), fix it, then run `vibecat eval --json` again.'] });
  }
  // Count invocations of the userscript's top-level functions so `calls` in
  // the result tells the agent how many functions the expression exercised.
  const counter = { calls: 0 };
  for (const key of Object.keys(context)) {
    const value = context[key];
    if (typeof value === 'function') {
      context[key] = new Proxy(value, {
        apply(target, thisArg, args) { counter.calls += 1; return Reflect.apply(target, thisArg, args); },
      });
    }
  }
  const started = process.hrtime.bigint();
  let raw;
  try {
    raw = vm.runInContext(expr, context, { filename: 'eval-expression.js', timeout: timeoutMs });
  } catch (error) {
    throw new VibeCatError('EVAL_FAILED', `Expression failed: ${error.message}`, { retryable: false, evidence: { errorType: error && error.name || typeof error }, nextActions: ['Fix the expression or the referenced function, then run `vibecat eval --json` again.'] });
  }
  if (raw && typeof raw.then === 'function') {
    raw = await Promise.race([
      raw,
      new Promise((_resolve, reject) => setTimeout(() => reject(new VibeCatError('EVAL_TIMEOUT', 'The evaluated expression timed out.', { retryable: true, nextActions: ['Raise --timeout-ms or simplify the expression.'] })), timeoutMs)),
    ]);
  }
  const timeMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  return { result: serialize(raw), type: typeof raw, calls: counter.calls, timeMs, timeoutMs };
}

module.exports = { runEval, makeSandbox, unwrapIIFE, serialize };
