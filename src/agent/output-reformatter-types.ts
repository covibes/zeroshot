import type { ErrorObject, Schema } from 'ajv';

export interface RuntimeProviderBoundary {
  isRetryableError(error: Error): boolean;
}

export interface ProvidersBoundary {
  getProvider(name: string): RuntimeProviderBoundary;
}

export interface SchemaUtilsBoundary {
  normalizeEnumValues(result: unknown, schema: unknown): unknown;
}

export interface RecoveryError extends Error {
  code?: unknown;
  permanent?: unknown;
  provider?: unknown;
  capability?: unknown;
  nestedExecutionCancellation?: unknown;
  nestedExecutionLifecycle?: unknown;
  retainTaskHandle?: unknown;
  recoveryAbort?: unknown;
  terminationExhausted?: unknown;
  taskId?: unknown;
}

export interface ReformatInvocationResult {
  success?: unknown;
  output?: string;
  error?: unknown;
  code?: unknown;
  permanent?: unknown;
  provider?: unknown;
  capability?: unknown;
  nestedExecutionCancellation?: unknown;
  nestedExecutionLifecycle?: unknown;
  retainTaskHandle?: unknown;
  terminationExhausted?: unknown;
  taskId?: unknown;
}

export interface StructuredValidationResult {
  valid: boolean;
  value: unknown;
  errors: ErrorObject[];
  error: string | null;
}

export type StructuredOutputValidator = (candidate: unknown) => StructuredValidationResult;

export type RunReformat = (
  prompt: string
) =>
  | ReformatInvocationResult
  | null
  | undefined
  | Promise<ReformatInvocationResult | null | undefined>;

export interface ReformatOutputArguments {
  rawOutput: string;
  schema: Schema;
  providerName: string;
  maxAttempts?: number;
  initialError?: string | null;
  validateCandidate?: StructuredOutputValidator;
  onAttempt?(attempt: number, lastError: string | null): unknown;
  isCancelled?(): boolean;
  runReformat?: RunReformat;
}

export interface RecoveryAttemptArguments {
  prompt: string;
  providerName: string;
  validateCandidate: StructuredOutputValidator;
  isCancelled(): boolean;
  runReformat: RunReformat;
}

export type RecoveryAttemptOutcome =
  | { status: 'recovered'; value: unknown }
  | { status: 'retry'; error: string | null };

export type ReformatOutcome =
  | { status: 'recovered'; value: unknown; attempts: number }
  | { status: 'exhausted'; attempts: number; lastError: string };
