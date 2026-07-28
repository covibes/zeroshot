// @ts-nocheck
/**
 * AgentTaskExecutor - Claude CLI spawning and monitoring
 *
 * Provides:
 * - Claude CLI task spawning (normal and isolated modes)
 * - Log streaming and real-time output broadcasting
 * - Task lifecycle management (wait, kill)
 * - Output parsing and validation
 * - Vibe-specific Claude config with AskUserQuestion blocked
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { parseProviderChunk, getProvider } = require('../providers');
const { getTask, getTaskBySpawnOwnershipToken } = require('../../task-lib/store.js');
const { loadSettings } = require('../../lib/settings.js');
const { resolveClaudeAuth } = require('../../lib/settings/claude-auth.js');
const { prependWorktreeToolBinToEnv } = require('../worktree-tooling-env.js');
const {
  CLAUDE_SETTINGS_ENV,
  cleanupClaudeSettingsOverlay,
  ensureAskUserQuestionHook,
  ensureDangerousGitHook,
  prepareClaudeSettingsOverlay,
  resolveContainerMcpConfigPath,
  resolveRepoMcpConfigPath,
} = require('../worktree-claude-config.js');
const {
  appendTaskRunModelArgs,
  wrapTaskRunWithIsolatedSettings,
} = require('../task-run-model-args.js');
const { buildRawLogOnlyMetadata } = require('./context-replay-policy');
const {
  TASK_SPAWN_OWNERSHIP_TOKEN_ENV,
  cleanupCallerOwnedCommand,
  callerOwnsCommandCleanup,
  createTaskSpawnOwnershipToken,
  requireTaskIdFromWrapperResult,
  trackTaskWrapperCleanupOwnership,
} = require('../task-spawn-cleanup-ownership');
const {
  providerSessionFromCompletedTask,
  resolveAgentResumeSessionId,
  validateCompletedResumeIdentity,
} = require('./provider-session');
const { extractClaudeVertexModelError } = require('./output-extraction');

function runCommandWithTimeout(command, args, options = {}, callback = null) {
  const timeout = options.timeout ?? 30000;
  if (timeout <= 0) {
    const error = new Error(
      'runCommandWithTimeout timeout must be > 0. Infinite waits are forbidden.'
    );
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
    runCommandWithTimeout(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
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

// Schema utilities for normalizing LLM output
const { normalizeEnumValues } = require('./schema-utils');

/**
 * Build Claude-specific environment variables for task spawning
 * Consolidates auth resolution and model mapping logic used by both isolated and non-isolated modes
 * @param {Object} modelSpec - Model specification from agent
 * @param {Object} [options] - Options
 * @param {boolean} [options.includeAuth=true] - Include auth env vars (false for isolated mode where IsolationManager handles auth)
 * @returns {Object} Environment variables to merge into spawn env
 */
function buildClaudeEnv(modelSpec, options = {}) {
  const { includeAuth = true } = options;
  const env = {};

  if (includeAuth) {
    const settings = loadSettings();
    const authEnv = resolveClaudeAuth(settings);
    Object.assign(env, authEnv);
  }

  if (modelSpec?.model) {
    env.ANTHROPIC_MODEL = modelSpec.model;
  }

  // Activate AskUserQuestion blocking hook (see cluster-hooks/block-ask-user-question.py)
  env.ZEROSHOT_BLOCK_ASK_USER = '1';

  return env;
}

/**
 * Validate and sanitize error messages.
 * Detects TypeScript type annotations that may have leaked into error storage.
 *
 * @param {string|null} error - Error message to validate
 * @returns {string|null} Sanitized error or original if valid
 */
function sanitizeErrorMessage(error) {
  if (!error) return null;

  // Patterns that look like TypeScript type annotations (not real error messages)
  const typeAnnotationPatterns = [
    /^string\s*\|\s*null$/i,
    /^number\s*\|\s*undefined$/i,
    /^boolean\s*\|\s*null$/i,
    /^any$/i,
    /^unknown$/i,
    /^void$/i,
    /^never$/i,
    /^[A-Z][a-zA-Z]*\s*\|\s*(?:null|undefined)$/, // e.g., "Error | null"
  ];

  const trimmedError = error.trim();

  // Check if it's a union type like "string | number | boolean" (ReDoS-safe approach)
  const unionParts = trimmedError.split(/\s*\|\s*/);
  const isUnionType = unionParts.length > 1 && unionParts.every((p) => /^[a-z]+$/i.test(p));

  for (const pattern of typeAnnotationPatterns) {
    if (pattern.test(trimmedError) || isUnionType) {
      console.warn(
        `[agent-task-executor] WARNING: Error message looks like a TypeScript type annotation: "${error}". ` +
          `This indicates corrupted data. Replacing with generic error.`
      );
      return `Task failed with corrupted error data (original: "${error}")`;
    }
  }

  return error;
}

function safeTail(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

function getClaudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function findLatestClaudeDebugFile(configDir) {
  try {
    const debugDir = path.join(configDir, 'debug');
    const latestLink = path.join(debugDir, 'latest');
    if (fs.existsSync(latestLink)) {
      const resolved = fs.realpathSync(latestLink);
      const stats = fs.statSync(resolved);
      return { path: resolved, mtimeMs: stats.mtimeMs };
    }

    const entries = fs.readdirSync(debugDir);
    let newest = null;
    for (const entry of entries) {
      const fullPath = path.join(debugDir, entry);
      const stats = fs.statSync(fullPath);
      if (!stats.isFile()) continue;
      if (!newest || stats.mtimeMs > newest.mtimeMs) {
        newest = { path: fullPath, mtimeMs: stats.mtimeMs };
      }
    }
    return newest;
  } catch (error) {
    return { error: error.message };
  }
}

function readFileTail(filePath, maxBytes) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      if (length <= 0) return '';
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function logNoMessagesReturned({ taskId, output, statusOutput, debug }) {
  const claudeConfigDir = getClaudeConfigDir();
  const latestDebug = findLatestClaudeDebugFile(claudeConfigDir);
  const latestDebugPath = latestDebug?.path || null;
  const latestDebugTail =
    latestDebugPath && typeof latestDebugPath === 'string'
      ? safeTail(readFileTail(latestDebugPath, 4000), 4000)
      : '';

  const payload = {
    event: 'NO_MESSAGES_RETURNED',
    timestamp: new Date().toISOString(),
    taskId,
    agentId: debug?.agentId || null,
    provider: debug?.providerName || null,
    pid: debug?.pid || null,
    cwd: debug?.cwd || null,
    worktreePath: debug?.worktreePath || null,
    isolation: debug?.isolation || false,
    clusterId: debug?.clusterId || null,
    logFilePath: debug?.logFilePath || null,
    outputLen: output ? output.length : 0,
    outputTail: safeTail(output || '', 1000),
    statusOutputLen: statusOutput ? statusOutput.length : 0,
    statusOutputTail: safeTail(statusOutput || '', 1000),
    claudeConfigDir,
    claudeDebugLatest: latestDebugPath,
    claudeDebugLatestMtimeMs: latestDebug?.mtimeMs || null,
    claudeDebugLatestTail: latestDebugTail,
  };

  console.error('[AgentTaskExecutor] Claude CLI returned no messages', payload);
}

/**
 * Extract error context from task output.
 * Shared by both isolated and non-isolated modes.
 *
 * @param {Object} params - Extraction parameters
 * @param {string} params.output - Full task output
 * @param {string} [params.statusOutput] - Status command output (non-isolated only)
 * @param {string} params.taskId - Task ID for error messages
 * @param {boolean} [params.isNotFound=false] - True if task was not found
 * @param {Object} [params.debug] - Additional debug context for logging
 * @returns {string|null} Sanitized error context or null if extraction failed
 */
function extractErrorContext({ output, statusOutput, taskId, isNotFound = false, debug }) {
  // Task not found - explicit error
  if (isNotFound) {
    return sanitizeErrorMessage(`Task ${taskId} not found (may have crashed or been killed)`);
  }

  // Try status output first (only available in non-isolated mode)
  if (statusOutput) {
    const statusErrorMatch = statusOutput.match(/Error:\s*(.+)/);
    if (statusErrorMatch) {
      return sanitizeErrorMessage(statusErrorMatch[1].trim());
    }
  }

  // KNOWN CLAUDE CODE LIMITATIONS - detect and provide actionable guidance
  const fullOutput = output || '';

  // 256KB file limit error
  if (fullOutput.includes('exceeds maximum allowed size') || fullOutput.includes('256KB')) {
    return sanitizeErrorMessage(
      `FILE TOO LARGE (Claude Code 256KB limit). ` +
        `Use offset and limit parameters when reading large files. ` +
        `Example: Read tool with offset=0, limit=1000 to read first 1000 lines.`
    );
  }

  // Streaming mode error (interactive tools in non-interactive mode)
  if (fullOutput.includes('only prompt commands are supported in streaming mode')) {
    return sanitizeErrorMessage(
      `STREAMING MODE ERROR: Agent tried to use interactive tools in streaming mode. ` +
        `This usually happens with AskUserQuestion or interactive prompts. ` +
        `Zeroshot agents must run non-interactively.`
    );
  }

  // Claude CLI transient failure: no messages returned
  if (fullOutput.includes('No messages returned')) {
    logNoMessagesReturned({ taskId, output: fullOutput, statusOutput, debug });
    return sanitizeErrorMessage(
      `Claude CLI returned no messages. This is usually transient; retry the task or resume the cluster.`
    );
  }

  // NEVER TRUNCATE OUTPUT - truncation corrupts structured JSON and causes false "crash" status
  // If output is too verbose, that's a prompt problem - fix the prompts, not the data
  const trimmedOutput = (output || '').trim();
  if (!trimmedOutput) {
    return sanitizeErrorMessage(
      'Task failed with no output (check if task was interrupted or timed out)'
    );
  }

  // Try to extract structured JSON from output first - it may contain the actual result
  // even if the task was marked as "failed" due to timeout/stale status
  try {
    const { extractJsonFromOutput } = require('./output-extraction');
    const extracted = extractJsonFromOutput(trimmedOutput);
    if (extracted && typeof extracted === 'object') {
      // If we found valid JSON, return it as the error context
      // This preserves the actual agent output for downstream processing
      return JSON.stringify(extracted);
    }
  } catch {
    // Extraction failed, fall through to error pattern matching
  }

  // Extract non-JSON lines only (JSON lines contain "is_error": true which falsely matches)
  const nonJsonLines = trimmedOutput
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      // Skip JSON objects and JSON-like content
      return trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('"');
    })
    .join('\n');

  // Common error patterns - match against non-JSON content
  const textToSearch = nonJsonLines || trimmedOutput;
  const errorPatterns = [
    /Error:\s*(.+)/i,
    /error:\s*(.+)/i,
    /failed:\s*(.+)/i,
    /Exception:\s*(.+)/i,
    /panic:\s*(.+)/i,
  ];

  for (const pattern of errorPatterns) {
    const match = textToSearch.match(pattern);
    if (match) {
      // Don't truncate - let the full error message through
      return sanitizeErrorMessage(match[1]);
    }
  }

  // No pattern matched - return full output (no truncation)
  // If this is too long, the solution is to make agents output less, not to corrupt data
  return sanitizeErrorMessage(`Task failed. Output: ${trimmedOutput}`);
}

/**
 * Extract token usage from NDJSON output.
 * Looks for the 'result' event line which contains usage data.
 * Falls back to summing 'turn.completed' events for cache metrics
 * when the result event doesn't include them.
 *
 * @param {string} output - Full NDJSON output from Claude CLI
 * @returns {Object|null} Token usage data or null if not found
 */
function extractTokenUsage(output, providerName = 'claude') {
  if (!output) return null;

  const events = parseProviderChunk(providerName, output);
  const resultEvent = events.find((event) => event.type === 'result');

  if (!resultEvent) {
    return null;
  }

  let cacheReadInputTokens = resultEvent.cacheReadInputTokens || 0;
  let cacheCreationInputTokens = resultEvent.cacheCreationInputTokens || 0;

  // Fallback: if result event has no cache data, extract from raw turn.completed events.
  // Claude CLI emits turn.completed with cached_input_tokens but the result event may omit them.
  if (cacheReadInputTokens === 0) {
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed);
        if (raw.type === 'turn.completed' && raw.usage) {
          const usage = raw.usage;
          cacheReadInputTokens += usage.cached_input_tokens || usage.cache_read_input_tokens || 0;
          cacheCreationInputTokens += usage.cache_creation_input_tokens || 0;
        }
      } catch {
        // skip non-JSON lines
      }
    }
  }

  return {
    inputTokens: resultEvent.inputTokens || 0,
    outputTokens: resultEvent.outputTokens || 0,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalCostUsd: resultEvent.cost || null,
    durationMs: resultEvent.duration || null,
    modelUsage: resultEvent.modelUsage || null,
  };
}

/**
 * Spawn claude-zeroshots process and stream output via message bus
 * @param {Object} agent - Agent instance
 * @param {String} context - Context to pass to Claude
 * @returns {Promise<Object>} Result object { success, output, error }
 */
async function spawnClaudeTask(agent, context) {
  const providerName = agent._resolveProvider ? agent._resolveProvider() : 'claude';
  const modelSpec = resolveAgentModelSpec(agent);

  const ctPath = getClaudeTasksPath();
  const cwd = agent.config.cwd || process.cwd();

  // Build zeroshot task run args.
  // CRITICAL: Default to strict schema validation to prevent cluster crashes from parse failures
  // strictSchema=true uses Claude CLI's native --json-schema enforcement (no streaming but guaranteed structure)
  // strictSchema=false uses stream-json with post-run validation (live logs but fragile)
  const { desiredOutputFormat, runOutputFormat } = resolveOutputFormatConfig(agent);
  const args = buildTaskRunArgs({
    agent,
    providerName,
    modelSpec,
    runOutputFormat,
  });

  // NOTE: maxRetries is handled by the agent wrapper's internal retry loop,
  // not passed to the CLI. See _handleTrigger() for retry logic.

  maybeLogStreamJsonNotice(agent, runOutputFormat);

  // If schema enforcement is desired but we had to run stream-json for live logs,
  // add explicit output instructions so the model still knows the required shape.
  const finalContext = buildFinalContext({
    agent,
    context,
    desiredOutputFormat,
    runOutputFormat,
  });

  args.push(finalContext);

  // MOCK SUPPORT: Use injected mock function if provided
  if (agent.mockSpawnFn) {
    return agent.mockSpawnFn(args, { context });
  }

  // SAFETY: Fail hard if testMode=true but no mock (should be caught in constructor)
  if (agent.testMode) {
    throw new Error(
      `AgentWrapper: testMode=true but attempting real Claude API call for agent '${agent.id}'. ` +
        `This is a bug - mock should be set in constructor.`
    );
  }

  // ISOLATION MODE: Run inside Docker container
  if (agent.isolation?.enabled) {
    return spawnClaudeTaskIsolated(agent, context);
  }

  // NON-ISOLATION MODE: Load safety hooks through an additional per-run settings file. Claude
  // still reads the user's normal config and the repository's project/local config.
  // AskUserQuestion blocking handled via:
  // 1. Prompt injection (see agent-context-builder)
  // 2. PreToolUse hook (defense-in-depth) - activated by ZEROSHOT_BLOCK_ASK_USER env var
  const claudeSettingsPath =
    providerName === 'claude'
      ? prepareClaudeSettingsOverlay({
          includeDangerousGit: Boolean(agent.worktree?.enabled),
        })
      : null;

  let taskId;
  let pendingLaunch;
  try {
    const spawnEnv = buildSpawnEnv(agent, providerName, modelSpec, { claudeSettingsPath });
    taskId = await spawnTaskProcess({
      agent,
      ctPath,
      args,
      cwd,
      spawnEnv,
    });
    pendingLaunch = agent.currentTask;
  } catch (error) {
    cleanupCallerOwnedCommand(error, () => cleanupClaudeSettingsOverlay(claudeSettingsPath));
    throw error;
  }

  // The task ID transfers provider and cleanup ownership to the detached
  // watcher. From this point, follower/PID observation failures must not remove
  // files that a live provider still reads.
  agent._log(`📋 Agent ${agent.id}: Following zeroshot logs for ${taskId}`);
  await waitForTaskReady(agent, taskId);
  if (pendingLaunch?.cancelled) throw new Error(`Task launch cancelled: ${taskId}`);

  const MAX_PID_POLLS = 30;
  const PID_POLL_DELAY = 100;
  let realPid = null;
  let terminalBeforePidObservation = false;

  for (let i = 0; i < MAX_PID_POLLS; i++) {
    const taskInfo = getTask(taskId);
    if (taskInfo?.pid) {
      realPid = taskInfo.pid;
      break;
    }
    if (taskInfo && ['completed', 'failed', 'killed', 'stale'].includes(taskInfo.status)) {
      terminalBeforePidObservation = true;
      break;
    }
    await new Promise((r) => setTimeout(r, PID_POLL_DELAY));
  }

  if (pendingLaunch?.cancelled) throw new Error(`Task launch cancelled: ${taskId}`);

  if (realPid) {
    agent.processPid = realPid;
    agent._publishLifecycle('PROCESS_SPAWNED', { pid: realPid });
    agent._log(`📋 Agent ${agent.id}: Process PID: ${realPid}`);
  } else if (terminalBeforePidObservation) {
    agent._log(`📋 Agent ${agent.id}: Task finished before PID observation`);
  } else {
    agent._log(`⚠️ Agent ${agent.id}: PID not available (task may use non-standard watcher)`);
  }

  return followClaudeTaskLogs(agent, taskId);
}

function resolveAgentModelSpec(agent) {
  return agent._resolveModelSpec ? agent._resolveModelSpec() : { model: agent._selectModel() };
}

function resolveOutputFormatConfig(agent) {
  // CRITICAL: Default to strict schema validation to prevent cluster crashes from parse failures
  // strictSchema=true uses Claude CLI's native --json-schema enforcement (no streaming but guaranteed structure)
  // strictSchema=false uses stream-json with post-run validation (live logs but fragile)
  const desiredOutputFormat = agent.config.outputFormat || 'json';
  const strictSchema = agent.config.strictSchema !== false; // DEFAULT TO TRUE
  const runOutputFormat =
    agent.config.jsonSchema && desiredOutputFormat === 'json' && !strictSchema
      ? 'stream-json'
      : desiredOutputFormat;

  return { desiredOutputFormat, strictSchema, runOutputFormat };
}

function buildTaskRunArgs({ agent, providerName, modelSpec, runOutputFormat }) {
  const args = ['task', 'run', '--output-format', runOutputFormat, '--provider', providerName];
  const modelSpecSource = agent._resolveModelSpecSource
    ? agent._resolveModelSpecSource()
    : 'direct';
  appendTaskRunModelArgs(args, modelSpec, modelSpecSource);

  // Add verification mode flag if configured
  if (agent.config.verificationMode) {
    args.push('-v');
  }

  // Add JSON schema if specified in agent config.
  // If we are running stream-json for live logs (strictSchema=false), do NOT pass schema to CLI.
  if (agent.config.jsonSchema && runOutputFormat === 'json') {
    const schema = JSON.stringify(agent.config.jsonSchema);
    args.push('--json-schema', schema);
  }

  // MCP servers: explicitly forward the repo config through the task CLI.
  // Claude receives the path; providers such as Copilot receive inlined JSON
  // so it survives container path translation.
  for (const mcpArg of resolveMcpConfigArgs(agent, providerName)) {
    args.push(mcpArg);
  }

  const resumeSessionId = resolveAgentResumeSessionId(agent, providerName);
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  return args;
}

/**
 * Build the `--mcp-config` args for a task-run invocation, or [] when they don't apply.
 *
 * Claude receives the config path because its CLI supports `--mcp-config`.
 * Other providers whose adapter models an MCP config flag receive inlined
 * content so the identical value works under Docker isolation.
 */
function resolveMcpConfigArgs(agent, providerName) {
  const mcpPath = resolveRepoMcpConfigPath({
    cwd: agent.config?.cwd || process.cwd(),
    worktreePath: agent.worktree?.path || null,
  });
  if (!mcpPath) return [];

  if (providerName === 'claude') {
    const forwardedPath = agent.isolation?.enabled
      ? resolveContainerMcpConfigPath({
          cwd: agent.config?.cwd || process.cwd(),
          worktreePath: agent.worktree?.path || null,
        })
      : mcpPath;
    return forwardedPath ? ['--mcp-config', forwardedPath] : [];
  }
  if (!providerModelsMcpConfigFlag(providerName)) return [];

  const content = fs.readFileSync(mcpPath, 'utf8').trim();
  if (content.length === 0) return [];

  return ['--mcp-config', content];
}

/** True when the provider's adapter models an MCP config CLI flag (currently only Copilot). */
function providerModelsMcpConfigFlag(providerName) {
  const adapter = getProvider(providerName).adapter;
  return 'supportsMcpConfig' in adapter.detectCliFeatures('');
}

function maybeLogStreamJsonNotice(agent, runOutputFormat) {
  if (agent.config.jsonSchema && runOutputFormat !== 'json' && !agent.quiet) {
    agent._log(
      `[Agent ${agent.id}] jsonSchema configured; running stream-json for live logs (strictSchema=false). Schema will be validated after completion.`
    );
  }
}

function buildFinalContext({ agent, context, desiredOutputFormat, runOutputFormat }) {
  if (
    agent.config.jsonSchema &&
    desiredOutputFormat === 'json' &&
    runOutputFormat === 'stream-json'
  ) {
    return (
      context +
      `\n\n## Output Format (REQUIRED)\n\nReturn a JSON object that matches this schema exactly.\n\nSchema:\n\`\`\`json\n${JSON.stringify(
        agent.config.jsonSchema,
        null,
        2
      )}\n\`\`\`\n`
    );
  }

  return context;
}

function buildSpawnEnv(agent, providerName, modelSpec, options = {}) {
  const { claudeSettingsPath = null } = options;
  const spawnEnv = { ...process.env };
  const agentCwd = agent.config?.cwd || agent.worktree?.path || process.cwd();
  const clusterId = agent.cluster?.id || agent.cluster_id || process.env.ZEROSHOT_CLUSTER_ID;

  if (clusterId) {
    spawnEnv.ZEROSHOT_CLUSTER_ID = clusterId;
    const cmdproofRoot = path.join(os.homedir(), '.zeroshot', 'cmdproof', clusterId);
    if (!spawnEnv.CMDPROOF_CACHE_DIR) {
      spawnEnv.CMDPROOF_CACHE_DIR = path.join(cmdproofRoot, 'cache');
    }
    if (!spawnEnv.CMDPROOF_KEY_DIR) {
      spawnEnv.CMDPROOF_KEY_DIR = path.join(cmdproofRoot, 'keys');
    }
  }

  const commandProofs = Array.isArray(agent.config?.commandProofs)
    ? agent.config.commandProofs
    : agent.cluster?.commandProofs || [];
  if (commandProofs.length > 0) {
    spawnEnv.ZEROSHOT_COMMAND_PROOFS = JSON.stringify(commandProofs);
  }

  if (providerName === 'claude') {
    Object.assign(spawnEnv, buildClaudeEnv(modelSpec));
    if (claudeSettingsPath) {
      spawnEnv[CLAUDE_SETTINGS_ENV] = claudeSettingsPath;
    }

    // WORKTREE MODE: Activate git safety hook via environment variable
    if (agent.worktree?.enabled) {
      spawnEnv.ZEROSHOT_WORKTREE = '1';
    }
  }

  prependWorktreeToolBinToEnv(spawnEnv, {
    cwd: agentCwd,
    worktreePath: agent.worktree?.path || null,
  });

  return spawnEnv;
}

function parseTaskIdFromOutput(stdout) {
  const match = stdout.match(/Task spawned: ((?:task-)?[a-z]+-[a-z]+-[a-z0-9]+)/);
  return match ? match[1] : null;
}

const TASK_TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'stale']);

function assignDurableTaskId(agent, taskId) {
  if (!taskId || agent.currentTaskId === taskId) return;
  agent.currentTaskId = taskId;
  agent._publishLifecycle('TASK_ID_ASSIGNED', {
    pid: agent.processPid,
    taskId,
  });
}

function createPendingTaskLaunchHandle({
  agent,
  proc,
  ctPath,
  findPersistedTaskId,
  waitForWrapperClose,
  isWrapperClosed,
}) {
  let cancellation = null;
  const handle = {
    pendingLaunch: true,
    cancelled: false,
    kill(reason = 'Task killed') {
      handle.cancelled = true;
      if (cancellation) return cancellation;
      const cancellationAttempt = (async () => {
        let taskId = findPersistedTaskId();
        let commandError = null;
        let commandAttempted = false;
        const cancelTask = async (persistedTaskId) => {
          commandAttempted = true;
          assignDurableTaskId(agent, persistedTaskId);
          try {
            await runCommandWithTimeout(ctPath, ['kill', persistedTaskId], { timeout: 10000 });
          } catch (error) {
            commandError = error;
          }
        };
        if (taskId) await cancelTask(taskId);

        if (!isWrapperClosed()) {
          proc.kill('SIGKILL');
          await waitForWrapperClose;
        }

        taskId = taskId || findPersistedTaskId();
        if (taskId && !commandAttempted) await cancelTask(taskId);
        if (taskId && commandError === null) {
          const task = getTask(taskId);
          if (!task || !TASK_TERMINAL_STATUSES.has(task.status) || task.commandCleanup) {
            commandError = new Error(
              `Task ${taskId} termination and command cleanup were not confirmed`
            );
          }
        } else if (taskId) {
          const task = getTask(taskId);
          if (task && TASK_TERMINAL_STATUSES.has(task.status) && !task.commandCleanup) {
            commandError = null;
          }
        }

        if (commandError) {
          return { forced: false, reason: commandError.message };
        }
        agent._log?.(`Cancelled pending task launch${taskId ? ` ${taskId}` : ''}: ${reason}`);
        return { forced: true, taskId: taskId || null };
      })();
      cancellation = cancellationAttempt;
      cancellationAttempt.then(
        (termination) => {
          if (termination?.forced === false && cancellation === cancellationAttempt) {
            cancellation = null;
          }
        },
        () => {
          if (cancellation === cancellationAttempt) cancellation = null;
        }
      );
      return cancellationAttempt;
    },
  };
  return handle;
}

function spawnTaskProcess({
  agent,
  ctPath,
  args,
  cwd,
  spawnEnv,
  spawnTimeoutMs = 30000,
}) {
  // Timeout for spawn phase - if CLI hangs during init (e.g., opencode 429 bug), kill it.
  const SPAWN_TIMEOUT_MS = spawnTimeoutMs;
  // spawn() throws on null bytes in argv; strip them before they get there.
  const safeArgs = args.map((arg) => (typeof arg === 'string' ? arg.replace(/\0/g, '') : arg));
  const ownershipToken = createTaskSpawnOwnershipToken();
  const findPersistedTaskId = () => getTaskBySpawnOwnershipToken(ownershipToken)?.id || null;

  return new Promise((resolve, reject) => {
    const proc = spawn(ctPath, safeArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...spawnEnv, [TASK_SPAWN_OWNERSHIP_TOKEN_ENV]: ownershipToken },
      windowsHide: true,
    });

    let wrapperClosed = false;
    let resolveWrapperClose;
    const waitForWrapperClose = new Promise((resolveClose) => {
      resolveWrapperClose = resolveClose;
    });
    const markWrapperClosed = () => {
      if (wrapperClosed) return;
      wrapperClosed = true;
      resolveWrapperClose();
    };
    proc.once('close', markWrapperClosed);
    proc.once('error', markWrapperClosed);
    const pendingLaunch = createPendingTaskLaunchHandle({
      agent,
      proc,
      ctPath,
      findPersistedTaskId,
      waitForWrapperClose,
      isWrapperClosed: () => wrapperClosed,
    });
    agent.currentTask = pendingLaunch;

    // NOTE: Don't emit PROCESS_SPAWNED here - proc.pid is a wrapper that exits immediately.
    // Real PID comes from task store after watcher spawns the actual CLI process.
    // PROCESS_SPAWNED is emitted in spawnClaudeTask after waitForTaskReady + PID polling.

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let timeoutError = null;
    const classifyCleanupOwnership = trackTaskWrapperCleanupOwnership(findPersistedTaskId);
    const rejectWithOwnership = async (error) => {
      const classifiedError = classifyCleanupOwnership(error);
      if (
        !callerOwnsCommandCleanup(classifiedError) &&
        agent.currentTask === pendingLaunch
      ) {
        let termination;
        try {
          termination = await pendingLaunch.kill(classifiedError.message);
        } catch (cleanupError) {
          termination = { forced: false, reason: cleanupError.message };
        }
        if (termination?.forced === false) {
          classifiedError.message += ` Task cleanup was not confirmed: ${termination.reason}`;
          classifiedError.retainTaskHandle = true;
          classifiedError.permanent = true;
          classifiedError.restartExhausted = true;
          classifiedError.terminationExhausted = true;
          classifiedError.terminationAttempts = 1;
          classifiedError.taskId = agent.currentTaskId || null;
        } else if (agent.currentTask === pendingLaunch) {
          agent.currentTask = null;
          agent.currentTaskId = null;
          agent.processPid = null;
          agent.lastOutputTime = null;
          agent.taskStartedAt = null;
        }
      } else if (wrapperClosed && agent.currentTask === pendingLaunch) {
        agent.currentTask = null;
      }
      reject(classifiedError);
    };

    // CRITICAL: Timeout to prevent infinite hang if provider CLI hangs
    const spawnTimeout = setTimeout(() => {
      if (resolved) return;
      timeoutError = new Error(
        `Spawn timeout after ${SPAWN_TIMEOUT_MS / 1000}s - provider CLI hung. ` +
          `stdout: ${stdout.slice(-500)}, stderr: ${stderr.slice(-500)}`
      );
      proc.kill('SIGKILL');
    }, SPAWN_TIMEOUT_MS);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', async (code, signal) => {
      clearTimeout(spawnTimeout);
      if (resolved) return;
      resolved = true;
      if (timeoutError) {
        await rejectWithOwnership(timeoutError);
        return;
      }
      // Handle process killed by signal (e.g., SIGTERM, SIGKILL, SIGSTOP)
      if (signal) {
        await rejectWithOwnership(
          new Error(`Process killed by signal ${signal}${stderr ? `: ${stderr}` : ''}`)
        );
        return;
      }

      let spawnedTaskId;
      try {
        spawnedTaskId = requireTaskIdFromWrapperResult({
          code,
          stdout,
          stderr,
          parseTaskId: parseTaskIdFromOutput,
          persistedTaskId: findPersistedTaskId(),
        });
      } catch (error) {
        await rejectWithOwnership(error);
        return;
      }

      assignDurableTaskId(agent, spawnedTaskId);

      // Start liveness monitoring
      if (agent.enableLivenessCheck) {
        agent.taskStartedAt = Date.now();
        agent.lastOutputTime = agent.taskStartedAt;
        agent._startLivenessCheck();
      }

      resolve(spawnedTaskId);
    });

    proc.on('error', (error) => {
      clearTimeout(spawnTimeout);
      if (resolved) return;
      resolved = true;
      rejectWithOwnership(error);
    });
  });
}

/**
 * Wait for task to be registered in ct storage
 * @param {Object} agent - Agent instance
 * @param {String} taskId - Task ID to wait for
 * @param {Number} maxRetries - Max retries (default 10)
 * @param {Number} delayMs - Delay between retries (default 200)
 * @returns {Promise<void>}
 */
async function waitForTaskReady(agent, taskId, maxRetries = 10, delayMs = 200) {
  const ctPath = getClaudeTasksPath();

  for (let i = 0; i < maxRetries; i++) {
    let exists = false;
    try {
      const { stdout } = await runCommandWithTimeout(ctPath, ['status', taskId], { timeout: 5000 });
      exists = !stdout.includes('Task not found');
    } catch {
      // Timeout or error - task not ready yet
    }

    if (exists) return;

    // Wait before retry
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // FAIL FAST: Task not found after retries = unrecoverable error
  // Continuing with a non-existent task causes 30s of pointless polling then crash
  throw new Error(
    `Task ${taskId} not found after ${maxRetries} retries (${maxRetries * delayMs}ms). ` +
      `Task spawn may have failed silently. Check zeroshot task run output.`
  );
}

const MAX_STATUS_FAILURES = 30;

function createLogFollowState() {
  return {
    output: '',
    logFilePath: null,
    lastSize: 0,
    pollInterval: null,
    statusCheckInterval: null,
    resolved: false,
    lineBuffer: '',
    consecutiveExecFailures: 0,
  };
}

function lookupLogFilePath(ctPath, taskId) {
  try {
    return runCommandSync(ctPath, ['get-log-path', taskId], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function parseTimestampedLine(line) {
  let timestamp = Date.now();
  let content = line.replace(/\r$/, '');

  const timestampMatch = content.match(/^\[(\d{13})\](.*)$/);
  if (timestampMatch) {
    timestamp = parseInt(timestampMatch[1], 10);
    content = timestampMatch[2];
  }

  return { timestamp, content };
}

function shouldSkipLogLine(content) {
  return (
    content.startsWith('===') ||
    content.startsWith('Finished:') ||
    content.startsWith('Exit code:') ||
    (content.includes('"type":"system"') && content.includes('"subtype":"init"'))
  );
}

function isValidJsonLine(content) {
  if (!content.trim().startsWith('{')) {
    return false;
  }

  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

function broadcastAgentLine({ agent, providerName, state, line }) {
  if (!line.trim()) return;

  const { timestamp, content } = parseTimestampedLine(line);
  if (shouldSkipLogLine(content)) {
    return;
  }

  const isValidJson = isValidJsonLine(content);
  state.output += content + '\n';

  agent.lastOutputTime = Date.now();

  agent._publish({
    topic: 'AGENT_OUTPUT',
    receiver: 'broadcast',
    metadata: buildRawLogOnlyMetadata(),
    timestamp,
    content: {
      text: content,
      data: {
        type: isValidJson ? 'json' : 'text',
        line: content,
        agent: agent.id,
        role: agent.role,
        iteration: agent.iteration,
        provider: providerName,
      },
    },
  });
}

function appendContentToBuffer(state, content, onLine) {
  state.lineBuffer += content;
  const lines = state.lineBuffer.split('\n');

  for (let i = 0; i < lines.length - 1; i++) {
    onLine(lines[i]);
  }

  state.lineBuffer = lines[lines.length - 1];
}

function pollLogFileForUpdates({ agent, fsModule, ctPath, taskId, state, onNewContent }) {
  if (!state.logFilePath) {
    const logFilePath = lookupLogFilePath(ctPath, taskId);
    if (!logFilePath) {
      return;
    }
    state.logFilePath = logFilePath;
    agent._log(`📋 Agent ${agent.id}: Found log file: ${logFilePath}`);
  }

  if (!fsModule.existsSync(state.logFilePath)) {
    return;
  }

  try {
    const stats = fsModule.statSync(state.logFilePath);
    const currentSize = stats.size;

    if (currentSize > state.lastSize) {
      const fd = fsModule.openSync(state.logFilePath, 'r');
      const buffer = Buffer.alloc(currentSize - state.lastSize);
      fsModule.readSync(fd, buffer, 0, buffer.length, state.lastSize);
      fsModule.closeSync(fd);

      onNewContent(buffer.toString('utf-8'));
      state.lastSize = currentSize;
    }
  } catch (err) {
    const error = /** @type {Error} */ (err);
    console.warn(`⚠️ Agent ${agent.id}: Error reading log: ${error.message}`);
  }
}

function stripAnsiCodes(value) {
  const ansiPattern = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
  return value.replace(ansiPattern, '');
}

function parseStatusFlags(cleanStdout) {
  return {
    isCompleted: /Status:\s+completed/i.test(cleanStdout),
    isFailed: /Status:\s+failed/i.test(cleanStdout),
    isStale: /Status:\s+stale/i.test(cleanStdout),
    isKilled: /Status:\s+killed/i.test(cleanStdout),
  };
}

function determineStaleSuccess({ agent, output, providerName, taskId }) {
  if (!output) {
    return false;
  }

  const hasStructuredOutput = /"structured_output"\s*:/.test(output);
  const hasSuccessResult = /"subtype"\s*:\s*"success"/.test(output);
  let hasParsedOutput = false;

  try {
    const { extractJsonFromOutput } = require('./output-extraction');
    hasParsedOutput = !!extractJsonFromOutput(output, providerName);
  } catch {
    // Ignore extraction errors - fallback to other signals
  }

  const success = hasStructuredOutput || hasSuccessResult || hasParsedOutput;
  if (!agent.quiet) {
    agent._log(
      `[Agent ${agent.id}] Task ${taskId} is stale - recovered as ${success ? 'SUCCESS' : 'FAILURE'} based on output analysis`
    );
  }

  return success;
}

function requiresStructuredResult(agent) {
  const outputFormat = agent?.config?.outputFormat || 'json';
  return outputFormat !== 'text' || !!agent?.config?.jsonSchema;
}

async function evaluateStructuredSuccess({ agent, taskId, state, success }) {
  if (!success || !requiresStructuredResult(agent)) {
    return { success, error: null };
  }
  try {
    await agent._parseResultOutput(state.output);
    return { success: true, error: null };
  } catch (error) {
    const errorContext = sanitizeErrorMessage(error.message);
    console.warn(
      `[Agent ${agent.id}] Task ${taskId} reported completed but produced invalid structured output; ` +
        `treating task as failed: ${errorContext}`
    );
    return { success: false, error: errorContext };
  }
}

function buildFailureContext({ agent, taskId, providerName, state, stdout }) {
  return extractErrorContext({
    output: state.output,
    statusOutput: stdout,
    taskId,
    debug: {
      agentId: agent.id,
      providerName,
      pid: agent.processPid,
      cwd: agent.config.cwd || process.cwd(),
      worktreePath: agent.worktree?.path || null,
      isolation: !!agent.isolation?.enabled,
      logFilePath: state.logFilePath || null,
    },
  });
}

async function buildCompletionResult({
  agent,
  taskId,
  providerName,
  state,
  stdout,
  success,
  taskInfo = getTask(taskId),
}) {
  const classified = await evaluateStructuredSuccess({ agent, taskId, state, success });
  const resumeIdentityError = classified.success ? validateCompletedResumeIdentity(taskInfo) : null;
  if (resumeIdentityError) {
    classified.success = false;
    classified.error = resumeIdentityError;
  }
  const vertexModelError =
    providerName === 'claude'
      ? extractClaudeVertexModelError(state.output, {
          useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
        })
      : null;
  if (vertexModelError) {
    classified.success = false;
  }
  let errorContext = classified.error;
  if (!errorContext && !classified.success) {
    errorContext = buildFailureContext({ agent, taskId, providerName, state, stdout });
  }

  return {
    success: classified.success,
    output: state.output,
    error: errorContext,
    tokenUsage: extractTokenUsage(state.output, providerName),
    providerSession: providerSessionFromCompletedTask({
      agent,
      providerName,
      taskInfo,
      logicalSuccess: classified.success,
    }),
    vertexModelError,
  };
}

function finalizeLogFollow(agent, state) {
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
  }
  if (state.statusCheckInterval) {
    clearInterval(state.statusCheckInterval);
  }
  agent.currentTask = null;
}

function handleStatusExecError({ agent, state, ctPath, taskId, error, stderr, resolve }) {
  if (!error) {
    return false;
  }

  // CRITICAL: "ID not found" means task completed or was removed - FAIL-SAFE by restarting
  // We have zero confidence about what happened:
  // - Task may have completed successfully
  // - Task may have failed and been cleaned up
  // - Task may have been manually killed
  // - Zeroshot storage may be corrupted
  // With zero confidence → restart is safer than assuming success
  const errorMessage = error.message || '';
  const stderrMessage = stderr || '';
  const isNotFound =
    errorMessage.includes('ID not found') ||
    errorMessage.includes('Not found in tasks') ||
    stderrMessage.includes('ID not found') ||
    stderrMessage.includes('Not found in tasks');

  if (isNotFound) {
    console.warn(
      `[Agent ${agent.id}] ⚠️ Task ${taskId} not found - will restart to ensure completion`
    );

    if (!state.resolved) {
      state.resolved = true;
      finalizeLogFollow(agent, state);

      agent._publish({
        topic: 'AGENT_ERROR',
        receiver: 'broadcast',
        content: {
          text: `Task ${taskId} not found - restarting for safety`,
          data: {
            taskId,
            error: 'task_not_found',
            role: agent.role,
            iteration: agent.iteration,
          },
        },
      });

      resolve({
        success: false,
        output: state.output,
        error: `Task not found - restarting for safety`,
      });
    }

    return true;
  }

  state.consecutiveExecFailures++;
  if (state.consecutiveExecFailures < MAX_STATUS_FAILURES) {
    return true;
  }

  console.error(
    `[Agent ${agent.id}] ⚠️ Status polling failed ${MAX_STATUS_FAILURES} times consecutively! STOPPING.`
  );
  console.error(`  Command: ${ctPath} status ${taskId}`);
  console.error(`  Error: ${error.message}`);
  console.error(`  Stderr: ${stderr || 'none'}`);
  console.error(`  This may indicate zeroshot is not in PATH or task storage is corrupted.`);

  if (!state.resolved) {
    state.resolved = true;
    finalizeLogFollow(agent, state);

    agent._publish({
      topic: 'AGENT_ERROR',
      receiver: 'broadcast',
      content: {
        text: `Task ${taskId} polling failed after ${MAX_STATUS_FAILURES} consecutive failures`,
        data: {
          taskId,
          error: 'polling_timeout',
          attempts: state.consecutiveExecFailures,
          role: agent.role,
          iteration: agent.iteration,
        },
      },
    });

    resolve({
      success: false,
      output: state.output,
      error: `Status polling failed ${MAX_STATUS_FAILURES} times - task may not exist`,
    });
  }

  return true;
}

function handleStatusCompletion({
  agent,
  taskId,
  providerName,
  state,
  stdout,
  pollLogFile,
  resolve,
}) {
  const cleanStdout = stripAnsiCodes(stdout);
  const { isCompleted, isFailed, isStale, isKilled } = parseStatusFlags(cleanStdout);

  if (!isCompleted && !isFailed && !isStale && !isKilled) {
    return false;
  }

  pollLogFile();

  let success = isCompleted;
  if (isStale) {
    success = determineStaleSuccess({ agent, output: state.output, providerName, taskId });
  }

  setTimeout(() => {
    if (state.resolved) return;
    state.resolved = true;

    finalizeLogFollow(agent, state);

    buildCompletionResult({
      agent,
      taskId,
      providerName,
      state,
      stdout,
      success,
    })
      .then(resolve)
      .catch((error) => {
        resolve({
          success: false,
          output: state.output,
          error: sanitizeErrorMessage(error.message),
          tokenUsage: extractTokenUsage(state.output, providerName),
        });
      });
  }, 500);

  return true;
}

function buildKillHandler({ agent, taskId, state, providerName, resolve }) {
  return {
    kill: (reason = 'Task killed', details = {}) => {
      if (state.resolved) return;
      state.resolved = true;
      finalizeLogFollow(agent, state);
      agent._stopLivenessCheck();
      resolve({
        success: false,
        output: state.output,
        error: reason,
        code: details.code || null,
        taskId,
        tokenUsage: extractTokenUsage(state.output, providerName),
      });
    },
  };
}

function createLogFollower({ agent, taskId, fsModule, ctPath, providerName }) {
  return new Promise((resolve) => {
    const state = createLogFollowState();

    state.logFilePath = lookupLogFilePath(ctPath, taskId);
    if (state.logFilePath) {
      agent._log(`📋 Agent ${agent.id}: Following ct logs for ${taskId}`);
    } else {
      agent._log(`⏳ Agent ${agent.id}: Waiting for log file...`);
    }

    const broadcastLine = (line) => broadcastAgentLine({ agent, providerName, state, line });
    const processNewContent = (content) => appendContentToBuffer(state, content, broadcastLine);
    const pollLogFile = () =>
      pollLogFileForUpdates({
        agent,
        fsModule,
        ctPath,
        taskId,
        state,
        onNewContent: processNewContent,
      });

    state.pollInterval = setInterval(pollLogFile, 300);

    state.statusCheckInterval = setInterval(() => {
      runCommandWithTimeout(
        ctPath,
        ['status', taskId],
        { timeout: 5000 },
        (error, stdout, stderr) => {
          if (state.resolved) return;

          if (handleStatusExecError({ agent, state, ctPath, taskId, error, stderr, resolve })) {
            return;
          }

          state.consecutiveExecFailures = 0;
          handleStatusCompletion({
            agent,
            taskId,
            providerName,
            state,
            stdout,
            pollLogFile,
            resolve,
          });
        }
      );
    }, 1000);

    agent.currentTask = buildKillHandler({ agent, taskId, state, providerName, resolve });
  });
}

/**
 * Follow claude-zeroshots logs until completion, streaming to message bus
 * Reads log file directly for reliable streaming
 * @param {Object} agent - Agent instance
 * @param {String} taskId - Task ID to follow
 * @returns {Promise<Object>} Result object { success, output, error }
 */
function followClaudeTaskLogs(agent, taskId) {
  const fsModule = require('fs');
  const ctPath = getClaudeTasksPath();
  const providerName = agent._resolveProvider ? agent._resolveProvider() : 'claude';

  return createLogFollower({ agent, taskId, fsModule, ctPath, providerName });
}

// Cache zeroshot path at module load time (when PATH is correct)
let _cachedZeroshotPath = null;
function _resolveZeroshotPath() {
  if (_cachedZeroshotPath) return _cachedZeroshotPath;

  try {
    // Use safe execSync (already imported at top) with explicit PATH
    const fullPath = runCommandSync('which', ['zeroshot'], {
      encoding: 'utf8',
      env: { ...process.env }, // Pass current process's PATH
    }).trim();
    if (fullPath) {
      _cachedZeroshotPath = fullPath;
      return fullPath;
    }
  } catch {
    // which failed, fall back to bare command
  }
  _cachedZeroshotPath = 'zeroshot';
  return 'zeroshot';
}

/**
 * Get path to claude-zeroshots executable
 * @returns {String} Path to zeroshot command
 */
function getClaudeTasksPath() {
  return _resolveZeroshotPath();
}

/**
 * Spawn claude-zeroshots inside Docker container (isolation mode)
 * Runs Claude CLI inside the container for full isolation
 * @param {Object} agent - Agent instance
 * @param {String} context - Context to pass to Claude
 * @returns {Promise<Object>} Result object { success, output, error }
 */
async function spawnClaudeTaskIsolated(agent, context) {
  const { manager, clusterId } = agent.isolation;
  const providerName = agent._resolveProvider ? agent._resolveProvider() : 'claude';
  const modelSpec = resolveAgentModelSpec(agent);
  const modelSpecSource = agent._resolveModelSpecSource
    ? agent._resolveModelSpecSource()
    : 'direct';

  agent._log(`📦 Agent ${agent.id}: Running task in isolated container using zeroshot task run...`);

  const { desiredOutputFormat, runOutputFormat } = resolveOutputFormatConfig(agent);
  let command = [
    'zeroshot',
    ...buildTaskRunArgs({
      agent,
      providerName,
      modelSpec,
      runOutputFormat,
    }),
  ];
  maybeLogStreamJsonNotice(agent, runOutputFormat);
  const finalContext = buildFinalContext({
    agent,
    context,
    desiredOutputFormat,
    runOutputFormat,
  });

  command.push(finalContext);
  command = wrapTaskRunWithIsolatedSettings(command, {
    providerName,
    settings: loadSettings(),
    modelSpecSource,
    modelSpec,
  });

  // STEP 1: Spawn task and extract task ID (same as non-isolated mode)
  // Timeout for spawn phase - if CLI hangs during init (e.g., opencode 429 bug), kill it
  const SPAWN_TIMEOUT_MS = agent.spawnTimeoutMs ?? 30000;
  const ownershipToken = createTaskSpawnOwnershipToken();
  // Auth env vars are injected by IsolationManager; the launch token is the
  // only authoritative bridge back to the detached task row in the container.
  const isolatedEnv = {
    ...(providerName === 'claude' ? buildClaudeEnv(modelSpec, { includeAuth: false }) : {}),
    [TASK_SPAWN_OWNERSHIP_TOKEN_ENV]: ownershipToken,
  };

  let isolatedPendingLaunch = null;
  const taskId = await new Promise((resolve, reject) => {
    const proc = manager.spawnInContainer(clusterId, command, {
      env: isolatedEnv,
    });

    let isolatedTaskId = null;
    let wrapperClosed = false;
    let resolveWrapperClose;
    let stdout = '';
    let stderr = '';
    let resolved = false;
    let timeoutError = null;
    let spawnTimeout = null;
    let cancellation = null;
    const waitForWrapperClose = new Promise((resolveClose) => {
      resolveWrapperClose = resolveClose;
    });
    const markWrapperClosed = () => {
      if (!wrapperClosed) {
        wrapperClosed = true;
        resolveWrapperClose();
      }
    };
    const findPersistedTaskId = async () => {
      const persistedTaskId = await resolveIsolatedTaskIdBySpawnToken(
        manager,
        clusterId,
        ownershipToken
      );
      if (persistedTaskId) {
        isolatedTaskId = persistedTaskId;
        assignDurableTaskId(agent, persistedTaskId);
      }
      return persistedTaskId;
    };
    const rejectLaunch = (error, { retainHandle = false } = {}) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(spawnTimeout);
      const rejection = error instanceof Error ? error : new Error(String(error));
      if (retainHandle) {
        rejection.retainTaskHandle = true;
        rejection.permanent = true;
        rejection.restartExhausted = true;
        rejection.terminationExhausted = true;
        rejection.terminationAttempts = 1;
        rejection.taskId = isolatedTaskId || agent.currentTaskId || null;
      } else if (agent.currentTask === isolatedPendingLaunch) {
        agent.currentTask = null;
      }
      reject(rejection);
    };

    proc.once('close', markWrapperClosed);
    proc.once('error', markWrapperClosed);
    isolatedPendingLaunch = {
      pendingLaunch: true,
      cancelled: false,
      async kill(reason = 'Task killed') {
        isolatedPendingLaunch.cancelled = true;
        if (cancellation) return cancellation;
        cancellation = (async () => {
          let termination = null;
          let commandError = null;
          try {
            const persistedTaskId = isolatedTaskId || (await findPersistedTaskId());
            if (persistedTaskId) {
              termination = await terminateIsolatedTask(manager, clusterId, persistedTaskId);
            }
          } catch (error) {
            commandError = error;
          }

          if (!wrapperClosed) {
            proc.kill('SIGKILL');
            await waitForWrapperClose;
          }

          try {
            const persistedTaskId = isolatedTaskId || (await findPersistedTaskId());
            if (persistedTaskId && !termination) {
              termination = await terminateIsolatedTask(manager, clusterId, persistedTaskId);
              commandError = null;
            }
          } catch (error) {
            commandError ||= error;
          }

          if (commandError) {
            return { forced: false, reason: commandError.message };
          }
          agent._log?.(`Cancelled pending isolated task launch: ${reason}`);
          return termination
            ? { ...termination, forced: true, taskId: isolatedTaskId }
            : { forced: true, taskId: null };
        })();

        const termination = await cancellation;
        if (termination?.forced === false) cancellation = null;
        if (!resolved) {
          const error =
            timeoutError ||
            new Error(
              termination?.forced === false
                ? `Task launch cancellation was not confirmed: ${termination.reason}`
                : `Task launch cancelled: ${isolatedTaskId || 'before persistence'}`
            );
          rejectLaunch(error, { retainHandle: termination?.forced === false });
        }
        return termination;
      },
    };
    agent.currentTask = isolatedPendingLaunch;

    // Track PID for resource monitoring
    agent.processPid = proc.pid;
    agent._publishLifecycle('PROCESS_SPAWNED', { pid: proc.pid });

    // CRITICAL: Timeout to prevent infinite hang if provider CLI hangs. Timeout
    // uses the same cancellation path so a durable child cannot outlive it.
    spawnTimeout = setTimeout(() => {
      if (resolved) return;
      timeoutError = new Error(
        `Spawn timeout after ${SPAWN_TIMEOUT_MS / 1000}s - provider CLI hung. ` +
          `stdout: ${stdout.slice(-500)}, stderr: ${stderr.slice(-500)}`
      );
      isolatedPendingLaunch.kill(timeoutError.message).catch((error) => {
        rejectLaunch(error, { retainHandle: true });
      });
    }, SPAWN_TIMEOUT_MS);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', async (code, signal) => {
      clearTimeout(spawnTimeout);
      if (resolved || isolatedPendingLaunch.cancelled) return;
      if (signal) {
        await isolatedPendingLaunch.kill(
          `Process killed by signal ${signal}${stderr ? `: ${stderr}` : ''}`
        );
        return;
      }

      try {
        const persistedTaskId = await findPersistedTaskId();
        const spawnedTaskId = requireTaskIdFromWrapperResult({
          code,
          stdout,
          stderr,
          parseTaskId: parseTaskIdFromOutput,
          persistedTaskId,
        });
        isolatedTaskId = spawnedTaskId;
        assignDurableTaskId(agent, spawnedTaskId);
        resolved = true;
        resolve(spawnedTaskId);
      } catch (error) {
        const termination = await isolatedPendingLaunch.kill(error.message);
        if (!resolved) {
          rejectLaunch(error, { retainHandle: termination?.forced === false });
        }
      }
    });

    proc.on('error', async (error) => {
      clearTimeout(spawnTimeout);
      if (resolved || isolatedPendingLaunch.cancelled) return;
      const termination = await isolatedPendingLaunch.kill(error.message);
      if (termination?.forced === false && !resolved) {
        rejectLaunch(error, { retainHandle: true });
      }
    });
  });
  if (isolatedPendingLaunch?.cancelled) throw new Error(`Task launch cancelled: ${taskId}`);

  agent._log(`📋 Agent ${agent.id}: Following zeroshot logs for ${taskId} in container...`);

  // STEP 2: Install the lifecycle-owned handle before liveness monitoring can
  // observe the task, then follow the task's log file inside the container.
  const execution = followClaudeTaskLogsIsolated(agent, taskId);
  if (agent.enableLivenessCheck) {
    agent.taskStartedAt = Date.now();
    agent.lastOutputTime = agent.taskStartedAt;
    agent._startLivenessCheck();
  }
  return execution;
}

/**
 * Follow task logs inside Docker container (isolated mode)
 * Reads task log file inside container and streams JSON lines to message bus
 * @param {Object} agent - Agent instance with isolation context
 * @param {String} taskId - Task ID to follow
 * @returns {Promise<Object>} Result object
 * @private
 */
/**
 * Follow Claude task logs in isolated container using persistent tail -f stream
 * Issue #23: Persistent log streaming instead of polling (10-20% latency reduction)
 *
 * OLD APPROACH (removed):
 * - Polled every 500ms with 2-3 docker exec calls per poll
 * - Each docker exec = ~100-200ms overhead
 * - Total: 300-400ms latency per poll cycle
 *
 * NEW APPROACH:
 * - Single persistent `tail -f` stream via spawnInContainer()
 * - Lines arrive in real-time as they're written
 * - Status checks reduced to every 2 seconds (not every poll)
 * - Result: 10-20% overall latency reduction
 */
function createIsolatedLogState() {
  return {
    taskExited: false,
    resolved: false,
    terminationPromise: null,
    lifecycleHandle: null,
    logFilePath: null,
    fullOutput: '',
    tailProcess: null,
    statusCheckInterval: null,
    timeoutTimer: null,
    lineBuffer: '',
  };
}

function buildIsolatedCleanup(state) {
  return () => {
    if (state.tailProcess) {
      try {
        state.tailProcess.kill('SIGTERM');
      } catch {
        // Ignore - process may already be dead
      }
      state.tailProcess = null;
    }
    if (state.statusCheckInterval) {
      clearInterval(state.statusCheckInterval);
      state.statusCheckInterval = null;
    }
    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = null;
    }
  };
}

function clearIsolatedLifecycleHandle(agent, state) {
  if (agent.currentTask === state.lifecycleHandle) {
    agent.currentTask = null;
  }
  agent._stopLivenessCheck?.();
}

function settleIsolatedFollower({ agent, state, cleanup, resolve, result }) {
  if (state.resolved) return;
  state.resolved = true;
  state.taskExited = true;
  cleanup();
  clearIsolatedLifecycleHandle(agent, state);
  resolve(result);
}

function rejectIsolatedFollower({ agent, state, cleanup, reject, error }) {
  if (state.resolved) return;
  state.resolved = true;
  state.taskExited = true;
  cleanup();
  clearIsolatedLifecycleHandle(agent, state);
  reject(error);
}

async function resolveIsolatedTaskIdBySpawnToken(manager, clusterId, ownershipToken) {
  const result = await manager.execInContainer(clusterId, [
    'zeroshot',
    'get-task-id-by-spawn-token',
    ownershipToken,
  ]);
  if (result.code === 2) return null;
  if (result.code !== 0) {
    throw new Error(
      `Failed to resolve isolated task ownership: ${result.stderr || result.stdout || `exit ${result.code}`}`
    );
  }
  const taskId = result.stdout.trim();
  if (!taskId) {
    throw new Error('Isolated task ownership lookup returned an empty task ID');
  }
  return taskId;
}

function parseIsolatedStatus(output) {
  return output.match(/Status:\s+(completed|failed|killed|stale|cancelled)/i)?.[1].toLowerCase();
}

async function terminateIsolatedTask(manager, clusterId, taskId) {
  const before = await manager.execInContainer(clusterId, ['zeroshot', 'status', taskId]);
  const beforeStatus = before.code === 0 ? parseIsolatedStatus(before.stdout) : null;
  const result = await manager.execInContainer(clusterId, ['zeroshot', 'kill', taskId]);
  if (result.code !== 0) {
    throw new Error(
      `Failed to terminate isolated task ${taskId}: ${result.stderr || result.stdout || `exit ${result.code}`}`
    );
  }

  const status = await manager.execInContainer(clusterId, ['zeroshot', 'status', taskId]);
  const afterStatus = status.code === 0 ? parseIsolatedStatus(status.stdout) : null;
  if (!afterStatus) {
    throw new Error(
      `Failed to confirm isolated task ${taskId} after cleanup recovery: ${
        status.stderr || status.stdout || `exit ${status.code}`
      }`
    );
  }

  return {
    alreadyTerminal: Boolean(beforeStatus),
    forced: !beforeStatus && afterStatus === 'killed',
    status: beforeStatus || afterStatus,
  };
}

async function resolveIsolatedLogFilePath(manager, clusterId, taskId, state) {
  if (state.logFilePath) return state.logFilePath;

  const result = await manager.execInContainer(clusterId, [
    'sh',
    '-c',
    `zeroshot get-log-path ${taskId}`,
  ]);
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(
      `Failed to get log path for ${taskId} inside container: ${result.stderr || result.stdout}`
    );
  }
  state.logFilePath = result.stdout.trim();
  return state.logFilePath;
}

function settleIsolatedTerminalStatus({
  agent,
  manager,
  clusterId,
  taskId,
  providerName,
  status,
  isNotFound = false,
  state,
  cleanup,
  resolve,
  reject,
  onLine,
}) {
  if (state.resolved) return Promise.resolve();
  if (state.terminalSettlementPromise) return state.terminalSettlementPromise;

  state.taskExited = true;
  const settlement = (async () => {
    const logFilePath = await resolveIsolatedLogFilePath(manager, clusterId, taskId, state);
    await new Promise((settle) => setTimeout(settle, 200));
    const finalReadResult = await manager.execInContainer(clusterId, [
      'sh',
      '-c',
      `cat "${logFilePath}" 2>/dev/null || echo ""`,
    ]);

    if (finalReadResult.code === 0 && finalReadResult.stdout) {
      state.fullOutput = finalReadResult.stdout;
      for (const line of state.fullOutput.split('\n')) {
        if (line.trim()) onLine(line);
      }
    }

    const vertexModelError =
      providerName === 'claude'
        ? extractClaudeVertexModelError(state.fullOutput, {
            useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
          })
        : null;
    const success = status === 'completed' && !vertexModelError;
    const errorContext = !success
      ? extractErrorContext({
          output: state.fullOutput,
          statusOutput: status ? `Status: ${status}` : '',
          taskId,
          isNotFound,
          debug: {
            agentId: agent.id,
            providerName,
            pid: agent.processPid,
            cwd: agent.config.cwd || process.cwd(),
            worktreePath: agent.worktree?.path || null,
            isolation: true,
            clusterId,
            logFilePath,
          },
        })
      : null;
    const parsedResult = vertexModelError ? null : await agent._parseResultOutput(state.fullOutput);

    settleIsolatedFollower({
      agent,
      state,
      cleanup,
      resolve,
      result: {
        success,
        output: state.fullOutput,
        taskId,
        result: parsedResult,
        error: errorContext,
        tokenUsage: extractTokenUsage(state.fullOutput, providerName),
        vertexModelError,
      },
    });
  })().catch((error) => {
    rejectIsolatedFollower({ agent, state, cleanup, reject, error });
  });
  state.terminalSettlementPromise = settlement;
  return settlement;
}

function buildIsolatedLifecycleHandle({
  agent,
  manager,
  clusterId,
  taskId,
  providerName,
  state,
  cleanup,
  resolve,
  reject,
  onLine,
}) {
  const terminate = (reason = 'Task killed', details = {}) => {
    if (state.resolved || state.taskExited) return;
    if (state.terminationPromise) return state.terminationPromise;

    const terminationPromise = (async () => {
      const termination = await terminateIsolatedTask(manager, clusterId, taskId);
      if (!termination.forced) {
        await settleIsolatedTerminalStatus({
          agent,
          manager,
          clusterId,
          taskId,
          providerName,
          status: termination.status,
          state,
          cleanup,
          resolve,
          reject,
          onLine,
        });
        return termination;
      }

      settleIsolatedFollower({
        agent,
        state,
        cleanup,
        resolve,
        result: {
          success: false,
          output: state.fullOutput,
          error: reason,
          code: details.code || null,
          taskId,
          tokenUsage: extractTokenUsage(state.fullOutput, providerName),
        },
      });
      return termination;
    })();
    state.terminationPromise = terminationPromise;
    terminationPromise.catch(() => {
      if (state.terminationPromise === terminationPromise) {
        state.terminationPromise = null;
      }
    });

    return terminationPromise;
  };

  return {
    isolated: true,
    terminate,
    kill: terminate,
    failClosed(error) {
      rejectIsolatedFollower({ agent, state, cleanup, reject, error });
    },
  };
}

function broadcastIsolatedLine({ agent, providerName, taskId, line }) {
  const timestampMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s*(.*)$/);
  const timestamp = timestampMatch ? new Date(timestampMatch[1]).getTime() : Date.now();
  const content = timestampMatch ? timestampMatch[2] : line;

  agent.messageBus.publish({
    cluster_id: agent.cluster.id,
    topic: 'AGENT_OUTPUT',
    sender: agent.id,
    metadata: buildRawLogOnlyMetadata(),
    content: {
      data: {
        line: content,
        taskId,
        iteration: agent.iteration,
        provider: providerName,
      },
    },
    timestamp,
  });

  agent.lastOutputTime = Date.now();
}

function appendIsolatedContent(state, content, onLine) {
  state.lineBuffer += content;
  const lines = state.lineBuffer.split('\n');

  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim()) {
      onLine(lines[i]);
    }
  }

  state.lineBuffer = lines[lines.length - 1];
}

function startIsolatedTail({ agent, manager, clusterId, logFilePath, state, onLine }) {
  state.tailProcess = manager.spawnInContainer(clusterId, [
    'sh',
    '-c',
    `while [ ! -f "${logFilePath}" ]; do sleep 0.1; done; tail -F -n +1 "${logFilePath}"`,
  ]);

  state.tailProcess.stdout.on('data', (data) => {
    const chunk = data.toString();
    state.fullOutput += chunk;
    appendIsolatedContent(state, chunk, onLine);
  });

  state.tailProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('file truncated')) {
      agent._log(`[${agent.id}] tail stderr: ${msg}`);
    }
  });

  state.tailProcess.on('close', (exitCode) => {
    if (!state.taskExited) {
      agent._log(`[${agent.id}] tail process exited with code ${exitCode}`);
    }
  });

  state.tailProcess.on('error', (err) => {
    agent._log(`[${agent.id}] tail process error: ${err.message}`);
  });
}

async function checkIsolatedStatus({
  agent,
  manager,
  clusterId,
  logFilePath,
  taskId,
  providerName,
  state,
  cleanup,
  resolve,
  reject,
  onLine,
}) {
  if (state.taskExited) return;

  const statusResult = await manager.execInContainer(clusterId, [
    'sh',
    '-c',
    `zeroshot status ${taskId} 2>/dev/null || echo "not_found"`,
  ]);

  const statusOutput = statusResult.stdout;
  const status = parseIsolatedStatus(statusOutput);
  const isNotFound = statusOutput.includes('not_found');

  if (!status && !isNotFound) {
    return;
  }

  state.logFilePath = logFilePath;
  await settleIsolatedTerminalStatus({
    agent,
    manager,
    clusterId,
    taskId,
    providerName,
    status,
    isNotFound,
    state,
    cleanup,
    resolve,
    reject,
    onLine,
  });
}

function startIsolatedStatusChecks({
  agent,
  manager,
  clusterId,
  logFilePath,
  taskId,
  providerName,
  state,
  cleanup,
  resolve,
  reject,
  onLine,
}) {
  state.statusCheckInterval = setInterval(() => {
    checkIsolatedStatus({
      agent,
      manager,
      clusterId,
      logFilePath,
      taskId,
      providerName,
      state,
      cleanup,
      resolve,
      reject,
      onLine,
    }).catch((statusErr) => {
      agent._log(`[${agent.id}] Status check error (will retry): ${statusErr.message}`);
    });
  }, 2000);
}

function followClaudeTaskLogsIsolated(agent, taskId) {
  const { isolation } = agent;
  if (!isolation?.manager) {
    throw new Error('followClaudeTaskLogsIsolated: isolation manager not found');
  }

  const manager = isolation.manager;
  const clusterId = isolation.clusterId;
  const providerName = agent._resolveProvider ? agent._resolveProvider() : 'claude';

  return new Promise((resolve, reject) => {
    const state = createIsolatedLogState();
    const cleanup = buildIsolatedCleanup(state);
    const onLine = (line) => broadcastIsolatedLine({ agent, providerName, taskId, line });
    state.lifecycleHandle = buildIsolatedLifecycleHandle({
      agent,
      manager,
      clusterId,
      taskId,
      providerName,
      state,
      cleanup,
      resolve,
      reject,
      onLine,
    });
    agent.currentTask = state.lifecycleHandle;

    manager
      .execInContainer(clusterId, ['sh', '-c', `zeroshot get-log-path ${taskId}`])
      .then(({ stdout, stderr, code }) => {
        if (code !== 0) {
          return rejectIsolatedFollower({
            agent,
            state,
            cleanup,
            reject,
            error: new Error(
              `Failed to get log path for ${taskId} inside container: ${stderr || stdout}`
            ),
          });
        }

        const logFilePath = stdout.trim();
        if (!logFilePath) {
          return rejectIsolatedFollower({
            agent,
            state,
            cleanup,
            reject,
            error: new Error(`Empty log path returned for ${taskId}`),
          });
        }
        state.logFilePath = logFilePath;
        if (state.resolved || state.taskExited) {
          return;
        }

        agent._log(`[${agent.id}] Following isolated task logs (streaming): ${logFilePath}`);

        startIsolatedTail({
          agent,
          manager,
          clusterId,
          logFilePath,
          state,
          onLine,
        });

        startIsolatedStatusChecks({
          agent,
          manager,
          clusterId,
          logFilePath,
          taskId,
          providerName,
          state,
          cleanup,
          resolve,
          reject,
          onLine,
        });

        if (agent.timeout > 0 && !agent.enableLivenessCheck) {
          state.timeoutTimer = setTimeout(() => {
            state.lifecycleHandle
              .terminate(`Task timed out after ${agent.timeout}ms`, {
                code: 'AGENT_TASK_TIMEOUT',
              })
              .catch((error) => {
                agent._log(
                  `[${agent.id}] Failed to terminate timed-out isolated task: ${error.message}`
                );
              });
          }, agent.timeout);
        }
      })
      .catch((err) => {
        rejectIsolatedFollower({ agent, state, cleanup, reject, error: err });
      });
  });
}

/**
 * Parse agent output to extract structured result data
 * GENERIC - returns whatever structured output the agent provides
 * Works with any agent schema (planner, validator, worker, etc.)
 *
 * Uses clean extraction pipeline from output-extraction.js
 * Falls back to reformatting if extraction fails and schema is available
 *
 * @param {Object} agent - Agent instance
 * @param {String} output - Raw output from agent
 * @returns {Promise<Object>} Parsed result data
 */
async function parseResultOutput(agent, output) {
  // Empty outputs = FAIL
  if (!output || !output.trim()) {
    throw new Error('Task execution failed - no output');
  }

  const providerName = agent._resolveProvider ? agent._resolveProvider() : 'claude';
  const {
    extractJsonFromOutput,
    extractCliError,
    hasFatalStandaloneOutput,
  } = require('./output-extraction');

  // Check for CLI errors FIRST - surface the actual error message
  const cliError = extractCliError(output);
  if (cliError) {
    throw new Error(`CLI error (${cliError.provider}): ${cliError.error}`);
  }

  // Use clean extraction pipeline
  let parsed = extractJsonFromOutput(output, providerName);

  // If extraction failed but we have a schema, attempt reformatting
  if (!parsed && agent.config.jsonSchema) {
    const { reformatOutput } = require('./output-reformatter');

    try {
      parsed = await reformatOutput({
        rawOutput: output,
        schema: agent.config.jsonSchema,
        providerName,
        onAttempt: (attempt, lastError) => {
          if (lastError) {
            console.warn(`[Agent ${agent.id}] Reformat attempt ${attempt}: ${lastError}`);
          } else {
            console.warn(
              `[Agent ${agent.id}] JSON extraction failed, reformatting (attempt ${attempt})...`
            );
          }
        },
      });
    } catch (reformatError) {
      // Reformatting failed - fall through to error below
      console.error(`[Agent ${agent.id}] Reformatting failed: ${reformatError.message}`);
    }
  }

  if (!parsed) {
    if (hasFatalStandaloneOutput(output)) {
      throw new Error('Task execution failed - no output');
    }
    const trimmedOutput = output.trim();
    console.error(`\n${'='.repeat(80)}`);
    console.error(`🔴 AGENT OUTPUT MISSING REQUIRED JSON BLOCK`);
    console.error(`${'='.repeat(80)}`);
    console.error(`Agent: ${agent.id}, Role: ${agent.role}, Provider: ${providerName}`);
    console.error(`Output (last 500 chars): ${trimmedOutput.slice(-500)}`);
    console.error(`${'='.repeat(80)}\n`);
    throw new Error(`Agent ${agent.id} output missing required JSON block`);
  }

  // If a JSON schema is configured, validate parsed output locally.
  // This preserves schema enforcement even when we run stream-json for live logs.
  // IMPORTANT: For non-validator agents we warn but do not fail the cluster.
  if (agent.config.jsonSchema) {
    // Normalize enum values BEFORE validation (handles case mismatches, common variations)
    // This is provider-agnostic - works for Claude CLI, Gemini, Codex, etc.
    normalizeEnumValues(parsed, agent.config.jsonSchema);

    const Ajv = require('ajv');
    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      coerceTypes: false, // STRICT: Reject type mismatches (e.g., null instead of array)
      useDefaults: true,
      removeAdditional: true,
    });
    const validate = ajv.compile(agent.config.jsonSchema);
    const valid = validate(parsed);
    if (!valid) {
      const errorList = (validate.errors || [])
        .slice(0, 5)
        .map((e) => `${e.instancePath || e.schemaPath} ${e.message}`)
        .join('; ');
      const msg =
        `Agent ${agent.id} output failed JSON schema validation: ` +
        (errorList || 'unknown schema error');

      // Validators stay strict (they already have auto-approval fallback on crash).
      if (agent.role === 'validator') {
        throw new Error(msg);
      }

      // Non-validators: emit warning and continue with best-effort parsed data.
      console.warn(`⚠️  ${msg}`);
      agent._publish({
        topic: 'AGENT_SCHEMA_WARNING',
        receiver: 'broadcast',
        content: {
          text: msg,
          data: {
            agent: agent.id,
            role: agent.role,
            iteration: agent.iteration,
            errors: validate.errors || [],
          },
        },
      });
    }
  }

  // Return whatever the agent produced - no hardcoded field requirements
  // Template substitution will validate that required fields exist
  return parsed;
}

/**
 * Kill current task
 * @param {Object} agent - Agent instance
 */
function normalizeTermination(termination) {
  if (termination && typeof termination === 'object') {
    return {
      reason: termination.reason || 'Task killed',
      code: termination.code || null,
    };
  }
  return { reason: termination || 'Task killed', code: null };
}

async function killTask(agent, termination = 'Task killed') {
  const { reason, code } = normalizeTermination(termination);
  const currentTask = agent.currentTask;
  const taskId = agent.currentTaskId;

  if (currentTask?.pendingLaunch && typeof currentTask.kill === 'function') {
    const pendingTermination = await currentTask.kill(reason, { code });
    if (pendingTermination?.forced === false) return pendingTermination;
    agent._stopLivenessCheck?.();
    agent.currentTask = null;
    agent.currentTaskId = null;
    agent.processPid = null;
    agent.lastOutputTime = null;
    agent.taskStartedAt = null;
    return pendingTermination;
  }

  if (agent.isolation?.enabled && taskId) {
    return killIsolatedTask(agent, currentTask, taskId, reason, code);
  }

  // Kill the underlying task before resolving the local follower. This keeps
  // retries from racing a provider process that is still shutting down.
  if (taskId) {
    const ctPath = agent.taskCommandPath || getClaudeTasksPath();
    try {
      // `kill` is a top-level smart command. `task kill` has never existed.
      await runCommandWithTimeout(ctPath, ['kill', taskId], { timeout: 10000 });
      agent._log?.(`Killed task ${taskId}`);
    } catch (error) {
      agent._log?.(`Note: Could not confirm termination for task ${taskId}: ${error.message}`);
      return { forced: false, reason: error.message };
    }
  }

  agent._stopLivenessCheck?.();

  if (currentTask && typeof currentTask.kill === 'function') {
    await currentTask.kill(reason, { code });
  }

  agent.currentTask = null;
  agent.currentTaskId = null;
  agent.processPid = null;
  agent.lastOutputTime = null;
  agent.taskStartedAt = null;
}

async function killIsolatedTask(agent, currentTask, taskId, reason, code) {
  let termination;
  try {
    if (currentTask && typeof currentTask.terminate === 'function') {
      termination = await currentTask.terminate(reason, { code });
    } else {
      termination = await terminateIsolatedTask(
        agent.isolation.manager,
        agent.isolation.clusterId,
        taskId
      );
      if (currentTask && typeof currentTask.kill === 'function') {
        currentTask.kill(reason, { code });
      }
    }
  } catch (error) {
    return { forced: false, reason: error.message };
  }

  if (termination?.forced === false && !termination.alreadyTerminal) {
    return termination;
  }

  agent._stopLivenessCheck?.();
  agent.currentTask = null;
  agent.currentTaskId = null;
  agent.processPid = null;
  agent.lastOutputTime = null;
  agent.taskStartedAt = null;
  return termination;
}

module.exports = {
  ensureAskUserQuestionHook,
  ensureDangerousGitHook,
  resolveMcpConfigArgs,
  spawnClaudeTask,
  spawnTaskProcess,
  followClaudeTaskLogs,
  followClaudeTaskLogsIsolated,
  waitForTaskReady,
  spawnClaudeTaskIsolated,
  getClaudeTasksPath,
  broadcastAgentLine,
  broadcastIsolatedLine,
  parseResultOutput,
  buildCompletionResult,
  buildTaskRunArgs,
  killTask,
};
