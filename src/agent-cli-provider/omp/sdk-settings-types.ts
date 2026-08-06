export const OMP_SDK_TOOL_IDS = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'glob',
  'lsp',
  'ast_edit',
] as const;
export const OMP_SDK_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const OMP_AUTH_BROKER_ENV_NAMES = Object.freeze({
  url: 'OMP_AUTH_BROKER_URL',
  token: 'OMP_AUTH_BROKER_TOKEN',
});

export type OmpSdkToolId = (typeof OMP_SDK_TOOL_IDS)[number];
export type OmpTransport = 'sdk' | 'rpc';
export type OmpModelLevel = 'level1' | 'level2' | 'level3';
export type OmpReasoningEffort = (typeof OMP_SDK_REASONING_EFFORTS)[number];
export type OmpExecutionContext = 'host' | 'detached' | 'docker';

export interface ExactOmpModelSelector {
  readonly provider: string;
  readonly model: string;
}

export interface OmpLevelOverride {
  readonly model: string;
  readonly reasoningEffort: OmpReasoningEffort;
}

export interface OmpEnvironmentAuth {
  readonly mode: 'environment';
  readonly credentials: Readonly<Record<string, { readonly env: string }>>;
}

export interface OmpBrokerAuth {
  readonly mode: 'broker';
}

export interface OmpHomeAuth {
  readonly mode: 'omp-home';
  /** Explicit OMP agent/config directory containing agent.db, not a HOME root. */
  readonly path: string;
}

export interface OmpNoneAuth {
  readonly mode: 'none';
}

export type OmpSdkAuth = OmpEnvironmentAuth | OmpBrokerAuth | OmpHomeAuth | OmpNoneAuth;

export interface OmpModelDefinition {
  readonly [field: string]: unknown;
  readonly id: string;
}

export interface OmpProviderConfig {
  readonly [field: string]: unknown;
}

export interface OmpModelsConfig {
  readonly providers: Readonly<Record<string, OmpProviderConfig>>;
}

export interface OmpSdkSettings {
  readonly transport: OmpTransport;
  readonly minLevel: OmpModelLevel;
  readonly defaultLevel: OmpModelLevel;
  readonly maxLevel: OmpModelLevel;
  readonly levelOverrides: Readonly<Partial<Record<OmpModelLevel, OmpLevelOverride>>>;
  readonly modelsConfig: OmpModelsConfig;
  readonly auth?: OmpSdkAuth;
  readonly tools: readonly OmpSdkToolId[];
  readonly nestedAgents: false;
  readonly mcp: false;
}

export interface ConfiguredOmpSdkSettings extends OmpSdkSettings {
  readonly levelOverrides: Readonly<Record<OmpModelLevel, OmpLevelOverride>>;
  readonly auth: OmpSdkAuth;
}

export interface OmpSettingsValidationContext {
  readonly executionContext?: OmpExecutionContext;
  readonly requireModelConfiguration?: boolean;
}
