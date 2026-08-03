import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getProviderAdapter } from './adapters';
import { UnsupportedProviderCapabilityError } from './errors';
import { normalizeGatewayBuildOptions, resolveGatewayConfiguration } from './gateway-tools';
import { isRecord } from './json';
import {
  OMP_SDK_BACKEND_VERSION,
  OMP_SDK_BUN_VERSION,
  OMP_SDK_MAX_REQUEST_BYTES,
  OMP_SDK_PROTOCOL_VERSION,
  parseOmpSdkSidecarRequest,
} from './omp-sdk-protocol';
import type {
  OmpSdkExecutionContext,
  OmpSdkSidecarRequest,
} from './omp-sdk-protocol';
import {
  normalizeOmpSdkSettings,
  OMP_AUTH_BROKER_ENV_NAMES,
  parseExactOmpModelSelector,
  resolveOmpSdkSettings,
} from './omp-sdk-settings';
import type { ConfiguredOmpSdkSettings } from './omp-sdk-settings';
import {
  getDefaultProviderId,
  getProviderRegistryEntry,
  resolveProviderCommand,
  supportsProviderCapability,
  supportsProviderOutputReformatting,
} from './provider-registry';
import type {
  BuildProviderCommandOptions,
  CliFeatureOverrides,
  CommandSpec,
  GatewayBuildOptions,
  LevelOverrides,
  ModelLevel,
  ModelSpec,
  ProviderAdapter,
  StructuredOutputRecoveryAdapter,
  ProviderCliFeatures,
  ProviderId,
  ResolvedGatewayBuildOptions,
  ReasoningEffort,
  OmpSdkContainmentRequirement,
  OmpSdkExecutionIdentity,
  OmpSdkSemanticIdentity,
  PreparedEnvironmentPolicy,
  PreparedPrivateArtifacts,
  PreparedProviderInvoke,
  WebSearchAttestation,
} from './types';

type UnknownFunction = (...args: readonly unknown[]) => unknown;

interface CommandParts {
  readonly command: string;
  readonly args: readonly string[];
}

interface RuntimeProviderSettings {
  readonly defaultLevel?: ModelLevel;
  readonly levelOverrides: LevelOverrides;
  readonly gateway?: GatewayBuildOptions;
  readonly webSearch?: boolean;
}

interface RuntimeCommandContext {
  readonly cliFeatures: CliFeatureOverrides;
  readonly authEnv: Readonly<Record<string, string>>;
}

export interface SingleAgentProviderCommandInput {
  readonly provider?: string | null;
  readonly context: string;
  readonly options?: BuildProviderCommandOptions;
}

export interface PreparedSingleAgentProviderCommand {
  readonly adapter: ProviderAdapter;
  readonly commandSpec: CommandSpec;
  readonly context: string;
  readonly options: BuildProviderCommandOptions;
  readonly cliFeatures: CliFeatureOverrides;
  readonly configuration: {
    readonly webSearch: WebSearchAttestation;
  };
  readonly invoke: PreparedProviderInvoke;
  readonly environmentPolicy?: PreparedEnvironmentPolicy;
  readonly credentialNames?: readonly string[];
  readonly privateArtifacts?: PreparedPrivateArtifacts;
  readonly executionIdentity?: OmpSdkExecutionIdentity;
  readonly semanticIdentity?: OmpSdkSemanticIdentity;
  readonly containmentRequirement?: OmpSdkContainmentRequirement;
}

export interface RuntimeProviderProbe {
  readonly available: boolean;
  readonly helpText: string;
  readonly versionText: string;
  readonly capabilities: ProviderCliFeatures;
  readonly configuration: {
    readonly webSearch: WebSearchAttestation;
  };
}

interface RuntimeProbeEvidence {
  readonly available?: boolean;
  readonly helpText: string;
  readonly versionText: string;
}

type MutableModelSpec = {
  level?: ModelLevel;
  model?: string | null;
  reasoningEffort?: ReasoningEffort;
};

const MODEL_LEVELS: readonly ModelLevel[] = ['level1', 'level2', 'level3'];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV = 'ZEROSHOT_ISOLATED_PROVIDER_SETTINGS_JSON';
const settingsModule: unknown = require('../../lib/settings');
const providerDetectionModule: unknown = require('../../lib/provider-detection');
const claudeAuthModule: unknown = require('../../lib/settings/claude-auth');
const ompSdkRuntimeModule: unknown = require('../../scripts/omp-sdk-runtime');

const loadSettingsFn = moduleFunction(settingsModule, 'loadSettings');
const getClaudeCommandFn = moduleFunction(settingsModule, 'getClaudeCommand');
const commandExistsFn = moduleFunction(providerDetectionModule, 'commandExists');
const getHelpOutputFn = moduleFunction(providerDetectionModule, 'getHelpOutput');
const getVersionOutputFn = moduleFunction(providerDetectionModule, 'getVersionOutput');
const resolveClaudeAuthFn = moduleFunction(claudeAuthModule, 'resolveClaudeAuth');
const resolveOmpSdkRuntimeFn = moduleFunction(ompSdkRuntimeModule, 'resolveOmpSdkRuntime');

export function prepareSingleAgentProviderCommand(
  input: SingleAgentProviderCommandInput
): PreparedSingleAgentProviderCommand {
  rejectCallerSuppliedModelProvenance(input);
  const baseOptions = input.options ?? {};
  const settings = loadRuntimeSettings();
  const adapter = adapterForRuntimeInput(input.provider, settings);
  const ompTransport = adapter.id === 'omp' ? runtimeOmpTransport(settings) : undefined;
  if (ompTransport === 'sdk') {
    const configuredOmpSettings = resolveOmpSdkSettings(settings);
    return prepareOmpProviderCommand(input, adapter, baseOptions, configuredOmpSettings);
  }
  const providerSettings = runtimeProviderSettings(
    settings,
    adapter.id,
    baseOptions.cwd ?? process.cwd()
  );
  const requestedWebSearch = baseOptions.structuredOutputRecovery
    ? recoveryWebSearchOption(adapter)
    : (baseOptions.webSearch ?? providerSettings.webSearch);
  assertWebSearchDeclared(adapter.id, requestedWebSearch);
  const cliFeatures = resolveRuntimeCliFeatures(
    adapter.id,
    baseOptions.cliFeatures,
    requestedWebSearch === true
  );
  const authEnv = baseOptions.authEnv ?? resolveRuntimeAuthEnv(adapter.id, settings);
  const options = buildRuntimeOptions(baseOptions, adapter, providerSettings, {
    cliFeatures,
    authEnv,
  });
  return {
    invoke: preparedInvokeForRegistry(adapter, options),
    adapter,
    context: input.context,
    options,
    cliFeatures,
    configuration: {
      webSearch: webSearchAttestation(options),
    },
    commandSpec: buildRuntimeCommand(adapter, input.context, options),
  };
}
interface OmpSdkRuntimeAssets {
  readonly bunExecutable: string;
  readonly bunVersion: string;
  readonly ompVersion: string;
  readonly sidecarPath: string;
}


function prepareOmpProviderCommand(
  input: SingleAgentProviderCommandInput,
  adapter: ProviderAdapter,
  baseOptions: BuildProviderCommandOptions,
  rawOmpSettings: unknown
): PreparedSingleAgentProviderCommand {
  const executionContext = ompExecutionContext(baseOptions.executionContext);
  const normalized = normalizeOmpSdkSettings(rawOmpSettings, {
    ...(executionContext === undefined
      ? {}
      : {
          executionContext: executionContext === 'benchmark' ? 'docker' : executionContext,
        }),
    requireModelConfiguration: true,
  });
  if (executionContext === undefined) {
    throw new Error(
      'options.executionContext is required for OMP SDK preparation and must be "host", "detached", "docker", or "benchmark".'
    );
  }
  if (baseOptions.resumeSessionId !== undefined || baseOptions.continueSession === true) {
    throw new UnsupportedProviderCapabilityError(
      'omp',
      'sessionResume',
      'OMP SDK structured runs are always fresh; resume and continue are not supported.'
    );
  }
  if (baseOptions.structuredOutputRecovery === true) {
    throw new UnsupportedProviderCapabilityError(
      'omp',
      'structuredOutputRecovery',
      'OMP SDK strict output is produced by the original coding turn and cannot run a recovery turn.'
    );
  }
  if (baseOptions.mcpConfig !== undefined && baseOptions.mcpConfig.length > 0) {
    throw new UnsupportedProviderCapabilityError(
      'omp',
      'mcpServers',
      'OMP SDK preparation does not accept caller MCP configuration.'
    );
  }
  if (baseOptions.webSearch === true) {
    throw new UnsupportedProviderCapabilityError(
      'omp',
      'webSearch',
      'OMP SDK preparation uses the configured closed coding-tool allowlist and does not enable web search.'
    );
  }
  if (baseOptions.authEnv !== undefined && Object.keys(baseOptions.authEnv).length > 0) {
    throw new Error(
      'options.authEnv is not accepted for OMP SDK preparation; declare credential environment variable names in providerSettings.omp.auth.'
    );
  }

  const configured = normalized as Readonly<ConfiguredOmpSdkSettings>;
  const level = baseOptions.modelSpec?.level ?? configured.defaultLevel;
  const levelOverride = configured.levelOverrides[level];
  const requestedModel = baseOptions.modelSpec?.model;
  if (requestedModel === null) {
    throw new Error('options.modelSpec.model must be an exact OMP provider/model selector.');
  }
  if (
    MODEL_LEVELS.indexOf(level) < MODEL_LEVELS.indexOf(configured.minLevel) ||
    MODEL_LEVELS.indexOf(level) > MODEL_LEVELS.indexOf(configured.maxLevel)
  ) {
    throw new Error(
      `options.modelSpec.level must be between providerSettings.omp.minLevel (${configured.minLevel}) and maxLevel (${configured.maxLevel}).`
    );
  }
  if (requestedModel !== undefined && requestedModel !== levelOverride.model) {
    throw new Error(
      `options.modelSpec.model must exactly match providerSettings.omp.levelOverrides.${level}.model.`
    );
  }
  const modelSelector = requestedModel ?? levelOverride.model;
  const parsedSelector = parseExactOmpModelSelector(modelSelector);
  const reasoningEffort =
    baseOptions.modelSpec?.reasoningEffort ?? levelOverride.reasoningEffort;
  const output = ompSdkOutputContract(baseOptions);
  const cwd = path.resolve(baseOptions.cwd ?? process.cwd());
  const cliFeatures = adapter.detectCliFeatures('', '');
  const options: BuildProviderCommandOptions = {
    cwd,
    executionContext,
    modelSpec: {
      level,
      model: modelSelector,
      reasoningEffort,
    },
    outputFormat: output.mode,
    ...(output.mode === 'json' ? { jsonSchema: output.schema } : {}),
    strictSchema: true,
    cliFeatures,
  };

  const requestInput: OmpSdkSidecarRequest =
    output.mode === 'json'
      ? {
          protocolVersion: OMP_SDK_PROTOCOL_VERSION,
          runId: randomUUID(),
          cwd,
          executionContext,
          prompt: input.context,
          modelSelector,
          reasoningEffort,
          modelsConfig: configured.modelsConfig,
          auth: configured.auth,
          tools: configured.tools,
          context: '',
          outputMode: 'json',
          outputSchema: output.schema,
        }
      : {
          protocolVersion: OMP_SDK_PROTOCOL_VERSION,
          runId: randomUUID(),
          cwd,
          executionContext,
          prompt: input.context,
          modelSelector,
          reasoningEffort,
          modelsConfig: configured.modelsConfig,
          auth: configured.auth,
          tools: configured.tools,
          context: '',
          outputMode: 'text',
        };
  const request = parseOmpSdkSidecarRequest(requestInput);
  const requestText = JSON.stringify(request);
  if (Buffer.byteLength(requestText, 'utf8') > OMP_SDK_MAX_REQUEST_BYTES) {
    throw new Error(`OMP SDK request exceeds ${OMP_SDK_MAX_REQUEST_BYTES} bytes.`);
  }

  const usesContainerRuntime =
    executionContext === 'docker' || executionContext === 'benchmark';
  const runtime = usesContainerRuntime
    ? {
        bunExecutable: '/opt/zeroshot/node_modules/bun/bin/bun.exe',
        bunVersion: OMP_SDK_BUN_VERSION,
        ompVersion: OMP_SDK_BACKEND_VERSION,
        sidecarPath: '/opt/zeroshot/scripts/omp-sdk-sidecar.ts',
      }
    : ompSdkRuntimeAssets();
  let privateRoot: string | undefined;
  try {
    privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-sdk-request-'));
    fs.chmodSync(privateRoot, 0o700);
    const requestPath = path.join(privateRoot, 'request.json');
    fs.writeFileSync(requestPath, requestText, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(requestPath, 0o600);
    const credentialNames = ompSdkCredentialNames(configured, parsedSelector.provider);
    const invoke = {
      lane: 'spawn',
      parser: 'omp-sdk-ndjson',
      ptyEligible: false,
      strictTerminal: true,
    } as const;
    return {
      context: input.context,
      adapter,
      options,
      cliFeatures,
      configuration: {
        webSearch: { requested: false, effective: false },
      },
      invoke,
      environmentPolicy: {
        inherit: 'minimal',
        values: Object.freeze({}),
      },
      credentialNames,
      privateArtifacts: {
        root: privateRoot,
        requestPath,
        owned: true,
      },
      executionIdentity: {
        backend: 'omp-sdk',
        backendVersion: OMP_SDK_BACKEND_VERSION,
        runtime: {
          name: 'bun',
          version: OMP_SDK_BUN_VERSION,
        },
        transport: 'sdk',
      },
      semanticIdentity: {
        requestedModelSelector: modelSelector,
        reasoningEffort,
        provider: parsedSelector.provider,
      },
      containmentRequirement: {
        mode: usesContainerRuntime ? 'container' : 'host-process-tree',
        required: true,
      },
      commandSpec: {
        binary: runtime.bunExecutable,
        args: [runtime.sidecarPath, requestPath],
        env: {},
        cwd,
        cleanup: [privateRoot],
        cleanupMetadata: [
          {
            kind: 'temp-directory',
            provider: 'omp',
            path: privateRoot,
            reason: 'sdk-private-root',
          },
        ],
        warnings: [],
        redactions: credentialNames.map((key) => ({ kind: 'env' as const, key })),
        invocation: {
          lane: 'spawn',
          pty: false,
          protocol: 'omp-sdk-v1',
        },
      },
    };
  } catch (error) {
    if (privateRoot !== undefined) {
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

function ompExecutionContext(
  value: BuildProviderCommandOptions['executionContext']
): OmpSdkExecutionContext | undefined {
  if (value === undefined) return undefined;
  if (
    value === 'host' ||
    value === 'detached' ||
    value === 'docker' ||
    value === 'benchmark'
  ) {
    return value;
  }
  throw new Error(
    'options.executionContext must be "host", "detached", "docker", or "benchmark".'
  );
}

function runtimeOmpTransport(settings: Record<string, unknown>): 'sdk' | 'rpc' {
  const providerSettings = settings.providerSettings;
  if (!isRecord(providerSettings)) return 'sdk';
  const omp = providerSettings.omp;
  return isRecord(omp) && omp.transport === 'rpc' ? 'rpc' : 'sdk';
}

function ompSdkOutputContract(options: BuildProviderCommandOptions):
  | { readonly mode: 'json'; readonly schema: boolean | Readonly<Record<string, unknown>> }
  | { readonly mode: 'text' } {
  const hasSchema = options.jsonSchema !== undefined && options.jsonSchema !== null;
  if (hasSchema) {
    if (options.outputFormat !== undefined && options.outputFormat !== 'json') {
      throw new Error('OMP SDK caller schemas require options.outputFormat "json".');
    }
    if (options.strictSchema === false) {
      throw new Error('OMP SDK caller schemas require strict schema enforcement.');
    }
    if (typeof options.jsonSchema !== 'boolean' && !isRecord(options.jsonSchema)) {
      throw new Error('options.jsonSchema must be a boolean or JSON Schema object.');
    }
    return { mode: 'json', schema: options.jsonSchema };
  }
  if (options.outputFormat !== undefined && options.outputFormat !== 'text') {
    throw new Error(
      'OMP SDK output without a caller schema must use options.outputFormat "text" and the host-owned strict text envelope.'
    );
  }
  if (options.strictSchema === false) {
    throw new Error('OMP SDK text output always uses the host-owned strict text envelope.');
  }
  return { mode: 'text' };
}

function ompSdkCredentialNames(
  settings: Readonly<ConfiguredOmpSdkSettings>,
  provider: string
): readonly string[] {
  if (settings.auth.mode === 'environment') {
    const credential = settings.auth.credentials[provider];
    if (credential === undefined) {
      throw new Error(`No OMP environment credential reference is declared for ${provider}.`);
    }
    return Object.freeze([credential.env]);
  }
  if (settings.auth.mode === 'broker') {
    return Object.freeze(
      [OMP_AUTH_BROKER_ENV_NAMES.token, OMP_AUTH_BROKER_ENV_NAMES.url].sort((left, right) =>
        left.localeCompare(right, 'en')
      )
    );
  }
  return Object.freeze([]);
}

function ompSdkRuntimeAssets(): OmpSdkRuntimeAssets {
  const value = resolveOmpSdkRuntimeFn();
  if (!isRecord(value)) throw new Error('Pinned OMP SDK runtime resolver returned invalid evidence.');
  const runtime = {
    bunExecutable: requiredStringValue(value.bunExecutable, 'ompSdkRuntime.bunExecutable'),
    bunVersion: requiredStringValue(value.bunVersion, 'ompSdkRuntime.bunVersion'),
    ompVersion: requiredStringValue(value.ompVersion, 'ompSdkRuntime.ompVersion'),
    sidecarPath: requiredStringValue(value.sidecarPath, 'ompSdkRuntime.sidecarPath'),
  };
  if (
    runtime.bunVersion !== OMP_SDK_BUN_VERSION ||
    runtime.ompVersion !== OMP_SDK_BACKEND_VERSION
  ) {
    throw new Error('Pinned OMP SDK runtime identity does not match the sidecar protocol.');
  }
  return runtime;
}

function preparedInvokeForRegistry(
  adapter: ProviderAdapter,
  options: BuildProviderCommandOptions
): PreparedProviderInvoke {
  const invoke = getProviderRegistryEntry(adapter.id).invoke;
  if (invoke.lane === 'acp-stdio') {
    return {
      lane: 'acp-stdio',
      parser: 'acp',
      ptyEligible: false,
      strictTerminal: false,
    };
  }
  if (invoke.lane === 'rpc-stdio') {
    return {
      lane: 'rpc-stdio',
      parser: 'provider',
      ptyEligible: false,
      strictTerminal: false,
    };
  }
  return {
    lane: 'spawn',
    parser: 'provider',
    ptyEligible: !(adapter.id === 'claude' && Boolean(options.jsonSchema)),
    strictTerminal: false,
  };
}


function buildRuntimeCommand(
  adapter: ProviderAdapter,
  context: string,
  options: BuildProviderCommandOptions
): CommandSpec {
  if (options.structuredOutputRecovery !== true) {
    return adapter.buildCommand(context, options);
  }
  if (!supportsProviderOutputReformatting(adapter.id)) {
    throw new UnsupportedProviderCapabilityError(
      adapter.id,
      'structuredOutputRecovery',
      `Provider ${adapter.id} does not advertise structured-output recovery.`
    );
  }
  const recoveryAdapter = adapter as ProviderAdapter &
    Partial<StructuredOutputRecoveryAdapter>;
  if (typeof recoveryAdapter.buildStructuredOutputRecoveryCommand !== 'function') {
    throw new UnsupportedProviderCapabilityError(
      adapter.id,
      'structuredOutputRecovery',
      `Provider ${adapter.id} advertises structured output without a recovery adapter. Upgrade Zeroshot before retrying.`
    );
  }
  return recoveryAdapter.buildStructuredOutputRecoveryCommand(context, options);
}

export function detectRuntimeProviderCliFeatures(provider: string): ProviderCliFeatures {
  return probeRuntimeProviderCli(provider).capabilities;
}

function resolveRuntimeCliFeatures(
  provider: ProviderId,
  overrides: CliFeatureOverrides | undefined,
  webSearchRequested: boolean
): CliFeatureOverrides {
  if (provider === 'gateway') {
    const detected = detectRuntimeProviderCliFeatures(provider);
    return {
      ...detected,
      ...overrides,
      supportsBundledRunner: true,
      supportsWebSearch: false,
    };
  }
  if (getProviderRegistryEntry(provider).invoke.lane === 'acp-stdio') {
    const detected = detectRuntimeProviderCliFeatures(provider);
    if (overrides === undefined) return detected;
    return mergeAcpFailClosedCliFeatures(detected, overrides);
  }
  if (overrides === undefined) return detectRuntimeProviderCliFeatures(provider);
  if (!webSearchRequested) return overrides;
  const detected = detectRuntimeProviderCliFeatures(provider);
  return {
    ...overrides,
    supportsResume:
      'supportsResume' in detected &&
      detected.supportsResume === true &&
      overrides.supportsResume !== false,
    supportsWebSearch:
      detected.supportsWebSearch === true && overrides.supportsWebSearch !== false,
  };
}

function mergeAcpFailClosedCliFeatures(
  detected: ProviderCliFeatures,
  overrides: CliFeatureOverrides
): CliFeatureOverrides {
  if (!('supportsAcpStdio' in detected)) return overrides;
  return {
    ...detected,
    ...overrides,
    supportsAcpStdio: detected.supportsAcpStdio && overrides.supportsAcpStdio !== false,
    supportsPromptImages: detected.supportsPromptImages && overrides.supportsPromptImages !== false,
    supportsLoadSession: detected.supportsLoadSession && overrides.supportsLoadSession !== false,
    supportsSessionCancel:
      detected.supportsSessionCancel && overrides.supportsSessionCancel !== false,
    supportsSessionSetModel:
      detected.supportsSessionSetModel && overrides.supportsSessionSetModel !== false,
    supportsSessionSetMode:
      detected.supportsSessionSetMode && overrides.supportsSessionSetMode !== false,
    supportsRemoteTransport: false,
    supportsCustomTransport: false,
    supportsPermissionRequests: false,
    supportsFsTools: false,
    supportsTerminalTools: false,
  };
}

export function probeRuntimeProviderCli(
  provider: string,
  evidence?: RuntimeProbeEvidence
): RuntimeProviderProbe {
  const adapter = getProviderAdapter(provider);
  if (adapter.id === 'gateway') {
    return probeGatewayProvider(adapter);
  }
  const registryEntry = getProviderRegistryEntry(adapter.id);
  const settings = loadRuntimeSettings();
  if (adapter.id === 'omp' && runtimeOmpTransport(settings) === 'sdk') {
    const capabilities = adapter.detectCliFeatures('', '');
    try {
      const runtime = ompSdkRuntimeAssets();
      return {
        available: true,
        helpText: 'Pinned bundled OMP SDK sidecar',
        versionText: `omp-sdk ${runtime.ompVersion}; bun ${runtime.bunVersion}`,
        capabilities,
        configuration: {
          webSearch: { requested: false, effective: false },
        },
      };
    } catch {
      return {
        available: false,
        helpText: '',
        versionText: '',
        capabilities,
        configuration: {
          webSearch: { requested: false, effective: false },
        },
      };
    }
  }
  const requested = registryEntry.settingsFields.includes('webSearch')
    ? runtimeProviderSettings(loadRuntimeSettings(), adapter.id, process.cwd()).webSearch === true
    : false;
  const helpCommand = runtimeHelpCommand(adapter.id);
  const commandAvailable =
    evidence === undefined
      ? booleanResult(commandExistsFn(helpCommand.command))
      : evidence.available !== false;
  if (!commandAvailable) {
    const capabilities = attestedCliFeatures(adapter, '', '');
    return {
      available: false,
      helpText: '',
      versionText: '',
      capabilities,
      configuration: {
        webSearch: webSearchAttestation({ webSearch: requested, cliFeatures: capabilities }),
      },
    };
  }

  const helpText =
    evidence?.helpText ??
    stringResult(getHelpOutputFn(helpCommand.command, helpCommand.args)).trim();
  const versionText =
    evidence?.versionText ??
    stringResult(
      getVersionOutputFn(
        helpCommand.command,
        registryEntry.capabilities.webSearch === true ? [] : helpCommand.args
      )
    ).trim();
  const capabilities = attestedCliFeatures(adapter, helpText, versionText);

  return {
    available:
      evidence?.available ??
      (registryEntry.availabilityProbe === 'help-or-version'
        ? Boolean(helpText || versionText)
        : true),
    helpText,
    versionText,
    capabilities,
    configuration: {
      webSearch: webSearchAttestation({ webSearch: requested, cliFeatures: capabilities }),
    },
  };
}

function buildRuntimeOptions(
  baseOptions: BuildProviderCommandOptions,
  adapter: ProviderAdapter,
  providerSettings: RuntimeProviderSettings,
  runtime: RuntimeCommandContext
): BuildProviderCommandOptions {
  const modelSpec = resolveRuntimeModelSpec(adapter, baseOptions.modelSpec, providerSettings);
  const gateway = resolveRuntimeGatewayOptions(
    adapter.id,
    baseOptions,
    providerSettings,
    modelSpec
  );
  const webSearch = baseOptions.structuredOutputRecovery
    ? recoveryWebSearchOption(adapter)
    : (baseOptions.webSearch ?? providerSettings.webSearch);
  assertWebSearchDeclared(adapter.id, webSearch);
  const baseResolved = {
    ...baseOptions,
    modelSpec,
    ...(gateway === undefined ? {} : { gateway }),
    ...(webSearch === undefined ? {} : { webSearch }),
    cliFeatures: runtime.cliFeatures,
  };
  const resolved = { ...baseResolved };
  if (baseOptions.structuredOutputRecovery) {
    delete resolved.resumeSessionId;
    delete resolved.continueSession;
    delete resolved.mcpConfig;
    resolved.autoApprove = false;
    if (recoveryWebSearchOption(adapter) === undefined) delete resolved.webSearch;
    else resolved.webSearch = false;
  }
  if (baseOptions.jsonSchema && !supportsProviderCapability(adapter.id, 'jsonSchema')) {
    if (!shouldIncludeAuthEnv(baseOptions, runtime.authEnv)) {
      return { ...resolved, strictSchema: false };
    }
    return { ...resolved, authEnv: runtime.authEnv, strictSchema: false };
  }
  if (!shouldIncludeAuthEnv(baseOptions, runtime.authEnv)) return resolved;
  return { ...resolved, authEnv: runtime.authEnv };
}

function recoveryWebSearchOption(adapter: ProviderAdapter): false | undefined {
  return getProviderRegistryEntry(adapter.id).capabilities.webSearch === false ? undefined : false;
}

function resolveRuntimeGatewayOptions(
  provider: ProviderId,
  baseOptions: BuildProviderCommandOptions,
  providerSettings: RuntimeProviderSettings,
  modelSpec: ModelSpec
): ResolvedGatewayBuildOptions | undefined {
  if (provider !== 'gateway') return undefined;
  const cwd = baseOptions.cwd ?? process.cwd();
  const settingsGateway = providerSettings.gateway ?? {};
  const requestGateway = baseOptions.gateway ?? {};
  const mergedHeaders =
    requestGateway.headers === undefined
      ? settingsGateway.headers
      : { ...(settingsGateway.headers ?? {}), ...requestGateway.headers };
  const mergedGateway: GatewayBuildOptions = {
    ...(requestGateway.protocol ?? settingsGateway.protocol
      ? { protocol: requestGateway.protocol ?? settingsGateway.protocol }
      : {}),
    ...((requestGateway.baseUrl ?? settingsGateway.baseUrl)
      ? { baseUrl: requestGateway.baseUrl ?? settingsGateway.baseUrl }
      : {}),
    ...((requestGateway.apiKey ?? settingsGateway.apiKey)
      ? { apiKey: requestGateway.apiKey ?? settingsGateway.apiKey }
      : {}),
    ...(mergedHeaders === undefined ? {} : { headers: mergedHeaders }),
    model: requestGateway.model ?? modelSpec.model ?? settingsGateway.model ?? null,
    ...(requestGateway.maxTokens ?? settingsGateway.maxTokens
      ? { maxTokens: requestGateway.maxTokens ?? settingsGateway.maxTokens }
      : {}),
    ...((requestGateway.toolPolicy ?? settingsGateway.toolPolicy)
      ? { toolPolicy: requestGateway.toolPolicy ?? settingsGateway.toolPolicy }
      : {}),
  };
  return resolveGatewayConfiguration(mergedGateway, 'options.gateway', cwd);
}

function shouldIncludeAuthEnv(
  baseOptions: BuildProviderCommandOptions,
  authEnv: Readonly<Record<string, string>>
): boolean {
  return baseOptions.authEnv !== undefined || Object.keys(authEnv).length > 0;
}

function resolveRuntimeModelSpec(
  adapter: ProviderAdapter,
  explicit: ModelSpec | undefined,
  providerSettings: RuntimeProviderSettings
): ModelSpec {
  if (explicit?.model !== undefined) {
    adapter.validateModelId(explicit.model);
    return explicit;
  }

  const level = explicit?.level ?? providerSettings.defaultLevel ?? adapter.defaultLevel;
  const resolved = adapter.resolveModelSpec(level, providerSettings.levelOverrides);
  const modelSpec = modelSpecFromResolved(resolved);
  if (explicit?.reasoningEffort === undefined) return modelSpec;
  return { ...modelSpec, reasoningEffort: explicit.reasoningEffort };
}

function modelSpecFromResolved(resolved: {
  readonly level: ModelLevel;
  readonly model: string | null;
  readonly reasoningEffort: ReasoningEffort | undefined;
}): ModelSpec {
  const result: MutableModelSpec = {
    level: resolved.level,
    model: resolved.model,
  };
  if (resolved.reasoningEffort !== undefined) result.reasoningEffort = resolved.reasoningEffort;
  return result;
}

function resolveRuntimeAuthEnv(
  provider: ProviderId,
  settings: Record<string, unknown>
): Readonly<Record<string, string>> {
  if (provider !== 'claude') return {};
  return stringRecordFromUnknown(resolveClaudeAuthFn(settings), 'resolveClaudeAuth');
}

function adapterForRuntimeInput(
  provider: string | null | undefined,
  settings: Record<string, unknown>
): ProviderAdapter {
  const configured =
    provider ?? optionalString(settings.defaultProvider, 'settings.defaultProvider');
  return getProviderAdapter(configured ?? getDefaultProviderId());
}

function runtimeProviderSettings(
  settings: Record<string, unknown>,
  provider: ProviderId,
  cwd: string
): RuntimeProviderSettings {
  const allSettings = optionalRecord(settings.providerSettings, 'settings.providerSettings');
  const providerValue = allSettings?.[provider];
  if (providerValue === undefined) return { levelOverrides: {} };
  const providerSettings = requiredRecord(providerValue, `settings.providerSettings.${provider}`);
  const defaultLevel = optionalModelLevel(
    providerSettings.defaultLevel,
    `settings.providerSettings.${provider}.defaultLevel`
  );
  const levelOverrides = levelOverridesFromUnknown(
    providerSettings.levelOverrides,
    `settings.providerSettings.${provider}.levelOverrides`
  );
  const webSearch = optionalBoolean(
    providerSettings.webSearch,
    `settings.providerSettings.${provider}.webSearch`
  );
  const gateway =
    provider === 'gateway'
      ? normalizeGatewayBuildOptions(providerSettings, 'settings.providerSettings.gateway', cwd)
      : undefined;
  const base = {
    levelOverrides,
    ...(gateway === undefined ? {} : { gateway }),
    ...(webSearch === undefined ? {} : { webSearch }),
  };
  return defaultLevel === undefined ? base : { ...base, defaultLevel };
}

function runtimeHelpCommand(provider: ProviderId): CommandParts {
  if (provider === 'claude') {
    return commandPartsFromUnknown(getClaudeCommandFn(), 'getClaudeCommand');
  }
  return resolveProviderCommand(provider);
}

function probeGatewayProvider(adapter: ProviderAdapter): RuntimeProviderProbe {
  const capabilities = attestedCliFeatures(adapter, '', '');
  try {
    const settings = loadRuntimeSettings();
    const providerSettings = runtimeProviderSettings(settings, 'gateway', process.cwd());
    resolveGatewayConfiguration(
      providerSettings.gateway,
      'settings.providerSettings.gateway',
      process.cwd()
    );
    return {
      available: true,
      helpText: 'Bundled gateway runner',
      versionText: process.version,
      capabilities,
      configuration: {
        webSearch: { requested: false, effective: false },
      },
    };
  } catch {
    return {
      available: false,
      helpText: 'Bundled gateway runner',
      versionText: process.version,
      capabilities,
      configuration: {
        webSearch: { requested: false, effective: false },
      },
    };
  }
}

function attestedCliFeatures(
  adapter: ProviderAdapter,
  helpText: string,
  versionText: string
): ProviderCliFeatures {
  const detected = adapter.detectCliFeatures(helpText, versionText);
  return {
    ...detected,
    supportsWebSearch:
      getProviderRegistryEntry(adapter.id).capabilities.webSearch === true &&
      detected.supportsWebSearch === true,
  };
}

function webSearchAttestation(options: {
  readonly webSearch?: boolean;
  readonly cliFeatures?: CliFeatureOverrides;
}): WebSearchAttestation {
  const requested = options.webSearch === true;
  return {
    requested,
    effective: requested && options.cliFeatures?.supportsWebSearch === true,
  };
}

function assertWebSearchDeclared(provider: ProviderId, requested: boolean | undefined): void {
  if (requested === undefined || getProviderRegistryEntry(provider).capabilities.webSearch === true) {
    return;
  }
  throw new UnsupportedProviderCapabilityError(
    provider,
    'webSearch',
    `Provider ${provider} does not expose provider-controlled native web search; remove options.webSearch.`
  );
}

function loadRuntimeSettings(): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(process.env, LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV)) {
    throw new Error(
      `${LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV} is not a trusted settings channel; use the settings file.`
    );
  }
  return requiredRecord(loadSettingsFn(), 'loadSettings');
}

function rejectCallerSuppliedModelProvenance(input: SingleAgentProviderCommandInput): void {
  if (Object.prototype.hasOwnProperty.call(input, 'modelSpecSource')) {
    throw new Error(
      'modelSpecSource is not accepted at the child provider boundary; use modelLevel and effective provider settings.'
    );
  }
}

function moduleFunction(moduleValue: unknown, field: string): UnknownFunction {
  const record = requiredRecord(moduleValue, 'module');
  const value = record[field];
  if (isUnknownFunction(value)) return value;
  throw new Error(`Expected ${field} to be a function.`);
}

function isUnknownFunction(value: unknown): value is UnknownFunction {
  return typeof value === 'function';
}

function commandPartsFromUnknown(value: unknown, field: string): CommandParts {
  const record = requiredRecord(value, field);
  return {
    command: requiredStringValue(record.command, `${field}.command`),
    args: stringArray(record.args, `${field}.args`),
  };
}

function levelOverridesFromUnknown(value: unknown, field: string): LevelOverrides {
  if (value === undefined) return {};
  const record = requiredRecord(value, field);
  const result: Partial<Record<ModelLevel, ModelSpec>> = {};
  for (const level of MODEL_LEVELS) {
    if (record[level] !== undefined) result[level] = modelSpecFromUnknown(record[level], field);
  }
  return result;
}

function modelSpecFromUnknown(value: unknown, field: string): ModelSpec {
  const record = requiredRecord(value, field);
  const result: MutableModelSpec = {};
  addModelLevel(result, record.level, `${field}.level`);
  addModel(result, record.model, `${field}.model`);
  addReasoningEffort(result, record.reasoningEffort, `${field}.reasoningEffort`);
  return result;
}

function addModelLevel(result: MutableModelSpec, value: unknown, field: string): void {
  const level = optionalModelLevel(value, field);
  if (level !== undefined) result.level = level;
}

function addModel(result: MutableModelSpec, value: unknown, field: string): void {
  if (value === undefined) return;
  if (value === null || typeof value === 'string') {
    result.model = value;
    return;
  }
  throw new Error(`${field} must be a string or null.`);
}

function addReasoningEffort(result: MutableModelSpec, value: unknown, field: string): void {
  const effort = optionalReasoningEffort(value, field);
  if (effort !== undefined) result.reasoningEffort = effort;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error(`${field} must be a boolean.`);
}

function optionalModelLevel(value: unknown, field: string): ModelLevel | undefined {
  if (value === undefined) return undefined;
  if (value === 'level1' || value === 'level2' || value === 'level3') return value;
  throw new Error(`${field} must be one of: ${MODEL_LEVELS.join(', ')}.`);
}

function optionalReasoningEffort(value: unknown, field: string): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  ) {
    return value;
  }
  throw new Error(`${field} must be one of: ${REASONING_EFFORTS.join(', ')}.`);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  throw new Error(`${field} must be a string.`);
}

function requiredStringValue(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`${field} must be a non-empty string.`);
}

function optionalRecord(
  value: unknown,
  field: string
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredRecord(value, field);
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`${field} must be an object.`);
}

function stringRecordFromUnknown(value: unknown, field: string): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return {};
  const record = requiredRecord(value, field);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string') throw new Error(`${field}.${key} must be a string.`);
    result[key] = item;
  }
  return result;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${field} entries must be strings.`);
    result.push(item);
  }
  return result;
}

function stringResult(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new Error('Provider help output must be a string.');
}

function booleanResult(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  throw new Error('Provider availability probe must return a boolean.');
}
