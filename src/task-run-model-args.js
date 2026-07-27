/**
 * Append a resolved model selection to a nested `zeroshot task run` invocation.
 *
 * Direct requests use the public, catalog-strict `--model` channel.
 * Provider-level selections retain their level and carry the already validated
 * configured value through the internal `--configured-model` channel.
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
    if (modelSpec.model) {
      args.push('--configured-model', modelSpec.model);
    }
  } else if (modelSpec?.model) {
    args.push('--model', modelSpec.model);
  }

  if (modelSpec?.reasoningEffort) {
    args.push('--reasoning-effort', modelSpec.reasoningEffort);
  }

  return args;
}

module.exports = { appendTaskRunModelArgs };
