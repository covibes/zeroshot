import {
  OMP_SDK_BACKEND_VERSION,
  OMP_SDK_BUN_VERSION,
  parseOmpSdkProtocolFrame,
  type OmpSdkProtocolFrame,
} from './sdk-protocol';
import {
  SidecarFailure,
  isRecord,
  type OmpAuthStorage,
  type OmpModel,
  type OmpModelRegistry,
  type OmpModelRegistryConstructor,
  type OmpSdkBindings,
  type OmpSingleResult,
} from './sdk-sidecar-types';

export function bunVersion(): string | undefined {
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
export function requireOmpAuthStorage(value: unknown): OmpAuthStorage {
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
export function requireOmpModelRegistry(value: unknown): OmpModelRegistry {
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
export function requireOmpSingleResult(value: unknown): OmpSingleResult {
  if (!isOmpSingleResult(value)) throw new TypeError('invalid OMP runSubprocess result');
  return value;
}
// OMP is an optional sidecar-only dependency and must not load in the host process.
async function importRuntimeModule(specifier: string): Promise<unknown> {
  const runtimeModule: unknown = await import(specifier);
  return runtimeModule;
}

export async function loadOmpSdk(): Promise<OmpSdkBindings> {
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
export function runIdFrom(value: unknown): string {
  if (!isRecord(value) || typeof value.runId !== 'string') return 'unknown';
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.runId) && Buffer.byteLength(value.runId) <= 128
    ? value.runId
    : 'unknown';
}
export function classify(error: unknown): SidecarFailure {
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
