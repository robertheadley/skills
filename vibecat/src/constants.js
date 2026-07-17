'use strict';

const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8642;
const PUBLIC_STATES = Object.freeze([
  'UNAVAILABLE', 'INSTALLED', 'READY', 'STARTING', 'RUNNING', 'CONNECTED',
  'BUILDING', 'WATCHING', 'DIRTY', 'PUSHING', 'PUSHED', 'VALIDATING',
  'VALIDATED', 'STOPPING', 'STOPPED', 'ERROR',
]);

module.exports = { APP_ROOT, DEFAULT_HOST, DEFAULT_PORT, PUBLIC_STATES };
