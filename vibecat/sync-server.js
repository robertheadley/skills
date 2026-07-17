#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSyncServer, isAllowedOrigin } = require('./src/server');
const { instrumentUserscript } = require('./src/browser-bridge');

function resolveLegacyTarget(args, cwd = process.cwd()) {
  const explicit = args.find((argument) => !argument.startsWith('-'));
  if (explicit) return path.resolve(cwd, explicit);
  const candidates = fs.readdirSync(cwd).filter((name) => name.endsWith('.user.js'));
  if (candidates.length !== 1) {
    const detail = candidates.length ? `Multiple userscripts found: ${candidates.join(', ')}` : 'No userscript was found.';
    throw new Error(`${detail} Pass an explicit .user.js path.`);
  }
  return path.join(cwd, candidates[0]);
}

async function main() {
  const args = process.argv.slice(2);
  const filePath = resolveLegacyTarget(args);
  const server = await createSyncServer({
    filePath,
    host: process.env.VIBECAT_HOST || '127.0.0.1',
    port: Number(process.env.VIBECAT_PORT || 8642),
    token: process.env.VIBECAT_SESSION_TOKEN || process.env.SYNC_BEARER_TOKEN,
    projectId: process.env.VIBECAT_PROJECT_ID,
    debugLogPath: process.env.VIBECAT_EVENT_LOG,
    watch: !args.includes('--no-watch'),
  });
  const address = server.address();
  console.log(`VibeCat service listening on http://${address.address}:${address.port}`);
  console.log(`Watching ${filePath}`);
  const shutdown = async () => { await server.close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (require.main === module) main().catch((error) => { console.error(`VibeCat service failed: ${error.message}`); process.exit(1); });

module.exports = { createSyncServer, instrumentUserscript, isAllowedOrigin, resolveLegacyTarget };
