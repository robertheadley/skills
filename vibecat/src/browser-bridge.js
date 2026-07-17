'use strict';

const crypto = require('node:crypto');
const { extractMetadata } = require('./metadata');

function browserBridgeRuntime(config) {
  'use strict';
  const MAX_TEXT = 500;
  const MAX_NODES = 200;
  const handles = new Map();
  const reverseHandles = new WeakMap();
  const mutations = [];
  const pendingMessages = [];
  let mutationObserver = null;
  let socket = null;
  let handleCounter = 0;
  const sessionNonce = Math.random().toString(36).slice(2);
  const SECRET_NAME = /pass(word)?|token|secret|authorization|api[-_]?key|credit|card|cvv|session/i;
  const SECRET_VALUE = /(?:bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,}|\b(?:\d[ -]*?){13,19}\b)/i;

  function text(value, limit = MAX_TEXT) {
    const normalized = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return SECRET_VALUE.test(normalized) ? '[REDACTED]' : normalized.slice(0, limit);
  }
  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  }
  function handleFor(element) {
    if (!(element instanceof Element)) return null;
    let handle = reverseHandles.get(element);
    if (!handle) {
      handle = `el_${sessionNonce}_${(++handleCounter).toString(36)}`;
      reverseHandles.set(element, handle);
      handles.set(handle, element);
    }
    return handle;
  }
  function resolveHandle(handle) {
    const element = handles.get(handle);
    if (!element || !element.isConnected) {
      handles.delete(handle);
      const error = new Error(`Element handle is stale or unknown: ${handle}`);
      /** @type {any} */ (error).code = 'STALE_ELEMENT_HANDLE';
      throw error;
    }
    return element;
  }
  function safeAttributes(element) {
    const output = {};
    const allowed = /^(id|class|role|title|alt|href|name|type|value|placeholder|aria-[\w-]+|data-[\w-]+)$/i;
    for (const attribute of Array.from(element.attributes || [])) {
      if (!allowed.test(attribute.name)) continue;
      if (attribute.name === 'value' && (element.type === 'password' || SECRET_NAME.test(element.name || element.id || ''))) output[attribute.name] = '[REDACTED]';
      else output[attribute.name] = SECRET_NAME.test(attribute.name) || SECRET_VALUE.test(attribute.value) ? '[REDACTED]' : text(attribute.value, 300);
    }
    return output;
  }
  function describe(element) {
    return {
      handle: handleFor(element), tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || null,
      text: text(element.innerText || element.textContent || ''), visible: visible(element),
      attributes: safeAttributes(element), childCount: element.children.length,
    };
  }
  function boundedTree(root, options = {}) {
    const maxDepth = Math.min(Number(options.depth || 3), 8);
    const maxNodes = Math.min(Number(options.maxNodes || MAX_NODES), 1000);
    const visibleOnly = options.visibleOnly === true;
    let count = 0;
    function visit(element, depth) {
      if (!(element instanceof Element) || depth > maxDepth || count >= maxNodes) return null;
      if (visibleOnly && !visible(element)) return null;
      count += 1;
      const node = describe(element);
      node.children = [];
      for (const child of element.children) {
        const item = visit(child, depth + 1);
        if (item) node.children.push(item);
        if (count >= maxNodes) break;
      }
      return node;
    }
    return { root: visit(root, 0), nodeCount: count, truncated: count >= maxNodes, maxDepth, maxNodes };
  }
  function query(selector, options = {}) {
    const root = options.root ? resolveHandle(options.root) : document;
    const limit = Math.min(Number(options.limit || 20), 100);
    return Array.from(root.querySelectorAll(selector)).filter((el) => !options.visibleOnly || visible(el)).slice(0, limit).map(describe);
  }
  function queryXPath(xpath, options = {}) {
    const root = options.root ? resolveHandle(options.root) : document;
    const limit = Math.min(Number(options.limit || 20), 100);
    const result = document.evaluate(xpath, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const items = [];
    for (let index = 0; index < Math.min(result.snapshotLength, limit); index += 1) {
      const node = result.snapshotItem(index);
      if (node instanceof Element && (!options.visibleOnly || visible(node))) items.push(describe(node));
    }
    return items;
  }
  function cssEscape(value) {
    if (globalThis.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  }
  function selectorSuggestion(element) {
    const reasons = [];
    const warnings = [];
    let selector;
    if (element.id && !/^(?:ember|react|radix|headlessui|:r)[-_:]?\d/i.test(element.id)) {
      selector = `#${cssEscape(element.id)}`;
      reasons.push('Uses a stable-looking ID.');
    } else if (element.getAttribute('role')) {
      selector = `${element.tagName.toLowerCase()}[role="${cssEscape(element.getAttribute('role'))}"]`;
      reasons.push('Uses a semantic role.');
      const label = element.getAttribute('aria-label');
      if (label) {
        selector += `[aria-label="${cssEscape(label)}"]`;
        reasons.push('Uses an accessible name.');
        if (/[a-z]{3,}/i.test(label)) warnings.push('The selector may depend on page language.');
      }
    } else {
      const stableData = Array.from(element.attributes).find((attribute) => /^data-(?:test|testid|qa|automation|vibecat|id)/i.test(attribute.name) && !SECRET_NAME.test(attribute.name));
      if (stableData) {
        selector = `${element.tagName.toLowerCase()}[${stableData.name}="${cssEscape(stableData.value)}"]`;
        reasons.push('Uses a stable data attribute.');
      } else {
        selector = element.tagName.toLowerCase();
        reasons.push('Falls back to the element tag.');
        warnings.push('No stable semantic attribute was available.');
      }
    }
    const matches = document.querySelectorAll(selector).length;
    return { selector, matches, unique: matches === 1, stability: selector.startsWith('#') ? 'high' : reasons.length > 1 ? 'high' : matches < 10 ? 'medium' : 'low', reasons, warnings, languageDependent: warnings.some((item) => item.includes('language')), generatedClassDependent: false };
  }
  function recordMutation(record) {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    mutations.push({
      timestamp: new Date().toISOString(), type: record.type,
      target: target ? handleFor(target) : null,
      attribute: record.attributeName || null,
      added: Array.from(record.addedNodes || []).filter((node) => node instanceof Element).slice(0, 20).map(describe),
      removedCount: Array.from(record.removedNodes || []).length,
      text: record.type === 'characterData' ? text(record.target.data) : null,
    });
    if (mutations.length > 500) mutations.splice(0, mutations.length - 500);
  }
  async function screenshot(element) {
    const target = element || document.documentElement;
    const rect = element ? element.getBoundingClientRect() : { x: 0, y: 0, width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight };
    const width = Math.max(1, Math.min(Math.ceil(rect.width), 4096));
    const height = Math.max(1, Math.min(Math.ceil(rect.height), 4096));
    const clone = target.cloneNode(true);
    clone.querySelectorAll && clone.querySelectorAll('input[type="password"], input[name*="token" i], input[name*="secret" i]').forEach((input) => input.setAttribute('value', '[REDACTED]'));
    const serialized = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('Browser could not render the bounded DOM capture.')); img.src = url; });
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(image, 0, 0, width, height);
      return { dataUrl: canvas.toDataURL('image/png'), width, height, method: 'dom-foreign-object' };
    } finally { URL.revokeObjectURL(url); }
  }
  async function execute(operation, args) {
    switch (operation) {
      case 'page': return { url: location.href, title: document.title, readyState: document.readyState, language: document.documentElement.lang || null, viewport: { width: innerWidth, height: innerHeight }, document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } };
      case 'landmarks': return Array.from(document.querySelectorAll('main,nav,header,footer,aside,form,[role="main"],[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="form"],[role="search"]')).filter(visible).slice(0, 50).map(describe);
      case 'tree': return boundedTree(args && args.root ? resolveHandle(args.root) : document.body || document.documentElement, args || {});
      case 'element': return describe(resolveHandle(args.handle));
      case 'query': return query(args.selector, args);
      case 'queryXPath': return queryXPath(args.xpath, args);
      case 'attributes': return safeAttributes(resolveHandle(args.handle));
      case 'text': return { text: text(resolveHandle(args.handle).innerText || resolveHandle(args.handle).textContent || '', Number(args.limit || 2000)) };
      case 'styles': { const style = getComputedStyle(resolveHandle(args.handle)); const properties = args.properties || ['display', 'visibility', 'position', 'color', 'background-color', 'font-size', 'border-left-style', 'border-left-color']; return Object.fromEntries(properties.slice(0, 50).map((name) => [name, style.getPropertyValue(name)])); }
      case 'rect': { const rect = resolveHandle(args.handle).getBoundingClientRect(); return { x: rect.x, y: rect.y, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height }; }
      case 'highlight': { const element = resolveHandle(args.handle); const previous = element.style.outline; element.style.outline = '3px solid #ff00a8'; setTimeout(() => { element.style.outline = previous; }, Math.min(Number(args.durationMs || 1500), 5000)); return { highlighted: true, durationMs: Math.min(Number(args.durationMs || 1500), 5000) }; }
      case 'selectorSuggest': return selectorSuggestion(resolveHandle(args.handle));
      case 'selectorTest': { const matches = query(args.selector, { ...args, limit: 100 }); return { selector: args.selector, matches: matches.length, unique: matches.length === 1, elements: matches }; }
      case 'selectorCompare': { const elements = args.handles.map(resolveHandle); const suggestions = elements.map(selectorSuggestion); const sharedRole = elements.every((el) => el.getAttribute('role') === elements[0].getAttribute('role')) ? elements[0].getAttribute('role') : null; return { suggestions, shared: sharedRole ? { role: sharedRole, selector: `[role="${cssEscape(sharedRole)}"]` } : null }; }
      case 'mutationsStart': if (!mutationObserver) { mutationObserver = new MutationObserver((records) => records.forEach(recordMutation)); mutationObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: ['id', 'class', 'role', 'aria-label', 'hidden', 'style'] }); } return { active: true, retained: mutations.length };
      case 'mutationsRead': return { active: Boolean(mutationObserver), events: mutations.slice(-Math.min(Number(args.limit || 100), 500)) };
      case 'mutationsClear': mutations.splice(0); return { active: Boolean(mutationObserver), cleared: true };
      case 'mutationsStop': if (mutationObserver) mutationObserver.disconnect(); mutationObserver = null; return { active: false, retained: mutations.length };
      case 'screenshot': return screenshot(args && args.handle ? resolveHandle(args.handle) : null);
      default: { const error = new Error(`Unsupported browser operation: ${operation}`); /** @type {any} */ (error).code = 'BROWSER_OPERATION_UNSUPPORTED'; throw error; }
    }
  }
  function send(message) {
    const raw = JSON.stringify(message);
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(raw); else if (pendingMessages.length < 200) pendingMessages.push(raw);
  }
  globalThis.__vibecatReport = (level, args) => send({ action: 'runtimeEvent', data: { level, message: Array.from(args).map((item) => text(typeof item === 'string' ? item : JSON.stringify(item))).join(' '), url: location.href, hash: config.hash, timestamp: new Date().toISOString() } });
  addEventListener('error', (event) => globalThis.__vibecatReport('error', [`${event.message} at ${event.filename}:${event.lineno}:${event.colno}`]));
  addEventListener('unhandledrejection', (event) => globalThis.__vibecatReport('unhandledrejection', [event.reason && event.reason.message || String(event.reason)]));
  function connect() {
    const protocol = location.protocol === 'https:' ? 'ws' : 'ws';
    socket = new WebSocket(`${protocol}://${config.host}:${config.port}/?role=browser&token=${encodeURIComponent(config.token)}`);
    socket.onopen = () => {
      socket.send(JSON.stringify({ action: 'browserHello', data: { projectId: config.projectId, hash: config.hash, url: location.href, title: document.title, sessionNonce } }));
      while (pendingMessages.length) socket.send(pendingMessages.shift());
    };
    socket.onmessage = async (event) => {
      let request;
      try {
        request = JSON.parse(event.data);
        if (request.action !== 'command') return;
        const data = await execute(request.operation, request.args || {});
        send({ action: 'commandResult', requestId: request.requestId, ok: true, data });
      } catch (error) {
        send({ action: 'commandResult', requestId: request && request.requestId, ok: false, error: { code: error.code || 'BROWSER_COMMAND_FAILED', message: error.message } });
      }
    };
    socket.onclose = () => setTimeout(connect, 1500);
  }
  connect();
}

function makeBrowserBridge(config) {
  return `;(${browserBridgeRuntime.toString()})(${JSON.stringify(config)});`;
}

function instrumentUserscript(source, options) {
  const metadata = extractMetadata(source);
  if (!metadata.valid) throw new Error(`Invalid userscript metadata: ${metadata.errors.map((item) => item.message).join('; ')}`);
  const body = source.slice(source.indexOf(metadata.block) + metadata.block.length);
  const hash = options.hash || crypto.createHash('sha256').update(source).digest('hex');
  const bridge = makeBrowserBridge({ host: options.host || '127.0.0.1', port: options.port, token: options.token, projectId: options.projectId, hash });
  const wrapped = `\n${bridge}\n;(function () {\n'use strict';\nconst __nativeConsole = globalThis.console;\nconst console = Object.fromEntries(['debug','log','info','warn','error'].map((level) => [level, (...args) => { __nativeConsole[level](...args); globalThis.__vibecatReport(level, args); }]));\ntry {\n${body}\n} catch (__vibecatError) { globalThis.__vibecatReport('error', [__vibecatError && (__vibecatError.stack || __vibecatError.message) || String(__vibecatError)]); throw __vibecatError; }\n})();\n`;
  return `${metadata.block}${wrapped}`;
}

module.exports = { browserBridgeRuntime, makeBrowserBridge, instrumentUserscript };
