import type {
  providerAliases,
  providerIds,
  ProviderCapabilities,
  ProviderCapabilityState,
  ProviderCommandSpec,
  ProviderDockerMetadata,
  ProviderDockerMountPreset,
  ProviderDocsMetadata,
  ProviderInvokeSpec,
  ProviderRegistryEntry,
  StructuredOutputProviderRegistryEntry,
  UnstructuredOutputProviderRegistryEntry,
} from './provider-registry';
import type { OmpSessionLaunch } from './omp/rpc-session';

export type ProviderId = (typeof providerIds)[number];
export type ProviderAlias = (typeof providerAliases)[number];
export type KnownProviderName = ProviderId | ProviderAlias;
export type ModelLevel = 'level1' | 'level2' | 'level3';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type OutputFormat = 'text' | 'json' | 'stream-json';
export type GatewayProtocol = 'openai' | 'anthropic';
export type {
  ProviderCapabilities,
  ProviderCapabilityState,
  ProviderCommandSpec,
  ProviderDockerMetadata,
  ProviderDockerMountPreset,
  ProviderDocsMetadata,
  ProviderInvokeSpec,
  ProviderRegistryEntry,
  StructuredOutputProviderRegistryEntry,
  UnstructuredOutputProviderRegistryEntry,
};
export interface AgentCliProviderHelperMetadata {
  readonly packageName: '@the-open-engine/zeroshot';
  readonly buildOutputDir: 'lib/agent-cli-provider';
  readonly contractVersion: 1;
  readonly adapterVersion: string;
}

export interface ModelCatalogEntry {
  readonly rank: number;
}

export interface LevelModelSpec {
  readonly rank: number;
  readonly model: string | null;
  readonly reasoningEffort?: ReasoningEffort;
}

export interface ModelSpec {
  readonly level?: ModelLevel;
  readonly model?: string | null;
  readonly reasoningEffort?: ReasoningEffort;
}

export interface ResolvedModelSpec {
  readonly level: ModelLevel;
  readonly model: string | null;
  readonly reasoningEffort: ReasoningEffort | undefined;
}

export type LevelOverrides = Readonly<Partial<Record<ModelLevel, ModelSpec>>>;

export interface GatewayToolPolicy {
  readonly roots: readonly string[];
  readonly commands: readonly string[];
  readonly commandTimeoutMs?: number;
}

export interface GatewayBuildOptions {
  readonly protocol?: GatewayProtocol;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly model?: string | null;
  readonly maxTokens?: number;
  readonly toolPolicy?: GatewayToolPolicy;
}

export interface ResolvedGatewayBuildOptions {
  readonly protocol: GatewayProtocol;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly model: string;
  readonly maxTokens?: number;
  readonly toolPolicy: GatewayToolPolicy;
}

export interface BaseCliFeatures {
  readonly provider?: ProviderId;
  readonly unknown?: boolean;
  readonly supportsWebSearch?: boolean;
}

export interface ClaudeCliFeatures extends BaseCliFeatures {
  readonly provider: 'claude';
  readonly supportsOutputFormat: boolean;
  readonly supportsStreamJson: boolean;
  readonly supportsJsonSchema: boolean;
  readonly supportsAutoApprove: boolean;
  readonly supportsIncludePartials: boolean;
  readonly supportsVerbose: boolean;
  readonly supportsModel: boolean;
  readonly supportsEffort: boolean;
  readonly supportsSettings: boolean;
  readonly supportsMcpConfig: boolean;
  readonly supportsResume: boolean;
  readonly supportsTools: boolean;
  readonly supportsStrictMcpConfig: boolean;
  readonly supportsNoSessionPersistence: boolean;
}

export interface CodexCliFeatures extends BaseCliFeatures {
  readonly provider: 'codex';
  readonly supportsJson: boolean;
  readonly supportsOutputSchema: boolean;
  readonly supportsAutoApprove: boolean;
  readonly supportsCwd: boolean;
  readonly supportsConfigOverride: boolean;
  readonly supportsModel: boolean;
  readonly supportsSkipGitRepoCheck: boolean;
  readonly supportsResume: boolean;
  readonly supportsWebSearch: boolean;
  readonly supportsSandbox: boolean;
  readonly supportsEphemeral: boolean;
  readonly supportsIgnoreUserConfig: boolean;
  readonly supportsIgnoreRules: boolean;
  readonly supportsStrictConfig: boolean;
}

export interface GeminiCliFeatures extends BaseCliFeatures {
  readonly provider: 'gemini';
  readonly supportsStreamJson: boolean;
  readonly supportsAutoApprove: boolean;
  readonly supportsCwd: boolean;
  readonly supportsModel: boolean;
  readonly supportsAdminPolicy: boolean;
}

export interface OpencodeCliFeatures extends BaseCliFeatures {
  readonly provider: 'opencode';
  readonly supportsJson: boolean;
  readonly supportsModel: boolean;
  readonly supportsVariant: boolean;
  readonly supportsDir: boolean;
  readonly supportsCwd: boolean;
  readonly supportsAutoApprove: false;
  readonly supportsResume: boolean;
  readonly supportsWebSearch: boolean;
  readonly supportsAgent: boolean;
  readonly supportsRecoveryIsolation: boolean;
}

export interface PiCliFeatures extends BaseCliFeatures {
  readonly provider: 'pi';
  readonly versionMatches: boolean;
  readonly supportsJsonMode: boolean;
  readonly supportsModel: boolean;
  readonly supportsThinking: boolean;
  readonly supportsNoSession: boolean;
  readonly supportsNoExtensions: boolean;
  readonly supportsNoSkills: boolean;
  readonly supportsNoPromptTemplates: boolean;
  readonly supportsNoContextFiles: boolean;
  readonly supportsNoApprove: boolean;
}

export interface OmpCliFeatures extends BaseCliFeatures {
  readonly provider: 'omp';
  readonly supportsRpcMode: boolean;
  readonly supportsConfig: boolean;
  readonly supportsModel: boolean;
  readonly supportsThinking: boolean;
  readonly supportsApprovalMode: boolean;
  readonly supportsNoTitle: boolean;
  readonly supportsNoSession: boolean;
  readonly supportsSessionDir: boolean;
  readonly supportsResume: boolean;
  readonly versionMatches: boolean;
}

export interface CopilotCliFeatures extends BaseCliFeatures {
  readonly provider: 'copilot';
  readonly supportsJsonOutput: boolean;
  readonly supportsModel: boolean;
  readonly supportsAllowAll: boolean;
  readonly supportsNoAskUser: boolean;
  readonly supportsAddDir: boolean;
  readonly supportsMcpConfig: boolean;
}

export interface GatewayCliFeatures extends BaseCliFeatures {
  readonly provider: 'gateway';
  readonly supportsBundledRunner: true;
}

export interface AcpCliFeatures extends BaseCliFeatures {
  readonly provider: ProviderId;
  readonly supportsAcpStdio: boolean;
  readonly supportsPromptImages: boolean;
  readonly supportsLoadSession: boolean;
  readonly supportsSessionCancel: boolean;
  readonly supportsSessionSetModel: boolean;
  readonly supportsSessionSetMode: boolean;
  readonly supportsRemoteTransport: false;
  readonly supportsCustomTransport: false;
  readonly supportsPermissionRequests: false;
  readonly supportsFsTools: false;
  readonly supportsTerminalTools: false;
}

export type ProviderCliFeatures =
  | ClaudeCliFeatures
  | CodexCliFeatures
  | GeminiCliFeatures
  | OpencodeCliFeatures
  | PiCliFeatures
  | OmpCliFeatures
  | CopilotCliFeatures
  | GatewayCliFeatures
  | AcpCliFeatures;

export interface CliFeatureOverrides {
  readonly supportsOutputFormat?: boolean;
  readonly supportsStreamJson?: boolean;
  readonly supportsJsonSchema?: boolean;
  readonly supportsAutoApprove?: boolean;
  readonly supportsIncludePartials?: boolean;
  readonly supportsVerbose?: boolean;
  readonly supportsModel?: boolean;
  readonly supportsTools?: boolean;
  readonly supportsStrictMcpConfig?: boolean;
  readonly supportsNoSessionPersistence?: boolean;
  readonly supportsEffort?: boolean;
  readonly supportsSettings?: boolean;
  readonly supportsJson?: boolean;
  readonly supportsOutputSchema?: boolean;
  readonly supportsDir?: boolean;
  readonly supportsCwd?: boolean;
  readonly supportsConfigOverride?: boolean;
  readonly supportsSkipGitRepoCheck?: boolean;
  readonly supportsSandbox?: boolean;
  readonly supportsEphemeral?: boolean;
  readonly supportsIgnoreUserConfig?: boolean;
  readonly supportsIgnoreRules?: boolean;
  readonly supportsStrictConfig?: boolean;
  readonly supportsVariant?: boolean;
  readonly supportsAdminPolicy?: boolean;
  readonly supportsJsonMode?: boolean;
  readonly supportsNoSession?: boolean;
  readonly supportsNoExtensions?: boolean;
  readonly supportsNoSkills?: boolean;
  readonly supportsNoPromptTemplates?: boolean;
  readonly supportsAgent?: boolean;
  readonly supportsRecoveryIsolation?: boolean;
  readonly supportsNoContextFiles?: boolean;
  readonly supportsNoApprove?: boolean;
  readonly supportsRpcMode?: boolean;
  readonly supportsConfig?: boolean;
  readonly supportsThinking?: boolean;
  readonly supportsApprovalMode?: boolean;
  readonly supportsNoTitle?: boolean;
  readonly supportsSessionDir?: boolean;
  readonly versionMatches?: boolean;
  readonly supportsJsonOutput?: boolean;
  readonly supportsAllowAll?: boolean;
  readonly supportsNoAskUser?: boolean;
  readonly supportsAddDir?: boolean;
  readonly supportsMcpConfig?: boolean;
  readonly supportsResume?: boolean;
  readonly supportsWebSearch?: boolean;
  readonly supportsBundledRunner?: boolean;
  readonly supportsAcpStdio?: boolean;
  readonly supportsPromptImages?: boolean;
  readonly supportsLoadSession?: boolean;
  readonly supportsSessionCancel?: boolean;
  readonly supportsSessionSetModel?: boolean;
  readonly supportsSessionSetMode?: boolean;
  readonly supportsRemoteTransport?: false;
  readonly supportsCustomTransport?: false;
  readonly supportsPermissionRequests?: false;
  readonly supportsFsTools?: false;
  readonly supportsTerminalTools?: false;
  readonly unknown?: boolean;
}

export interface CleanupMetadata {
  readonly kind: 'temp-file' | 'temp-directory';
  readonly provider: ProviderId;
  readonly path: string;
  readonly reason:
    | 'output-schema'
    | 'settings-overlay'
    | 'admin-policy'
    | 'isolated-config'
    | 'sdk-private-root';
}

export interface WarningMetadata {
  readonly provider: ProviderId;
  readonly code: string;
  readonly message: string;
}

export interface RedactionMetadata {
  readonly kind: 'env' | 'secret-key' | 'secret-value';
  readonly key: string;
  readonly source?: string;
}

export interface WebSearchAttestation {
  readonly requested: boolean;
  readonly effective: boolean;
}

export type InvocationLane = 'spawn' | 'acp-stdio' | 'rpc-stdio';

export interface InvocationLaneMetadata {
  readonly lane: InvocationLane;
  readonly pty: boolean;
  readonly protocol?: 'omp-sdk-v1' | 'omp-rpc-v2' | 'acp';
}

export type PreparedInvocationParser = 'provider' | 'acp' | 'omp-sdk-ndjson';

export interface PreparedProviderInvoke {
  readonly lane: InvocationLane;
  readonly parser: PreparedInvocationParser;
  readonly ptyEligible: boolean;
  readonly strictTerminal: boolean;
}

export interface PreparedEnvironmentPolicy {
  readonly inherit: 'minimal';
  readonly values: Readonly<Record<string, string>>;
}

export interface PreparedPrivateArtifacts {
  readonly root: string;
  readonly requestPath: string;
  readonly owned: true;
}

export interface OmpSdkExecutionIdentity {
  readonly backend: 'omp-sdk';
  readonly backendVersion: '17.2.1';
  readonly runtime: {
    readonly name: 'bun';
    readonly version: '1.3.14';
  };
  readonly transport: 'sdk';
}

export interface OmpSdkSemanticIdentity {
  readonly requestedModelSelector: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly provider: string;
}

export interface OmpSdkContainmentRequirement {
  readonly mode: 'host-process-tree' | 'container';
  readonly required: true;
}

export interface OmpSdkCleanupAttestation {
  readonly mode: OmpSdkContainmentRequirement['mode'];
  readonly terminalBuffered: true;
  readonly descendantsReaped: true;
  readonly clean: true;
}

export interface OmpSdkRequestedIdentity {
  readonly modelSelector: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly outputMode: 'json' | 'text';
}

export interface OmpSdkResolvedIdentity {
  readonly modelSelector: string;
}

export interface OmpSdkStrictOutputEvidence {
  readonly source: 'caller';
  readonly mode: 'strict';
  readonly status: 'valid';
  readonly yieldCount: 1;
}

export interface OmpSdkUsageEvidence {
  readonly source: 'omp-aggregate';
  readonly completeness: 'unknown';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly totalTokens: number;
  readonly requests: number;
  readonly durationMs: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

export interface OmpSdkTerminalEvidence {
  readonly backend: {
    readonly id: 'omp-sdk';
    readonly version: '17.2.1';
  };
  readonly runtime: {
    readonly name: 'bun';
    readonly version: '1.3.14';
  };
  readonly requested: OmpSdkRequestedIdentity;
  readonly resolved: OmpSdkResolvedIdentity;
  readonly strictOutput: OmpSdkStrictOutputEvidence;
  readonly fallback: false;
  readonly execution: {
    readonly exitCode: 0;
    readonly aborted: false;
  };
  readonly usage: OmpSdkUsageEvidence;
}

export interface CommandSpec {
  readonly binary: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly cleanup?: readonly string[];
  readonly cleanupMetadata: readonly CleanupMetadata[];
  readonly warnings: readonly WarningMetadata[];
  readonly redactions: readonly RedactionMetadata[];
  readonly invocation?: InvocationLaneMetadata;
}

export interface BuildProviderCommandOptions {
  readonly modelSpec?: ModelSpec;
  readonly outputFormat?: OutputFormat;
  readonly jsonSchema?: unknown;
  readonly cwd?: string;
  readonly agentName?: string;
  readonly autoApprove?: boolean;
  readonly resumeSessionId?: string;
  readonly continueSession?: boolean;
  // OMP-only: a verified session launch (none/fresh/resume) built from a checked partition —
  // never a raw session id string. See src/agent-cli-provider/omp/rpc-session.ts.
  readonly ompSession?: OmpSessionLaunch;
  readonly webSearch?: boolean;
  readonly claudeSettingsFile?: string;
  readonly cliFeatures?: CliFeatureOverrides;
  readonly authEnv?: Readonly<Record<string, string>>;
  readonly strictSchema?: boolean;
  readonly gateway?: GatewayBuildOptions;
  /**
   * Required for fresh OMP SDK runs so preparation can select the containment and
   * authentication policy before any private request is materialized.
   */
  readonly executionContext?: 'host' | 'detached' | 'docker' | 'benchmark';
  // MCP server configs forwarded to providers that accept an MCP config CLI flag. Claude accepts
  // one variadic `--mcp-config` followed by file paths; adapters such as Copilot accept repeated
  // flags with inline JSON so configs survive container path translation.
  readonly mcpConfig?: readonly string[];
  /** Internal profile for provider-neutral structured-output correction turns. */
  readonly structuredOutputRecovery?: boolean;
  /** Preserve a caller-isolated CODEX_HOME profile during Codex recovery. */
  readonly trustIsolatedCodexProfile?: boolean;
}

export interface TextEvent {
  readonly type: 'text';
  readonly text: string;
}

export interface ThinkingEvent {
  readonly type: 'thinking';
  readonly text: string;
}

export interface ToolCallEvent {
  readonly type: 'tool_call';
  readonly toolName: string | null | undefined;
  readonly toolId: string | null | undefined;
  readonly input: unknown;
}

export interface ToolResultEvent {
  readonly type: 'tool_result';
  readonly toolId: string | null | undefined;
  readonly content: unknown;
  readonly isError: unknown;
}

export interface ResultEvent {
  readonly type: 'result';
  readonly success: boolean;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly cost?: unknown;
  readonly duration?: unknown;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly modelUsage?: unknown;
  readonly requests?: number;
  readonly usageSource?: 'omp-aggregate';
  readonly usageCompleteness?: 'unknown';
  readonly invocation?: InvocationLaneMetadata;
  readonly ompSdk?: OmpSdkTerminalEvidence;
}

export type OutputEvent = TextEvent | ThinkingEvent | ToolCallEvent | ToolResultEvent | ResultEvent;

export type ProviderParseResult = OutputEvent | readonly OutputEvent[] | null;

export interface ProviderParserState {
  readonly provider: ProviderId;
  lastToolId: string | null | undefined;
  lastAssistantText?: string;
  lastAssistantThinking?: string;
  messagePhaseById?: Map<string, string>;
  assistantTextByMessageId?: Map<string, string>;
  assistantThinkingByMessageId?: Map<string, string>;
  toolCalls?: Map<
    string,
    {
      name: string | null | undefined;
      input: unknown;
    }
  >;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  } | null;
}

export type ErrorClassificationKind =
  | 'status-retryable'
  | 'status-permanent'
  | 'code-retryable'
  | 'permanent-pattern'
  | 'retryable-pattern'
  | 'unknown-retryable'
  | 'cancelled';

export interface ErrorClassification {
  readonly retryable: boolean;
  readonly kind: ErrorClassificationKind;
  readonly matchedPattern?: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly binary: string;
  readonly adapterVersion: string;
  readonly credentialEnvKeys: readonly string[];
  readonly modelCatalog: Readonly<Record<string, ModelCatalogEntry>>;
  readonly levelMapping: Readonly<Record<ModelLevel, LevelModelSpec>>;
  readonly defaultLevel: ModelLevel;
  readonly defaultMaxLevel: ModelLevel;
  readonly defaultMinLevel: ModelLevel;
  detectCliFeatures(helpText?: string | null, versionText?: string | null): ProviderCliFeatures;
  buildCommand(context: string, options?: BuildProviderCommandOptions): CommandSpec;
  extractSessionId?(line: string): string | null;
  parseEvent(line: string, state: ProviderParserState): ProviderParseResult;
  finishParsing?(state: ProviderParserState): ProviderParseResult;
  createParserState(): ProviderParserState;
  resolveModelSpec(level: ModelLevel, overrides?: LevelOverrides): ResolvedModelSpec;
  validateModelId(modelId: string | null | undefined): string | null | undefined;
  validateConfiguredModelId?(modelId: string | null | undefined): string | null | undefined;
  classifyError(error: unknown): ErrorClassification;
}

export interface StructuredOutputRecoveryAdapter extends ProviderAdapter {
  buildStructuredOutputRecoveryCommand(
    context: string,
    options?: BuildProviderCommandOptions
  ): CommandSpec;
}

export class InvalidProviderModelError extends Error {
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidProviderModelError';
  }
}
