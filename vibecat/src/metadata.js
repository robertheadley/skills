'use strict';

const REPEATABLE = new Set(['match', 'include', 'exclude', 'grant', 'require', 'resource', 'connect']);
const SUPPORTED = new Set([
  'name', 'namespace', 'version', 'description', 'author', 'homepage', 'homepageURL',
  'supportURL', 'match', 'include', 'exclude', 'grant', 'run-at', 'require', 'resource',
  'connect', 'noframes', 'downloadURL', 'updateURL', 'uuid',
]);

function extractMetadata(source) {
  const match = source.match(/^\s*(\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==)/);
  if (!match) return { valid: false, block: null, fields: {}, errors: [{ code: 'METADATA_MISSING', message: 'The userscript metadata block is missing or is not first.' }] };
  const fields = {};
  const errors = [];
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^\/\/\s+@([^\s]+)(?:\s+(.*))?$/);
    if (!field) continue;
    const key = field[1];
    const value = (field[2] || '').trim();
    if (!SUPPORTED.has(key)) errors.push({ code: 'METADATA_FIELD_UNSUPPORTED', message: `Unsupported metadata field: @${key}` });
    if (!fields[key]) fields[key] = [];
    fields[key].push(value);
  }
  for (const required of ['name', 'version']) {
    if (!fields[required] || !fields[required][0]) errors.push({ code: 'METADATA_REQUIRED', message: `Required metadata field @${required} is missing.` });
  }
  for (const [key, values] of Object.entries(fields)) {
    if (!REPEATABLE.has(key) && values.length > 1) errors.push({ code: 'METADATA_DUPLICATE', message: `Metadata field @${key} may appear only once.` });
  }
  for (const pattern of fields.match || []) {
    if (!/^(\*|https?|file|ftp):\/\//.test(pattern)) errors.push({ code: 'METADATA_MATCH_INVALID', message: `Invalid @match pattern: ${pattern}` });
  }
  return {
    valid: errors.length === 0,
    block: match[1].replace(/\r\n/g, '\n'),
    fields,
    name: fields.name && fields.name[0],
    version: fields.version && fields.version[0],
    errors,
  };
}

function metadataFromObject(metadata) {
  const order = ['name', 'namespace', 'version', 'description', 'author', 'homepage', 'homepageURL', 'supportURL', 'match', 'include', 'exclude', 'grant', 'run-at', 'require', 'resource', 'connect', 'noframes', 'downloadURL', 'updateURL'];
  const lines = ['// ==UserScript=='];
  for (const key of order) {
    if (metadata[key] === undefined || metadata[key] === false) continue;
    const values = Array.isArray(metadata[key]) ? metadata[key] : [metadata[key] === true ? '' : metadata[key]];
    for (const value of values) lines.push(`// @${key.padEnd(12)}${String(value)}`.trimEnd());
  }
  lines.push('// ==/UserScript==');
  return extractMetadata(`${lines.join('\n')}\n`).block;
}

module.exports = { extractMetadata, metadataFromObject, REPEATABLE, SUPPORTED };
