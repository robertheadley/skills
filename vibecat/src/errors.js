'use strict';

class VibeCatError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'VibeCatError';
    this.code = code;
    this.evidence = options.evidence || {};
    this.retryable = options.retryable === true;
    this.nextActions = options.nextActions || [];
    this.exitCode = options.exitCode || 1;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      evidence: this.evidence,
      retryable: this.retryable,
      nextActions: this.nextActions,
    };
  }
}

function asVibeCatError(error) {
  if (error instanceof VibeCatError) return error;
  return new VibeCatError('INTERNAL_ERROR', error && error.message ? error.message : String(error), {
    evidence: { errorType: error && error.name ? error.name : typeof error },
    retryable: false,
  });
}

module.exports = { VibeCatError, asVibeCatError };
