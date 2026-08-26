'use strict';

// URL match-state helper: determines whether a live browser URL falls inside
// the project's userscript match patterns. Used by `vibecat status` and push
// error evidence to disambiguate why a delivered build never executed
// (user navigated away / wrong tab / closed tab).

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchPatterns(metadataMatches, configPattern) {
  const patterns = [];
  const seen = new Set();
  for (const pattern of [...(metadataMatches || []), ...(configPattern ? [configPattern] : [])]) {
    if (pattern && !seen.has(pattern)) { seen.add(pattern); patterns.push(pattern); }
  }
  return patterns;
}

function matchState(url, patterns) {
  if (!url) return 'no_tab';
  if (!patterns || patterns.length === 0) return 'unknown';
  return patterns.some((pattern) => globToRegExp(pattern).test(url)) ? 'matched' : 'mismatched';
}

module.exports = { globToRegExp, matchPatterns, matchState };
