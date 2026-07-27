const assert = require('assert');
const ClaudeTaskRunner = require('../src/claude-task-runner');
const { validateProviderSettings } = require('../src/config-validator');
const { getProvider } = require('../src/providers');

describe('Opencode external model configuration', function () {
  it('accepts well-formed external models only through level overrides', function () {
    const opencode = getProvider('opencode');
    const levelOverrides = {
      level2: { model: 'kimi/kimi-k2-5', reasoningEffort: 'high' },
    };

    assert.deepStrictEqual(opencode.resolveModelSpec('level2', levelOverrides), {
      level: 'level2',
      model: 'kimi/kimi-k2-5',
      reasoningEffort: 'high',
    });
    assert.doesNotThrow(() =>
      validateProviderSettings('opencode', {
        minLevel: 'level1',
        maxLevel: 'level3',
        defaultLevel: 'level2',
        levelOverrides,
      })
    );

    assert.throws(
      () => opencode.validateModelId('kimi/kimi-k2-5'),
      (error) =>
        error.permanent === true &&
        /Invalid model "kimi\/kimi-k2-5" for provider "opencode"/.test(error.message)
    );
  });
});

describe('Opencode external model task runner boundary', function () {
  it('carries configured external models through the task runner boundary', function () {
    const providerModule = getProvider('opencode');
    const levelOverrides = {
      level2: { model: 'kimi/kimi-k2-5', reasoningEffort: 'high' },
    };
    const runner = new ClaudeTaskRunner({ quiet: true });

    assert.deepStrictEqual(
      runner._resolveModelSpec({
        explicitModelSpec: {
          level: 'level2',
          model: 'kimi/kimi-k2-5',
          reasoningEffort: 'high',
        },
        modelSpecSource: 'provider-level',
        model: null,
        reasoningEffort: null,
        modelLevel: null,
        providerModule,
        providerSettings: { defaultLevel: 'level2', levelOverrides },
        levelOverrides,
      }),
      {
        level: 'level2',
        model: 'kimi/kimi-k2-5',
        reasoningEffort: 'high',
      }
    );

    assert.throws(
      () =>
        runner._resolveModelSpec({
          explicitModelSpec: {
            level: 'level2',
            model: 'kimi/kimi-k2-5',
          },
          modelSpecSource: 'direct',
          model: null,
          reasoningEffort: null,
          modelLevel: null,
          providerModule,
          providerSettings: { defaultLevel: 'level2', levelOverrides },
          levelOverrides,
        }),
      { permanent: true }
    );
  });

  it('rejects provider-level selections whose supplied model does not match settings', function () {
    const providerModule = getProvider('opencode');
    const levelOverrides = {
      level2: { model: 'kimi/kimi-k2-5', reasoningEffort: 'high' },
    };
    const runner = new ClaudeTaskRunner({ quiet: true });

    assert.throws(
      () =>
        runner._resolveModelSpec({
          explicitModelSpec: {
            level: 'level2',
            model: 'untrusted/external-model',
          },
          modelSpecSource: 'provider-level',
          model: null,
          reasoningEffort: null,
          modelLevel: null,
          providerModule,
          providerSettings: { defaultLevel: 'level2', levelOverrides },
          levelOverrides,
        }),
      /does not match the configured level2 model/
    );
  });
});

describe('Opencode malformed external model validation', function () {
  it('rejects malformed configured model ids as permanent errors', function () {
    const opencode = getProvider('opencode');

    for (const model of ['', 'kimi', '/kimi-k2-5', 'kimi/', 'kimi//kimi-k2-5', 'kimi/kimi k2']) {
      assert.throws(
        () =>
          opencode.resolveModelSpec('level2', {
            level2: { model },
          }),
        (error) =>
          error.permanent === true &&
          error.message.includes(`Invalid configured model "${model}" for provider "opencode"`)
      );
    }
  });
});
