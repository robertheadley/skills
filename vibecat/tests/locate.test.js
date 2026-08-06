'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { selectInstallation } = require('../src/services');

function fake(pathValue, version, complete = true) {
  return { path: path.resolve(pathValue), source: 'test', version, complete };
}

test('a single installation is not divergent', () => {
  const result = selectInstallation([fake('/opt/vibecat', '2.0.1')]);
  assert.equal(result.divergent, false);
  assert.equal(result.selected.path, path.resolve('/opt/vibecat'));
  assert.equal(result.candidates.length, 1);
});

test('same-version complete copies are not divergent', () => {
  const result = selectInstallation([fake('/opt/vibecat', '2.0.1'), fake('/home/u/.vibecat', '2.0.1'), fake('/home/u/.hermes/skills/vibecat', '2.0.1')]);
  assert.equal(result.divergent, false);
  assert.equal(result.candidates.length, 3);
});

test('different-version complete copies are divergent', () => {
  const result = selectInstallation([fake('/opt/vibecat', '2.0.1'), fake('/home/u/.vibecat', '1.2.0')]);
  assert.equal(result.divergent, true);
});

test('an incomplete copy alongside a complete one is divergent', () => {
  const result = selectInstallation([fake('/opt/vibecat', '2.0.1'), fake('/home/u/.vibecat', '2.0.1', false)]);
  assert.equal(result.divergent, true);
});

test('incomplete-only candidates select none and are divergent', () => {
  const result = selectInstallation([fake('/home/u/.vibecat', null, false)]);
  assert.equal(result.selected, null);
  assert.equal(result.divergent, false);
});

test('null and falsy candidates are ignored', () => {
  const result = selectInstallation([fake('/opt/vibecat', '2.0.1'), null, undefined]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.divergent, false);
});

test('duplicate paths are deduplicated case-insensitively', () => {
  const upper = fake('C:\\VIBECAT', '1.2.0');
  const lower = fake('c:\\vibecat', '2.0.1');
  const result = selectInstallation([upper, lower]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.divergent, false);
});

test('candidates expose active flags matching the selected installation', () => {
  const result = selectInstallation([fake('/opt/vibecat', '2.0.1'), fake('/home/u/.vibecat', '2.0.1')]);
  const active = result.candidates.filter((item) => item.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].path, result.selected.path);
});
