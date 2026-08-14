import type { OutputEvent, ProviderParseResult } from './agent-provider-boundary';
import { canonicalEvent } from './semantic-canonical';
import {
  MAX_EVENTS_PER_TASK,
  MAX_EVENT_BYTES,
  reportDiagnostic,
  type SourceSpan,
  type TaskProjection,
} from './semantic-contract';
import { SemanticProjectionError } from './semantic-json';

export function emitEvent(
  context: TaskProjection,
  event: OutputEvent,
  source: SourceSpan | null,
  derivation: 'line' | 'finish'
): void {
  if (context.terminalResultEmitted) {
    reportDiagnostic(context, 'output_after_terminal', source);
    return;
  }
  if (context.eventIndex >= MAX_EVENTS_PER_TASK) {
    if (!context.issueCodes.has('event_limit_exceeded')) {
      reportDiagnostic(context, 'event_limit_exceeded', source);
    }
    return;
  }
  try {
    const normalized = canonicalEvent(event);
    if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_EVENT_BYTES) {
      throw new SemanticProjectionError('event_too_large');
    }
    context.writer.write({
      record_type: 'event',
      task_id: context.taskId,
      event_index: context.eventIndex,
      provider: context.provider,
      adapter_id: context.adapter?.id ?? null,
      adapter_version: context.adapter?.adapterVersion ?? null,
      prompt_ref: context.promptRef,
      raw_output_ref: context.rawOutputRef,
      raw_output_sha256: context.rawOutputSha256,
      derivation,
      source,
      event: normalized,
    });
    context.eventIndex += 1;
    if (normalized.type === 'result') context.terminalResultEmitted = true;
  } catch (error) {
    reportDiagnostic(
      context,
      error instanceof SemanticProjectionError ? error.code : 'event_invalid',
      source
    );
  }
}

export function emittedEvents(result: ProviderParseResult): readonly OutputEvent[] {
  if (result === null) return [];
  return isEventArray(result) ? result : [result];
}

function isEventArray(result: ProviderParseResult): result is readonly OutputEvent[] {
  return Array.isArray(result);
}
