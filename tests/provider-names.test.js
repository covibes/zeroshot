const assert = require('assert');

const providerNames = require('../lib/provider-names');

describe('provider-names', () => {
  it('preserves the CommonJS export surface and function arities', () => {
    assert.deepStrictEqual(Reflect.ownKeys(providerNames), [
      'KNOWN_PROVIDER_NAMES',
      'PROVIDER_ALIASES',
      'PROVIDER_CAPABILITIES',
      'VALID_PROVIDERS',
      'getDefaultProviderId',
      'getProviderMetadata',
      'listProviderMetadata',
      'normalizeProviderName',
      'normalizeProviderSettings',
      'providerSupportsCapability',
      'providerSupportsOutputReformatting',
      'resolveProviderCommand',
    ]);
    assert.deepStrictEqual(
      Object.fromEntries(
        Object.entries(providerNames)
          .filter(([, value]) => typeof value === 'function')
          .map(([name, value]) => [name, value.length])
      ),
      {
        getDefaultProviderId: 0,
        getProviderMetadata: 1,
        listProviderMetadata: 0,
        normalizeProviderName: 1,
        normalizeProviderSettings: 1,
        providerSupportsCapability: 2,
        providerSupportsOutputReformatting: 1,
        resolveProviderCommand: 1,
      }
    );
  });

  it('preserves copied-array and frozen-map mutability contracts', () => {
    assert.strictEqual(Object.isFrozen(providerNames.VALID_PROVIDERS), false);
    assert.strictEqual(Object.isFrozen(providerNames.KNOWN_PROVIDER_NAMES), false);
    assert.strictEqual(Object.isFrozen(providerNames.PROVIDER_ALIASES), true);
    assert.strictEqual(Object.isFrozen(providerNames.PROVIDER_CAPABILITIES), true);
  });

  it('normalizes aliases and passes through falsey or non-string names', () => {
    assert.strictEqual(providerNames.normalizeProviderName('openai'), 'codex');
    assert.strictEqual(providerNames.normalizeProviderName('CODEX'), 'codex');
    assert.strictEqual(providerNames.normalizeProviderName(''), '');
    assert.strictEqual(providerNames.normalizeProviderName(null), null);
    assert.strictEqual(providerNames.normalizeProviderName(42), 42);
  });

  it('merges aliases first so canonical provider settings take precedence', () => {
    const settings = {
      codex: { shared: 'canonical', canonical: true },
      openai: { shared: 'alias', alias: true },
      mystery: { keep: true },
    };

    assert.deepStrictEqual(providerNames.normalizeProviderSettings(settings), {
      codex: {
        shared: 'canonical',
        alias: true,
        canonical: true,
      },
      mystery: { keep: true },
    });
    assert.strictEqual(providerNames.normalizeProviderSettings(null), null);
    assert.strictEqual(providerNames.normalizeProviderSettings('unchanged'), 'unchanged');
  });

  it('projects metadata and capabilities from the registry', () => {
    assert.deepStrictEqual(
      providerNames.listProviderMetadata().map((entry) => entry.id),
      providerNames.VALID_PROVIDERS
    );
    for (const name of providerNames.VALID_PROVIDERS) {
      const metadata = providerNames.getProviderMetadata(name);
      assert.strictEqual(providerNames.PROVIDER_CAPABILITIES[name], metadata.capabilities);
    }
  });
});
