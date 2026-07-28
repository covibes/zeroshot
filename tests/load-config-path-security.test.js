const assert = require('assert');
const path = require('path');

const Orchestrator = require('../src/orchestrator');
const TemplateResolver = require('../src/template-resolver');

const UNSAFE_STATIC_CONFIG_NAMES = [
  ['traversal', '../package'],
  ['backslash traversal', String.raw`..\package`],
  ['absolute path', path.resolve(__dirname, '..', 'package')],
  ['forward-slash nested path', 'nested/config'],
  ['backslash nested path', String.raw`nested\config`],
  ['Windows drive path', String.raw`C:\outside`],
  ['UNC path', String.raw`\\server\share`],
];

const UNSAFE_BASE_TEMPLATE_NAMES = [
  ['traversal', '../../package'],
  ['backslash traversal', String.raw`..\package`],
  ['absolute path', path.resolve(__dirname, '..', 'package')],
  ['forward-slash nested path', 'nested/template'],
  ['backslash nested path', String.raw`nested\template`],
  ['Windows drive path', String.raw`C:\outside`],
  ['UNC path', String.raw`\\server\share`],
];

describe('load_config path security', function () {
  let orchestrator;

  beforeEach(function () {
    orchestrator = new Orchestrator({ quiet: true, skipLoad: true });
  });

  afterEach(function () {
    orchestrator.close();
  });

  for (const [description, configName] of UNSAFE_STATIC_CONFIG_NAMES) {
    it(`should reject a static ${description} during validation and execution`, async function () {
      assert.throws(() => orchestrator._resolveLoadConfigAgents(configName), /Invalid config name/);
      await assert.rejects(
        orchestrator._opLoadConfig({}, { config: configName }, {}),
        /Invalid config name/
      );
    });
  }

  for (const [description, base] of UNSAFE_BASE_TEMPLATE_NAMES) {
    it(`should reject a parameterized ${description} during validation and execution`, async function () {
      const config = { base, params: {} };
      assert.throws(
        () => orchestrator._resolveLoadConfigAgents(config),
        /Invalid base template name/
      );
      await assert.rejects(
        orchestrator._opLoadConfig({}, { config }, {}),
        /Invalid base template name/
      );
    });
  }

  it('preserves the missing agents error after shared resolution', async function () {
    const originalResolve = TemplateResolver.prototype.resolveConfigReference;
    TemplateResolver.prototype.resolveConfigReference = () => ({
      kind: 'static',
      name: 'no-agents',
      params: null,
      loadedConfig: {},
    });

    try {
      assert.throws(
        () => orchestrator._resolveLoadConfigAgents('no-agents'),
        /Config has no agents array/
      );
      await assert.rejects(
        orchestrator._opLoadConfig({}, { config: 'no-agents' }, {}),
        /Config has no agents array/
      );
    } finally {
      TemplateResolver.prototype.resolveConfigReference = originalResolve;
    }
  });
});
