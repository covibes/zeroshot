export type JsonRecord = Record<string, unknown>;

export interface ProviderFailure {
  error: string;
  provider: string;
  event: string;
  category: string;
  classification: { kind: string; retryable: boolean };
  diagnostic: unknown;
}

export type ExtractProviderFailure = (
  content: string,
  providerName: string
) => ProviderFailure | null;

export interface PiUsageAccumulator {
  tokens: Record<string, number>;
  cost: Record<string, number>;
}

export interface PiLifecycleState {
  piUsage?: PiUsageAccumulator;
  piProtocolFailure?: ProviderFailure | null;
  providerFailure?: ProviderFailure | null;
  piLatestAssistantObserved?: boolean;
  pendingPiFailure?: ProviderFailure | null;
  piProtocolSettled?: boolean;
  piProtocolPrefixOmitted?: boolean;
  piProtocolObserved?: boolean;
}

export interface PiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  durationMs: null;
  modelUsage: Record<string, number | Record<string, number>>;
}
