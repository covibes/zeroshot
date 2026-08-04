#!/usr/bin/env bun

import { promises as fs, statSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  executeOmpSdkSidecar,
  serializeOmpSdkFrame,
} from '../../src/agent-cli-provider/omp-sdk-sidecar';

type Scenario = {
  readonly abortAfterMs?: number;
  readonly expectedPrompt: string;
  readonly expectedSecret: string;
  readonly registryError?: boolean;
  readonly result: Record<string, unknown>;
  readonly throwError?: { readonly message?: string; readonly status?: number };
};

type Observation = {
  authClosed: boolean;
  authDatabaseUsed: boolean;
  brokerDiscoveryUsed: boolean;
  genericDiscoveryUsed: boolean;
  credentialMatched: boolean;
  credentialEnvironmentCleared: boolean;
  environmentPrivate: boolean;
  invocationCount: number;
  modelsFilePrivate: boolean;
  optionsStrict: boolean;
  privateStateRemoved: boolean;
  promptMatched: boolean;
};

export function createFakeOmpSdk(
  scenario: Scenario,
  observation: Observation,
  selector: string,
  authMode: string,
  onInvocationStarted?: () => void
): Record<string, unknown> {
  let authenticated = false;
  const separator = selector.indexOf('/');
  const model = { provider: selector.slice(0, separator), id: selector.slice(separator + 1) };
  class FakeAuthStorage {
    static async create(databasePath: string): Promise<FakeAuthStorage> {
      observation.authDatabaseUsed = true;
      if (authMode === 'omp-home') {
        statSync(databasePath);
        authenticated = true;
      }
      return new FakeAuthStorage();
    }
    close(): void {
      observation.authClosed = true;
    }
    hasAuth(provider: string): boolean {
      return provider === model.provider && authenticated;
    }
    setRuntimeApiKey(provider: string, key: string): void {
      authenticated = provider === model.provider;
      observation.credentialMatched = key === scenario.expectedSecret;
    }
  }
  class FakeModelRegistry {
    constructor(_storage: FakeAuthStorage, modelsPath: string) {
      observation.modelsFilePrivate = (statSync(modelsPath).mode & 0o077) === 0;
    }
    find(provider: string, id: string): typeof model | undefined {
      return provider === model.provider && id === model.id ? model : undefined;
    }
    getAvailable(): readonly (typeof model)[] {
      return authenticated || authMode === 'none' ? [model] : [];
    }
    getError(): Error | undefined {
      return scenario.registryError === true ? new Error('fake registry error') : undefined;
    }
  }
  return {
    AuthStorage: FakeAuthStorage,
    ModelRegistry: FakeModelRegistry,
    Settings: { isolated: (overrides: unknown) => ({ overrides }) },
    discoverAuthStorage: async () => {
      observation.genericDiscoveryUsed = true;
      authenticated = true;
      return new FakeAuthStorage();
    },
    discoverBrokerAuthStorage: async () => {
      observation.brokerDiscoveryUsed = true;
      authenticated = true;
      return new FakeAuthStorage();
    },
    getBundledAgent: (name: string) =>
      name === 'task'
        ? {
            name: 'task',
            description: 'fake task',
            systemPrompt: 'fake',
            source: 'bundled',
            spawns: '*',
          }
        : undefined,
    parseModelString: (value: string) => {
      const slash = value.indexOf('/');
      return slash > 0
        ? { provider: value.slice(0, slash), id: value.slice(slash + 1) }
        : undefined;
    },
    runSubprocess: async (options: Record<string, unknown>) => {
      observation.invocationCount += 1;
      observation.promptMatched = options.task === scenario.expectedPrompt;
      observation.credentialEnvironmentCleared =
        authMode === 'environment'
          ? process.env.FAKE_OMP_SECRET === undefined
          : authMode === 'broker'
            ? process.env.OMP_AUTH_BROKER_TOKEN === undefined
            : true;
      const agent = options.agent as Record<string, unknown>;
      const settings = options.settings as {
        readonly overrides?: Readonly<Record<string, unknown>>;
      };
      const overrides = settings.overrides ?? {};
      observation.optionsStrict =
        !Object.hasOwn(options, 'requireYieldTool') &&
        options.outputSchemaMode === 'strict' &&
        options.outputSchemaSource === 'caller' &&
        options.outputSchemaOverridesAgent === true &&
        options.restrictToolNames === true &&
        options.enableMCP === false &&
        options.enableIrc === false &&
        options.keepAlive === false &&
        options.modelOverride === selector &&
        options.thinkingLevel === 'max' &&
        Array.isArray(agent.tools) &&
        JSON.stringify(agent.tools) ===
          JSON.stringify(['read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'ast_edit']) &&
        Array.isArray(agent.spawns) &&
        agent.spawns.length === 0 &&
        overrides['retry.modelFallback'] === false &&
        overrides['retry.usageAwareFallback'] === false &&
        JSON.stringify(overrides['retry.fallbackChains']) === '{}' &&
        overrides['task.maxRecursionDepth'] === 0 &&
        overrides['task.prewalk'] === false &&
        overrides['async.enabled'] === false &&
        overrides['bash.autoBackground.enabled'] === false &&
        overrides['compaction.enabled'] === false &&
        overrides['compaction.strategy'] === 'off' &&
        overrides['advisor.enabled'] === false &&
        overrides['prewalk.enabled'] === false &&
        Array.isArray(options.contextFiles) &&
        options.contextFiles.length === 0 &&
        Array.isArray(options.skills) &&
        options.skills.length === 0 &&
        Array.isArray(options.promptTemplates) &&
        options.promptTemplates.length === 0 &&
        Array.isArray(options.rules) &&
        options.rules.length === 0 &&
        Array.isArray(options.preloadedExtensionPaths) &&
        options.preloadedExtensionPaths.length === 0 &&
        Array.isArray(options.preloadedCustomToolPaths) &&
        options.preloadedCustomToolPaths.length === 0 &&
        options.signal instanceof AbortSignal &&
        !options.signal.aborted;
      const home = process.env.HOME ?? '';
      const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? '';
      observation.environmentPrivate =
        home.includes('zeroshot-omp-sdk-') &&
        agentDirectory.includes('zeroshot-omp-sdk-') &&
        process.env.XDG_CONFIG_HOME?.includes('zeroshot-omp-sdk-') === true &&
        process.env.XDG_CACHE_HOME?.includes('zeroshot-omp-sdk-') === true &&
        process.env.XDG_DATA_HOME?.includes('zeroshot-omp-sdk-') === true &&
        process.env.XDG_STATE_HOME?.includes('zeroshot-omp-sdk-') === true;
      onInvocationStarted?.();
      if (scenario.throwError !== undefined) {
        throw Object.assign(new Error(scenario.throwError.message ?? 'fake provider error'), {
          status: scenario.throwError.status,
        });
      }
      if (scenario.abortAfterMs !== undefined) {
        await new Promise<void>((resolve) => {
          const signal = options.signal as AbortSignal;
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return scenario.result;
    },
  };
}

async function main(): Promise<void> {
  const [, , requestPath, scenarioPath, observationPath] = process.argv;
  if (requestPath === undefined || scenarioPath === undefined || observationPath === undefined) {
    process.exitCode = 2;
    return;
  }
  const request = JSON.parse(await fs.readFile(requestPath, 'utf8')) as unknown;
  const scenario = JSON.parse(await fs.readFile(scenarioPath, 'utf8')) as Scenario;
  const observation: Observation = {
    authClosed: false,
    authDatabaseUsed: false,
    brokerDiscoveryUsed: false,
    credentialEnvironmentCleared: false,
    credentialMatched: false,
    environmentPrivate: false,
    invocationCount: 0,
    genericDiscoveryUsed: false,
    modelsFilePrivate: false,
    optionsStrict: false,
    privateStateRemoved: false,
    promptMatched: false,
  };
  const controller = new AbortController();
  let privateRoot = '';
  const requestRecord =
    request !== null && typeof request === 'object' && !Array.isArray(request)
      ? (request as Record<string, unknown>)
      : {};
  const selector = String(requestRecord.modelSelector ?? 'fake-provider/fake-model');
  const auth =
    requestRecord.auth !== null &&
    typeof requestRecord.auth === 'object' &&
    !Array.isArray(requestRecord.auth)
      ? (requestRecord.auth as Record<string, unknown>)
      : {};
  const sdk = createFakeOmpSdk(
    scenario,
    observation,
    selector,
    String(auth.mode ?? 'environment'),
    () => {
      if (scenario.abortAfterMs !== undefined) {
        setTimeout(() => controller.abort(), scenario.abortAfterMs);
      }
    }
  );
  const loadOmpSdk = async () => {
    privateRoot = dirname(process.env.PI_CODING_AGENT_DIR ?? '');
    return sdk;
  };
  const frame = await executeOmpSdkSidecar(request, {
    loadOmpSdk: loadOmpSdk as never,
    runtimeVersion: () => '1.3.14',
    signal: controller.signal,
  });
  try {
    await fs.stat(privateRoot);
  } catch {
    observation.privateStateRemoved = privateRoot.length > 0;
  }
  await fs.writeFile(observationPath, JSON.stringify(observation), { mode: 0o600 });
  process.stdout.write(serializeOmpSdkFrame(frame));
  process.exitCode = frame.type === 'result' ? 0 : 1;
}

if (import.meta.main) await main();
