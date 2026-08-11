// The `executionFingerprint` recorded with every resumable OMP session (issue #866).
//
// A session transcript is only safely continuable under the same execution contract that produced
// it. This digest binds that contract: the pinned OMP release, the Zeroshot config overlay's
// content, the requested Zeroshot selectors (`--model`, `--thinking`, `--approval-mode`), and the
// concrete provider/model/thinking level OMP actually reported for the turn. Any of those drifting
// between the recording turn and a resume attempt — a Zeroshot upgrade that retunes the overlay, a
// changed level mapping, an alias resolving to a different concrete model, a different thinking
// level — makes the fingerprints differ, and the continuation is refused before the prompt.
import { createHash } from 'crypto';

interface ConfigOverlayFacade {
  readonly OMP_CONFIG_OVERLAY_DIGEST: string;
}

interface CommandSpec {
  readonly args?: unknown;
}

interface OmpSessionEvidence {
  readonly selectedProvider?: unknown;
  readonly selectedModel?: unknown;
  readonly thinkingLevel?: unknown;
}

interface FingerprintParams {
  readonly expectedVersion: unknown;
  readonly commandSpec: CommandSpec | null | undefined;
  readonly evidence: OmpSessionEvidence | null | undefined;
  readonly configOverlayDigest?: unknown;
}

interface RequestedExecutionSelectors {
  readonly modelSelector: string;
  readonly thinkingSelector: string;
  readonly approvalMode: string;
}

// The generated CommonJS module resolves the maintained overlay at the matching runtime path.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { OMP_CONFIG_OVERLAY_DIGEST }: ConfigOverlayFacade = require('./omp-config-overlay');

/** Value of `--flag <value>` in an argv array, or '' when the flag is absent. */
function flagValue(args: unknown, flag: string): string {
  if (!Array.isArray(args)) return '';
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) return '';
  const value: unknown = args[index + 1];
  return typeof value === 'string' ? value : '';
}

/** The Zeroshot-requested half of the contract, readable from the command spec alone. */
function requestedExecutionSelectors(
  commandSpec: CommandSpec | null | undefined
): RequestedExecutionSelectors {
  const args = commandSpec?.args;
  return {
    modelSelector: flagValue(args, '--model'),
    thinkingSelector: flagValue(args, '--thinking'),
    approvalMode: flagValue(args, '--approval-mode'),
  };
}

/** Compute the deterministic digest for the requested and observed OMP execution contract. */
function computeOmpExecutionFingerprint({
  expectedVersion,
  commandSpec,
  evidence,
  configOverlayDigest = OMP_CONFIG_OVERLAY_DIGEST,
}: FingerprintParams): string {
  const fields: Record<string, string> = {
    ompSupportedVersion: String(expectedVersion ?? ''),
    configOverlayDigest: String(configOverlayDigest ?? ''),
    ...requestedExecutionSelectors(commandSpec),
    observedProvider: String(evidence?.selectedProvider ?? ''),
    observedModel: String(evidence?.selectedModel ?? ''),
    observedThinkingLevel: String(evidence?.thinkingLevel ?? ''),
  };
  const stable: Record<string, string> = {};
  // Fingerprints preserve ECMAScript's locale-independent UTF-16 code-unit ordering.
  // eslint-disable-next-line sonarjs/no-alphabetical-sort
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key];
    if (value !== undefined) stable[key] = value;
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex')}`;
}

export = {
  computeOmpExecutionFingerprint,
  requestedExecutionSelectors,
};
