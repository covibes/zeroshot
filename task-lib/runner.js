import { execFileSync, spawn } from 'child_process';
import { isAbsolute, join, dirname, relative, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { LOGS_DIR } from './config.js';
import { addTask, generateId, ensureDirs, updateTask } from './store.js';
import {
  isOmpSessionlessRun,
  resolveOmpStorageRoot,
  resolveOmpOwnerKind,
} from './omp-storage-root.js';
import {
  readOwnership,
  retireOmpOwnershipAtTerminalBoundary,
  writeProvisionalOwnership,
} from './omp-session-ownership.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveTaskExecutionContext } = require('../src/task-execution-context.js');
export { resolveTaskExecutionContext };
const {
  buildOmpPrompt,
  getProviderRegistryEntry,
  normalizeProviderName,
  prepareSingleAgentProviderCommand,
} = require('./provider-helper-runtime.js');
const { getDefaultProviderId } = require('../lib/provider-names.js');
const { loadSettings } = require('../lib/settings.js');
const { resolveOmpTransport } = require('./omp-sdk-runtime.js');
const {
  ISOLATED_SETTINGS_FILE_ENV,
  ISOLATED_SETTINGS_FILE_MARKER,
  LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV,
} = require('../src/task-run-model-args.js');
const {
  CLAUDE_MCP_CONFIG_ENV,
  CLAUDE_SETTINGS_ENV,
  isClaudeSettingsOverlayPath,
} = require('../src/worktree-claude-config');
const { TASK_SPAWN_OWNERSHIP_TOKEN_ENV } = require('../src/task-spawn-cleanup-ownership');
const { sendWatcherPrompt } = require('../src/watcher-prompt-channel');
const {
  generateOmpPartitionId,
  partitionPathFor,
  createOmpSessionPartitionDirectory,
} = require('../src/omp-session-partition');
export {
  isOwnedProcessTreeRunning,
  isProcessRunning,
  killTask,
  terminateProcess,
} from './process-termination.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Cross-check the caller-supplied resume descriptor against the prior owner's *persisted* record
 * and return the expectation the watcher will re-verify.
 *
 * The descriptor arrives over argv (from the agent's own `providerSession.ompSession` snapshot, or
 * from `zeroshot task resume`), so it is never trusted on its own: the task row named by
 * `priorOwnerTaskId` is the authority, and every field the descriptor asserts must match it
 * exactly. A descriptor and a row that disagree are conflicting identities and fail closed here,
 * before a task row is even created — the "conflicting IDs never reach a resume prompt" case.
 */
export function resolveOmpResumeExpectation({ descriptor, storageRoot, canonicalWorkspace }) {
  const prior = readOwnership(descriptor.priorOwnerTaskId);
  if (!prior) {
    throw new Error(
      `OMP resume: task ${descriptor.priorOwnerTaskId} has no valid OMP session ownership record.`
    );
  }
  if (prior.state !== 'committed' || !prior.session || !prior.partitionIdentity) {
    throw new Error(
      `OMP resume: task ${descriptor.priorOwnerTaskId} ownership is '${prior.state}', not a committed resumable session.`
    );
  }
  if (prior.storageRoot !== resolvePath(storageRoot)) {
    throw new Error(
      `OMP resume: storage root ${resolvePath(storageRoot)} does not match the recorded ${prior.storageRoot}.`
    );
  }
  // Moved/deleted workspace and "existing-but-wrong recorded cwd": a session belongs to the
  // workspace it was recorded against and may never be continued from a different one.
  if (prior.canonicalWorkspace !== resolvePath(canonicalWorkspace)) {
    throw new Error(
      `OMP resume: workspace ${resolvePath(canonicalWorkspace)} does not match the recorded ${prior.canonicalWorkspace}.`
    );
  }

  const mismatches = [];
  const requireExact = (label, actual, expected) => {
    if (actual !== expected) mismatches.push(`${label} (${actual} != ${expected})`);
  };
  requireExact('partitionId', descriptor.partitionId, prior.partitionId);
  requireExact('sessionId', descriptor.expectedSessionId, prior.session.sessionId);
  requireExact('sessionFileName', descriptor.sessionFileName, prior.session.fileName);
  requireExact(
    'sessionFileIdentity',
    `${descriptor.expectedSessionFileIdentity?.device}:${descriptor.expectedSessionFileIdentity?.inode}`,
    `${prior.session.fileIdentity.device}:${prior.session.fileIdentity.inode}`
  );
  // partitionIdentity is deliberately absent from the agent's `providerSession.ompSession`
  // snapshot (issue #866 fixes that field list, and the snapshot never carries partition paths or
  // storage-root state), so it is authoritative from the row only. `zeroshot task resume`, which
  // reads the row directly, does assert it — check it whenever it is supplied.
  if (descriptor.expectedPartitionIdentity !== undefined) {
    requireExact(
      'partitionIdentity',
      `${descriptor.expectedPartitionIdentity?.device}:${descriptor.expectedPartitionIdentity?.inode}`,
      `${prior.partitionIdentity.device}:${prior.partitionIdentity.inode}`
    );
  }
  requireExact(
    'artifactManifestDigest',
    descriptor.expectedArtifactManifestDigest,
    prior.session.artifactManifestDigest
  );
  requireExact(
    'executionFingerprint',
    descriptor.expectedExecutionFingerprint,
    prior.session.executionFingerprint
  );
  requireExact(
    'selectedProvider',
    descriptor.expectedSelectedProvider,
    prior.session.selectedProvider
  );
  requireExact('selectedModel', descriptor.expectedSelectedModel, prior.session.selectedModel);
  if (mismatches.length > 0) {
    throw new Error(
      `OMP resume: descriptor conflicts with the persisted owner record: ${mismatches.join(', ')}.`
    );
  }

  return {
    priorOwnerTaskId: descriptor.priorOwnerTaskId,
    partitionId: prior.partitionId,
    partitionPath: prior.partitionPath,
    canonicalWorkspace: prior.canonicalWorkspace,
    sessionFileName: prior.session.fileName,
    sessionFilePath: join(prior.partitionPath, prior.session.fileName),
    expectedSessionId: prior.session.sessionId,
    expectedPartitionIdentity: prior.partitionIdentity,
    expectedSessionFileIdentity: prior.session.fileIdentity,
    expectedArtifactManifestDigest: prior.session.artifactManifestDigest,
    expectedExecutionFingerprint: prior.session.executionFingerprint,
    expectedSelectedProvider: prior.session.selectedProvider,
    expectedSelectedModel: prior.session.selectedModel,
  };
}

/**
 * Resolve this task's OMP session plan, or null for every other provider / structured-output
 * recovery turn. Allocates (but does not yet create on disk) a fresh partition, or resolves the
 * resume descriptor against the prior owner's persisted record. The partition directory itself is
 * created only after the task row is durable (see spawnTask below — row-before-directory), and
 * the structural/identity/fingerprint verification plus the owner transfer happen in the rpc-stdio
 * watcher, not here.
 */
function resolveOmpSessionPlan({ id, cwd, options, providerName }) {
  if (options.structuredOutputRecovery) return null;
  const resolvedProviderName =
    providerName || normalizeProviderName(options.provider || getDefaultProviderId());
  if (resolvedProviderName !== 'omp') return null;
  // Docker stays fresh-only (issue #866). Returning null here means no partition is allocated, no
  // ownership row is written, and the adapter falls back to `--no-session`.
  if (isOmpSessionlessRun(options)) return null;

  const storageRoot = resolveOmpStorageRoot(options);
  mkdirSync(storageRoot, { recursive: true });
  const ownerKind = resolveOmpOwnerKind(options);
  const owner = { ...ownerKind, taskId: id };

  if (options.ompResume) {
    const expectation = resolveOmpResumeExpectation({
      descriptor: options.ompResume,
      storageRoot,
      canonicalWorkspace: cwd,
    });
    return {
      session: {
        kind: 'resume',
        partition: { path: expectation.partitionPath },
        file: { path: expectation.sessionFilePath },
      },
      resumeExpectation: expectation,
      provisionalOwnership: writeProvisionalOwnership({
        partitionId: expectation.partitionId,
        storageRoot,
        canonicalWorkspace: cwd,
        owner,
      }),
      createDirectory: () => {}, // must already exist; the watcher verifies before spawn
    };
  }

  const partitionId = generateOmpPartitionId();
  const partitionPath = partitionPathFor(storageRoot, partitionId);
  return {
    session: { kind: 'fresh', partition: { path: partitionPath } },
    resumeExpectation: null,
    provisionalOwnership: writeProvisionalOwnership({
      partitionId,
      storageRoot,
      canonicalWorkspace: cwd,
      owner,
    }),
    createDirectory: () => createOmpSessionPartitionDirectory(partitionPath),
  };
}

/**
 * Close a spawn that failed after its row was written but before anything could own the task.
 *
 * Two durable transitions, in this order and both idempotent, so a retry or a crash-recovery
 * replay converges on the same state:
 *   1. the OMP ownership record is retired to `cleanup-required`, releasing the partition claim
 *      that would otherwise block every future reclaim of that directory;
 *   2. the task row reaches a terminal status, so nothing downstream (status, kill, resume, the
 *      stuck-task recovery sweep) keeps treating it as a live run.
 *
 * The decision comes from this boundary alone. Whether the partition directory exists is not
 * consulted and must not be: a partial mkdir and a clean failure are indistinguishable on disk,
 * and the row is the only thing that knows a spawn was attempted at all.
 */
function failSpawnAtProvisionalBoundary(id, error) {
  retireOmpOwnershipAtTerminalBoundary(id, (ownershipError) => {
    console.warn(
      `Warning: failed to retire the OMP session ownership of task ${id}: ${ownershipError.message}`
    );
  });
  try {
    updateTask(id, {
      status: 'failed',
      pid: null,
      exitCode: 1,
      error: `Task spawn failed before the provider started: ${error.message}`,
    });
  } catch (updateError) {
    console.warn(`Warning: failed to mark task ${id} failed: ${updateError.message}`);
  }
}
function prepareTaskSpawn(prompt, options, runtime) {
  const outputFormat = resolveOutputFormat(options);
  const jsonSchema = resolveJsonSchema(options, outputFormat);
  const settings = loadSettings();
  const providerName = normalizeProviderName(
    options.provider || settings.defaultProvider || getDefaultProviderId()
  );
  const ompTransport = providerName === 'omp' ? resolveOmpTransport(settings) : null;
  const providerOutputFormat =
    ompTransport === 'sdk' && outputFormat === 'stream-json' && jsonSchema === null
      ? 'text'
      : outputFormat;
  if (ompTransport === 'sdk' && options.ompResume) {
    throw new Error(
      'OMP SDK detached runs are always fresh; --omp-resume requires transport "rpc".'
    );
  }
  const ompPlan =
    ompTransport === 'rpc' ? resolveOmpSessionPlan({ ...runtime, options, providerName }) : null;
  const prepared = prepareTaskProviderCommandFromResolved(
    prompt,
    options,
    {
      outputFormat: providerOutputFormat,
      jsonSchema,
      cwd: runtime.cwd,
      ompSession: ompPlan?.session,
    },
    settings
  );
  const resolvedProviderName = prepared.adapter.id;
  return {
    outputFormat,
    jsonSchema,
    ompPlan,
    prepared,
    providerName: resolvedProviderName,
    modelSpec: prepared.options.modelSpec,
    commandSpec: attachClaudeOverlayCleanup(prepared.commandSpec, resolvedProviderName),
  };
}

export function spawnTask(prompt, options = {}) {
  ensureDirs();

  const id = generateId();
  const logFile = join(LOGS_DIR, `${id}.log`);
  const cwd = options.cwd || process.cwd();

  const { outputFormat, jsonSchema, ompPlan, prepared, providerName, modelSpec, commandSpec } =
    prepareTaskSpawn(prompt, options, { id, cwd });

  const task = buildTaskRecord({
    id,
    prompt,
    cwd,
    options,
    logFile,
    providerName,
    modelSpec,
    commandSpec,
    ompSessionOwnership: ompPlan?.provisionalOwnership ?? null,
  });

  // Row-before-directory: the SQL row is durable proof of an attempted allocation before the
  // partition directory (or anything else OMP-owned) exists on disk. A *crash* between these two
  // lines leaves a provisional row pointing at a path with nothing there yet — cleanup safely
  // no-ops on a nonexistent path, and normal task-lifecycle recovery handles the row itself.
  //
  // A *thrown* materialization failure is different, and must not be left to recovery: this
  // process is still alive and owns the row, so it has to close the boundary itself. Without this,
  // an EACCES/ENOSPC mkdir left a row that looks forever like a live task holding a live
  // provisional claim on a partition — permanently unreclaimable, because cleanup refuses to touch
  // a partition any other row still claims provisionally.
  addTask(task);
  try {
    ompPlan?.createDirectory();
  } catch (error) {
    failSpawnAtProvisionalBoundary(id, error);
    throw error;
  }

  const watcherConfig = buildWatcherConfig(
    outputFormat,
    jsonSchema,
    options,
    providerName,
    prepared,
    commandSpec,
    ompPlan
  );
  const watcherScript = resolveWatcherScript(
    {
      attachable: options.attachable,
      jsonSchema,
    },
    providerName,
    prepared.invoke
  );
  spawnWatcher({
    watcherScript,
    id,
    cwd,
    logFile,
    finalArgs: commandSpec.args,
    watcherConfig,
    // Prompt bytes never enter argv: the rpc-stdio watcher receives them over a private pipe,
    // while the SDK watcher receives only the path to its owner-only request file.
    ...(isRpcStdioInvoke(prepared.invoke)
      ? { rpcPrompt: buildOmpPrompt(prompt, prepared.options || {}) }
      : {}),
  });

  return task;
}

export function prepareTaskProviderCommand(prompt, options = {}) {
  const outputFormat = resolveOutputFormat(options);
  const jsonSchema = resolveJsonSchema(options, outputFormat);
  const settings = loadSettings();
  const providerName = normalizeProviderName(
    options.provider || settings.defaultProvider || getDefaultProviderId()
  );
  const providerOutputFormat =
    providerName === 'omp' &&
    resolveOmpTransport(settings) === 'sdk' &&
    outputFormat === 'stream-json' &&
    jsonSchema === null
      ? 'text'
      : outputFormat;
  return prepareTaskProviderCommandFromResolved(
    prompt,
    options,
    {
      outputFormat: providerOutputFormat,
      jsonSchema,
      cwd: options.cwd || process.cwd(),
    },
    settings
  );
}

function prepareTaskProviderCommandFromResolved(prompt, options, runtime, settings) {
  const modelSelection = resolveRequestedModelSelection(options);
  return prepareSingleAgentProviderCommand(
    {
      provider: options.provider || null,
      context: prompt,
      options: buildProviderOptions(options, runtime, modelSelection),
    },
    settings
  );
}

function resolveOutputFormat(options) {
  return options.outputFormat || 'stream-json';
}

function resolveJsonSchema(options, outputFormat) {
  let jsonSchema = options.jsonSchema ?? null;
  if (typeof jsonSchema === 'string') {
    try {
      jsonSchema = JSON.parse(jsonSchema);
    } catch (error) {
      throw new Error(`--json-schema must be valid JSON: ${error.message}`);
    }
  }
  if (
    jsonSchema !== null &&
    typeof jsonSchema !== 'boolean' &&
    (typeof jsonSchema !== 'object' || Array.isArray(jsonSchema))
  ) {
    throw new Error('--json-schema must be a boolean or JSON Schema object.');
  }
  if (jsonSchema !== null && outputFormat !== 'json') {
    console.warn('Warning: --json-schema requires --output-format json, ignoring schema');
    jsonSchema = null;
  }
  return jsonSchema;
}

function buildProviderOptions(options, runtime, modelSelection) {
  const structuredOutputRecovery = options.structuredOutputRecovery === true;
  const executionContext = resolveTaskExecutionContext();
  return {
    outputFormat: runtime.outputFormat,
    jsonSchema: runtime.jsonSchema,
    cwd: runtime.cwd,
    ...codexGitMetadataOption(options, runtime.cwd, executionContext),
    executionContext,
    autoApprove: !structuredOutputRecovery,
    ...(modelSelection === undefined ? {} : { modelSpec: modelSelection.modelSpec }),
    ...(structuredOutputRecovery ? {} : mcpConfigOption(options)),
    ...claudeSettingsFileOption(),
    ...(!structuredOutputRecovery && options.resume ? { resumeSessionId: options.resume } : {}),
    ...(runtime.ompSession ? { ompSession: runtime.ompSession } : {}),
    ...(process.env.ZEROSHOT_OPENCODE_AGENT?.trim()
      ? { agentName: process.env.ZEROSHOT_OPENCODE_AGENT.trim() }
      : {}),
    ...(!structuredOutputRecovery && options.continue ? { continueSession: true } : {}),
    ...(structuredOutputRecovery ? { structuredOutputRecovery: true } : {}),
  };
}

function codexGitMetadataOption(options, cwd, executionContext) {
  const settings = loadSettings();
  const providerName = normalizeProviderName(
    options.provider || settings.defaultProvider || getDefaultProviderId()
  );
  if (providerName !== 'codex') return {};
  if (executionContext === 'docker' || executionContext === 'benchmark') return {};
  const directories = resolveCodexGitMetadataDirectories(cwd);
  return directories.length === 0 ? {} : { additionalWritableDirectories: directories };
}

export function resolveCodexGitMetadataDirectories(cwd, runGit = execFileSync) {
  try {
    const raw = runGit('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const commonDirectory = resolvePath(cwd, raw.trim());
    const fromWorkspace = relative(resolvePath(cwd), commonDirectory);
    const outsideWorkspace =
      isAbsolute(fromWorkspace) ||
      fromWorkspace === '..' ||
      fromWorkspace.startsWith('../') ||
      fromWorkspace.startsWith('..\\');
    return outsideWorkspace ? [commonDirectory] : [];
  } catch {
    return [];
  }
}

function claudeSettingsFileOption() {
  const settingsPath = process.env[CLAUDE_SETTINGS_ENV]?.trim();
  return settingsPath ? { claudeSettingsFile: settingsPath } : {};
}

function mcpConfigOption(options) {
  const entries = Array.isArray(options.mcpConfig) ? [...options.mcpConfig] : [];
  const claudeMcpConfigPath = process.env[CLAUDE_MCP_CONFIG_ENV]?.trim();
  if (claudeMcpConfigPath && !entries.includes(claudeMcpConfigPath)) {
    entries.push(claudeMcpConfigPath);
  }
  if (entries.length === 0) return {};
  return { mcpConfig: entries };
}

function resolveRequestedModelSelection(options) {
  if (Object.prototype.hasOwnProperty.call(options, 'configuredModel')) {
    throw new Error(
      '--configured-model is not supported; configure providerSettings levelOverrides instead'
    );
  }

  if (options.model) {
    return directModelSelection(options);
  }

  return providerLevelSelection(options);
}

function directModelSelection(options) {
  const modelSpec = { model: options.model };
  if (options.reasoningEffort) modelSpec.reasoningEffort = options.reasoningEffort;
  return { modelSpec };
}

function providerLevelSelection(options) {
  if (!options.reasoningEffort && !options.modelLevel) return undefined;
  const modelSpec = {};
  if (options.modelLevel) modelSpec.level = options.modelLevel;
  if (options.reasoningEffort) modelSpec.reasoningEffort = options.reasoningEffort;
  return { modelSpec };
}

export function attachClaudeOverlayCleanup(commandSpec, providerName) {
  if (providerName !== 'claude') return commandSpec;
  const settingsPath = process.env[CLAUDE_SETTINGS_ENV]?.trim();
  if (!isClaudeSettingsOverlayPath(settingsPath)) return commandSpec;

  const overlayDir = dirname(settingsPath);
  return {
    ...commandSpec,
    cleanup: [...(commandSpec.cleanup || []), overlayDir],
    cleanupMetadata: [
      ...(commandSpec.cleanupMetadata || []),
      {
        kind: 'temp-directory',
        provider: 'claude',
        path: overlayDir,
        reason: 'settings-overlay',
      },
    ],
  };
}

export function buildTaskRecord({
  id,
  prompt,
  cwd,
  options,
  logFile,
  providerName,
  modelSpec,
  commandSpec = {},
  ompSessionOwnership = null,
}) {
  return {
    id,
    prompt: prompt.slice(0, 200) + (prompt.length > 200 ? '...' : ''),
    fullPrompt: prompt,
    cwd,
    status: 'running',
    pid: null,
    // Only watcher-observed provider output may populate sessionId. A requested
    // resume ID is diagnostic input, not proof the resumed provider emitted or
    // accepted that session identity.
    sessionId: null,
    sessionIdConflict: false,
    requestedResumeSessionId: options.structuredOutputRecovery ? null : options.resume || null,
    // Resumed tasks start fail-closed. Only the watcher terminal transaction
    // may prove that the requested identity completed without conflict.
    resumeIdentityVerified: options.structuredOutputRecovery || !options.resume,
    logFile,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exitCode: null,
    error: null,
    provider: providerName,
    model: modelSpec?.model || null,
    // Schedule reference (if spawned by scheduler)
    scheduleId: options.scheduleId || null,
    // Attach support
    socketPath: null,
    attachable: false,
    processGroupId: null,
    terminationStrategy: null,
    cancelRequested: false,
    spawnOwnershipToken: process.env[TASK_SPAWN_OWNERSHIP_TOKEN_ENV] || null,
    ompSessionOwnership,
    commandCleanup:
      commandSpec.cleanup?.length > 0
        ? {
            cleanup: commandSpec.cleanup,
            cleanupMetadata: commandSpec.cleanupMetadata || [],
          }
        : null,
  };
}

function isRpcStdioInvoke(invoke) {
  return invoke.lane === 'rpc-stdio';
}

function isOmpSdkInvoke(invoke) {
  return invoke.parser === 'omp-sdk-ndjson';
}

// The returned object is JSON-serialized into the detached watcher's argv, so it must never carry
// prompt or other task content: `ps` and /proc/<pid>/cmdline expose argv to every local user for
// the whole lifetime of the watcher. Partition paths, ids, and digests are not secret.
function buildWatcherConfig(
  outputFormat,
  jsonSchema,
  options,
  providerName,
  prepared,
  commandSpec,
  ompPlan
) {
  const protocolInvoke = isRpcStdioInvoke(prepared.invoke) || isOmpSdkInvoke(prepared.invoke);
  return {
    outputFormat,
    jsonSchema,
    silentJsonOutput: options.silentJsonOutput || false,
    structuredOutputRecovery: options.structuredOutputRecovery === true,
    provider: providerName,
    command: commandSpec.binary,
    env: commandSpec.env || {},
    commandSpec: buildWatcherCommandSpec(commandSpec, protocolInvoke),
    ...(isOmpSdkInvoke(prepared.invoke)
      ? {
          sdkPrepared: {
            invoke: prepared.invoke,
            environmentPolicy: prepared.environmentPolicy,
            credentialNames: prepared.credentialNames,
            privateArtifacts: prepared.privateArtifacts,
            executionIdentity: prepared.executionIdentity,
            semanticIdentity: prepared.semanticIdentity,
            containmentRequirement: prepared.containmentRequirement,
          },
        }
      : {}),
    ...(ompPlan
      ? {
          ompSession: ompPlan.session,
          ompResumeExpectation: ompPlan.resumeExpectation,
          // The workspace the ownership row was canonicalized against; the watcher compares it to
          // the session header's own recorded cwd after materialization.
          ompCanonicalWorkspace: ompPlan.provisionalOwnership.canonicalWorkspace,
        }
      : {}),
  };
}

function buildWatcherCommandSpec(commandSpec, keepArgs = false) {
  const watcherCommandSpec = { ...commandSpec };
  if (!keepArgs) delete watcherCommandSpec.args;
  return watcherCommandSpec;
}

export function shouldUseAttachableWatcher(options, providerName) {
  if (options.attachable === false) {
    return false;
  }

  // Benchmark runs are non-interactive and keep the cluster process in the foreground. Use the
  // pipe watcher so task completion is observed only after stdout/stderr close; a PTY exit can
  // race its final buffered output on remote runtimes and lose the terminal structured result.
  if (resolveTaskExecutionContext() === 'benchmark') {
    return false;
  }

  // The rpc-stdio lane owns bidirectional correlated RPC over stdio itself (see
  // omp-rpc-driver.ts) and always uses rpc-watcher.js instead of the attachable PTY watcher.
  if (getProviderRegistryEntry(providerName).invoke.lane === 'rpc-stdio') {
    return false;
  }

  // Claude strict structured output still needs the non-PTY watcher. Claude
  // can treat PTY notifications as streaming commands and reject the run.
  // Other providers, including Codex, support their structured-output mode in
  // the attachable PTY watcher and must not lose the advertised attach socket.
  return !(providerName === 'claude' && options.jsonSchema);
}

function resolveWatcherScript(options, providerName, invoke) {
  if (isOmpSdkInvoke(invoke)) return join(__dirname, 'sdk-watcher.js');
  if (isRpcStdioInvoke(invoke)) return join(__dirname, 'rpc-watcher.js');
  const useAttachable = shouldUseAttachableWatcher(options, providerName);
  return useAttachable ? join(__dirname, 'attachable-watcher.js') : join(__dirname, 'watcher.js');
}

function spawnWatcher({ watcherScript, id, cwd, logFile, finalArgs, watcherConfig, rpcPrompt }) {
  const sendsPrompt = typeof rpcPrompt === 'string';
  const watcherEnv = buildWatcherEnv();
  const watcher = spawn(
    process.execPath,
    [watcherScript, id, cwd, logFile, JSON.stringify(finalArgs), JSON.stringify(watcherConfig)],
    {
      detached: true,
      // A prompt-carrying lane needs only a private stdin pipe; detached watchers have no parent
      // messaging contract, so an IPC channel would add a second, racy wrapper-lifetime owner.
      stdio: sendsPrompt ? ['pipe', 'ignore', 'ignore'] : 'ignore',
      windowsHide: true,
      env: watcherEnv,
    }
  );

  // Only the pipe write holds the event loop (until it drains), never the watcher itself: the
  // parent still exits without waiting for the detached task to finish.
  if (sendsPrompt) sendWatcherPrompt(watcher.stdin, rpcPrompt);

  watcher.unref();
}

export function buildWatcherEnv(sourceEnv = process.env) {
  const watcherEnv = { ...sourceEnv };
  delete watcherEnv[LEGACY_ISOLATED_PROVIDER_SETTINGS_ENV];
  delete watcherEnv[TASK_SPAWN_OWNERSHIP_TOKEN_ENV];
  if (watcherEnv[ISOLATED_SETTINGS_FILE_MARKER] === '1') {
    delete watcherEnv[ISOLATED_SETTINGS_FILE_ENV];
    delete watcherEnv[ISOLATED_SETTINGS_FILE_MARKER];
  }
  return watcherEnv;
}
