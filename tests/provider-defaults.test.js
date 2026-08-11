const assert = require('assert');
const sinon = require('sinon');

const defaultsPath = require.resolve('../lib/provider-defaults');
const namesPath = require.resolve('../lib/provider-names');
const providersPath = require.resolve('../src/providers');

function metadataFor(name) {
  return {
    defaultLevels: {
      max: `${name}-max`,
      min: `${name}-min`,
      default: `${name}-default`,
    },
  };
}

function fallbackFor(name) {
  return {
    maxLevel: `${name}-max`,
    minLevel: `${name}-min`,
    defaultLevel: `${name}-default`,
    levelOverrides: {},
  };
}

let originalNames;
let originalProviders;

function captureModuleCache() {
  originalNames = require.cache[namesPath];
  originalProviders = require.cache[providersPath];
  delete require.cache[defaultsPath];
}

function restoreModuleCache() {
  sinon.restore();
  delete require.cache[defaultsPath];
  if (originalNames) require.cache[namesPath] = originalNames;
  else delete require.cache[namesPath];
  if (originalProviders) require.cache[providersPath] = originalProviders;
  else delete require.cache[providersPath];
}

function loadDefaults(providerNames, providers) {
  require.cache[namesPath] = {
    exports: {
      VALID_PROVIDERS: providerNames,
      getProviderMetadata: metadataFor,
    },
  };
  require.cache[providersPath] = { exports: providers };
  return require(defaultsPath);
}

describe('provider-defaults CommonJS surface', () => {
  beforeEach(captureModuleCache);
  afterEach(restoreModuleCache);

  it('preserves the CommonJS export surface', () => {
    const defaults = loadDefaults([], {
      listProviders: () => [],
      getProvider: () => assert.fail('unexpected provider lookup'),
    });

    assert.deepStrictEqual(Reflect.ownKeys(defaults), [
      'getProviderDefaults',
      'clearProviderDefaultsCache',
    ]);
    assert.deepStrictEqual(
      Object.values(defaults).map((value) => value.length),
      [0, 0]
    );
  });
});

describe('provider-defaults behavior', () => {
  beforeEach(captureModuleCache);
  afterEach(restoreModuleCache);

  it('caches registry defaults and fills providers missing from the live registry', () => {
    const alphaDefaults = { defaultLevel: 'alpha-live', custom: true };
    let defaultCalls = 0;
    const defaults = loadDefaults(['alpha', 'beta'], {
      listProviders: () => ['alpha'],
      getProvider: () => ({
        getDefaultSettings: () => {
          defaultCalls += 1;
          return alphaDefaults;
        },
      }),
    });

    const first = defaults.getProviderDefaults();
    assert.strictEqual(first.alpha, alphaDefaults);
    assert.deepStrictEqual(first.beta, fallbackFor('beta'));
    assert.strictEqual(defaults.getProviderDefaults(), first);
    assert.strictEqual(defaultCalls, 1);

    defaults.clearProviderDefaultsCache();
    assert.notStrictEqual(defaults.getProviderDefaults(), first);
    assert.strictEqual(defaultCalls, 2);
  });

  it('warns and uses registry metadata when a provider throws', () => {
    const warning = sinon.stub(console, 'warn');
    const defaults = loadDefaults(['alpha'], {
      listProviders: () => ['alpha'],
      getProvider: () => {
        throw new Error('provider unavailable');
      },
    });

    assert.deepStrictEqual(defaults.getProviderDefaults().alpha, fallbackFor('alpha'));
    assert.strictEqual(
      warning.calledOnceWithExactly(
        'Warning: Could not get defaults for alpha: provider unavailable'
      ),
      true
    );
  });
});
