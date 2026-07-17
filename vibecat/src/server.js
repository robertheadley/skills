'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const WebSocket = require('ws');
const { extractMetadata } = require('./metadata');
const { instrumentUserscript } = require('./browser-bridge');

function isAllowedOrigin(origin) {
  return origin === undefined || /^chrome-extension:\/\//.test(origin) || /^moz-extension:\/\//.test(origin);
}
function sha256(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
function jsonResponse(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
function readJson(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; if (raw.length > limit) reject(new Error('Request body is too large.')); });
    request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); } });
    request.on('error', reject);
  });
}

async function createSyncServer(options) {
  const filePath = path.resolve(options.filePath);
  const host = options.host || '127.0.0.1';
  const port = Number(options.port === undefined ? 8642 : options.port);
  const token = options.token || crypto.randomBytes(32).toString('hex');
  const projectId = options.projectId || sha256(path.dirname(filePath)).slice(0, 16);
  const logger = options.logger || console;
  const debugLogPath = options.debugLogPath || path.join(path.dirname(filePath), '.vibecat-runtime-events.jsonl');
  const extensionClients = new Set();
  const browserSessions = new Map();
  const pendingCommands = new Map();
  const debugEvents = [];
  let watcher = null;
  let lastSourceHash = null;
  let lastDelivery = null;
  let debounce = null;
  let closed = false;

  function activeBrowser() {
    return Array.from(browserSessions.values()).sort((a, b) => b.connectedAt.localeCompare(a.connectedAt))[0] || null;
  }
  function publicBrowser(session = activeBrowser()) {
    return session ? { connected: true, tabHandle: session.tabHandle, url: session.url, title: session.title, connectedAt: session.connectedAt, hash: session.hash } : { connected: false };
  }
  function health() {
    const browser = activeBrowser();
    return {
      status: 'ok', pid: process.pid, host, port: address().port, watched_file: filePath,
      websocket_clients: extensionClients.size, browser_sessions: browserSessions.size,
      browser: publicBrowser(browser), last_delivery: lastDelivery,
      console_diagnostics: { enabled: true, buffered_events: debugEvents.length, dropped_events: 0, last_event_at: debugEvents.length ? debugEvents[debugEvents.length - 1].received_at : null },
    };
  }
  function authorized(request) { return request.headers.authorization === `Bearer ${token}`; }
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${host}`);
    if (request.method === 'GET' && requestUrl.pathname === '/debug/health') return jsonResponse(response, 200, health());
    if (requestUrl.pathname === '/debug/events' && request.method === 'POST') {
      if (!authorized(request)) return jsonResponse(response, 401, { error: { code: 'AUTH_REQUIRED', message: 'A valid session bearer token is required.' } });
      try {
        const body = await readJson(request);
        const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
        fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
        for (const event of events) {
          const record = { ...event, received_at: new Date().toISOString() };
          debugEvents.push(record); if (debugEvents.length > 500) debugEvents.shift();
          fs.appendFileSync(debugLogPath, `${JSON.stringify(record)}\n`);
        }
        return jsonResponse(response, 202, { accepted: events.length });
      } catch (error) { return jsonResponse(response, 400, { error: { code: 'EVENTS_INVALID', message: error.message } }); }
    }
    if (requestUrl.pathname === '/api/command' && request.method === 'POST') {
      if (!authorized(request)) return jsonResponse(response, 401, { error: { code: 'AUTH_REQUIRED', message: 'A valid session bearer token is required.' } });
      try {
        const body = await readJson(request);
        const data = await sendCommand(body.operation, body.args || {}, Number(body.timeoutMs || 5000));
        return jsonResponse(response, 200, { ok: true, data });
      } catch (error) { return jsonResponse(response, error.code === 'BROWSER_NOT_CONNECTED' ? 409 : 422, { ok: false, error: { code: error.code || 'BROWSER_COMMAND_FAILED', message: error.message } }); }
    }
    if (requestUrl.pathname === '/api/push' && request.method === 'POST') {
      if (!authorized(request)) return jsonResponse(response, 401, { error: { code: 'AUTH_REQUIRED', message: 'A valid session bearer token is required.' } });
      try { return jsonResponse(response, 200, { ok: true, data: await syncNow('api') }); }
      catch (error) { return jsonResponse(response, 422, { ok: false, error: { code: 'PUSH_FAILED', message: error.message } }); }
    }
    return jsonResponse(response, 404, { error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } });
  });
  const wss = new WebSocket.WebSocketServer({ noServer: true, maxPayload: 6 * 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url, `http://${host}`);
    const role = requestUrl.searchParams.get('role') || 'extension';
    if (role === 'browser') {
      if (requestUrl.searchParams.get('token') !== token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    } else if (!isAllowedOrigin(request.headers.origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, role));
  });
  wss.on('connection', (socket, request, role) => {
    if (role === 'extension') {
      extensionClients.add(socket);
      socket.send(JSON.stringify({ action: 'hello' }));
      logger.info('ScriptCat handshake confirmed');
      socket.on('message', (raw) => {
        try { const message = JSON.parse(raw.toString()); if (message.action !== 'hello' && message.action !== 'ping') logger.warn(`Ignored unsupported extension action: ${message.action}`); if (message.action === 'ping') socket.send(JSON.stringify({ action: 'pong' })); } catch { logger.warn('Ignored invalid extension message.'); }
      });
      socket.on('close', () => extensionClients.delete(socket));
      return;
    }
    let session = null;
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.action === 'browserHello') {
          if (!message.data || message.data.projectId !== projectId) { socket.close(4003, 'Project mismatch'); return; }
          const tabHandle = `tab_${sha256(`${message.data.sessionNonce}:${message.data.url}`).slice(0, 12)}`;
          session = { socket, tabHandle, projectId, url: message.data.url, title: message.data.title, hash: message.data.hash, connectedAt: new Date().toISOString() };
          browserSessions.set(tabHandle, session);
          socket.send(JSON.stringify({ action: 'browserAccepted', data: { tabHandle } }));
        } else if (message.action === 'commandResult') {
          const pending = pendingCommands.get(message.requestId);
          if (!pending) return;
          pendingCommands.delete(message.requestId); clearTimeout(pending.timer);
          if (message.ok) pending.resolve(message.data); else { const error = new Error(message.error && message.error.message || 'Browser command failed.'); /** @type {any} */ (error).code = message.error && message.error.code; pending.reject(error); }
        } else if (message.action === 'runtimeEvent') {
          const record = { ...message.data, tabHandle: session && session.tabHandle, received_at: new Date().toISOString() };
          debugEvents.push(record); if (debugEvents.length > 500) debugEvents.shift();
          fs.mkdirSync(path.dirname(debugLogPath), { recursive: true }); fs.appendFileSync(debugLogPath, `${JSON.stringify(record)}\n`);
        }
      } catch (error) { logger.warn(`Ignored invalid browser message: ${error.message}`); }
    });
    socket.on('close', () => { if (session) browserSessions.delete(session.tabHandle); });
  });
  function sendCommand(operation, args, timeoutMs) {
    const session = activeBrowser();
    if (!session || session.socket.readyState !== WebSocket.OPEN) { const error = new Error('No inspectable browser tab is connected.'); /** @type {any} */ (error).code = 'BROWSER_NOT_CONNECTED'; throw error; }
    const requestId = `req_${crypto.randomBytes(8).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pendingCommands.delete(requestId); const error = new Error(`Browser operation timed out: ${operation}`); /** @type {any} */ (error).code = 'BROWSER_COMMAND_TIMEOUT'; reject(error); }, Math.min(Math.max(timeoutMs, 100), 30000));
      pendingCommands.set(requestId, { resolve, reject, timer });
      session.socket.send(JSON.stringify({ action: 'command', requestId, operation, args }));
    });
  }
  async function syncNow(reason = 'manual') {
    const source = fs.readFileSync(filePath, 'utf8');
    const metadata = extractMetadata(source);
    if (!metadata.valid) throw new Error(metadata.errors.map((item) => item.message).join('; '));
    const hash = sha256(source);
    if (hash === lastSourceHash && reason !== 'api') return { sent: false, reason: 'unchanged', hash, clients: extensionClients.size };
    const delivered = instrumentUserscript(source, { host, port: address().port, token, projectId, hash });
    new vm.Script(delivered.replace(/^\s*\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, ''), { filename: filePath });
    const payload = JSON.stringify({ action: 'onchange', data: { script: delivered, uri: pathToFileURL(filePath).href, version: metadata.version || '0.1', hash } });
    for (const client of extensionClients) if (client.readyState === WebSocket.OPEN) client.send(payload);
    lastSourceHash = hash;
    lastDelivery = { buildId: `build_${hash.slice(0, 12)}`, hash, reason, timestamp: new Date().toISOString(), clients: extensionClients.size };
    logger.info(`Synced ${path.basename(filePath)} (${extensionClients.size} client(s), sha256:${hash})`);
    return { sent: extensionClients.size > 0, reason: extensionClients.size ? reason : 'no_clients', hash, clients: extensionClients.size, buildId: lastDelivery.buildId };
  }
  function address() { const value = server.address(); return value && typeof value === 'object' ? value : { address: host, port }; }
  function startWatcher() {
    const directory = path.dirname(filePath); const filename = path.basename(filePath);
    watcher = fs.watch(directory, (_event, changed) => { if (changed && changed.toString() !== filename) return; clearTimeout(debounce); debounce = setTimeout(() => syncNow('watch').catch((error) => logger.error(`Watch sync failed: ${error.message}`)), options.debounceMs || 100); });
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()); });
  if (options.watch !== false) startWatcher();
  return {
    address, health, syncNow, sendCommand, getDebugConfig: () => ({ token, logPath: debugLogPath }),
    getDebugEvents: () => debugEvents.slice(), getBrowser: () => publicBrowser(),
    async close() {
      if (closed) return; closed = true; clearTimeout(debounce); if (watcher) watcher.close();
      for (const client of [...extensionClients, ...Array.from(browserSessions.values()).map((item) => item.socket)]) client.terminate();
      for (const pending of pendingCommands.values()) { clearTimeout(pending.timer); pending.reject(new Error('Server stopped.')); }
      await new Promise((resolve) => server.close(() => resolve())); wss.close();
    },
  };
}

module.exports = { createSyncServer, isAllowedOrigin, sha256 };
