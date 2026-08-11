interface Settings extends Record<string, unknown> {}

interface ClusterConfig extends Record<string, unknown> {}

interface ClusterInput extends Record<string, string> {}

interface OrchestratorFacade {
  loadConfig(configPath: string): ClusterConfig;
  start(config: ClusterConfig, input: ClusterInput, options: unknown): unknown;
}

interface ProviderNamesFacade {
  normalizeProviderName(name: string): string;
}

interface ProvidersFacade {
  getProvider(providerId: string): unknown;
}

interface IssueProvidersFacade {
  detectProvider(input: string, settings: Settings, forceProvider: string | null): unknown;
}

interface ConfigHelpersFacade {
  resolveConfigPath(configName: string): string;
  prepareClusterConfig(
    config: ClusterConfig,
    settings?: Settings,
    providerOverride?: string | null
  ): ClusterConfig;
  loadClusterConfig(
    orchestrator: OrchestratorFacade,
    configPath: string,
    settings?: Settings,
    providerOverride?: string | null
  ): ClusterConfig;
}

interface RunOptionsHelpersFacade {
  buildStartOptions(args: Record<string, unknown>): unknown;
  buildTrustedStartOptions(args: Record<string, unknown>): unknown;
  resolveEffectiveRunPlan(options?: Record<string, unknown>, settings?: Settings): unknown;
  detectGitRepoRoot(): string;
}

interface ProviderOverrideOptions {
  provider?: string | null;
  envProvider?: string | null;
  validateProvider?: unknown;
}

interface StartClusterArgs extends Record<string, unknown> {
  orchestrator?: OrchestratorFacade;
  config?: ClusterConfig | null;
  configPath?: string | null;
  configName?: string | null;
  settings?: Settings;
  providerOverride?: string | null;
  modelOverride?: unknown;
  forceProvider?: unknown;
  clusterId?: unknown;
  options?: Record<string, unknown>;
  text: string;
  issue: string;
  file: string;
}

interface ResolveConfigArgs {
  orchestrator: OrchestratorFacade;
  config?: ClusterConfig | null | undefined;
  configPath?: string | null | undefined;
  configName?: string | null | undefined;
  settings?: Settings | undefined;
  providerOverride?: string | null | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const providerNames: ProviderNamesFacade = require('./provider-names');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const providers: ProvidersFacade = require('../src/providers');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const issueProviders: IssueProvidersFacade = require('../src/issue-providers');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const configHelpers: ConfigHelpersFacade = require('./start-cluster-config');
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const runOptionsHelpers: RunOptionsHelpersFacade = require('./start-cluster-run-options');

const { normalizeProviderName } = providerNames;
const { getProvider } = providers;
const { detectProvider } = issueProviders;
const { resolveConfigPath, prepareClusterConfig, loadClusterConfig } = configHelpers;
const { buildStartOptions, buildTrustedStartOptions, resolveEffectiveRunPlan, detectGitRepoRoot } =
  runOptionsHelpers;

function buildTextInput(text: string): ClusterInput {
  return { text };
}

function buildIssueInput(issue: string): ClusterInput {
  return { issue };
}

function buildFileInput(file: string): ClusterInput {
  return { file };
}

function detectRunInput(
  inputArg: string,
  settings: Settings = {},
  forceProvider: string | null = null
): ClusterInput {
  const isMarkdownFile = /\.(md|markdown)$/i.test(inputArg);
  if (isMarkdownFile) {
    return buildFileInput(inputArg);
  }

  const ProviderClass = detectProvider(inputArg, settings, forceProvider);
  if (ProviderClass) {
    return buildIssueInput(inputArg);
  }

  return buildTextInput(inputArg);
}

const STDIN_MARKER = '-';

function isStdinInput(inputArg: string): boolean {
  return inputArg === STDIN_MARKER;
}

async function readStdinText(
  stream: AsyncIterable<string | Uint8Array> = process.stdin
): Promise<string> {
  const chunks: Array<string | Uint8Array> = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))))
    .toString('utf8')
    .trim();
}

function encodeStdinEnv(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodeStdinEnv(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function resolveProviderOverride(options: ProviderOverrideOptions = {}): string | null {
  const override = options.provider || options.envProvider || process.env.ZEROSHOT_PROVIDER;
  if (!override || !override.trim()) {
    return null;
  }
  const normalized = normalizeProviderName(override);
  if (options.validateProvider) {
    getProvider(normalized);
  }
  return normalized;
}

function resolveConfigOrThrow({
  orchestrator,
  config,
  configPath,
  configName,
  settings,
  providerOverride,
}: ResolveConfigArgs): ClusterConfig {
  if (config) {
    return config;
  }
  const resolvedPath = configPath || (configName ? resolveConfigPath(configName) : null);
  if (!resolvedPath) {
    throw new Error('configPath or configName is required when config is not provided');
  }
  return loadClusterConfig(orchestrator, resolvedPath, settings, providerOverride);
}

function startClusterWithInput(args: StartClusterArgs, input: ClusterInput): unknown {
  const { orchestrator, config, configPath, configName, settings, providerOverride } = args;
  if (!orchestrator) {
    throw new Error('orchestrator is required');
  }
  const resolvedConfig = resolveConfigOrThrow({
    orchestrator,
    config,
    configPath,
    configName,
    settings,
    providerOverride,
  });
  const startOptions = buildStartOptions({
    clusterId: args.clusterId,
    options: args.options || {},
    settings,
    providerOverride,
    modelOverride: args.modelOverride,
    forceProvider: args.forceProvider,
  });
  return orchestrator.start(resolvedConfig, input, startOptions);
}

function startClusterFromText(args: StartClusterArgs): unknown {
  return startClusterWithInput(args, buildTextInput(args.text));
}

function startClusterFromIssue(args: StartClusterArgs): unknown {
  return startClusterWithInput(args, buildIssueInput(args.issue));
}

function startClusterFromFile(args: StartClusterArgs): unknown {
  return startClusterWithInput(args, buildFileInput(args.file));
}

export = {
  buildTextInput,
  buildIssueInput,
  buildFileInput,
  detectRunInput,
  isStdinInput,
  readStdinText,
  encodeStdinEnv,
  decodeStdinEnv,
  resolveProviderOverride,
  resolveConfigPath,
  prepareClusterConfig,
  loadClusterConfig,
  buildStartOptions,
  buildTrustedStartOptions,
  resolveEffectiveRunPlan,
  startClusterFromText,
  startClusterFromIssue,
  startClusterFromFile,
  detectGitRepoRoot,
};
