import crypto from 'node:crypto';

import type { HostedOptions, HostedRunDependencies, HostedRunIntent } from './contracts.ts';
import {
  context,
  HostedRunHttpError,
  TERMINAL_STATES,
  UUID,
  type HostedContext,
} from './client.ts';
import {
  githubToken,
  providerKey,
  resolveHostedInput,
  validateHostedOptions,
} from './input.ts';

const DEFAULT_MODEL = 'openai/gpt-5.4';
const RUN_INTENT_VERSION = 'zeroshot.run-intent/v1';
const MAX_RUN_INTENT_BYTES = 1024 * 1024 + 64 * 1024;
const RUN_INTENT_POLL_MS = 500;

function output(deps: HostedRunDependencies, value: string): void {
  (deps.stdout ?? process.stdout).write(`${value}\n`);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function displayState(intent: HostedRunIntent): string {
  return intent.waiting_reason ? `${intent.state} (${intent.waiting_reason})` : intent.state;
}

function resumeCommand(value: HostedContext, intentId: string): string {
  return `zeroshot target status ${value.targetName} ${intentId} --follow`;
}

async function follow(
  value: HostedContext,
  initial: HostedRunIntent,
  deps: HostedRunDependencies
): Promise<Record<string, unknown> | null> {
  let intent = initial;
  let displayed: string | null = null;
  for (;;) {
    const state = displayState(intent);
    if (state !== displayed) {
      output(deps, `Run ${intent.intent_id}: ${state}`);
      displayed = state;
    }
    if (TERMINAL_STATES.has(intent.state)) break;
    await (deps.delay ?? wait)(RUN_INTENT_POLL_MS);
    intent = await value.client.get(intent.intent_id);
  }
  if (intent.state === 'succeeded') {
    const summary = intent.result?.['summary'];
    if (typeof summary === 'string' && summary) output(deps, summary);
    return intent.result;
  }
  const detail = intent.error_code ? ` (${intent.error_code})` : '';
  throw new Error(`hosted run ${intent.state}${detail}`);
}

export async function runHosted(
  input: string,
  options: HostedOptions,
  deps: HostedRunDependencies
): Promise<HostedRunIntent | Record<string, unknown> | null> {
  validateHostedOptions(options);
  const environment = deps.environment ?? process.env;
  const resolved = await resolveHostedInput(input, options, environment);
  const value = await context(options.target!, deps);
  const body = {
    label: 'zeroshot-cli',
    size: options.size ?? 'standard',
    intent: {
      version: RUN_INTENT_VERSION,
      credentials: {
        githubToken: githubToken(environment),
        openrouterApiKey: providerKey(environment),
        repository: resolved.repository,
        model: options.model ?? DEFAULT_MODEL,
      },
      request: resolved.request,
    },
  };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_RUN_INTENT_BYTES) {
    throw new Error('hosted run intent exceeds the 1088 KiB upload limit');
  }
  const submissionKey = options.submissionKey ?? crypto.randomUUID();
  let created: HostedRunIntent;
  try {
    created = await value.client.submit(body, submissionKey);
  } catch (error) {
    if (error instanceof HostedRunHttpError) throw error;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. Recover this submission by rerunning ` +
        `the same command with --submission-key ${submissionKey}`,
      { cause: error }
    );
  }
  output(deps, `Run ${created.intent_id} queued`);
  output(deps, `Resume: ${resumeCommand(value, created.intent_id)}`);
  if (options.detach) return created;
  output(deps, 'Ctrl+C disconnects without cancelling.');
  return follow(value, created, deps);
}

export async function statusHostedRun(
  targetName: string,
  intentId: string,
  shouldFollow: boolean,
  deps: HostedRunDependencies
): Promise<HostedRunIntent | Record<string, unknown> | null> {
  if (!UUID.test(intentId)) throw new Error('run intent id must be a UUID');
  const value = await context(targetName, deps);
  const intent = await value.client.get(intentId);
  if (!shouldFollow) {
    output(deps, JSON.stringify(intent, null, 2));
    return intent;
  }
  if (!TERMINAL_STATES.has(intent.state)) {
    output(deps, `Following ${intentId}; Ctrl+C disconnects without cancelling.`);
    output(deps, `Resume: ${resumeCommand(value, intentId)}`);
  }
  return follow(value, intent, deps);
}

export async function cancelHostedRun(
  targetName: string,
  intentId: string,
  deps: HostedRunDependencies
): Promise<HostedRunIntent> {
  if (!UUID.test(intentId)) throw new Error('run intent id must be a UUID');
  const value = await context(targetName, deps);
  const intent = await value.client.cancel(intentId);
  output(deps, `Run ${intent.intent_id}: ${displayState(intent)}`);
  return intent;
}
