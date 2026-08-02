// @ts-nocheck
/**
 * AgentWrapper - Manages agent lifecycle and claude-zeroshots execution
 *
 * Provides:
 * - Agent state machine (idle -> evaluating -> building context -> executing -> idle)
 * - Trigger evaluation via LogicEngine
 * - Context building from ledger
 * - claude-zeroshots spawning and monitoring
 * - Hook execution (onStart, onComplete, onError)
 */

const LogicEngine = require('./logic-engine');
const { validateAgentConfig } = require('./agent/agent-config');
const { loadSettings, validateModelAgainstMax, VALID_MODELS } = require('../lib/settings');
const { normalizeProviderName, getDefaultProviderId } = require('../lib/provider-names');
const { getProvider } = require('./providers');
const { buildContext } = require('./agent/agent-context-builder');
const { collectQueuedGuidance } = require('./agent/guidance-queue');
const {
  promptIdentity,
  resolveAgentProviderSession,
  updateAgentProviderSession,
} = require('./agent/provider-session');
const { findMatchingTrigger, evaluateTrigger } = require('./agent/agent-trigger-evaluator');
const { executeHook } = require('./agent/agent-hook-executor');
const { injectInput: injectAgentInput } = require('./agent/agent-input-injector');
const { NestedExecutionRegistry } = require('./agent/task-execution-handle');
const {
  spawnClaudeTask,
  followClaudeTaskLogs,
  waitForTaskReady,
  spawnClaudeTaskIsolated,
  getClaudeTasksPath,
  parseResultOutput,
  killTask,
} = require('./agent/agent-task-executor');
const {
  start: lifecycleStart,
  stop: lifecycleStop,
  handleMessage: lifecycleHandleMessage,
  executeTriggerAction: lifecycleExecuteTriggerAction,
  executeTask: lifecycleExecuteTask,
  startLivenessCheck: lifecycleStartLivenessCheck,
  stopLivenessCheck: lifecycleStopLivenessCheck,
} = require('./agent/agent-lifecycle');

class AgentWrapper {
  /**
   * @param {any} config - Agent configuration
   * @param {any} messageBus - Message bus instance
   * @param {any} cluster - Cluster instance
   * @param {any} options - Options
   */
  constructor(config, messageBus, cluster, options = {}) {
    // Validate and normalize configuration
    const normalizedConfig = validateAgentConfig(config, options);

    this.id = normalizedConfig.id;
    this.role = normalizedConfig.role;
    this.modelConfig = normalizedConfig.modelConfig;
    this.config = normalizedConfig;
    this.messageBus = messageBus;
    this.cluster = cluster;
    this.logicEngine = new LogicEngine(messageBus, cluster);

    this.state = 'idle';
    this.iteration = 0;
    this.maxIterations = normalizedConfig.maxIterations;
    this.timeout = normalizedConfig.timeout;
    /** @type {any} */
    this.currentTask = null;
    /** @type {string | null} */
    this.currentTaskId = null; // Track spawned task ID for resume capability
    /** @type {{provider: string, sessionId: string, agentId: string, taskId: string, generation: number, cwd: string, worktreePath: string|null, contextSequence: string, guidanceSequence: string|null, promptIdentity: string|null} | null} */
    this.providerSession = null; // Provider continuation state, owned by this logical agent only
    this.currentContextSequence = '0';
    this.currentGuidanceSequence = null;
    this.currentPromptIdentity = null;
    /** @type {number | null} */
    this.processPid = null; // Track process PID for resource monitoring
    /** Active child executions never overwrite the parent task identity fields. */
    this.nestedExecutions = new NestedExecutionRegistry(this.id);
    this.running = false;
    /** @type {Function | null} */
    this.unsubscribe = null;
    /** @type {number | null} */
    this.lastTaskEndTime = null; // Track when last task completed (for context filtering)
    /** @type {number | null} */
    this.lastAgentStartTime = null; // Track when agent last began executing (for context filtering)
    /** @type {number | null} */
    this.lastGuidanceAppliedId = null; // Track last queued guidance sequence applied to prompt

    // LIVENESS DETECTION - Track output freshness to detect stuck agents
    /** @type {number | null} */
    this.lastOutputTime = null; // Timestamp of last output received
    /** @type {number | null} */
    this.taskStartedAt = null; // Timestamp used for absolute task timeout
    /** @type {NodeJS.Timeout | null} */
    this.livenessCheckInterval = null; // Interval for health checks
    this.consecutiveStaleWarnings = 0;
    this.livenessTerminationStarted = false;
    this.livenessTerminationContext = null;
    this.livenessTerminationAttempts = 0;
    this.livenessTerminationRetryAt = 0;
    this.staleDuration = normalizedConfig.staleDuration;
    this.enableLivenessCheck = normalizedConfig.enableLivenessCheck;

    // MOCK SUPPORT - Inject mock spawn function for testing
    // When set, _spawnClaudeTask uses this instead of real ct CLI
    // Priority: options.mockSpawnFn (legacy) > options.taskRunner (new DI pattern)
    if (options.mockSpawnFn) {
      this.mockSpawnFn = options.mockSpawnFn;
    } else if (options.taskRunner) {
      // TaskRunner DI - create mockSpawnFn wrapper
      const taskRunner = options.taskRunner;
      this.mockSpawnFn = (args, { context }) => {
        const spec = this._resolveModelSpec();
        const source = this._resolveModelSpecSource();
        return taskRunner.run(context, {
          agentId: this.id,
          ...(source === 'direct' ? { model: spec.model } : { modelLevel: spec.level }),
          ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
          provider: this._resolveProvider(),
          cwd: this.config.cwd || process.cwd(),
          worktreePath: this.worktree?.path || null,
        });
      };
    } else {
      this.mockSpawnFn = null;
    }

    this.testMode = options.testMode || false;
    this.quiet = options.quiet || false;
    this.providerCliFeatures = options.providerCliFeatures || null;

    // ISOLATION SUPPORT - Run tasks inside Docker container
    this.isolation = options.isolation || null;

    // WORKTREE SUPPORT - Run tasks in git worktree (lightweight isolation without Docker)
    this.worktree = options.worktree || null;
  }

  /**
   * Log message (respects quiet mode)
   * @private
   */
  _log(...args) {
    if (!this.quiet) {
      console.log(...args);
    }
  }

  _resolveProvider() {
    const settings = loadSettings();
    const clusterConfig = this.cluster?.config || {};

    const resolved =
      clusterConfig.forceProvider ||
      this.config.provider ||
      clusterConfig.defaultProvider ||
      settings.defaultProvider ||
      getDefaultProviderId();

    return normalizeProviderName(resolved) || getDefaultProviderId();
  }

  _resolveModelSpec() {
    const settings = loadSettings();
    const providerName = this._resolveProvider();
    const provider = getProvider(providerName);
    const clusterConfig = this.cluster?.config || {};
    const providerSettings = settings.providerSettings?.[providerName] || {};
    const levelOverrides = providerSettings.levelOverrides || {};
    const minLevel = providerSettings.minLevel;
    const maxLevel = providerSettings.maxLevel;
    const forcedLevel =
      clusterConfig.forceProvider === providerName ? clusterConfig.forceLevel : null;

    const applyReasoningOverride = (spec, override) => {
      if (!override) return spec;
      return { ...spec, reasoningEffort: override };
    };

    if (this.modelConfig.type === 'rules') {
      for (const rule of this.modelConfig.rules) {
        if (this._matchesIterationRange(rule.iterations)) {
          if (rule.model) {
            provider.validateModelId(rule.model);
            return {
              level: 'custom',
              model: rule.model,
              reasoningEffort: rule.reasoningEffort || this.config.reasoningEffort,
            };
          }
          if (rule.modelLevel) {
            const level = provider.validateLevel(rule.modelLevel, minLevel, maxLevel);
            const spec = provider.resolveModelSpec(level, levelOverrides);
            return applyReasoningOverride(
              { ...spec, level },
              rule.reasoningEffort || this.config.reasoningEffort
            );
          }
        }
      }

      throw new Error(
        `Agent ${this.id}: No model rule matched iteration ${this.iteration}. ` +
          `Add a catch-all rule like { "iterations": "all", "modelLevel": "level2" }`
      );
    }

    if (this.modelConfig.model) {
      provider.validateModelId(this.modelConfig.model);
      return {
        level: 'custom',
        model: this.modelConfig.model,
        reasoningEffort: this.config.reasoningEffort,
      };
    }

    if (forcedLevel) {
      const level = provider.validateLevel(forcedLevel, minLevel, maxLevel);
      const spec = provider.resolveModelSpec(level, levelOverrides);
      return applyReasoningOverride({ ...spec, level }, this.config.reasoningEffort);
    }

    if (this.modelConfig.modelLevel) {
      const level = provider.validateLevel(this.modelConfig.modelLevel, minLevel, maxLevel);
      const spec = provider.resolveModelSpec(level, levelOverrides);
      return applyReasoningOverride({ ...spec, level }, this.config.reasoningEffort);
    }

    const defaultLevel = providerSettings.defaultLevel || provider.getDefaultLevel();
    const level = provider.validateLevel(defaultLevel, minLevel, maxLevel);
    const spec = provider.resolveModelSpec(level, levelOverrides);
    return applyReasoningOverride({ ...spec, level }, this.config.reasoningEffort);
  }

  _resolveModelSpecSource() {
    if (this.modelConfig.type === 'rules') {
      for (const rule of this.modelConfig.rules) {
        if (this._matchesIterationRange(rule.iterations)) {
          return rule.model ? 'direct' : 'provider-level';
        }
      }
    }
    return this.modelConfig.model ? 'direct' : 'provider-level';
  }

  /**
   * Publish a message to the message bus, always including sender_model
   * @private
   */
  _publish(message) {
    this.messageBus.publish({
      ...message,
      cluster_id: this.cluster.id,
      sender: this.id,
      sender_model: this._selectModel(),
      sender_provider: this._resolveProvider(),
    });
  }

  /**
   * Publish agent lifecycle event to message bus (visible in zeroshot logs)
   * @private
   */
  _publishLifecycle(event, details = {}) {
    this._publish({
      topic: 'AGENT_LIFECYCLE',
      receiver: 'system',
      content: {
        text: `${this.id}: ${event}`,
        data: {
          event,
          agent: this.id,
          role: this.role,
          state: this.state,
          model: this._selectModel(),
          provider: this._resolveProvider(),
          ...details,
        },
      },
    });
  }

  /**
   * Select model based on current iteration and agent config
   * Enforces legacy maxModel/minModel aliases for Claude compatibility
   * @returns {string|null}
   * @private
   */
  _selectModel() {
    const spec = this._resolveModelSpec();
    const settings = loadSettings();
    const maxModel = settings.maxModel;
    const minModel = settings.minModel || null;

    if (spec.model && maxModel && VALID_MODELS.includes(spec.model)) {
      return validateModelAgainstMax(spec.model, maxModel, minModel);
    }

    return spec.model || null;
  }

  /**
   * Check if current iteration matches the range pattern
   * @param {string} pattern - e.g., "1", "1-3", "5+", "all"
   * @returns {boolean}
   * @private
   */
  _matchesIterationRange(pattern) {
    if (pattern === 'all') return true;

    const current = this.iteration;

    // Exact match: "3"
    if (/^\d+$/.test(pattern)) {
      return current === parseInt(pattern);
    }

    // Range: "1-3"
    const rangeMatch = pattern.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const [, start, end] = rangeMatch;
      return current >= parseInt(start) && current <= parseInt(end);
    }

    // Open-ended: "5+"
    const openMatch = pattern.match(/^(\d+)\+$/);
    if (openMatch) {
      const [, start] = openMatch;
      return current >= parseInt(start);
    }

    throw new Error(
      `Agent ${this.id}: Invalid iteration pattern '${pattern}'. ` +
        `Valid formats: "1", "1-3", "5+", "all"`
    );
  }

  /**
   * Select prompt based on current iteration and agent config
   * @returns {string|null} System prompt string, or null if no prompt configured
   * @private
   */
  _selectPrompt() {
    const promptConfig = this.config.promptConfig;

    // No prompt configured
    if (!promptConfig) {
      return null;
    }

    // Backward compatibility: static prompt
    if (promptConfig.type === 'static') {
      return promptConfig.system;
    }

    // Dynamic rules: evaluate based on iteration
    for (const rule of promptConfig.rules) {
      if (this._matchesIterationRange(rule.match)) {
        return rule.system;
      }
    }

    // No match: fail fast
    throw new Error(
      `Agent ${this.id}: No prompt rule matched iteration ${this.iteration}. ` +
        `Add a catch-all rule like { "match": "all", "system": "..." }`
    );
  }

  /**
   * Start the agent (begin listening for triggers)
   */
  start() {
    return lifecycleStart(this);
  }

  /**
   * Stop the agent
   */
  stop() {
    return lifecycleStop(this);
  }

  /**
   * Handle incoming message
   * @private
   */
  _handleMessage(message) {
    return lifecycleHandleMessage(this, message);
  }

  /**
   * Find trigger matching the message topic
   * @private
   */
  _findMatchingTrigger(message) {
    return findMatchingTrigger({
      triggers: this.config.triggers,
      message,
    });
  }

  /**
   * Evaluate trigger logic
   * @private
   */
  _evaluateTrigger(trigger, message) {
    const agent = {
      id: this.id,
      role: this.role,
      iteration: this.iteration,
      cluster_id: this.cluster.id,
      requiredQualityGates: this.config?.requiredQualityGates || [],
    };

    return evaluateTrigger({
      trigger,
      message,
      agent,
      logicEngine: this.logicEngine,
    });
  }

  /**
   * Execute trigger action
   * @private
   */
  _executeTriggerAction(trigger, message) {
    return lifecycleExecuteTriggerAction(this, trigger, message);
  }

  /**
   * Execute claude-zeroshots with built context
   * Retries disabled by default. Set agent config `maxRetries` to enable (e.g., 3).
   * @private
   */
  _executeTask(triggeringMessage) {
    return lifecycleExecuteTask(this, triggeringMessage);
  }

  /**
   * Build context from ledger based on contextStrategy
   * @private
   */
  _buildContext(triggeringMessage) {
    const previousAgentStart = this.lastAgentStartTime;
    const providerName = this._resolveProvider();
    let providerSession = resolveAgentProviderSession(this, providerName);
    if (providerSession && !this._providerSupportsSessionResume(providerName)) {
      updateAgentProviderSession(this, null);
      providerSession = null;
    }
    const contextMode = providerSession ? 'continuation' : 'full';
    const selectedPrompt = this._selectPrompt();
    const latestMessage = this.messageBus.findLast({
      cluster_id: this.cluster.id,
      orderBySequence: true,
    });
    this.currentContextSequence = latestMessage?.sequence || '0';
    const queuedGuidance = collectQueuedGuidance({
      messageBus: this.messageBus,
      clusterId: this.cluster.id,
      agentId: this.id,
      afterId: this.lastGuidanceAppliedId,
      throughId: this.currentContextSequence,
    });
    this.currentGuidanceSequence =
      queuedGuidance.latestSequence ?? this.lastGuidanceAppliedId ?? null;
    this.currentPromptIdentity = promptIdentity(selectedPrompt);
    const context = buildContext({
      id: this.id,
      role: this.role,
      iteration: this.iteration,
      config: this.config,
      messageBus: this.messageBus,
      cluster: this.cluster,
      lastTaskEndTime: this.lastTaskEndTime,
      lastAgentStartTime: previousAgentStart,
      triggeringMessage,
      selectedPrompt,
      queuedGuidance: queuedGuidance.guidanceBlock,
      mode: contextMode,
      continuationSequence: providerSession?.contextSequence,
      contextThroughId: this.currentContextSequence,
      previousPromptIdentity: providerSession?.promptIdentity,
      currentPromptIdentity: this.currentPromptIdentity,
      // Pass isolation state for conditional git restriction
      worktree: this.worktree,
      isolation: this.isolation,
    });

    // Record when this iteration started so future "since: last_agent_start" filters work.
    const latestTimestamp = latestMessage?.timestamp;
    const now = Date.now();
    this.lastAgentStartTime =
      typeof latestTimestamp === 'number' ? Math.max(now, latestTimestamp + 1) : now;

    return context;
  }

  _providerSupportsSessionResume(providerName) {
    const override = this.providerCliFeatures?.[providerName];
    if (override && Object.hasOwn(override, 'supportsResume')) {
      return override.supportsResume === true;
    }
    return getProvider(providerName).getCliFeatures().supportsResume === true;
  }

  /**
   * Spawn claude-zeroshots process and stream output via message bus
   * @private
   */
  _spawnClaudeTask(context, options = {}) {
    return spawnClaudeTask(this, context, options);
  }

  /**
   * Wait for task to be registered in ct storage
   * @private
   */
  _waitForTaskReady(taskId, maxRetries = 10, delayMs = 200) {
    return waitForTaskReady(this, taskId, maxRetries, delayMs);
  }

  /**
   * Follow claude-zeroshots logs until completion, streaming to message bus
   * Reads log file directly for reliable streaming
   * @private
   */
  _followClaudeTaskLogs(taskId) {
    return followClaudeTaskLogs(this, taskId);
  }

  /**
   * Get path to claude-zeroshots executable
   * @private
   */
  _getClaudeTasksPath() {
    return getClaudeTasksPath();
  }

  /**
   * Spawn claude-zeroshots inside Docker container (isolation mode)
   * Runs Claude CLI inside the container for full isolation
   * @private
   */
  _spawnClaudeTaskIsolated(context) {
    return spawnClaudeTaskIsolated(this, context);
  }

  /**
   * Kill current task
   * @private
   */
  _killTask(reason) {
    return killTask(this, reason);
  }

  /**
   * Execute a hook
   * THROWS on failure - no silent errors
   * @private
   */
  _executeHook(hookName, context) {
    const hook = this.config.hooks?.[hookName];
    return executeHook({
      hook,
      agent: this,
      message: context.triggeringMessage,
      result: context.result,
      messageBus: this.messageBus,
      cluster: this.cluster,
      orchestrator: this.orchestrator,
    });
  }

  /**
   * Parse agent output to extract structured result data
   * GENERIC - returns whatever structured output the agent provides
   * Works with any agent schema (planner, validator, worker, etc.)
   * Falls back to reformatting if extraction fails
   * @private
   */
  _parseResultOutput(output, options = {}) {
    return parseResultOutput(this, output, options);
  }

  /**
   * Resume agent task with context from previous failure
   * Called by Orchestrator.resume() to continue where we left off
   * @param {String} resumeContext - Context describing what to resume
   */
  async resume(resumeContext) {
    if (!this.running) {
      throw new Error(`Agent ${this.id} is not running. Start it first.`);
    }

    if (this.state !== 'idle') {
      throw new Error(`Agent ${this.id} is busy (state: ${this.state}). Wait for current task.`);
    }

    this._log(`[${this.id}] Resuming task...`);

    // Create a synthetic triggering message for resume
    const triggeringMessage = {
      cluster_id: this.cluster.id,
      topic: 'AGENT_RESUME',
      sender: 'system',
      content: {
        text: resumeContext,
      },
    };

    // Execute the task with resume context
    await this._executeTask(triggeringMessage);
  }

  /**
   * Inject live input into a running agent task when possible
   * @param {string} text
   * @param {object} [options]
   * @returns {Promise<{status: string, reason?: string|null, method?: string|null, taskId?: string|null}>}
   */
  injectInput(text, options = {}) {
    return injectAgentInput(this, text, options);
  }

  /**
   * Get current agent state
   */
  getState() {
    const modelSpec = this._resolveModelSpec();
    const hasLiveOrTrackedTask =
      this.state === 'executing_task' && (!!this.currentTask || !!this.currentTaskId);
    return {
      id: this.id,
      role: this.role,
      model: this._selectModel(),
      provider: this._resolveProvider(),
      modelSpec,
      state: this.state,
      iteration: this.iteration,
      maxIterations: this.maxIterations,
      currentTask: hasLiveOrTrackedTask,
      currentTaskId: this.currentTaskId,
      pid: this.processPid,
    };
  }

  /**
   * Start monitoring agent output liveness
   * Detects when agent produces no output for configured staleDuration
   * @private
   */
  _startLivenessCheck() {
    return lifecycleStartLivenessCheck(this);
  }

  /**
   * Stop liveness monitoring
   * @private
   */
  _stopLivenessCheck() {
    return lifecycleStopLivenessCheck(this);
  }
}

module.exports = AgentWrapper;
