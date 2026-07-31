import { stripTimestampPrefix } from '../log-prefix';
import { UnsupportedProviderCapabilityError } from '../errors';
import {
  getProviderRegistryEntry,
  normalizeProviderName,
  providerIds,
  supportsProviderCapability,
} from '../provider-registry';
import type {
  BuildProviderCommandOptions,
  CommandSpec,
  ErrorClassification,
  KnownProviderName,
  LevelOverrides,
  ModelLevel,
  OutputEvent,
  ProviderAdapter,
  ProviderId,
  ProviderSessionCapturePolicy,
  ResolvedModelSpec,
} from '../types';
export {
  NO_MESSAGES_RETURNED,
  STREAMING_MODE_ERROR,
  detectProviderFatalError,
  detectProviderStreamingModeError,
  recoverProviderStructuredOutput,
  supportsProviderStructuredOutputRecovery,
  type StreamingModeError,
  type StructuredOutputRecovery,
} from './claude-recovery';

function isOutputEventArray(
  event: OutputEvent | readonly OutputEvent[]
): event is readonly OutputEvent[] {
  return Array.isArray(event);
}

function adapterForProviderId(provider: ProviderId): ProviderAdapter {
  return getProviderRegistryEntry(provider).adapter;
}

function isProviderId(name: string): name is ProviderId {
  return (providerIds as readonly string[]).includes(name);
}

export function getProviderAdapter(name: KnownProviderName | string): ProviderAdapter {
  const normalized = normalizeProviderName(name || '');
  if (isProviderId(normalized)) return adapterForProviderId(normalized);
  throw new Error(`Unknown provider: ${name}. Valid: ${providerIds.join(', ')}`);
}

export function listProviderAdapters(): readonly ProviderId[] {
  return providerIds;
}

export function buildProviderCommand(
  providerName: KnownProviderName | string,
  context: string,
  options?: BuildProviderCommandOptions
): CommandSpec {
  const adapter = getProviderAdapter(providerName);
  if (options?.webSearch !== undefined && !supportsProviderCapability(adapter.id, 'webSearch')) {
    throw new UnsupportedProviderCapabilityError(
      adapter.id,
      'webSearch',
      `Provider ${adapter.id} does not expose provider-controlled native web search; remove options.webSearch.`
    );
  }
  return adapter.buildCommand(context, options);
}

export function parseProviderChunk(
  providerName: KnownProviderName | string,
  chunk: string
): readonly OutputEvent[] {
  const adapter = getProviderAdapter(providerName || 'claude');
  const state = adapter.createParserState();
  const events: OutputEvent[] = [];
  const lines = chunk.split('\n');

  for (const line of lines) {
    const content = stripTimestampPrefix(line);
    if (!content) continue;
    const event = adapter.parseEvent(content, state);
    if (!event) continue;
    if (isOutputEventArray(event)) {
      events.push(...event);
    } else {
      events.push(event);
    }
  }

  return events;
}

export function getProviderSessionCapturePolicy(
  providerName: KnownProviderName | string
): ProviderSessionCapturePolicy | null {
  return getProviderAdapter(providerName || 'claude').sessionCapture ?? null;
}

export function extractProviderSessionId(
  providerName: KnownProviderName | string,
  line: string
): string | null {
  const adapter = getProviderAdapter(providerName || 'claude');
  const content = stripTimestampPrefix(line);
  if (!content || !adapter.extractSessionId) return null;
  return adapter.extractSessionId(content);
}

export function resolveModelSpec(
  providerName: KnownProviderName | string,
  level: ModelLevel,
  overrides?: LevelOverrides
): ResolvedModelSpec {
  return getProviderAdapter(providerName).resolveModelSpec(level, overrides);
}

export function classifyProviderError(
  providerName: KnownProviderName | string,
  error: unknown
): ErrorClassification {
  return getProviderAdapter(providerName).classifyError(error);
}
