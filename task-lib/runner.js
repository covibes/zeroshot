import { fork } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LOGS_DIR } from './config.js';
import { addTask, generateId, ensureDirs } from './store.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { prepareSingleAgentProviderCommand } = require('./provider-helper-runtime.js');
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
  const prepared = prepareSingleAgentProviderCommand({
    provider: options.provider || null,
    context: prompt,
    options: buildProviderOptions(options, outputFormat, jsonSchema, cwd),
  });
  const providerName = prepared.adapter.id;
  const modelSpec = prepared.options.modelSpec;
  const commandSpec = prepared.commandSpec;

  const task = buildTaskRecord({
    id,
    prompt,
    cwd,
    options,
    logFile,
    providerName,
    modelSpec,
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
  });

  return task;
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

function buildProviderOptions(options, outputFormat, jsonSchema, cwd) {
  return {
    outputFormat,
    jsonSchema,
    cwd,
    autoApprove: true,
    ...modelSpecOption(options),
    ...mcpConfigOption(options),
    ...(options.resume ? { resumeSessionId: options.resume } : {}),
    ...(options.continue ? { continueSession: true } : {}),
  };
}

function mcpConfigOption(options) {
  const entries = options.mcpConfig;
  if (!Array.isArray(entries) || entries.length === 0) return {};
  return { mcpConfig: entries };
}

function modelSpecOption(options) {
  const modelSpec = resolveRequestedModelSpec(options);
  return modelSpec === undefined ? {} : { modelSpec };
}

function resolveRequestedModelSpec(options) {
  if (options.model) {
    return {
      model: options.model,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    };
  }

  if (options.reasoningEffort) {
    return {
      ...(options.modelLevel ? { level: options.modelLevel } : {}),
      reasoningEffort: options.reasoningEffort,
    };
  }
  if (options.modelLevel) return { level: options.modelLevel };
  return undefined;
}

function buildTaskRecord({ id, prompt, cwd, options, logFile, providerName, modelSpec }) {
  return {
    id,
    prompt: prompt.slice(0, 200) + (prompt.length > 200 ? '...' : ''),
    fullPrompt: prompt,
    cwd,
    status: 'running',
    pid: null,
    sessionId: options.resume || options.sessionId || null,
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
  };
}

function buildWatcherConfig(outputFormat, jsonSchema, options, providerName, commandSpec) {
  return {
    outputFormat,
    jsonSchema,
    silentJsonOutput: options.silentJsonOutput || false,
    provider: providerName,
    command: commandSpec.binary,
    env: commandSpec.env || {},
    commandSpec: buildWatcherCommandSpec(commandSpec),
  };
}

function buildWatcherCommandSpec(commandSpec) {
  const watcherCommandSpec = { ...commandSpec };
  delete watcherCommandSpec.args;
  return watcherCommandSpec;
}

export function shouldUseAttachableWatcher(options, providerName) {
  if (options.attachable === false) {
    return false;
  }

  // Claude strict structured output still needs the non-PTY watcher. Claude
  // can treat PTY notifications as streaming commands and reject the run.
  // Other providers, including Codex, support their structured-output mode in
  // the attachable PTY watcher and must not lose the advertised attach socket.
  return !(providerName === 'claude' && options.jsonSchema);
}

function resolveWatcherScript(options, providerName) {
  const useAttachable = shouldUseAttachableWatcher(options, providerName);
  return useAttachable ? join(__dirname, 'attachable-watcher.js') : join(__dirname, 'watcher.js');
}

function spawnWatcher({ watcherScript, id, cwd, logFile, finalArgs, watcherConfig }) {
  const watcher = fork(
    watcherScript,
    [id, cwd, logFile, JSON.stringify(finalArgs), JSON.stringify(watcherConfig)],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }
  );

  watcher.unref();
  watcher.disconnect(); // Close IPC channel so parent can exit
}
