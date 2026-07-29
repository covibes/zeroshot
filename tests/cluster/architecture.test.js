'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { contentsBelow } = require('./harness');

const root = path.resolve(__dirname, '../..');
const sourceRoot = path.join(root, 'src/cluster');
const outputRoot = path.join(root, 'lib/cluster');

test('cluster source and every emitted artifact are isolated from provider helpers', () => {
  const forbidden = ['agent', 'cli', 'provider'].join('-');
  for (const { file, content } of [...contentsBelow(sourceRoot), ...contentsBelow(outputRoot)]) {
    assert.equal(content.includes(forbidden), false, file);
  }
});

test('cluster source has no imports from unrelated product internals', () => {
  for (const { file, content } of contentsBelow(sourceRoot)) {
    for (const match of content.matchAll(/(?:from\s+|import\()(['"])([^'"]+)\1/g)) {
      const specifier = match[2];
      if (specifier === 'ws' || specifier === 'ajv' || specifier.startsWith('ajv/')) continue;
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `${file}: ${specifier}`);
      const target = path.resolve(path.dirname(file), specifier);
      assert.ok(target.startsWith(sourceRoot + path.sep), `${file}: ${specifier}`);
    }
  }
});

test('request allocation and reconnect ownership invariants are mechanically singular', () => {
  const connection = fs.readFileSync(path.join(sourceRoot, 'connection.ts'), 'utf8');
  const subscriptions = fs.readFileSync(path.join(sourceRoot, 'subscriptions.ts'), 'utf8');
  assert.equal([...connection.matchAll(/this\.#allocateId\(/g)].length, 1);
  assert.equal([...connection.matchAll(/#sequence\+\+/g)].length, 1);
  const nextBodies = subscriptions.match(/async next\(\)[\s\S]*?\n[ ]{2}\}/g) ?? [];
  for (const body of nextBodies) assert.equal(body.includes('.reconnect('), false);
  assert.doesNotMatch(subscriptions, /\b(?:new\s+Set|Set<)/);
  const runtime = contentsBelow(sourceRoot)
    .map(({ content }) => content)
    .join('\n');
  assert.equal(/this\.(?:socket|transport)\s*=/.test(runtime), false);
});

test('cluster regressions contain no wall-clock race waits', () => {
  const forbidden = [
    String.raw`set` + String.raw`Timeout\s*\(`,
    String.raw`sle` + String.raw`ep\s*\(`,
  ];
  const expression = new RegExp(forbidden.join('|'));
  for (const { file, content } of contentsBelow(path.join(root, 'tests/cluster'))) {
    assert.equal(expression.test(content), false, file);
  }
});
