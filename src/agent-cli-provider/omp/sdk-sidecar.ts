import { closeSync, promises as fs, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';

import Ajv from 'ajv';

import {
  OMP_SDK_BACKEND_VERSION,
  OMP_SDK_BUN_VERSION,
  OMP_SDK_MAX_CREDENTIAL_BYTES,
  OMP_SDK_MAX_FRAME_BYTES,
  OMP_SDK_TEXT_OUTPUT_SCHEMA,
  parseOmpSdkProtocolFrame,
  parseOmpSdkSidecarRequest,
  validateOmpSdkProtocolResultFrame,
  type OmpSdkErrorCategory,
  type OmpSdkErrorCode,
  type OmpSdkProtocolFrame,
  type OmpSdkSidecarRequest,
} from './sdk-protocol';
import { compilePrivateOmpModelsYaml } from './sdk-settings';
import { openOmpAuthStorage } from './auth-policy';

const PRIVATE_BASE_ENV_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
] as const;
const MAX_CREDENTIAL_COUNT = 32;
const MAX_CREDENTIAL_NAME_BYTES = 128;
const MAX_CREDENTIAL_VALUE_BYTES = 16 * 1024;
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALLOWED_YIELD_FIELDS: Readonly<Record<string, true>> = {
  data: true,
  error: true,
  schemaOverridden: true,
  status: true,
  type: true,
  useLastTurn: true,
};

const ISOLATED_SETTINGS = {
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

interface OmpAuthStorage {
  close(): void;
  hasAuth(provider: string): boolean;
  setRuntimeApiKey(provider: string, apiKey: string): void;
}
interface OmpModel {
  readonly api?: string;
  readonly baseUrl?: string;
  readonly id: string;
  readonly provider: string;
}
interface OmpModelRegistry {
  find(provider: string, id: string): OmpModel | undefined;
  getAvailable(): readonly OmpModel[];
  getError(): unknown;
}
interface OmpModelRegistryConstructor {
  new (
    authStorage: OmpAuthStorage,
    modelsPath: string,
    options?: { ignoreLocalModelConfig?: boolean }
  ): unknown;
}
interface OmpSingleResult {
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
interface OmpSdkBindings {
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
interface PrivateState {
  readonly agentDirectory: string;
  readonly authDatabasePath: string;
  readonly brokerCachePath: string;
  readonly modelsPath: string;
  readonly discoveryCwd: string;
  readonly root: string;
}
interface YieldItem {
  readonly data?: unknown;
  readonly error?: string;
  readonly schemaOverridden?: boolean;
  readonly status?: 'success' | 'aborted';
  readonly type?: string | readonly string[];
  readonly useLastTurn?: boolean;
}
interface CredentialChannel {
  readonly values: Readonly<Record<string, string>>;
}
export interface OmpSdkSidecarOptions {
  readonly loadOmpSdk?: () => Promise<OmpSdkBindings>;
  readonly runtimeVersion?: () => string | undefined;
  readonly signal?: AbortSignal;
  readonly credentialChannelFd?: number;
}

class SidecarFailure extends Error {
  constructor(
    readonly code: OmpSdkErrorCode,
    readonly category: OmpSdkErrorCategory,
    readonly retryable: boolean
  ) {
    super(code);
    this.name = 'SidecarFailure';
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function natural(value: unknown): value is number {
  return nonnegative(value) && Number.isInteger(value);
}
function closeCredentialChannel(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    throw new SidecarFailure('invalid-request', 'request', false);
  }
}
function readCredentialChannel(fd: number): CredentialChannel {
  if (!Number.isInteger(fd) || fd < 3) {
    throw new SidecarFailure('invalid-request', 'request', false);
  }
  const buffer = Buffer.allocUnsafe(OMP_SDK_MAX_CREDENTIAL_BYTES + 1);
  let offset = 0;
  try {
    while (offset <= OMP_SDK_MAX_CREDENTIAL_BYTES) {
      const count = readSync(fd, buffer, offset, buffer.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
  } catch {
    throw new SidecarFailure('invalid-request', 'request', false);
  } finally {
    closeCredentialChannel(fd);
  }
  if (offset === 0 || offset > OMP_SDK_MAX_CREDENTIAL_BYTES) {
    throw new SidecarFailure('invalid-request', 'request', false);
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
    parsed = JSON.parse(text);
  } catch {
    throw new SidecarFailure('invalid-request', 'request', false);
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 2 ||
    parsed.protocolVersion !== 1 ||
    !isRecord(parsed.values)
  ) {
    throw new SidecarFailure('invalid-request', 'request', false);
  }
  const entries = Object.entries(parsed.values);
  if (entries.length > MAX_CREDENTIAL_COUNT) {
    throw new SidecarFailure('invalid-request', 'request', false);
  }
  const values: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (
      !CREDENTIAL_NAME.test(name) ||
      Buffer.byteLength(name) > MAX_CREDENTIAL_NAME_BYTES ||
      typeof value !== 'string' ||
      value.length === 0 ||
      Buffer.byteLength(value) > MAX_CREDENTIAL_VALUE_BYTES
    ) {
      throw new SidecarFailure('invalid-request', 'request', false);
    }
    values[name] = value;
  }
  return { values: Object.freeze(values) };
}
function credentialsForRequest(
  request: OmpSdkSidecarRequest,
  channel: CredentialChannel
): CredentialChannel {
  const provider = request.modelSelector.slice(0, request.modelSelector.indexOf('/'));
  let expected: readonly string[];
  if (request.auth.mode === 'environment') {
    const reference = request.auth.credentials[provider];
    if (reference === undefined) throw new SidecarFailure('provider-auth', 'auth', false);
    expected = [reference.env];
  } else if (request.auth.mode === 'broker') {
    expected = ['OMP_AUTH_BROKER_TOKEN', 'OMP_AUTH_BROKER_URL'];
  } else {
    expected = [];
  }
  const actual = Object.keys(channel.values).sort((left, right) => left.localeCompare(right));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right));
  if (
    actual.length !== sortedExpected.length ||
    actual.some((name, index) => name !== sortedExpected[index])
  ) {
    throw new SidecarFailure('provider-auth', 'auth', false);
  }
  return channel;
}
function bunVersion(): string | undefined {
  const value = (globalThis as typeof globalThis & { Bun?: { version?: unknown } }).Bun?.version;
  return typeof value === 'string' ? value : undefined;
}
function runtimeMember(container: unknown, name: string): unknown {
  if (container === null || (typeof container !== 'object' && typeof container !== 'function')) {
    throw new TypeError('invalid OMP SDK module');
  }
  const value: unknown = Reflect.get(container, name);
  return value;
}
function isRuntimeCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}
function runtimeCallable(value: unknown): (...args: unknown[]) => unknown {
  if (!isRuntimeCallable(value)) throw new TypeError('invalid OMP SDK export');
  return value;
}
function isRuntimeConstructor(value: unknown): value is OmpModelRegistryConstructor {
  if (typeof value !== 'function') return false;
  try {
    Reflect.construct(Object, [], value);
    return true;
  } catch {
    return false;
  }
}
function runtimeConstructor(value: unknown): OmpModelRegistryConstructor {
  if (!isRuntimeConstructor(value)) throw new TypeError('invalid OMP SDK constructor');
  return value;
}
function isOmpAuthStorage(value: unknown): value is OmpAuthStorage {
  return (
    isRecord(value) &&
    typeof value.close === 'function' &&
    typeof value.hasAuth === 'function' &&
    typeof value.setRuntimeApiKey === 'function'
  );
}
function requireOmpAuthStorage(value: unknown): OmpAuthStorage {
  if (!isOmpAuthStorage(value)) throw new TypeError('invalid OMP AuthStorage');
  return value;
}
function isOmpModelRegistry(value: unknown): value is OmpModelRegistry {
  return (
    isRecord(value) &&
    typeof value.find === 'function' &&
    typeof value.getAvailable === 'function' &&
    typeof value.getError === 'function'
  );
}
function requireOmpModelRegistry(value: unknown): OmpModelRegistry {
  if (!isOmpModelRegistry(value)) throw new TypeError('invalid OMP ModelRegistry');
  return value;
}
function isOmpModel(value: unknown): value is OmpModel {
  return isRecord(value) && typeof value.id === 'string' && typeof value.provider === 'string';
}
function isOmpUsage(value: unknown): value is NonNullable<OmpSingleResult['usage']> {
  if (!isRecord(value) || !isRecord(value.cost)) return false;
  return (
    typeof value.input === 'number' &&
    typeof value.output === 'number' &&
    typeof value.cacheRead === 'number' &&
    typeof value.cacheWrite === 'number' &&
    typeof value.totalTokens === 'number' &&
    typeof value.cost.input === 'number' &&
    typeof value.cost.output === 'number' &&
    typeof value.cost.cacheRead === 'number' &&
    typeof value.cost.cacheWrite === 'number' &&
    typeof value.cost.total === 'number'
  );
}
function isOmpSingleResult(value: unknown): value is OmpSingleResult {
  if (!isRecord(value)) return false;
  const extractedToolData = value.extractedToolData;
  return (
    typeof value.durationMs === 'number' &&
    typeof value.exitCode === 'number' &&
    typeof value.requests === 'number' &&
    typeof value.stderr === 'string' &&
    (value.aborted === undefined || typeof value.aborted === 'boolean') &&
    (value.abortReason === undefined || typeof value.abortReason === 'string') &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.resolvedModel === undefined || typeof value.resolvedModel === 'string') &&
    (value.resolvedModelIsFallback === undefined ||
      typeof value.resolvedModelIsFallback === 'boolean') &&
    (value.structuredOutput === undefined || isRecord(value.structuredOutput)) &&
    (extractedToolData === undefined ||
      (isRecord(extractedToolData) && Object.values(extractedToolData).every(Array.isArray))) &&
    (value.usage === undefined || isOmpUsage(value.usage))
  );
}
function requireOmpSingleResult(value: unknown): OmpSingleResult {
  if (!isOmpSingleResult(value)) throw new TypeError('invalid OMP runSubprocess result');
  return value;
}
// OMP is an optional sidecar-only dependency and must not load in the host process.
async function importRuntimeModule(specifier: string): Promise<unknown> {
  const runtimeModule: unknown = await import(specifier);
  return runtimeModule;
}

async function loadOmpSdk(): Promise<OmpSdkBindings> {
  const [root, agents, resolver, broker] = await Promise.all([
    importRuntimeModule('@oh-my-pi/pi-coding-agent'),
    importRuntimeModule('@oh-my-pi/pi-coding-agent/task/agents'),
    importRuntimeModule('@oh-my-pi/pi-coding-agent/config/model-resolver'),
    importRuntimeModule('@oh-my-pi/pi-coding-agent/session/auth-broker-config'),
  ]);
  const authStorageExport = runtimeMember(root, 'AuthStorage');
  const createAuthStorage = runtimeCallable(runtimeMember(authStorageExport, 'create'));
  const settings = runtimeMember(root, 'Settings');
  const isolatedSettings = runtimeCallable(runtimeMember(settings, 'isolated'));
  const discoverBrokerAuthStorage = runtimeCallable(runtimeMember(broker, 'discoverAuthStorage'));
  const getBundledAgent = runtimeCallable(runtimeMember(agents, 'getBundledAgent'));
  const parseModelString = runtimeCallable(runtimeMember(resolver, 'parseModelString'));
  const modelRegistry = runtimeConstructor(runtimeMember(root, 'ModelRegistry'));
  const runSubprocess = runtimeCallable(runtimeMember(root, 'runSubprocess'));

  return {
    AuthStorage: {
      async create(path: string): Promise<OmpAuthStorage> {
        const value: unknown = await Promise.resolve(
          Reflect.apply(createAuthStorage, authStorageExport, [path])
        );
        return requireOmpAuthStorage(value);
      },
    },
    ModelRegistry: modelRegistry,
    Settings: {
      isolated(overrides: Readonly<Record<string, unknown>>): unknown {
        const value: unknown = Reflect.apply(isolatedSettings, settings, [overrides]);
        return value;
      },
    },
    async discoverBrokerAuthStorage(
      agentDirectory: string,
      options: { cachePath: string; sourceLabel: string }
    ): Promise<OmpAuthStorage> {
      const value: unknown = await Promise.resolve(
        Reflect.apply(discoverBrokerAuthStorage, broker, [agentDirectory, options])
      );
      return requireOmpAuthStorage(value);
    },
    getBundledAgent(name: string): Readonly<Record<string, unknown>> | undefined {
      const value: unknown = Reflect.apply(getBundledAgent, agents, [name]);
      if (value === undefined) return undefined;
      if (!isRecord(value)) throw new TypeError('invalid OMP bundled agent');
      return value;
    },
    parseModelString(
      selector: string
    ): { readonly id: string; readonly provider: string } | undefined {
      const value: unknown = Reflect.apply(parseModelString, resolver, [selector]);
      if (value === undefined) return undefined;
      if (!isOmpModel(value)) throw new TypeError('invalid OMP model selector');
      return value;
    },
    async runSubprocess(options: Readonly<Record<string, unknown>>): Promise<OmpSingleResult> {
      const value: unknown = await Promise.resolve(Reflect.apply(runSubprocess, root, [options]));
      return requireOmpSingleResult(value);
    },
  };
}
function runIdFrom(value: unknown): string {
  if (!isRecord(value) || typeof value.runId !== 'string') return 'unknown';
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.runId) && Buffer.byteLength(value.runId) <= 128
    ? value.runId
    : 'unknown';
}
function classify(error: unknown): SidecarFailure {
  if (error instanceof SidecarFailure) return error;
  const record = isRecord(error) ? error : undefined;
  const code = typeof record?.code === 'string' ? record.code : '';
  const status =
    typeof record?.status === 'number'
      ? record.status
      : isRecord(record?.response) && typeof record.response.status === 'number'
        ? record.response.status
        : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof record?.errorMessage === 'string'
          ? record.errorMessage
          : '';
  const searchable = `${code} ${message}`;
  if (error instanceof Error && error.name === 'AbortError') {
    return new SidecarFailure('cancelled', 'cancelled', false);
  }
  if (
    status === 401 ||
    status === 403 ||
    /auth|unauthori[sz]ed|forbidden|api.?key/i.test(searchable)
  ) {
    return new SidecarFailure('provider-auth', 'auth', false);
  }
  if (status === 429 || /rate.?limit|too many requests|retry-after/i.test(searchable)) {
    return new SidecarFailure('provider-rate-limit', 'rate-limit', true);
  }
  if (/timeout|timed out|deadline|etimedout/i.test(searchable)) {
    return new SidecarFailure('provider-timeout', 'timeout', true);
  }
  if (/schema|structured output|yield/i.test(searchable)) {
    return new SidecarFailure('schema-violation', 'schema', false);
  }
  return new SidecarFailure('provider-error', 'provider', status === undefined || status >= 500);
}
export function createOmpSdkErrorFrame(runId: string, error: unknown): OmpSdkProtocolFrame {
  const failure = classify(error);
  return parseOmpSdkProtocolFrame({
    protocolVersion: 1,
    type: 'error',
    runId,
    backend: { id: 'omp-sdk', version: OMP_SDK_BACKEND_VERSION },
    runtime: { name: 'bun', version: OMP_SDK_BUN_VERSION },
    error: {
      code: failure.code,
      category: failure.category,
      retryable: failure.retryable,
      redacted: true,
    },
  });
}

async function privateState(): Promise<PrivateState> {
  const root = await fs.mkdtemp(join(tmpdir(), 'zeroshot-omp-sdk-'));
  try {
    await fs.chmod(root, 0o700);
    const directories = [
      'home',
      'xdg-config',
      'xdg-cache',
      'xdg-data',
      'xdg-state',
      'agent',
      'discovery-cwd',
    ];
    await Promise.all(directories.map((name) => fs.mkdir(join(root, name), { mode: 0o700 })));
    return {
      root,
      agentDirectory: join(root, 'agent'),
      authDatabasePath: join(root, 'agent', 'auth.db'),
      brokerCachePath: join(root, 'agent', 'broker-snapshot.json'),
      discoveryCwd: join(root, 'discovery-cwd'),
      modelsPath: join(root, 'agent', 'models.yml'),
    };
  } catch {
    await fs.rm(root, { force: true, maxRetries: 3, recursive: true });
    throw new SidecarFailure('cleanup-error', 'cleanup', false);
  }
}
function isolateEnvironment(
  state: PrivateState,
  auth: OmpSdkSidecarRequest['auth']
): Map<string, string | undefined> {
  const original = new Map<string, string | undefined>();
  const privateNames = new Set<string>(PRIVATE_BASE_ENV_KEYS);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('PI_') || name.startsWith('OMP_')) privateNames.add(name);
  }
  if (auth.mode === 'environment') {
    Object.values(auth.credentials).forEach(({ env }) => privateNames.add(env));
  }
  for (const name of privateNames) {
    original.set(name, process.env[name]);
    delete process.env[name];
  }
  process.env.HOME = join(state.root, 'home');
  process.env.XDG_CONFIG_HOME = join(state.root, 'xdg-config');
  process.env.XDG_CACHE_HOME = join(state.root, 'xdg-cache');
  process.env.XDG_DATA_HOME = join(state.root, 'xdg-data');
  process.env.XDG_STATE_HOME = join(state.root, 'xdg-state');
  process.env.PI_CODING_AGENT_DIR = state.agentDirectory;
  return original;
}
function restoreEnvironment(original: ReadonlyMap<string, string | undefined>): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('PI_') || name.startsWith('OMP_')) delete process.env[name];
  }
  original.forEach((value, key) => {
    if (!PRIVATE_BASE_ENV_KEYS.some((name) => name === key)) {
      delete process.env[key];
    } else if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
}
async function authStorage(
  sdk: OmpSdkBindings,
  request: OmpSdkSidecarRequest,
  state: PrivateState,
  provider: string,
  credentials: CredentialChannel
): Promise<OmpAuthStorage> {
  const environmentSecret =
    request.auth.mode === 'environment'
      ? credentials.values[request.auth.credentials[provider]?.env ?? '']
      : undefined;
  if (request.auth.mode === 'environment' && !environmentSecret) {
    throw new SidecarFailure('provider-auth', 'auth', false);
  }
  const brokerCredentials =
    request.auth.mode === 'broker'
      ? {
          url: credentials.values.OMP_AUTH_BROKER_URL,
          token: credentials.values.OMP_AUTH_BROKER_TOKEN,
        }
      : undefined;
  if (request.auth.mode === 'broker' && (!brokerCredentials?.url || !brokerCredentials.token)) {
    throw new SidecarFailure('provider-auth', 'auth', false);
  }
  const storage = await openOmpAuthStorage({
    mode: request.auth.mode,
    privateAgentDirectory: state.agentDirectory,
    privateDatabasePath: state.authDatabasePath,
    brokerCachePath: state.brokerCachePath,
    sourceLabel: 'zeroshot omp sdk broker',
    createDatabase: (databasePath) => sdk.AuthStorage.create(databasePath),
    discoverBroker: (agentDirectory, options) =>
      sdk.discoverBrokerAuthStorage(agentDirectory, options),
    ...(request.auth.mode === 'omp-home' ? { sourceDirectory: request.auth.path } : {}),
    ...(brokerCredentials === undefined ? {} : { brokerCredentials }),
  });
  if (typeof environmentSecret === 'string') {
    storage.setRuntimeApiKey(provider, environmentSecret);
  }
  return storage;
}
function exactModel(
  sdk: OmpSdkBindings,
  registry: OmpModelRegistry,
  storage: OmpAuthStorage,
  request: OmpSdkSidecarRequest
): Readonly<OmpModel> {
  const parsed = sdk.parseModelString(request.modelSelector);
  const model = parsed === undefined ? undefined : registry.find(parsed.provider, parsed.id);
  if (
    parsed === undefined ||
    `${parsed.provider}/${parsed.id}` !== request.modelSelector ||
    model?.provider !== parsed.provider ||
    model.id !== parsed.id
  ) {
    throw new SidecarFailure('model-resolution', 'model', false);
  }
  const available = registry
    .getAvailable()
    .find((candidate) => candidate.provider === parsed.provider && candidate.id === parsed.id);
  if (
    available === undefined ||
    (request.auth.mode === 'none') === storage.hasAuth(parsed.provider)
  ) {
    throw new SidecarFailure('provider-auth', 'auth', false);
  }
  const providerConfig = request.modelsConfig.providers[parsed.provider];
  const models = isUnknownArray(providerConfig?.models) ? providerConfig.models : [];
  const declaredModel = models.find(
    (candidate) => isRecord(candidate) && candidate.id === parsed.id
  );
  const declaredBaseUrl =
    isRecord(declaredModel) && typeof declaredModel.baseUrl === 'string'
      ? declaredModel.baseUrl
      : typeof providerConfig?.baseUrl === 'string'
        ? providerConfig.baseUrl
        : undefined;
  const declaredApi =
    isRecord(declaredModel) && typeof declaredModel.api === 'string'
      ? declaredModel.api
      : typeof providerConfig?.api === 'string'
        ? providerConfig.api
        : undefined;
  const routeExposed = model.api !== undefined || model.baseUrl !== undefined;
  const availableRouteExposed = available.api !== undefined || available.baseUrl !== undefined;
  if (
    routeExposed !== availableRouteExposed ||
    (routeExposed && (model.api === undefined || model.baseUrl === undefined)) ||
    (availableRouteExposed && (available.api === undefined || available.baseUrl === undefined)) ||
    (routeExposed && declaredBaseUrl !== undefined && model.baseUrl !== declaredBaseUrl) ||
    (routeExposed && declaredApi !== undefined && model.api !== declaredApi) ||
    model.api !== available.api ||
    model.baseUrl !== available.baseUrl
  ) {
    throw new SidecarFailure('model-resolution', 'model', false);
  }
  return Object.freeze({
    provider: model.provider,
    id: model.id,
    ...(model.api === undefined ? {} : { api: model.api }),
    ...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
  });
}
function privateModelsConfig(request: OmpSdkSidecarRequest): {
  readonly providers: Readonly<Record<string, Record<string, unknown>>>;
} {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [provider, config] of Object.entries(request.modelsConfig.providers)) {
    const copy: unknown = JSON.parse(JSON.stringify(config));
    if (!isRecord(copy)) throw new SidecarFailure('invalid-request', 'request', false);
    delete copy.apiKey;
    providers[provider] = copy;
  }
  return { providers };
}

function yieldItem(value: unknown): YieldItem {
  if (!isRecord(value)) throw new SidecarFailure('sdk-error', 'sdk', false);
  const type = value.type;
  if (
    Object.keys(value).some((key) => ALLOWED_YIELD_FIELDS[key] !== true) ||
    (value.status !== 'success' && value.status !== 'aborted') ||
    (value.error !== undefined && typeof value.error !== 'string') ||
    (value.schemaOverridden !== undefined && typeof value.schemaOverridden !== 'boolean') ||
    (value.useLastTurn !== undefined && typeof value.useLastTurn !== 'boolean') ||
    (type !== undefined &&
      !(typeof type === 'string' && type.length > 0) &&
      !(
        Array.isArray(type) &&
        type.length > 0 &&
        type.every((item) => typeof item === 'string' && item.length > 0)
      ))
  ) {
    throw new SidecarFailure('sdk-error', 'sdk', false);
  }
  return value as YieldItem;
}
function terminalYield(result: OmpSingleResult): YieldItem {
  const raw = result.extractedToolData?.yield;
  if (!Array.isArray(raw) || raw.length !== 1) {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  const terminal = yieldItem(raw[0]);
  if (
    Array.isArray(terminal.type) ||
    terminal.status !== 'success' ||
    terminal.error !== undefined ||
    terminal.useLastTurn === true ||
    terminal.schemaOverridden === true ||
    !Object.hasOwn(terminal, 'data')
  ) {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  return terminal;
}
function immutableYieldData(value: unknown): unknown {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    ) {
      continue;
    }
    if (typeof current !== 'object' || seen.has(current)) {
      throw new SidecarFailure('schema-violation', 'schema', false);
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((child) => pending.push(child));
      continue;
    }
    const prototype = Reflect.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SidecarFailure('schema-violation', 'schema', false);
    }
    Object.values(current).forEach((child) => pending.push(child));
  }
  let encoded: unknown;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  if (typeof encoded !== 'string') {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  const snapshot: unknown = JSON.parse(encoded);
  const stack = [snapshot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object' || Object.isFrozen(current)) continue;
    Object.values(current).forEach((child) => stack.push(child));
    Object.freeze(current);
  }
  return snapshot;
}
function validateSchema(schema: unknown, value: unknown): void {
  try {
    if (typeof schema !== 'boolean' && (schema === null || typeof schema !== 'object')) {
      throw new SidecarFailure('invalid-request', 'request', false);
    }
    const validate = new Ajv({
      allErrors: true,
      coerceTypes: false,
      strict: false,
      validateFormats: false,
    }).compile(schema);
    if (!validate(value)) throw new SidecarFailure('schema-violation', 'schema', false);
  } catch (error) {
    if (error instanceof SidecarFailure) throw error;
    throw new SidecarFailure('invalid-request', 'request', false);
  }
}
function successfulValue(
  result: OmpSingleResult,
  request: OmpSdkSidecarRequest,
  schema: unknown,
  signal?: AbortSignal
): unknown {
  if (signal?.aborted) throw new SidecarFailure('cancelled', 'cancelled', false);
  if (result.aborted === true) {
    if (/timeout|timed out|deadline/i.test(result.abortReason ?? '')) {
      throw new SidecarFailure('provider-timeout', 'timeout', true);
    }
    throw new SidecarFailure('cancelled', 'cancelled', false);
  }
  if (!Number.isInteger(result.exitCode)) throw new SidecarFailure('sdk-error', 'sdk', false);
  if (result.exitCode !== 0) throw classify(result.retryFailure ?? result.error ?? result.stderr);
  if (result.resolvedModel !== request.modelSelector) {
    throw new SidecarFailure('model-resolution', 'model', false);
  }
  if (result.resolvedModelIsFallback === true) {
    throw new SidecarFailure('model-fallback', 'model', false);
  }
  const structured = result.structuredOutput;
  if (
    structured?.source !== 'caller' ||
    structured.mode !== 'strict' ||
    structured.status !== 'valid' ||
    !Object.hasOwn(structured, 'data')
  ) {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  const terminal = terminalYield(result);
  const terminalData = immutableYieldData(terminal.data);
  const structuredData = immutableYieldData(structured.data);
  if (!isDeepStrictEqual(terminalData, structuredData)) {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  validateSchema(schema, structuredData);
  return structuredData;
}
function usage(result: OmpSingleResult): Record<string, unknown> {
  const item = result.usage;
  if (item === undefined) throw new SidecarFailure('sdk-error', 'sdk', false);
  const tokenValues = [item.input, item.output, item.cacheRead, item.cacheWrite, item.totalTokens];
  const costValues = [
    item.cost.input,
    item.cost.output,
    item.cost.cacheRead,
    item.cost.cacheWrite,
    item.cost.total,
  ];
  if (
    !tokenValues.every(natural) ||
    !costValues.every(nonnegative) ||
    !natural(result.requests) ||
    !nonnegative(result.durationMs)
  ) {
    throw new SidecarFailure('sdk-error', 'sdk', false);
  }
  return {
    source: 'omp-aggregate',
    completeness: 'unknown',
    inputTokens: item.input,
    outputTokens: item.output,
    cacheReadInputTokens: item.cacheRead,
    cacheCreationInputTokens: item.cacheWrite,
    totalTokens: item.totalTokens,
    requests: result.requests,
    durationMs: result.durationMs,
    cost: item.cost,
  };
}
function textResult(value: unknown): string {
  if (!isRecord(value) || typeof value.result !== 'string') {
    throw new SidecarFailure('schema-violation', 'schema', false);
  }
  return value.result;
}
function resultFrame(
  request: OmpSdkSidecarRequest,
  result: OmpSingleResult,
  rawValue: unknown
): OmpSdkProtocolFrame {
  const frame = {
    protocolVersion: 1,
    type: 'result',
    runId: request.runId,
    backend: { id: 'omp-sdk', version: OMP_SDK_BACKEND_VERSION },
    runtime: { name: 'bun', version: OMP_SDK_BUN_VERSION },
    requested: {
      modelSelector: request.modelSelector,
      reasoningEffort: request.reasoningEffort,
      outputMode: request.outputMode,
    },
    resolved: { modelSelector: result.resolvedModel },
    strictOutput: {
      source: 'caller',
      mode: 'strict',
      status: 'valid',
      yieldCount: 1,
    },
    fallback: false,
    execution: { exitCode: 0, aborted: false },
    value: request.outputMode === 'text' ? textResult(rawValue) : rawValue,
    usage: usage(result),
  };
  try {
    return validateOmpSdkProtocolResultFrame(frame, request);
  } catch {
    throw new SidecarFailure('sdk-error', 'sdk', false);
  }
}

async function execute(
  request: OmpSdkSidecarRequest,
  credentials: CredentialChannel,
  options: OmpSdkSidecarOptions
): Promise<OmpSdkProtocolFrame> {
  if ((options.runtimeVersion ?? bunVersion)() !== OMP_SDK_BUN_VERSION) {
    throw new SidecarFailure('sdk-error', 'sdk', false);
  }
  const state = await privateState();
  const originalCwd = process.cwd();
  const original = isolateEnvironment(state, request.auth);
  let storage: OmpAuthStorage | undefined;
  let candidate: OmpSdkProtocolFrame | undefined;
  let failure: unknown;
  let changedCwd = false;
  try {
    process.chdir(state.discoveryCwd);
    changedCwd = true;
    await fs.writeFile(
      state.modelsPath,
      compilePrivateOmpModelsYaml(privateModelsConfig(request)),
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }
    );
    await fs.chmod(state.modelsPath, 0o600);
    const sdk = await (options.loadOmpSdk ?? loadOmpSdk)();
    const parsed = sdk.parseModelString(request.modelSelector);
    if (parsed === undefined) throw new SidecarFailure('model-resolution', 'model', false);
    storage = await authStorage(sdk, request, state, parsed.provider, credentials);
    const registry = requireOmpModelRegistry(new sdk.ModelRegistry(storage, state.modelsPath));
    if (registry.getError() !== undefined) {
      throw new SidecarFailure('invalid-request', 'request', false);
    }
    const effectiveModel = exactModel(sdk, registry, storage, request);
    const base = sdk.getBundledAgent('task');
    if (base === undefined) throw new SidecarFailure('sdk-error', 'sdk', false);
    const settings = sdk.Settings.isolated({
      ...ISOLATED_SETTINGS,
      enabledModels: [request.modelSelector],
    });
    const agent = {
      ...base,
      tools: [...request.tools],
      spawns: [],
      model: [request.modelSelector],
      thinkingLevel: request.reasoningEffort,
      autoloadSkills: [],
      prewalk: false,
    };
    const schema =
      request.outputMode === 'text' ? OMP_SDK_TEXT_OUTPUT_SCHEMA : request.outputSchema;
    const result = await sdk.runSubprocess({
      cwd: request.cwd,
      agent,
      task: request.prompt,
      context: request.context,
      description: 'Zeroshot strict SDK execution',
      index: 0,
      id: request.runId,
      modelOverride: request.modelSelector,
      thinkingLevel: request.reasoningEffort,
      outputSchema: schema,
      outputSchemaMode: 'strict',
      outputSchemaSource: 'caller',
      outputSchemaOverridesAgent: true,
      settings,
      authStorage: storage,
      modelRegistry: registry,
      restrictToolNames: true,
      enableMCP: false,
      enableIrc: false,
      enableLsp: request.tools.includes('lsp'),
      contextFiles: [],
      skills: [],
      promptTemplates: [],
      workspaceTree: {
        rootPath: request.cwd,
        rendered: '',
        truncated: false,
        totalLines: 0,
        agentsMdFiles: [],
      },
      rules: [],
      preloadedExtensionPaths: [],
      preloadedCustomToolPaths: [],
      keepAlive: false,
      signal: options.signal,
    });
    const rawValue = successfulValue(result, request, schema, options.signal);
    if (
      registry.getError() !== undefined ||
      !isDeepStrictEqual(effectiveModel, exactModel(sdk, registry, storage, request))
    ) {
      throw new SidecarFailure('model-resolution', 'model', false);
    }
    candidate = resultFrame(request, result, rawValue);
  } catch (error) {
    failure = error;
  } finally {
    try {
      storage?.close();
    } catch {
      failure = new SidecarFailure('cleanup-error', 'cleanup', false);
    }
    if (changedCwd) {
      try {
        process.chdir(originalCwd);
      } catch {
        failure = new SidecarFailure('cleanup-error', 'cleanup', false);
      }
    }
    restoreEnvironment(original);
    try {
      await fs.rm(state.root, { force: true, maxRetries: 3, recursive: true });
    } catch {
      failure = new SidecarFailure('cleanup-error', 'cleanup', false);
    }
  }
  if (options.signal?.aborted) {
    throw new SidecarFailure('cancelled', 'cancelled', false);
  }
  if (failure !== undefined) throw failure;
  if (candidate === undefined) throw new SidecarFailure('internal-error', 'internal', false);
  return candidate;
}

export async function executeOmpSdkSidecar(
  input: unknown,
  options: OmpSdkSidecarOptions = {}
): Promise<OmpSdkProtocolFrame> {
  const runId = runIdFrom(input);
  let channel: CredentialChannel;
  try {
    channel = readCredentialChannel(options.credentialChannelFd ?? 3);
  } catch (error) {
    return createOmpSdkErrorFrame(runId, error);
  }
  let request: OmpSdkSidecarRequest;
  try {
    request = parseOmpSdkSidecarRequest(input);
  } catch {
    return createOmpSdkErrorFrame(runId, new SidecarFailure('invalid-request', 'request', false));
  }
  try {
    channel = credentialsForRequest(request, channel);
  } catch (error) {
    return createOmpSdkErrorFrame(runId, error);
  }
  try {
    return await execute(request, channel, options);
  } catch (error) {
    return createOmpSdkErrorFrame(runId, error);
  }
}
export function serializeOmpSdkFrame(frame: OmpSdkProtocolFrame): string {
  const serialized = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(serialized) <= OMP_SDK_MAX_FRAME_BYTES) return serialized;
  return `${JSON.stringify(
    createOmpSdkErrorFrame(frame.runId, new SidecarFailure('invalid-request', 'request', false))
  )}\n`;
}
