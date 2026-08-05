import { promises as fs } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import {
  OMP_SDK_BUN_VERSION,
  OMP_SDK_MAX_FRAME_BYTES,
  OMP_SDK_TEXT_OUTPUT_SCHEMA,
  parseOmpSdkSidecarRequest,
  type OmpSdkProtocolFrame,
  type OmpSdkSidecarRequest,
} from './sdk-protocol';
import { compilePrivateOmpModelsYaml } from './sdk-settings';
import { credentialsForRequest, readCredentialChannel } from './sdk-sidecar-credentials';
import {
  authStorage,
  exactModel,
  isolateEnvironment,
  privateModelsConfig,
  privateState,
  restoreEnvironment,
} from './sdk-sidecar-context';
import { resultFrame, successfulValue } from './sdk-sidecar-output';
import {
  bunVersion,
  createOmpSdkErrorFrame,
  loadOmpSdk,
  requireOmpModelRegistry,
  runIdFrom,
} from './sdk-sidecar-runtime';
import {
  ISOLATED_SETTINGS,
  SidecarFailure,
  type CredentialChannel,
  type OmpAuthStorage,
  type OmpSdkSidecarOptions,
} from './sdk-sidecar-types';

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
