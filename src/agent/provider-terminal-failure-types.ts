export interface ProviderClassification {
  retryable: boolean;
  kind: string;
}

export interface ProviderAdapterBoundary {
  classifyError(error: unknown): unknown;
}

export interface RuntimeProviderBoundary {
  adapter: ProviderAdapterBoundary;
}

export interface ProvidersBoundary {
  getProvider(name: string): RuntimeProviderBoundary;
}

export interface FailureMetadata {
  provider?: string | null;
  providerEvent?: string | null;
  providerCategory?: string | null;
  classification?: ProviderClassification | null;
  providerDiagnostic?: unknown;
  permanent?: boolean;
}

export interface TerminalFailureError extends Error, FailureMetadata {
  hookFailure?: unknown;
  vertexModelError?: unknown;
  terminationExhausted?: unknown;
  taskId?: string | null;
  code?: string;
  capability?: unknown;
  details?: unknown;
}

export interface FailureAgent {
  id: string;
  role: unknown;
  iteration: unknown;
  currentTaskId: string | null;
  cluster: {
    failureInfo: Record<string, unknown>;
  };
  _publish(message: Record<string, unknown>): unknown;
}

export interface WorkerFailure {
  code: 'crash' | 'refusal';
  reason: 'authentication_required' | 'declared_failure';
}

export interface TerminalFailureArguments {
  agent: FailureAgent;
  error: TerminalFailureError;
  attempts: number;
  worker: WorkerFailure;
  unsupportedCapability: boolean;
  structuredOutputInvalid: boolean;
}
