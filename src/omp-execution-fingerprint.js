// The `executionFingerprint` recorded with every resumable OMP session (issue #866).
//
// A session transcript is only safely continuable under the same execution contract that produced
// it. This digest binds that contract: the pinned OMP release, the Zeroshot config overlay's
// content, the requested Zeroshot selectors (`--model`, `--thinking`, `--approval-mode`), and the
// concrete provider/model/thinking level OMP actually reported for the turn. Any of those drifting
// between the recording turn and a resume attempt — a Zeroshot upgrade that retunes the overlay, a
// changed level mapping, an alias resolving to a different concrete model, a different thinking
// level — makes the fingerprints differ, and the continuation is refused before the prompt.
const { createHash } = require('crypto');
const { OMP_CONFIG_OVERLAY_DIGEST } = require('./omp-config-overlay');

/** Value of `--flag <value>` in an argv array, or '' when the flag is absent. */
function flagValue(args, flag) {
  if (!Array.isArray(args)) return '';
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) return '';
  const value = args[index + 1];
  return typeof value === 'string' ? value : '';
}

/** The Zeroshot-requested half of the contract, readable from the command spec alone. */
function requestedExecutionSelectors(commandSpec) {
  const args = commandSpec?.args;
  return {
    modelSelector: flagValue(args, '--model'),
    thinkingSelector: flagValue(args, '--thinking'),
    approvalMode: flagValue(args, '--approval-mode'),
  };
}

/**
 * @param {object} params
 * @param {string} params.expectedVersion pinned OMP release (OMP_SUPPORTED_VERSION)
 * @param {object} params.commandSpec the spec OMP was actually spawned with
 * @param {object} params.evidence OMP's reported session evidence (selectedProvider/Model, thinkingLevel)
 * @param {string} [params.configOverlayDigest] injectable for tests only
 * @returns {string} `sha256:<64-lower-hex>`
 */
function computeOmpExecutionFingerprint({
  expectedVersion,
  commandSpec,
  evidence,
  configOverlayDigest = OMP_CONFIG_OVERLAY_DIGEST,
}) {
  const fields = {
    ompSupportedVersion: String(expectedVersion ?? ''),
    configOverlayDigest: String(configOverlayDigest ?? ''),
    ...requestedExecutionSelectors(commandSpec),
    observedProvider: String(evidence?.selectedProvider ?? ''),
    observedModel: String(evidence?.selectedModel ?? ''),
    observedThinkingLevel: String(evidence?.thinkingLevel ?? ''),
  };
  const stable = {};
  for (const key of Object.keys(fields).sort()) stable[key] = fields[key];
  return `sha256:${createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex')}`;
}

module.exports = {
  computeOmpExecutionFingerprint,
  requestedExecutionSelectors,
};
