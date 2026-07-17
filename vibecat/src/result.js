'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { APP_ROOT, PUBLIC_STATES } = require('./constants');

function canonicalSkillPath() {
  const candidates = [path.join(APP_ROOT, 'skills', 'vibecat', 'SKILL.md'), path.join(APP_ROOT, 'skills', 'sync-scriptcat-userscripts', 'SKILL.md')];
  return candidates.find(fs.existsSync) || null;
}

function result(command, data = {}) {
  const state = data.state || 'READY';
  if (!PUBLIC_STATES.includes(state)) throw new Error(`Invalid public lifecycle state: ${state}`);
  return {
    ok: data.ok !== false,
    command,
    state,
    projectPath: data.projectPath || null,
    skillPath: data.skillPath || canonicalSkillPath(),
    sessionId: data.sessionId || null,
    evidence: data.evidence || {},
    checks: data.checks || [],
    warnings: data.warnings || [],
    errors: data.errors || [],
    nextActions: data.nextActions || [],
    ...Object.fromEntries(Object.entries(data).filter(([key]) => ![
      'ok', 'state', 'projectPath', 'skillPath', 'sessionId', 'evidence',
      'checks', 'warnings', 'errors', 'nextActions',
    ].includes(key))),
  };
}

function failedResult(command, error, context = {}) {
  return result(command, {
    ok: false,
    state: 'ERROR',
    ...context,
    errors: [error.toJSON()],
    nextActions: error.nextActions,
    retryable: error.retryable,
  });
}

module.exports = { result, failedResult };
