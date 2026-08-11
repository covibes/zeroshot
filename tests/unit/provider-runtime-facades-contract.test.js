const assert = require('assert');

const providerCapabilities = require('../../src/providers/capabilities');
const providerNames = require('../../lib/provider-names');

describe('provider runtime TypeScript facades', function () {
  it('preserves the capability facade contract', function () {
    assert.deepStrictEqual(Reflect.ownKeys(providerCapabilities), [
      'CAPABILITIES',
      'checkCapability',
      'warnIfExperimental',
    ]);
    assert.deepStrictEqual(
      [providerCapabilities.checkCapability.length, providerCapabilities.warnIfExperimental.length],
      [2, 2]
    );
    assert.strictEqual(Object.isFrozen(providerCapabilities.CAPABILITIES), true);
    for (const [provider, capabilities] of Object.entries(providerCapabilities.CAPABILITIES)) {
      assert.strictEqual(Object.isFrozen(capabilities), true);
      assert.deepStrictEqual(capabilities, providerNames.PROVIDER_CAPABILITIES[provider]);
      assert.notStrictEqual(capabilities, providerNames.PROVIDER_CAPABILITIES[provider]);
    }
    assert.strictEqual(providerCapabilities.checkCapability(null, 'jsonSchema'), false);
    assert.strictEqual(providerCapabilities.checkCapability('openai', 'jsonSchema'), true);
  });

  it('preserves provider-specific constructor entrypoints', function () {
    const entrypoints = [
      [require('../../src/providers/anthropic'), 'claude'],
      [require('../../src/providers/google'), 'gemini'],
      [require('../../src/providers/openai'), 'codex'],
      [require('../../src/providers/opencode'), 'opencode'],
    ];
    for (const [Provider, expectedName] of entrypoints) {
      assert.strictEqual(typeof Provider, 'function');
      assert.strictEqual(Provider.length, 0);
      assert.strictEqual(new Provider().name, expectedName);
    }
  });
});
