import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OmpSdkSidecarRequest } from './sdk-protocol';
import { openOmpAuthStorage } from './auth-policy';
import {
  PRIVATE_BASE_ENV_KEYS,
  SidecarFailure,
  isRecord,
  isUnknownArray,
  type CredentialChannel,
  type OmpAuthStorage,
  type OmpModel,
  type OmpModelRegistry,
  type OmpSdkBindings,
  type PrivateState,
} from './sdk-sidecar-types';

export async function privateState(): Promise<PrivateState> {
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
export function isolateEnvironment(
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
export function restoreEnvironment(original: ReadonlyMap<string, string | undefined>): void {
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
export async function authStorage(
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
export function exactModel(
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
export function privateModelsConfig(request: OmpSdkSidecarRequest): {
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
