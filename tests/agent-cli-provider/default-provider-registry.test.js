const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  providerRegistry,
  getDefaultProviderId,
  assertExactlyOneDefaultProvider,
} = require('../../lib/agent-cli-provider/provider-registry');

test('exactly one registry entry has default:true and it is claude', () => {
  const defaults = providerRegistry.filter((entry) => entry.default);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].id, 'claude');
});

test('getDefaultProviderId returns claude', () => {
  assert.equal(getDefaultProviderId(), 'claude');
});

test('assertExactlyOneDefaultProvider throws for zero defaults', () => {
  assert.throws(() => assertExactlyOneDefaultProvider([]), /exactly one default provider/);
});

test('assertExactlyOneDefaultProvider throws for two defaults', () => {
  assert.throws(
    () =>
      assertExactlyOneDefaultProvider([
        { id: 'a', default: true },
        { id: 'b', default: true },
      ]),
    /exactly one default provider/
  );
});

test('assertExactlyOneDefaultProvider returns the id for exactly one default', () => {
  const id = assertExactlyOneDefaultProvider([
    { id: 'a', default: false },
    { id: 'b', default: true },
  ]);
  assert.equal(id, 'b');
});
