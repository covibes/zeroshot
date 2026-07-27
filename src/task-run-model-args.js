/**
 * Append a resolved model selection to a nested `zeroshot task run` invocation.
 *
 * Direct requests use the public, catalog-strict `--model` channel.
 * Provider-level selections carry only their level. The child must resolve the
 * concrete model again from its effective provider settings.
 *
 * @param {string[]} args
 * @param {Object|null|undefined} modelSpec
 * @param {'direct'|'provider-level'} [modelSpecSource]
 * @returns {string[]}
 */
function appendTaskRunModelArgs(args, modelSpec, modelSpecSource = 'direct') {
  if (modelSpecSource === 'provider-level') {
    if (!modelSpec?.level) {
      throw new Error('Provider-level task model selections require a model level');
    }
    args.push('--model-level', modelSpec.level);
  } else if (modelSpec?.model) {
    args.push('--model', modelSpec.model);
  }

  if (modelSpec?.reasoningEffort) {
    args.push('--reasoning-effort', modelSpec.reasoningEffort);
  }

  return args;
}

const ISOLATED_PROVIDER_SETTINGS_ENV = 'ZEROSHOT_ISOLATED_PROVIDER_SETTINGS_JSON';

/**
 * Serialize the effective configured-model settings needed by an isolated
 * child. Only providers that support settings-owned external model IDs need a
 * snapshot; direct models continue through the strict public channel.
 *
 * @param {string} providerName
 * @param {Object} settings
 * @param {'direct'|'provider-level'} modelSpecSource
 * @param {Object|null|undefined} modelSpec
 * @returns {Record<string, string>}
 */
function buildIsolatedProviderSettingsEnv(providerName, settings, modelSpecSource, modelSpec) {
  if (providerName !== 'opencode' || modelSpecSource !== 'provider-level') return {};
  const providerSettings = settings.providerSettings?.[providerName] || {};
  const configuredModel = providerSettings.levelOverrides?.[modelSpec?.level]?.model ?? null;
  if (modelSpec?.model !== configuredModel) {
    const error = new Error(
      `Provider-level model "${modelSpec?.model}" does not match the effective isolated ${modelSpec?.level} model "${configuredModel}".`
    );
    error.permanent = true;
    throw error;
  }
  return {
    [ISOLATED_PROVIDER_SETTINGS_ENV]: JSON.stringify({
      [providerName]: providerSettings,
    }),
  };
}

module.exports = {
  ISOLATED_PROVIDER_SETTINGS_ENV,
  appendTaskRunModelArgs,
  buildIsolatedProviderSettingsEnv,
};
