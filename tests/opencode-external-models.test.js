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
  it('derives configured external models from modelLevel without a source flag', function () {
    const providerModule = getProvider('opencode');
    const levelOverrides = {
      level2: { model: 'kimi/kimi-k2-5', reasoningEffort: 'high' },
    };
    const runner = new ClaudeTaskRunner({ quiet: true });

    assert.deepStrictEqual(
      runner._resolveModelSpec({
        explicitModelSpec: null,
        model: null,
        reasoningEffort: null,
        modelLevel: 'level2',
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

  it('treats every caller-supplied concrete model as direct and catalog-strict', function () {
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

  it('rejects caller-supplied model provenance', async function () {
    const runner = new ClaudeTaskRunner({ quiet: true });
    await assert.rejects(
      runner.run('spoofed source', {
        provider: 'opencode',
        modelLevel: 'level2',
        modelSpecSource: 'provider-level',
      }),
      /modelSpecSource is derived/
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

  it('rejects prototype-inherited names for direct and configured models', function () {
    const opencode = getProvider('opencode');
    const codex = getProvider('codex');

    for (const model of ['constructor', 'toString', '__proto__']) {
      assert.throws(() => opencode.validateModelId(model), { permanent: true });
      assert.throws(() => codex.validateModelId(model), { permanent: true });
      assert.throws(() => opencode.resolveModelSpec('level2', { level2: { model } }), {
        permanent: true,
      });
      assert.throws(() => codex.resolveModelSpec('level2', { level2: { model } }), {
        permanent: true,
      });
    }
  });
});
