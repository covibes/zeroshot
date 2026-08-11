type JsonRecord = Record<string, unknown>;

interface ProviderFailure {
  readonly error: string;
  readonly provider: string;
  readonly event: string;
  readonly category: string;
  readonly classification: {
    readonly kind: string;
    readonly retryable: boolean;
  };
  readonly diagnostic: unknown;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseProviderEvent(content: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function providerFailureFields(failure: ProviderFailure): {
  error: { message: string };
  zeroshot_failure: {
    provider: string;
    event: string;
    category: string;
    kind: string;
    retryable: boolean;
    diagnostic: unknown;
  };
} {
  return {
    error: { message: failure.error },
    zeroshot_failure: {
      provider: failure.provider,
      event: failure.event,
      category: failure.category,
      kind: failure.classification.kind,
      retryable: failure.classification.retryable,
      diagnostic: failure.diagnostic,
    },
  };
}

export = { parseProviderEvent, providerFailureFields };
