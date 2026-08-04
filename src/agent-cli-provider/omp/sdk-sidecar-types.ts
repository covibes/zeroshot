import type { OmpSdkErrorCategory, OmpSdkErrorCode } from './sdk-protocol';

export const PRIVATE_BASE_ENV_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
] as const;
export const MAX_CREDENTIAL_COUNT = 32;
export const MAX_CREDENTIAL_NAME_BYTES = 128;
export const MAX_CREDENTIAL_VALUE_BYTES = 16 * 1024;
export const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ALLOWED_YIELD_FIELDS: Readonly<Record<string, true>> = {
  data: true,
  error: true,
  schemaOverridden: true,
  status: true,
  type: true,
  useLastTurn: true,
};

export const ISOLATED_SETTINGS = {
  'advisor.enabled': false,
  'advisor.subagents': false,
  'advisor.syncBacklog': 'off',
  'async.enabled': false,
  'async.maxJobs': 0,
  'bash.direnv': 'off',
  'bash.autoBackground.enabled': false,
  'compaction.autoContinue': false,
  'compaction.enabled': false,
  'compaction.idleEnabled': false,
  'compaction.midTurnEnabled': false,
  'compaction.remoteEnabled': false,
  'compaction.remoteStreamingV2Enabled': false,
  'compaction.strategy': 'off',
  'prewalk.enabled': false,
  'retry.fallbackChains': {},
  'retry.modelFallback': false,
  'retry.usageAwareFallback': false,
  'task.agentPrewalk': {},
  'task.maxRecursionDepth': 0,
  'task.maxRuntimeMs': 0,
  'task.prewalk': false,
  'task.softRequestBudget': 200,
  'task.softRequestBudgetNotice': true,
  'thinkingBudgets.high': 16384,
  'thinkingBudgets.low': 2048,
  'thinkingBudgets.max': 32768,
  'thinkingBudgets.medium': 8192,
  'thinkingBudgets.minimal': 1024,
  'thinkingBudgets.xhigh': 32768,
} as const;

export interface OmpAuthStorage {
  close(): void;
  hasAuth(provider: string): boolean;
  setRuntimeApiKey(provider: string, apiKey: string): void;
}
export interface OmpModel {
  readonly api?: string;
  readonly baseUrl?: string;
  readonly id: string;
  readonly provider: string;
}
export interface OmpModelRegistry {
  find(provider: string, id: string): OmpModel | undefined;
  getAvailable(): readonly OmpModel[];
  getError(): unknown;
}
export interface OmpModelRegistryConstructor {
  new (
    authStorage: OmpAuthStorage,
    modelsPath: string,
    options?: { ignoreLocalModelConfig?: boolean }
  ): unknown;
}
export interface OmpSingleResult {
  readonly aborted?: boolean;
  readonly abortReason?: string;
  readonly durationMs: number;
  readonly error?: string;
  readonly exitCode: number;
  readonly extractedToolData?: Readonly<Record<string, readonly unknown[]>>;
  readonly requests: number;
  readonly resolvedModel?: string;
  readonly resolvedModelIsFallback?: boolean;
  readonly retryFailure?: unknown;
  readonly stderr: string;
  readonly structuredOutput?: {
    readonly data?: unknown;
    readonly mode: unknown;
    readonly source: unknown;
    readonly status: unknown;
  };
  readonly usage?: {
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly cost: {
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly input: number;
      readonly output: number;
      readonly total: number;
    };
    readonly input: number;
    readonly output: number;
    readonly totalTokens: number;
  };
}
export interface OmpSdkBindings {
  readonly AuthStorage: { create(path: string): Promise<OmpAuthStorage> };
  readonly ModelRegistry: OmpModelRegistryConstructor;
  readonly Settings: { isolated(overrides: Readonly<Record<string, unknown>>): unknown };
  readonly discoverBrokerAuthStorage: (
    agentDirectory: string,
    options: { cachePath: string; sourceLabel: string }
  ) => Promise<OmpAuthStorage>;
  readonly getBundledAgent: (name: string) => Readonly<Record<string, unknown>> | undefined;
  readonly parseModelString: (
    selector: string
  ) => { readonly id: string; readonly provider: string } | undefined;
  readonly runSubprocess: (options: Readonly<Record<string, unknown>>) => Promise<OmpSingleResult>;
}
export interface PrivateState {
  readonly agentDirectory: string;
  readonly authDatabasePath: string;
  readonly brokerCachePath: string;
  readonly modelsPath: string;
  readonly discoveryCwd: string;
  readonly root: string;
}
export interface YieldItem {
  readonly data?: unknown;
  readonly error?: string;
  readonly schemaOverridden?: boolean;
  readonly status?: 'success' | 'aborted';
  readonly type?: string | readonly string[];
  readonly useLastTurn?: boolean;
}
export interface CredentialChannel {
  readonly values: Readonly<Record<string, string>>;
}
export interface OmpSdkSidecarOptions {
  readonly loadOmpSdk?: () => Promise<OmpSdkBindings>;
  readonly runtimeVersion?: () => string | undefined;
  readonly signal?: AbortSignal;
  readonly credentialChannelFd?: number;
}

export class SidecarFailure extends Error {
  constructor(
    readonly code: OmpSdkErrorCode,
    readonly category: OmpSdkErrorCategory,
    readonly retryable: boolean
  ) {
    super(code);
    this.name = 'SidecarFailure';
  }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
export function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
export function natural(value: unknown): value is number {
  return nonnegative(value) && Number.isInteger(value);
}
