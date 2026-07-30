/**
 * ClaudeTaskRunner - Production implementation of TaskRunner
 *
 * Executes provider tasks by spawning the `zeroshot task run` CLI command,
 * following logs, and assembling results.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const TaskRunner = require('./task-runner');
const { loadSettings } = require('../lib/settings');
const { normalizeProviderName } = require('../lib/provider-names');
const { getProvider } = require('./providers');
const { prependWorktreeToolBinToEnv } = require('./worktree-tooling-env');
const { applyDarwinKeychainBoundaryToEnv } = require('./darwin-keychain-boundary');
const { getTask, getTaskBySpawnOwnershipToken } = require('../task-lib/store.js');
const {
  TASK_SPAWN_OWNERSHIP_TOKEN_ENV,
  cleanupCallerOwnedCommand,
  callerOwnsCommandCleanup,
  createTaskSpawnOwnershipToken,
  requireTaskIdFromWrapperResult,
  trackTaskWrapperCleanupOwnership,
} = require('./task-spawn-cleanup-ownership');
const {
  CLAUDE_MCP_CONFIG_ENV,
  CLAUDE_SETTINGS_ENV,
  cleanupClaudeSettingsOverlay,
  prepareClaudeSettingsOverlay,
  resolveContainerMcpConfigPath,
  resolveRepoMcpConfigPath,
} = require('./worktree-claude-config');
const {
  appendTaskRunModelArgs,
  wrapTaskRunWithIsolatedSettings,
} = require('./task-run-model-args');
const { parseTaskStartupError } = require('./task-startup-error');

function rejectCallerSuppliedModelProvenance(options) {
  if (Object.prototype.hasOwnProperty.call(options, 'modelSpecSource')) {
    throw new Error(
      'modelSpecSource is derived from model versus modelLevel/default and cannot be supplied.'
    );
  }
}

function runCommand(command, args, options = {}, callback = null) {
  const timeout = options.timeout ?? 30000;
  if (timeout <= 0) {
    const error = new Error('runCommand timeout must be > 0. Infinite waits are forbidden.');
    if (callback) {
      callback(error);
      return;
    }
    return Promise.reject(error);
  }

  if (callback) {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      callback(error, stdout, stderr);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        callback(null, stdout, stderr);
        return;
      }
      const error = new Error(
        `Command ${command} exited with code ${code ?? 'null'} signal ${signal || 'none'}`
      );
      error.code = code;
      error.signal = signal;
      error.stderr = stderr;
      callback(error, stdout, stderr);
    });
    return;
  }

  return new Promise((resolve, reject) => {
    runCommand(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

const TASK_TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'stale', 'cancelled']);
const TASK_STARTUP_STDERR_MAX_CHARS = 500;

async function cleanupPersistedTaskAfterLaunchFailure(ctPath, taskId) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let commandError = null;
    try {
      await runCommand(ctPath, ['kill', taskId], { timeout: 10000 });
    } catch (error) {
      commandError = error;
    }
    const task = getTask(taskId);
    if (!task || (TASK_TERMINAL_STATUSES.has(task.status) && !task.commandCleanup)) {
      return;
    }
    lastError =
      commandError ||
      new Error(`Task ${taskId} termination and command cleanup were not confirmed`);
  }
  throw lastError || new Error(`Task ${taskId} cleanup failed`);
}

function runCommandSync(command, args, options = {}) {
  const timeout = options.timeout ?? 30000;
  const result = spawnSync(command, args, { ...options, timeout });
  if (result.status !== 0 || result.error) {
    const detail = result.error?.message || result.stderr?.toString() || 'no stderr';
    const error = new Error(
      `Command ${command} failed with status ${result.status ?? 'null'}: ${detail}`
    );
    error.status = result.status;
    error.stderr = result.stderr?.toString();
    throw error;
  }
  return result.stdout?.toString() || '';
}

function appendIsolatedMcpConfigArgs(command, provider, options) {
  if (provider !== 'claude') return;
  const mcpConfigPath = resolveContainerMcpConfigPath({
    cwd: options.cwd || process.cwd(),
    worktreePath: options.worktreePath || null,
  });
  if (mcpConfigPath) {
    command.push('--mcp-config', mcpConfigPath);
  }
}

class ClaudeTaskRunner extends TaskRunner {
  /**
   * @param {Object} options
   * @param {Object} [options.messageBus] - MessageBus for streaming output
   * @param {boolean} [options.quiet] - Suppress console logging
   * @param {number} [options.timeout] - Task timeout in ms (default: 1 hour)
   * @param {Function} [options.onOutput] - Callback for output lines
   * @param {Function} [options.applyDarwinKeychainBoundary] - Boundary injection seam for tests
   */
  constructor(options = {}) {
    super();
    this.messageBus = options.messageBus || null;
    this.quiet = options.quiet || false;
    this.timeout = options.timeout || 60 * 60 * 1000;
    this.onOutput = options.onOutput || null;
    this.applyDarwinKeychainBoundary =
      options.applyDarwinKeychainBoundary || applyDarwinKeychainBoundaryToEnv;
  }

  /**
   * @param {...any} args
   */
  _log(...args) {
    if (!this.quiet) {
      console.log(...args);
    }
  }

  /**
   * Execute a task via zeroshot CLI
   *
   * @param {string} context - Full prompt/context
   * @param {{agentId?: string, model?: string, modelLevel?: string, modelSpec?: Object|null, reasoningEffort?: string, outputFormat?: string, jsonSchema?: any, strictSchema?: boolean, cwd?: string, worktreePath?: string|null, isolation?: any}} options - Execution options
   * @returns {Promise<{success: boolean, output: string, error: string|null, taskId?: string}>}
   */
  async run(context, options = {}) {
    rejectCallerSuppliedModelProvenance(options);
    const {
      agentId = 'unknown',
      provider,
      model = null,
      modelLevel = null,
      modelSpec: explicitModelSpec = null,
      reasoningEffort = null,
      outputFormat = 'stream-json',
      jsonSchema = null,
      strictSchema = false, // false = live streaming (default), true = CLI schema enforcement (no streaming)
      cwd = process.cwd(),
      worktreePath = null,
      isolation = null,
    } = options;

    const settings = loadSettings();
    const providerName = normalizeProviderName(provider || settings.defaultProvider || 'claude');
    const { providerModule, providerSettings, levelOverrides } = this._getProviderContext(
      providerName,
      settings
    );
    const modelSelection = this._resolveModelSelection({
      explicitModelSpec,
      model,
      reasoningEffort,
      modelLevel,
      providerModule,
      providerSettings,
      levelOverrides,
    });
    const resolvedModelSpec = modelSelection.modelSpec;

    // Isolation mode delegates to separate method
    if (isolation?.enabled) {
      return this._runIsolated(context, {
        ...options,
        provider: providerName,
      });
    }

    const ctPath = 'zeroshot';

    const runOutputFormat = this._resolveOutputFormat({
      outputFormat,
      jsonSchema,
      strictSchema,
    });
    const args = this._buildRunArgs({
      context,
      providerName,
      runOutputFormat,
      resolvedModelSpec,
      modelSpecSource: modelSelection.source,
      jsonSchema,
    });

    // Spawn and get task ID
    const spawnEnv = this._buildSpawnEnv(providerName, resolvedModelSpec, {
      cwd,
      worktreePath,
    });

    let taskId;
    try {
      taskId = await this._spawnAndGetTaskId(ctPath, args, cwd, spawnEnv, agentId);
    } catch (error) {
      cleanupCallerOwnedCommand(error, () =>
        cleanupClaudeSettingsOverlay(spawnEnv[CLAUDE_SETTINGS_ENV])
      );
      throw error;
    }

    // Once a task ID is returned, the detached watcher owns provider
    // termination and command cleanup.
    this._log(`📋 [${agentId}]: Following zeroshot logs for ${taskId}`);
    await this._waitForTaskReady(ctPath, taskId);
    return this._followLogs(ctPath, taskId, agentId);
  }

  _getProviderContext(providerName, settings) {
    const providerModule = getProvider(providerName);
    const providerSettings = settings.providerSettings?.[providerName] || {};
    const levelOverrides = providerSettings.levelOverrides || {};
    return { providerModule, providerSettings, levelOverrides };
  }

  _resolveModelSpec({
    explicitModelSpec,
    model,
    reasoningEffort,
    modelLevel,
    providerModule,
    providerSettings,
    levelOverrides,
  }) {
    return this._resolveModelSelection({
      explicitModelSpec,
      model,
      reasoningEffort,
      modelLevel,
      providerModule,
      providerSettings,
      levelOverrides,
    }).modelSpec;
  }

  _resolveModelSelection({
    explicitModelSpec,
    model,
    reasoningEffort,
    modelLevel,
    providerModule,
    providerSettings,
    levelOverrides,
  }) {
    if (model) {
      providerModule.validateModelId(model);
      return {
        source: 'direct',
        modelSpec: { model, reasoningEffort },
      };
    }

    if (explicitModelSpec?.model !== undefined) {
      providerModule.validateModelId(explicitModelSpec.model);
      return {
        source: 'direct',
        modelSpec: explicitModelSpec,
      };
    }

    return {
      source: 'provider-level',
      modelSpec: this._resolveProviderLevelModelSpec({
        explicitModelSpec,
        modelLevel,
        reasoningEffort,
        providerModule,
        providerSettings,
        levelOverrides,
      }),
    };
  }

  _resolveProviderLevelModelSpec({
    explicitModelSpec,
    modelLevel,
    reasoningEffort,
    providerModule,
    providerSettings,
    levelOverrides,
  }) {
    const level =
      explicitModelSpec?.level ||
      modelLevel ||
      providerSettings.defaultLevel ||
      providerModule.getDefaultLevel();
    const resolvedModelSpec = providerModule.resolveModelSpec(level, levelOverrides);
    const resolvedReasoningEffort = explicitModelSpec?.reasoningEffort || reasoningEffort;

    return resolvedReasoningEffort
      ? { ...resolvedModelSpec, reasoningEffort: resolvedReasoningEffort }
      : resolvedModelSpec;
  }

  _resolveOutputFormat({ outputFormat, jsonSchema, strictSchema }) {
    // json output does not stream; if a jsonSchema is configured we run stream-json
    // for live logs and validate/parse JSON after completion.
    // Set strictSchema=true to disable live streaming and use CLI's native schema enforcement.
    return jsonSchema && outputFormat === 'json' && !strictSchema ? 'stream-json' : outputFormat;
  }

  _buildRunArgs({
    context,
    providerName,
    runOutputFormat,
    resolvedModelSpec,
    modelSpecSource = 'direct',
    jsonSchema,
  }) {
    const args = ['task', 'run', '--output-format', runOutputFormat, '--provider', providerName];
    appendTaskRunModelArgs(args, resolvedModelSpec, modelSpecSource);

    // Pass schema to CLI only when using json output (strictSchema=true or no conflict)
    if (jsonSchema && runOutputFormat === 'json') {
      args.push('--json-schema', JSON.stringify(jsonSchema));
    }

    args.push(context);

    return args;
  }

  _buildSpawnEnv(providerName, resolvedModelSpec, options = {}) {
    const { cwd = process.cwd(), worktreePath = null } = options;
    const spawnEnv = {
      ...process.env,
    };
    let claudeSettingsPath = null;
    if (providerName === 'claude' && resolvedModelSpec?.model) {
      spawnEnv.ANTHROPIC_MODEL = resolvedModelSpec.model;
    }
    if (providerName === 'claude') {
      claudeSettingsPath = prepareClaudeSettingsOverlay({
        includeDangerousGit: Boolean(worktreePath),
      });
      spawnEnv[CLAUDE_SETTINGS_ENV] = claudeSettingsPath;
      const mcpConfigPath = resolveRepoMcpConfigPath({ cwd, worktreePath });
      if (mcpConfigPath) {
        spawnEnv[CLAUDE_MCP_CONFIG_ENV] = mcpConfigPath;
      }
    }

    // KEYCHAIN BOUNDARY (darwin only): keep non-interactive worker descendants
    // away from the user's GUI Keychain session (issue #704).
    try {
      this.applyDarwinKeychainBoundary(spawnEnv);
    } catch (error) {
      if (claudeSettingsPath) cleanupClaudeSettingsOverlay(claudeSettingsPath);
      throw error;
    }

    prependWorktreeToolBinToEnv(spawnEnv, { cwd, worktreePath });

    return spawnEnv;
  }

  /**
   * @param {string} ctPath
   * @param {string[]} args
   * @param {string} cwd
   * @param {Object} spawnEnv
   * @param {string} _agentId
   * @returns {Promise<string>}
   */
  _spawnAndGetTaskId(ctPath, args, cwd, spawnEnv, _agentId) {
    const ownershipToken = createTaskSpawnOwnershipToken();
    const findPersistedTaskId = () => getTaskBySpawnOwnershipToken(ownershipToken)?.id || null;
    return new Promise((resolve, reject) => {
      const proc = spawn(ctPath, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...spawnEnv, [TASK_SPAWN_OWNERSHIP_TOKEN_ENV]: ownershipToken },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const classifyCleanupOwnership = trackTaskWrapperCleanupOwnership(findPersistedTaskId);
      const rejectWithOwnership = async (error) => {
        if (settled) return;
        settled = true;
        const classifiedError = classifyCleanupOwnership(error);
        if (!callerOwnsCommandCleanup(classifiedError)) {
          classifiedError.spawnOwnershipToken = ownershipToken;
          let persistedTaskId = null;
          let lookupError = null;
          try {
            persistedTaskId = findPersistedTaskId();
          } catch (lookupFailure) {
            lookupError = lookupFailure;
          }
          classifiedError.taskId = persistedTaskId;
          try {
            if (lookupError) throw lookupError;
            if (persistedTaskId) {
              await cleanupPersistedTaskAfterLaunchFailure(ctPath, persistedTaskId);
            }
          } catch (cleanupError) {
            classifiedError.message += ` Task cleanup was not confirmed: ${cleanupError.message}`;
            classifiedError.permanent = true;
            classifiedError.restartExhausted = true;
            classifiedError.terminationExhausted = true;
            classifiedError.terminationAttempts = persistedTaskId ? 3 : 1;
          }
        }
        reject(classifiedError);
      };

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', async (code) => {
        if (settled) return;
        try {
          const taskId = requireTaskIdFromWrapperResult({
            code,
            stdout,
            stderr,
            parseTaskId: (output) =>
              output.match(/Task spawned: ((?:task-)?[a-z]+-[a-z]+-[a-z0-9]+)/)?.[1],
            persistedTaskId: findPersistedTaskId(),
          });
          settled = true;
          resolve(taskId);
        } catch (error) {
          await rejectWithOwnership(error);
        }
      });

      proc.on('error', async (error) => {
        await rejectWithOwnership(error);
      });
    });
  }

  /**
   * @param {string} ctPath
   * @param {string} taskId
   * @param {number} maxRetries
   * @param {number} delayMs
   * @returns {Promise<void>}
   */
  async _waitForTaskReady(ctPath, taskId, maxRetries = 10, delayMs = 200) {
    for (let i = 0; i < maxRetries; i++) {
      const exists = await new Promise((resolve) => {
        runCommand(ctPath, ['status', taskId], {}, (error, stdout) => {
          resolve(!error && !stdout.includes('Task not found'));
        });
      });

      if (exists) return;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    console.warn(
      `⚠️ Task ${taskId} not yet visible after ${maxRetries} retries, continuing anyway`
    );
  }

  /**
   * @param {string} ctPath
   * @param {string} taskId
   * @param {string} agentId
   * @returns {Promise<{success: boolean, output: string, error: string|null, taskId: string}>}
   */
  _followLogs(ctPath, taskId, agentId) {
    return new Promise((resolve, reject) => {
      let output = '';
      /** @type {string|null} */
      let logFilePath = null;
      let lastSize = 0;
      /** @type {NodeJS.Timeout|null} */
      let pollInterval = null;
      /** @type {NodeJS.Timeout|null} */
      let statusCheckInterval = null;
      let resolved = false;
      let lineBuffer = '';
      let cleanupRecoveryPending = false;

      // Get log file path
      try {
        logFilePath = runCommandSync(ctPath, ['get-log-path', taskId], {
          encoding: 'utf-8',
        }).trim();
      } catch {
        this._log(`⏳ [${agentId}]: Waiting for log file...`);
      }

      /**
       * @param {string} line
       */
      const broadcastLine = (line) => {
        if (!line.trim()) return;

        let content = line;
        const timestampMatch = line.match(/^\[(\d{13})\](.*)$/);
        if (timestampMatch) {
          content = timestampMatch[2];
        }

        // Skip non-JSON patterns
        if (
          content.startsWith('===') ||
          content.startsWith('Finished:') ||
          content.startsWith('Exit code:') ||
          (content.includes('"type":"system"') && content.includes('"subtype":"init"'))
        ) {
          return;
        }

        if (!content.trim().startsWith('{')) return;

        try {
          JSON.parse(content);
        } catch {
          return;
        }

        output += content + '\n';

        // Callback for output streaming
        if (this.onOutput) {
          this.onOutput(content, agentId);
        }
      };

      /**
       * @param {string} content
       */
      const processNewContent = (content) => {
        lineBuffer += content;
        const lines = lineBuffer.split('\n');

        for (let i = 0; i < lines.length - 1; i++) {
          broadcastLine(lines[i]);
        }
        lineBuffer = lines[lines.length - 1];
      };

      const pollLogFile = () => {
        if (!logFilePath) {
          try {
            logFilePath = runCommandSync(ctPath, ['get-log-path', taskId], {
              encoding: 'utf-8',
            }).trim();
          } catch {
            return;
          }
        }

        if (!fs.existsSync(logFilePath)) return;

        try {
          const stats = fs.statSync(logFilePath);
          const currentSize = stats.size;

          if (currentSize > lastSize) {
            const fd = fs.openSync(logFilePath, 'r');
            const buffer = Buffer.alloc(currentSize - lastSize);
            fs.readSync(fd, buffer, 0, buffer.length, lastSize);
            fs.closeSync(fd);

            processNewContent(buffer.toString('utf-8'));
            lastSize = currentSize;
          }
        } catch (err) {
          const error = /** @type {Error} */ (err);
          console.warn(`⚠️ [${agentId}]: Error reading log: ${error.message}`);
        }
      };

      pollInterval = setInterval(pollLogFile, 300);

      /**
       * @param {boolean} success
       * @param {string} stdout
       * @returns {string|null}
       */
      const extractErrorContext = (success, stdout) => {
        if (success) return null;

        // Try to extract error from status output first
        const statusErrorMatch = stdout.match(/Error:\s*(.+)/);
        if (statusErrorMatch) {
          return statusErrorMatch[1].trim();
        }

        // Fall back to last 500 chars of output
        const lastOutput = output.slice(-500).trim();
        if (!lastOutput) {
          return 'Task failed with no output';
        }

        const errorPatterns = [
          /Error:\s*(.+)/i,
          /error:\s*(.+)/i,
          /failed:\s*(.+)/i,
          /Exception:\s*(.+)/i,
        ];

        for (const pattern of errorPatterns) {
          const match = lastOutput.match(pattern);
          if (match) {
            return match[1].slice(0, 200);
          }
        }

        return `Task failed. Last output: ${lastOutput.slice(-200)}`;
      };

      statusCheckInterval = setInterval(() => {
        runCommand(ctPath, ['status', taskId], {}, (error, stdout) => {
          if (resolved || error) return;
          const terminalMatch = stdout.match(/Status:\s+(completed|failed)/i);
          if (!terminalMatch) return;
          if (/Cleanup:\s+pending/i.test(stdout)) {
            if (!cleanupRecoveryPending) {
              cleanupRecoveryPending = true;
              runCommand(ctPath, ['kill', taskId], { timeout: 10000 }, (cleanupError) => {
                cleanupRecoveryPending = false;
                if (cleanupError) {
                  this._log(
                    `⚠️ [${agentId}]: Terminal cleanup recovery will retry: ${cleanupError.message}`
                  );
                }
              });
            }
            return;
          }

          const success = terminalMatch[1].toLowerCase() === 'completed';
          pollLogFile();

          setTimeout(() => {
            if (resolved) return;
            resolved = true;

            clearInterval(pollInterval);
            clearInterval(statusCheckInterval);

            const errorContext = extractErrorContext(success, stdout);

            resolve({
              success,
              output,
              error: errorContext,
              taskId,
            });
          }, 500);
        });
      }, 1000);

      // Timeout
      setTimeout(() => {
        if (resolved) return;
        resolved = true;

        clearInterval(pollInterval);
        clearInterval(statusCheckInterval);

        const timeoutMinutes = Math.round(this.timeout / 60000);
        reject(new Error(`Task timed out after ${timeoutMinutes} minutes`));
      }, this.timeout);
    });
  }

  /**
   * Run task in isolated Docker container
   * @param {string} context
   * @param {{agentId?: string, provider?: string, model?: string, modelLevel?: string, modelSpec?: Object|null, reasoningEffort?: string, outputFormat?: string, jsonSchema?: any, strictSchema?: boolean, isolation?: any}} options
   * @returns {Promise<{success: boolean, output: string, error: string|null}>}
   */
  _runIsolated(context, options) {
    rejectCallerSuppliedModelProvenance(options);
    const {
      agentId = 'unknown',
      provider = 'claude',
      model = null,
      modelLevel = null,
      modelSpec: explicitModelSpec = null,
      reasoningEffort = null,
      outputFormat = 'stream-json',
      jsonSchema = null,
      strictSchema = false,
      isolation,
    } = options;
    const { manager, clusterId } = isolation;
    const settings = loadSettings();
    const { providerModule, providerSettings, levelOverrides } = this._getProviderContext(
      provider,
      settings
    );
    const modelSelection = this._resolveModelSelection({
      explicitModelSpec,
      model,
      reasoningEffort,
      modelLevel,
      providerModule,
      providerSettings,
      levelOverrides,
    });
    const modelSpec = modelSelection.modelSpec;
    const modelSpecSource = modelSelection.source;

    this._log(`📦 [${agentId}]: Running task in isolated container...`);

    const desiredOutputFormat = outputFormat;
    const runOutputFormat =
      jsonSchema && desiredOutputFormat === 'json' && !strictSchema
        ? 'stream-json'
        : desiredOutputFormat;

    let command = [
      'zeroshot',
      'task',
      'run',
      '--output-format',
      runOutputFormat,
      '--provider',
      provider,
    ];

    appendTaskRunModelArgs(command, modelSpec, modelSpecSource);

    if (jsonSchema && runOutputFormat === 'json') {
      command.push('--json-schema', JSON.stringify(jsonSchema));
    }

    appendIsolatedMcpConfigArgs(command, provider, options);

    let finalContext = context;
    if (jsonSchema && desiredOutputFormat === 'json' && runOutputFormat === 'stream-json') {
      finalContext += `\n\n## Output Format (REQUIRED)\n\nReturn a JSON object that matches this schema exactly.\n\nSchema:\n\`\`\`json\n${JSON.stringify(
        jsonSchema,
        null,
        2
      )}\n\`\`\`\n`;
    }

    command.push(finalContext);
    command = wrapTaskRunWithIsolatedSettings(command, {
      providerName: provider,
      settings,
      modelSpecSource,
      modelSpec,
    });

    return new Promise((resolve, reject) => {
      let output = '';
      let resolved = false;
      let stderr = '';

      const proc = manager.spawnInContainer(clusterId, command, {
        env: {
          ...(provider === 'claude' && modelSpec?.model
            ? { ANTHROPIC_MODEL: modelSpec.model, ZEROSHOT_BLOCK_ASK_USER: '1' }
            : {}),
        },
      });

      proc.stdout.on('data', (/** @type {Buffer} */ data) => {
        const chunk = data.toString();
        output += chunk;

        if (this.onOutput) {
          this.onOutput(chunk, agentId);
        }
      });

      proc.stderr.on('data', (/** @type {Buffer} */ data) => {
        const chunk = data.toString();
        stderr = `${stderr}${chunk}`.slice(-TASK_STARTUP_STDERR_MAX_CHARS);
        if (!this.quiet) {
          console.error(`[${agentId}] stderr:`, chunk);
        }
      });

      proc.on('close', (/** @type {number|null} */ code) => {
        if (resolved) return;
        resolved = true;
        if (code !== 0) {
          const startupError = parseTaskStartupError(stderr);
          if (startupError) {
            reject(startupError);
            return;
          }
        }

        resolve({
          success: code === 0,
          output,
          error: code === 0 ? null : `Container exited with code ${code}`,
        });
      });

      proc.on('error', (/** @type {Error} */ error) => {
        if (resolved) return;
        resolved = true;
        reject(error);
      });

      setTimeout(() => {
        if (resolved) return;
        resolved = true;

        try {
          proc.kill('SIGKILL');
        } catch {
          // Ignore - process may already be dead
        }

        const timeoutMinutes = Math.round(this.timeout / 60000);
        reject(new Error(`Isolated task timed out after ${timeoutMinutes} minutes`));
      }, this.timeout);
    });
  }
}

module.exports = ClaudeTaskRunner;
