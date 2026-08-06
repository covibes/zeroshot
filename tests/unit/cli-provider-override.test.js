/**
 * Test: CLI Provider Override
 *
 * Verifies that provider override is only applied when explicitly set
 * via --provider or ZEROSHOT_PROVIDER.
 */

const assert = require('assert');
const { normalizeProviderName, getDefaultProviderId } = require('../../lib/provider-names');

// Mirrors resolveProviderOverride in cli/index.js
function resolveProviderOverride(options) {
  const override = options.provider || process.env.ZEROSHOT_PROVIDER;
  if (!override || (typeof override === 'string' && !override.trim())) {
    return null;
  }
  return normalizeProviderName(override);
}

// Mirrors ensureConfigProviderDefaults in lib/start-cluster.js: no --provider,
// no ZEROSHOT_PROVIDER, no settings.defaultProvider override present.
function resolveEffectiveProvider(options, settings) {
  return (
    resolveProviderOverride(options) ||
    normalizeProviderName(settings.defaultProvider || getDefaultProviderId())
  );
}

describe('CLI Provider Override', function () {
  const originalEnv = process.env.ZEROSHOT_PROVIDER;

  afterEach(function () {
    if (originalEnv === undefined) {
      delete process.env.ZEROSHOT_PROVIDER;
    } else {
      process.env.ZEROSHOT_PROVIDER = originalEnv;
    }
  });

  it('returns null when no override is set', function () {
    delete process.env.ZEROSHOT_PROVIDER;
    const result = resolveProviderOverride({});
    assert.strictEqual(result, null);
  });

  it('uses --provider when provided', function () {
    delete process.env.ZEROSHOT_PROVIDER;
    const result = resolveProviderOverride({ provider: 'claude' });
    assert.strictEqual(result, 'claude');
  });

  it('normalizes provider aliases', function () {
    delete process.env.ZEROSHOT_PROVIDER;
    const result = resolveProviderOverride({ provider: 'Anthropic' });
    assert.strictEqual(result, 'claude');
  });

  it('uses ZEROSHOT_PROVIDER when --provider is missing', function () {
    process.env.ZEROSHOT_PROVIDER = 'codex';
    const result = resolveProviderOverride({});
    assert.strictEqual(result, 'codex');
  });

  it('ignores empty ZEROSHOT_PROVIDER', function () {
    process.env.ZEROSHOT_PROVIDER = '   ';
    const result = resolveProviderOverride({});
    assert.strictEqual(result, null);
  });

  it('prefers --provider over ZEROSHOT_PROVIDER', function () {
    process.env.ZEROSHOT_PROVIDER = 'gemini';
    const result = resolveProviderOverride({ provider: 'claude' });
    assert.strictEqual(result, 'claude');
  });

  it('falls back to the registry default when no override or settings provider is present', function () {
    delete process.env.ZEROSHOT_PROVIDER;
    const result = resolveEffectiveProvider({}, {});
    assert.strictEqual(result, getDefaultProviderId());
  });
});
