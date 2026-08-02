import { fork } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LOGS_DIR } from './config.js';
import { addTask, generateId, ensureDirs } from './store.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildOmpPrompt,
  getProviderRegistryEntry,
  prepareSingleAgentProviderCommand,
} = require('./provider-helper-runtime.js');
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
export {
  isOwnedProcessTreeRunning,
  isProcessRunning,
  killTask,
  terminateProcess,
} from './process-termination.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function spawnTask(prompt, options = {}) {
  ensureDirs();

  const id = generateId();
  const logFile = join(LOGS_DIR, `${id}.log`);
  const cwd = options.cwd || process.cwd();

  const outputFormat = resolveOutputFormat(options);
  const jsonSchema = resolveJsonSchema(options, outputFormat);
  const prepared = prepareTaskProviderCommandFromResolved(prompt, options, {
    outputFormat,
    jsonSchema,
    cwd,
  });
  const providerName = prepared.adapter.id;
  const modelSpec = prepared.options.modelSpec;
  const commandSpec = attachClaudeOverlayCleanup(prepared.commandSpec, providerName);

  const task = buildTaskRecord({
    id,
    prompt,
    cwd,
    options,
    logFile,
    providerName,
    modelSpec,
    commandSpec,
  });

  addTask(task);

  const watcherConfig = buildWatcherConfig(
    outputFormat,
    jsonSchema,
    options,
    providerName,
    commandSpec
  );
  const watcherScript = resolveWatcherScript(
    {
      attachable: options.attachable,
      jsonSchema,
    },
    providerName
  );
  spawnWatcher({
    watcherScript,
    id,
    cwd,
    logFile,
    finalArgs: commandSpec.args,
    watcherConfig,
    // Prompt bytes never enter argv: the rpc-stdio watcher receives them over a private pipe
    // (src/watcher-prompt-channel.js). Every other lane passes the prompt to the provider through
    // commandSpec.args, which the provider process — not a long-lived watcher — then owns.
    ...(isRpcStdioLane(providerName)
      ? { rpcPrompt: buildOmpPrompt(prompt, prepared.options || {}) }
      : {}),
  });

  return task;
}

export function prepareTaskProviderCommand(prompt, options = {}) {
  const outputFormat = resolveOutputFormat(options);
  return prepareTaskProviderCommandFromResolved(prompt, options, {
    outputFormat,
    jsonSchema: resolveJsonSchema(options, outputFormat),
    cwd: options.cwd || process.cwd(),
  });
}

function prepareTaskProviderCommandFromResolved(prompt, options, runtime) {
  const modelSelection = resolveRequestedModelSelection(options);
  return prepareSingleAgentProviderCommand({
    provider: options.provider || null,
    context: prompt,
    options: buildProviderOptions(options, runtime, modelSelection),
  });
}

function resolveOutputFormat(options) {
  return options.outputFormat || 'stream-json';
}

function resolveJsonSchema(options, outputFormat) {
  let jsonSchema = options.jsonSchema || null;
  if (jsonSchema && outputFormat !== 'json') {
    console.warn('Warning: --json-schema requires --output-format json, ignoring schema');
    jsonSchema = null;
  }
  return jsonSchema;
}

function buildProviderOptions(options, runtime, modelSelection) {
  const structuredOutputRecovery = options.structuredOutputRecovery === true;
  return {
    outputFormat: runtime.outputFormat,
    jsonSchema: runtime.jsonSchema,
    cwd: runtime.cwd,
    autoApprove: !structuredOutputRecovery,
    ...(modelSelection === undefined ? {} : { modelSpec: modelSelection.modelSpec }),
    ...(structuredOutputRecovery ? {} : mcpConfigOption(options)),
    ...claudeSettingsFileOption(),
    ...(!structuredOutputRecovery && options.resume ? { resumeSessionId: options.resume } : {}),
    ...(process.env.ZEROSHOT_OPENCODE_AGENT?.trim()
      ? { agentName: process.env.ZEROSHOT_OPENCODE_AGENT.trim() }
      : {}),
    ...(!structuredOutputRecovery && options.continue ? { continueSession: true } : {}),
    ...(structuredOutputRecovery ? { structuredOutputRecovery: true } : {}),
  };
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
    commandCleanup:
      commandSpec.cleanup?.length > 0
        ? {
            cleanup: commandSpec.cleanup,
            cleanupMetadata: commandSpec.cleanupMetadata || [],
          }
        : null,
  };
}

function isRpcStdioLane(providerName) {
  return getProviderRegistryEntry(providerName).invoke.lane === 'rpc-stdio';
}

// The returned object is JSON-serialized into the detached watcher's argv, so it must never carry
// prompt or other task content: `ps` and /proc/<pid>/cmdline expose argv to every local user for
// the whole lifetime of the watcher.
function buildWatcherConfig(outputFormat, jsonSchema, options, providerName, commandSpec) {
  return {
    outputFormat,
    jsonSchema,
    silentJsonOutput: options.silentJsonOutput || false,
    structuredOutputRecovery: options.structuredOutputRecovery === true,
    provider: providerName,
    command: commandSpec.binary,
    env: commandSpec.env || {},
    commandSpec: buildWatcherCommandSpec(commandSpec, isRpcStdioLane(providerName)),
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

  // The rpc-stdio lane owns bidirectional correlated RPC over stdio itself (see
  // omp-rpc-driver.ts) and always uses rpc-watcher.js instead of the attachable PTY watcher.
  if (isRpcStdioLane(providerName)) {
    return false;
  }

  // Claude strict structured output still needs the non-PTY watcher. Claude
  // can treat PTY notifications as streaming commands and reject the run.
  // Other providers, including Codex, support their structured-output mode in
  // the attachable PTY watcher and must not lose the advertised attach socket.
  return !(providerName === 'claude' && options.jsonSchema);
}

function resolveWatcherScript(options, providerName) {
  if (isRpcStdioLane(providerName)) {
    return join(__dirname, 'rpc-watcher.js');
  }
  const useAttachable = shouldUseAttachableWatcher(options, providerName);
  return useAttachable ? join(__dirname, 'attachable-watcher.js') : join(__dirname, 'watcher.js');
}

function spawnWatcher({ watcherScript, id, cwd, logFile, finalArgs, watcherConfig, rpcPrompt }) {
  const sendsPrompt = typeof rpcPrompt === 'string';
  const watcherEnv = buildWatcherEnv();
  const watcher = fork(
    watcherScript,
    [id, cwd, logFile, JSON.stringify(finalArgs), JSON.stringify(watcherConfig)],
    {
      detached: true,
      // A prompt-carrying lane needs a real pipe on fd 0 to receive it; every other lane keeps
      // stdio fully ignored. fork() requires an explicit 'ipc' slot once stdio is an array.
      stdio: sendsPrompt ? ['pipe', 'ignore', 'ignore', 'ipc'] : 'ignore',
      windowsHide: true,
      env: watcherEnv,
    }
  );

  // Only the pipe write holds the event loop (until it drains), never the watcher itself: the
  // parent still exits without waiting for the detached task to finish.
  if (sendsPrompt) sendWatcherPrompt(watcher.stdin, rpcPrompt);

  watcher.unref();
  watcher.disconnect(); // Close IPC channel so parent can exit
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
