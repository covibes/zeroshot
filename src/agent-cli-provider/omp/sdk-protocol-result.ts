import type { ResultEvent } from '../types';
import {
  OMP_SDK_TEXT_OUTPUT_SCHEMA,
  type OmpSdkProtocolResultFrame,
  type OmpSdkSidecarRequest,
} from './sdk-protocol-types';
import { parseOmpSdkProtocolFrame } from './sdk-protocol-frame';
import { protocolFailure, schemaValidator } from './sdk-protocol-value';

function checkedValue(frame: OmpSdkProtocolResultFrame, request: OmpSdkSidecarRequest): unknown {
  if (frame.runId !== request.runId) protocolFailure('frame.runId does not match request.');
  if (
    frame.requested.modelSelector !== request.modelSelector ||
    frame.requested.reasoningEffort !== request.reasoningEffort ||
    frame.requested.outputMode !== request.outputMode
  ) {
    protocolFailure('frame.requested does not match request.');
  }
  if (frame.resolved.modelSelector !== request.modelSelector)
    protocolFailure('resolved model is not exact.');
  if (request.outputMode === 'text') {
    if (typeof frame.value !== 'string') protocolFailure('invalid text result.');
    if (!schemaValidator(OMP_SDK_TEXT_OUTPUT_SCHEMA)({ result: frame.value })) {
      protocolFailure('frame.value failed host schema validation.');
    }
    return frame.value;
  }
  if (!schemaValidator(request.outputSchema)(frame.value)) {
    protocolFailure('frame.value failed host schema validation.');
  }
  return frame.value;
}
export function validateOmpSdkProtocolResultFrame(
  value: unknown,
  request: OmpSdkSidecarRequest
): OmpSdkProtocolResultFrame {
  const frame = parseOmpSdkProtocolFrame(value);
  if (frame.type !== 'result') protocolFailure('a result frame is required.');
  checkedValue(frame, request);
  return frame;
}
export function normalizeOmpSdkResultFrame(
  value: unknown,
  request: OmpSdkSidecarRequest
): ResultEvent {
  const parsed = parseOmpSdkProtocolFrame(value);
  if (parsed.type !== 'result') protocolFailure('a result frame is required.');
  const frame = parsed;
  const result = checkedValue(frame, request);
  const parsedUsage = frame.usage;
  return {
    type: 'result',
    success: true,
    result,
    cost: parsedUsage.cost.total,
    duration: parsedUsage.durationMs,
    inputTokens:
      parsedUsage.inputTokens +
      parsedUsage.cacheReadInputTokens +
      parsedUsage.cacheCreationInputTokens,
    outputTokens: parsedUsage.outputTokens,
    cacheReadInputTokens: parsedUsage.cacheReadInputTokens,
    cacheCreationInputTokens: parsedUsage.cacheCreationInputTokens,
    modelUsage: parsedUsage,
    requests: parsedUsage.requests,
    usageSource: 'omp-aggregate',
    usageCompleteness: 'unknown',
    invocation: { lane: 'spawn', pty: false, protocol: 'omp-sdk-v1' },
    ompSdk: {
      backend: frame.backend,
      runtime: frame.runtime,
      requested: frame.requested,
      resolved: frame.resolved,
      strictOutput: frame.strictOutput,
      fallback: false,
      execution: frame.execution,
      usage: parsedUsage,
    },
  };
}
