// @ts-nocheck
/**
 * AgentLifecycle - Agent state machine and lifecycle management
 *
 * Provides:
 * - Agent startup and shutdown
 * - Message handling and routing
 * - Trigger action execution (execute_task, stop_cluster)
 * - Task execution with retry logic
 * - Bounded task runtime and provider-output inactivity monitoring
 *
 * State machine: idle → evaluating → building_context → executing → idle
 */

const { findMatchingTrigger, evaluateTrigger } = require('./agent-trigger-evaluator');
const { executeHook } = require('./agent-hook-executor');
const IsolationManager = require('../isolation-manager');
const crypto = require('crypto');
const { bufferMessage, scheduleDrain, drainBufferedMessages } = require('../message-buffer');
const { isPlatformSupported } = require('./agent-stuck-detector');
const { normalizeProviderName } = require('../../lib/provider-names');
const { loadSettings } = require('../../lib/settings');
const { findPlatformMismatchReason } = require('./validation-platform');
const { calculateRateLimitDelay, isRateLimitError } = require('./rate-limit-backoff');
const { updateAgentProviderSession } = require('./provider-session');

const DEFAULT_VALIDATOR_IMAGE = 'zeroshot-cluster-base';

class HookExecutionError extends Error {
  constructor(message, options) {
    super(message);
    this.name = 'HookExecutionError';
    this.hookFailure = true;
    this.hookRetries = options?.hookRetries;
    this.originalHookError = options?.originalHookError;
    this.taskId = options?.taskId || null;
  }
}

function resolveValidatorIsolationConfig(agent) {
  const config = agent.config?.isolation || {};
  if (config.type && config.type !== 'docker') {
    return null;
  }

  return {
    image: config.image || DEFAULT_VALIDATOR_IMAGE,
    mounts: config.mounts,
    noMounts: config.noMounts,
    containerHome: config.containerHome,
  };
}

async function createValidatorIsolation(agent, isolationConfig) {
  if (!IsolationManager.isDockerAvailable()) {
    agent._log(`[${agent.id}] Docker not available - cannot retry validator in isolation`);
    return null;
  }

  const cluster = agent.cluster || {};
  const workDir = agent.config?.cwd || cluster.worktree?.path || cluster.cwd || process.cwd();
  const providerName = normalizeProviderName(
    (agent._resolveProvider && agent._resolveProvider()) ||
      cluster.config?.forceProvider ||
      cluster.config?.defaultProvider ||
      loadSettings().defaultProvider ||
      'claude'
  );
  // Run validators on the provider's image variant (installs its CLI as a Docker-cached layer).
  const image = IsolationManager.imageForProvider(providerName, isolationConfig.image);
  await IsolationManager.ensureImage(image, true, IsolationManager.providerBuildArgs(providerName));

  const manager = new IsolationManager({ image });

  const isolationClusterId = `${cluster.id}-validators`;
  const containerId = await manager.createContainer(isolationClusterId, {
    workDir,
    image,
    noMounts: isolationConfig.noMounts,
    mounts: isolationConfig.mounts,
    containerHome: isolationConfig.containerHome,
    provider: providerName,
    reuseExistingWorkspace: true,
  });

  const validatorIsolation = {
    enabled: true,
    manager,
    clusterId: isolationClusterId,
    containerId,
    image,
    workDir,
  };

  cluster.validatorIsolation = validatorIsolation;
  return validatorIsolation;
}

async function ensureValidatorIsolation(agent) {
  const cluster = agent.cluster || {};

  if (agent.isolation?.enabled) {
    return agent.isolation;
  }

  if (cluster.validatorIsolation?.enabled) {
    agent.isolation = cluster.validatorIsolation;
    return agent.isolation;
  }

  if (cluster.validatorIsolationPromise) {
    const isolation = await cluster.validatorIsolationPromise;
    if (isolation?.enabled) {
      agent.isolation = isolation;
    }
    return agent.isolation || null;
  }

  const isolationConfig = resolveValidatorIsolationConfig(agent);
  if (!isolationConfig) {
    agent._log(`[${agent.id}] Validator isolation config is not docker - skipping fallback`);
    return null;
  }

  cluster.validatorIsolationPromise = createValidatorIsolation(agent, isolationConfig);

  try {
    const isolation = await cluster.validatorIsolationPromise;
    if (isolation?.enabled) {
      agent.isolation = isolation;
      return agent.isolation;
    }
    return null;
  } finally {
    cluster.validatorIsolationPromise = null;
  }
}

async function maybeRetryValidatorInDocker(agent, result) {
  if (agent.role !== 'validator') return null;
  if (agent.isolation?.enabled) return null;
  if (agent._validatorIsolationAttemptedIteration === agent.iteration) {
    return null;
  }

  const reason = findPlatformMismatchReason(result?.result || {});
  if (!reason) return null;

  const isolation = await ensureValidatorIsolation(agent);
  if (!isolation) {
    return null;
  }

  agent._validatorIsolationAttemptedIteration = agent.iteration;
  agent._log(`[${agent.id}] Platform mismatch detected - retrying validator in Docker isolation`);
  return reason;
}

/**
 * Start the agent (begin listening for triggers)
 * @param {AgentWrapper} agent - Agent instance
 */
function start(agent) {
  if (agent.running) {
    throw new Error(`Agent ${agent.id} is already running`);
  }

  agent.running = true;
  agent.state = 'idle';

  // Subscribe to all messages for this cluster
  agent.unsubscribe = agent.messageBus.subscribe((message) => {
    if (message.cluster_id === agent.cluster.id) {
      handleMessage(agent, message).catch((error) => {
        // FATAL: Message handling failed - crash loud
        console.error(`\n${'='.repeat(80)}`);
        console.error(`🔴 FATAL: Agent ${agent.id} message handler crashed`);
        console.error(`${'='.repeat(80)}`);
        console.error(`Topic: ${message.topic}`);
        console.error(`Error: ${error.message}`);
        console.error(`Stack: ${error.stack}`);
        console.error(`${'='.repeat(80)}\n`);
        // Re-throw to crash the process - DO NOT SILENTLY CONTINUE
        throw error;
      });
    }
  });

  agent._log(`Agent ${agent.id} started (role: ${agent.role})`);
  agent._publishLifecycle('STARTED', {
    triggers: agent.config.triggers?.map((t) => t.topic) || [],
  });
}

/**
 * Stop the agent
 * Waits for any in-flight execution to complete before returning.
 * @param {AgentWrapper} agent - Agent instance
 * @returns {Promise<void>}
 */
async function stop(agent) {
  stopLivenessCheck(agent);

  if (!agent.running && !agent.currentTask) {
    return;
  }

  agent.running = false;
  agent.state = 'stopped';

  if (agent.unsubscribe) {
    agent.unsubscribe();
    agent.unsubscribe = null;
  }

  // Kill current task if any
  if (agent.currentTask) {
    const termination = await agent._killTask('Task stopped by cluster shutdown');
    if (termination?.forced === false) {
      throw new Error(`Task shutdown could not confirm termination: ${termination.reason}`);
    }
  }

  // Wait for in-flight execution to complete (up to 5 seconds)
  // This prevents write-after-close race conditions
  if (agent._currentExecution) {
    let executionTimeout = null;
    try {
      await Promise.race([
        agent._currentExecution,
        new Promise((resolve) => {
          executionTimeout = setTimeout(resolve, 5000);
        }),
      ]);
    } catch {
      // Ignore errors from cancelled execution
    } finally {
      if (executionTimeout) {
        clearTimeout(executionTimeout);
      }
      agent._currentExecution = null;
    }
  }

  agent._log(`Agent ${agent.id} stopped`);
}

/**
 * Handle incoming message
 * @param {AgentWrapper} agent - Agent instance
 * @param {Object} message - Incoming message
 */
async function handleMessage(agent, message) {
  if (!agent._bufferedMessages) {
    agent._bufferedMessages = [];
  }

  // Check if any trigger matches FIRST (before state check)
  const matchingTrigger = findMatchingTrigger({
    triggers: agent.config.triggers,
    message,
  });

  if (!matchingTrigger) {
    return; // No trigger for this message type
  }

  // Now check state - LOG if we're dropping a message we SHOULD handle
  if (!agent.running) {
    console.warn(`[${agent.id}] ⚠️ DROPPING message (not running): ${message.topic}`);
    return;
  }
  if (agent.state !== 'idle') {
    // IMPORTANT: Never drop a message that matches a trigger.
    // Dropping validation/coordinator signals can wedge clusters in "running" state.
    bufferMessage(agent, message);
    console.warn(
      `[${agent.id}] ⏸️ BUFFERING message (busy, state=${agent.state}): ${message.topic}`
    );
    scheduleDrain(
      agent,
      () => drainBufferedMessages(agent, (next) => handleMessage(agent, next), { label: 'Agent' }),
      { label: 'Agent' }
    );
    return;
  }

  // Evaluate trigger logic
  agent.state = 'evaluating_logic';

  const agentContext = {
    id: agent.id,
    role: agent.role,
    iteration: agent.iteration,
    cluster_id: agent.cluster.id,
  };

  const shouldExecute = evaluateTrigger({
    trigger: matchingTrigger,
    message,
    agent: agentContext,
    logicEngine: agent.logicEngine,
  });

  if (!shouldExecute) {
    agent.state = 'idle';
    return;
  }

  // Execute trigger action (lifecycle event published inside for execute_task)
  // Track execution so stop() can wait for it
  const executionPromise = executeTriggerAction(agent, matchingTrigger, message);
  agent._currentExecution = executionPromise;
  try {
    await executionPromise;
  } finally {
    // Clear only if this is still our execution (not replaced by another)
    if (agent._currentExecution === executionPromise) {
      agent._currentExecution = null;
    }
  }
}

/**
 * Execute trigger action
 * @param {AgentWrapper} agent - Agent instance
 * @param {Object} trigger - Matched trigger config
 * @param {Object} message - Triggering message
 */
async function executeTriggerAction(agent, trigger, message) {
  const action = trigger.action || 'execute_task';

  if (action === 'execute_task') {
    await executeTask(agent, message);
  } else if (action === 'stop_cluster') {
    // Publish CLUSTER_COMPLETE message to signal successful completion
    agent._publish({
      topic: 'CLUSTER_COMPLETE',
      receiver: 'system',
      content: {
        text: 'All validation passed. Cluster completing successfully.',
        data: {
          reason: 'all_validators_approved',
          timestamp: Date.now(),
        },
      },
    });
    agent.state = 'completed';
    agent._log(`Agent ${agent.id}: Cluster completion triggered`);
  } else {
    console.warn(`Unknown action: ${action}`);
    agent.state = 'idle';
  }
}

/**
 * Execute task with built context
 * Default: uses settings.maxRetries (default 3) for exponential backoff retries.
 * Rate limit errors (429, capacity exhausted) use longer delays (30s base).
 * Override via agent config `maxRetries` to change retry behavior.
 * @param {AgentWrapper} agent - Agent instance
 * @param {Object} triggeringMessage - Message that triggered execution
 */
function handleMaxIterations(agent) {
  if (agent.iteration < agent.maxIterations) {
    return false;
  }

  agent._log(`[Agent ${agent.id}] Hit max iterations (${agent.maxIterations}), stopping cluster`);
  agent._publishLifecycle('MAX_ITERATIONS_REACHED', {
    iteration: agent.iteration,
    maxIterations: agent.maxIterations,
  });
  // Publish failure message - orchestrator watches for this and auto-stops
  agent._publish({
    topic: 'CLUSTER_FAILED',
    receiver: 'system',
    content: {
      text: `Agent ${agent.id} hit max iterations limit (${agent.maxIterations}). Stopping cluster.`,
      data: {
        reason: 'max_iterations',
        iteration: agent.iteration,
        maxIterations: agent.maxIterations,
      },
    },
  });
  agent.state = 'failed';
  return true;
}

function logInputContext(agent, context) {
  if (agent.quiet) {
    return;
  }

  console.log(`
${'='.repeat(80)}`);
  console.log(`📥 INPUT CONTEXT - Agent: ${agent.id} (Iteration: ${agent.iteration})`);
  console.log(`${'='.repeat(80)}`);
  console.log(context);
  console.log(`${'='.repeat(80)}
`);
}

async function applyValidatorJitter(agent) {
  // LOCK CONTENTION FIX: Add random jitter for validators to prevent thundering herd
  // When multiple validators wake on the same trigger (e.g., IMPLEMENTATION_READY),
  // they all try to spawn Claude CLI at the same time. Claude CLI uses a lock file
  // per workspace, so only one can run. Adding jitter staggers their starts.
  // SKIP in testMode - tests use mocks and don't need jitter
  if (agent.role !== 'validator' || agent.testMode) {
    return;
  }

  const jitterMs = crypto.randomInt(0, 15000); // 0-15 seconds
  if (!agent.quiet) {
    agent._log(
      `[Agent ${agent.id}] Adding ${Math.round(jitterMs / 1000)}s jitter to prevent lock contention`
    );
  }
  await new Promise((resolve) => setTimeout(resolve, jitterMs));
}

function publishTaskStarted(agent, triggeringMessage) {
  const modelSpec = agent._resolveModelSpec ? agent._resolveModelSpec() : null;
  agent._publishLifecycle('TASK_STARTED', {
    iteration: agent.iteration,
    model: agent._selectModel(),
    provider: agent._resolveProvider ? agent._resolveProvider() : 'claude',
    modelSpec,
    triggeredBy: triggeringMessage.topic,
    triggerFrom: triggeringMessage.sender,
  });
}

function attachResultMetadata(agent, result) {
  // Add task ID to result for debugging and hooks
  result.taskId = result.taskId || agent.currentTaskId;
  result.agentId = agent.id;
  result.iteration = agent.iteration;
}

function publishTaskCompleted(agent, result) {
  const session = result.providerSession;
  agent._publishLifecycle('TASK_COMPLETED', {
    iteration: agent.iteration,
    success: true,
    taskId: agent.currentTaskId,
    provider: agent._resolveProvider ? agent._resolveProvider() : 'claude',
    tokenUsage: result.tokenUsage || null,
    contextSequence: session?.contextSequence ?? agent.currentContextSequence,
    guidanceSequence: session?.guidanceSequence ?? agent.currentGuidanceSequence ?? null,
    promptIdentity: session?.promptIdentity ?? agent.currentPromptIdentity ?? null,
  });
}

function publishTokenUsage(agent, result) {
  // Publish TOKEN_USAGE event for aggregation and tracking
  // CRITICAL: Include taskId for causal linking - allows consumers to group
  // messages by task regardless of interleaved timing from async hooks
  if (!result.tokenUsage) {
    return;
  }

  agent.messageBus.publish({
    cluster_id: agent.cluster.id,
    topic: 'TOKEN_USAGE',
    sender: agent.id,
    content: {
      text: `${agent.id} used ${result.tokenUsage.inputTokens} input + ${result.tokenUsage.outputTokens} output tokens`,
      data: {
        agentId: agent.id,
        role: agent.role,
        model: agent._selectModel(),
        iteration: agent.iteration,
        taskId: agent.currentTaskId, // Causal linking for message ordering
        ...result.tokenUsage,
      },
    },
  });
}

function clearTransientTaskState(agent, error = null) {
  if (error?.retainTaskHandle) return;
  stopLivenessCheck(agent);
  agent.currentTask = null;
  agent.currentTaskId = null;
  agent.processPid = null;
  agent.lastOutputTime = null;
  agent.taskStartedAt = null;
}

async function executeOnCompleteHookWithRetry(agent, triggeringMessage, result) {
  // Execute onComplete hook WITH RETRY
  // Hook failure shouldn't retry the entire task - just the hook
  const hookMaxRetries = 3;
  const hookBaseDelay = 1000;
  let hookSuccess = false;

  for (let hookAttempt = 1; hookAttempt <= hookMaxRetries && !hookSuccess; hookAttempt++) {
    try {
      await executeHook({
        hook: agent.config.hooks?.onComplete,
        agent: agent,
        message: triggeringMessage,
        result: result,
        messageBus: agent.messageBus,
        cluster: agent.cluster,
        orchestrator: agent.orchestrator,
      });
      hookSuccess = true;
    } catch (hookError) {
      console.error(`
${'='.repeat(80)}`);
      console.error(
        `🔴 HOOK EXECUTION FAILED - AGENT: ${agent.id} (Attempt ${hookAttempt}/${hookMaxRetries})`
      );
      console.error(`${'='.repeat(80)}`);
      console.error(`Error: ${hookError.message}`);

      if (hookAttempt < hookMaxRetries) {
        const delay = hookBaseDelay * Math.pow(2, hookAttempt - 1);
        console.error(`Will retry hook in ${delay}ms...`);
        console.error(`${'='.repeat(80)}
`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        console.error(`${'='.repeat(80)}
`);
        // All hook retries exhausted - FAIL THE CLUSTER (do NOT rerun the whole task).
        // Retrying the task wastes tokens and cannot fix a deterministic hook/config bug.
        throw new HookExecutionError(
          `Hook execution failed after ${hookMaxRetries} attempts. ` +
            `Task completed successfully but hook could not publish result. ` +
            `Original error: ${hookError.message}`,
          {
            hookRetries: hookMaxRetries,
            originalHookError: hookError.message,
            taskId: result?.taskId || null,
          }
        );
      }
    }
  }
}

async function runTaskAttempt(agent, triggeringMessage) {
  // Execute onStart hook
  await executeHook({
    hook: agent.config.hooks?.onStart,
    agent: agent,
    message: triggeringMessage,
    result: undefined,
    messageBus: agent.messageBus,
    cluster: agent.cluster,
    orchestrator: agent.orchestrator,
  });

  // Check max iterations limit BEFORE incrementing (prevents infinite rejection loops)
  if (handleMaxIterations(agent)) {
    return;
  }

  // Increment iteration BEFORE building context so worker knows current iteration
  agent.iteration++;

  // Build context
  agent.state = 'building_context';
  const context = agent._buildContext(triggeringMessage);

  // Log input context (helps debug what each agent sees)
  logInputContext(agent, context);

  // Spawn provider task
  agent.state = 'executing_task';
  await applyValidatorJitter(agent);
  publishTaskStarted(agent, triggeringMessage);

  let result;
  try {
    result = await agent._spawnClaudeTask(context);
  } catch (error) {
    updateAgentProviderSession(agent, null);
    throw error;
  }
  attachResultMetadata(agent, result);

  // Check if task execution failed
  if (!result.success) {
    updateAgentProviderSession(agent, null);
    const error = new Error(result.error || 'Task execution failed');
    error.code = result.code || result.errorType || null;
    error.taskId = result.taskId || null;
    error.vertexModelError = result.vertexModelError || null;
    throw error;
  }

  const fallbackReason = await maybeRetryValidatorInDocker(agent, result);
  if (fallbackReason) {
    updateAgentProviderSession(agent, null);
    throw new Error(
      `Validator platform mismatch detected (${fallbackReason}). Retrying in Docker isolation.`
    );
  }

  // The hook publishes the logical output of the turn. Until it succeeds, neither
  // TASK_COMPLETED nor its provider continuation boundary is durable.
  try {
    await executeOnCompleteHookWithRetry(agent, triggeringMessage, result);
  } catch (error) {
    updateAgentProviderSession(agent, null);
    throw error;
  }

  updateAgentProviderSession(agent, result.providerSession);
  agent.lastGuidanceAppliedId = agent.currentGuidanceSequence;

  // Set state to idle BEFORE publishing lifecycle event
  // (so lifecycle message includes correct state)
  agent.state = 'idle';

  // Track completion time for context filtering (used by "since: last_task_end")
  agent.lastTaskEndTime = Date.now();

  publishTaskCompleted(agent, result);
  publishTokenUsage(agent, result);
  clearTransientTaskState(agent);
}

function logTaskAttemptFailure(agent, attempt, maxRetries, error) {
  // Log attempt failure
  console.error(`
${'='.repeat(80)}`);
  console.error(`🔴 TASK EXECUTION FAILED - AGENT: ${agent.id} (Attempt ${attempt}/${maxRetries})`);
  console.error(`${'='.repeat(80)}`);
  console.error(`Error: ${error.message}`);

  const vertexError = error.vertexModelError;
  if (vertexError) {
    const model = vertexError.model ? `"${vertexError.model}" is` : 'Selected model is';
    console.error(`
⚠️  ${model} not available on your Vertex AI deployment.
    Fix: set explicit model IDs that are enabled on your deployment:

    zeroshot settings set providerSettings.claude.levelOverrides '{"level1": {"model": "claude-sonnet-4-6"}, "level2": {"model": "claude-sonnet-4-6"}, "level3": {"model": "claude-sonnet-4-6"}}'

    Replace "claude-sonnet-4-6" with whichever Claude model your deployment has enabled.
    You can test a model with: claude --dangerously-skip-permissions -p "hi" --model <model-id>
`);
  }
}

async function handleLockContention() {
  // Lock contention - add significant jittered delay
  const lockDelay = 10000 + crypto.randomInt(0, 20000); // 10-30 seconds
  console.error(
    `⚠️ Lock contention detected - waiting ${Math.round(lockDelay / 1000)}s before retry`
  );
  await new Promise((resolve) => setTimeout(resolve, lockDelay));
}

async function handleFinalFailure(agent, triggeringMessage, error, maxRetries) {
  const failureAttempts = error?.terminationAttempts ?? maxRetries;
  console.error(`
${'='.repeat(80)}`);
  console.error(`🔴🔴🔴 MAX RETRIES EXHAUSTED - AGENT: ${agent.id} 🔴🔴🔴`);
  console.error(`${'='.repeat(80)}`);
  console.error(`All ${failureAttempts} attempts failed`);
  console.error(`Final error: ${error.message}`);
  console.error(`Stack: ${error.stack}`);
  console.error(`${'='.repeat(80)}
`);

  // CRITICAL FIX: Validator crash = REJECTION (not auto-approval)
  // Auto-approval on crash allowed broken code to be merged - unacceptable!
  // If validator crashed 3x, something is fundamentally wrong - REJECT and investigate
  if (agent.role === 'validator') {
    console.error(`
${'='.repeat(80)}`);
    console.error(`❌ VALIDATOR CRASHED - REJECTING (NOT AUTO-APPROVING)`);
    console.error(`${'='.repeat(80)}`);
    console.error(`Validator ${agent.id} crashed ${failureAttempts} times`);
    console.error(`Error: ${error.message}`);
    console.error(`REJECTING validation - broken code will NOT be merged`);
    console.error(`Investigation required before retry`);
    console.error(`${'='.repeat(80)}
`);

    // Publish REJECTION message (NOT approval!)
    const hook = agent.config.hooks?.onComplete;
    if (hook && hook.action === 'publish_message') {
      agent._publish({
        topic: hook.config.topic,
        receiver: hook.config.receiver || 'broadcast',
        content: {
          text: `REJECTED: Validator crashed ${failureAttempts} times - ${error.message}`,
          data: {
            approved: false, // REJECT!
            crashedAfterRetries: true,
            errors: JSON.stringify([
              `VALIDATOR CRASHED ${failureAttempts}x: ${error.message}`,
              `Validation could not be performed - REJECTING to prevent broken code merge`,
              `Investigation required before retry`,
            ]),
            attempts: failureAttempts,
            requiresInvestigation: true,
          },
        },
      });
    }

    agent.state = 'error';
    // Don't return - fall through to publish AGENT_ERROR and save failure info
    // This allows the cluster to stop and be resumed after investigation
  }

  // Non-validator agents: publish error and stop
  agent.state = 'error';

  // Hook failure: fail the whole cluster so it gets stopped + persisted (prevents deadlocked "running" clusters).
  if (error?.hookFailure) {
    agent._publish({
      topic: 'CLUSTER_FAILED',
      receiver: 'broadcast',
      content: {
        text: `Cluster failed: onComplete hook failed for ${agent.id} - ${error.message}`,
        data: {
          reason: 'on_complete_hook_failed',
          agentId: agent.id,
          role: agent.role,
          hookRetries: error.hookRetries ?? null,
          originalHookError: error.originalHookError ?? null,
          error: error.message,
        },
      },
    });
  }

  if (error?.vertexModelError) {
    agent._publish({
      topic: 'CLUSTER_FAILED',
      receiver: 'broadcast',
      content: {
        text: `Cluster failed: Claude model is unavailable on Vertex for ${agent.id}`,
        data: {
          reason: 'vertex_model_unavailable',
          agentId: agent.id,
          role: agent.role,
          model: error.vertexModelError.model,
        },
      },
    });
  }

  if (error?.terminationExhausted) {
    agent._publish({
      topic: 'CLUSTER_FAILED',
      receiver: 'broadcast',
      content: {
        text: `Cluster failed: task termination could not be verified for ${agent.id}`,
        data: {
          reason: 'task_termination_unverified',
          agentId: agent.id,
          role: agent.role,
          taskId: error.taskId || agent.currentTaskId,
          attempts: failureAttempts,
          error: error.message,
        },
      },
    });
  }

  // Save failure info to cluster for resume capability
  agent.cluster.failureInfo = {
    ...(error?.terminationExhausted ? agent.cluster.failureInfo : {}),
    agentId: agent.id,
    taskId: error?.taskId || agent.currentTaskId,
    iteration: agent.iteration,
    error: error.message,
    attempts: failureAttempts,
    timestamp: Date.now(),
  };

  // Publish error to message bus for visibility in logs
  agent._publish({
    topic: 'AGENT_ERROR',
    receiver: 'broadcast',
    content: {
      text: `Task execution failed after ${failureAttempts} attempts: ${error.message}`,
      data: {
        error: error.message,
        stack: error.stack,
        hookFailure: error?.hookFailure === true,
        restartExhausted: error?.restartExhausted === true,
        terminationExhausted: error?.terminationExhausted === true,
        hookRetries: error?.hookRetries ?? undefined,
        originalHookError: error?.originalHookError ?? undefined,
        agent: agent.id,
        role: agent.role,
        iteration: agent.iteration,
        taskId: error?.taskId || agent.currentTaskId,
        attempts: failureAttempts,
        hookFailureContext: error.message.includes('Hook uses result')
          ? {
              taskId: agent.currentTaskId || 'UNKNOWN',
              retrieveLogs: agent.currentTaskId
                ? `zeroshot task logs ${agent.currentTaskId}`
                : 'N/A',
            }
          : undefined,
      },
    },
    metadata: {
      triggeringTopic: triggeringMessage.topic,
    },
  });

  // Execute onError hook
  await executeHook({
    hook: agent.config.hooks?.onError,
    agent: agent,
    message: triggeringMessage,
    result: { error },
    messageBus: agent.messageBus,
    cluster: agent.cluster,
    orchestrator: agent.orchestrator,
  });

  if (!error?.terminationExhausted) {
    agent.state = 'idle';
  }
}

async function scheduleRetry(agent, error, attempt, maxRetries, _baseDelay) {
  // Use rate-limit-aware backoff (30s+ for 429s, 2s for others)
  const settings = loadSettings();
  const delay = calculateRateLimitDelay(error, attempt, settings);
  const isRateLimit = isRateLimitError(error);

  agent._publishLifecycle('RETRY_SCHEDULED', {
    attempt,
    maxRetries,
    delayMs: delay,
    error: error.message,
    isRateLimitError: isRateLimit,
  });

  const prefix = isRateLimit ? '🔄 Rate limit - ' : '⚠️  ';
  agent._log(
    `[${agent.id}] ${prefix}Retrying in ${Math.round(delay / 1000)}s... (${attempt + 1}/${maxRetries})`
  );

  // Rate-limit-aware backoff
  await new Promise((resolve) => setTimeout(resolve, delay));

  agent._log(`[${agent.id}] 🔄 Starting retry attempt ${attempt + 1}/${maxRetries}`);
}

async function handleTaskAttemptFailure({
  agent,
  triggeringMessage,
  error,
  attempt,
  maxRetries,
  baseDelay,
}) {
  // LOCK CONTENTION: Add extra jittered delay for lock file errors
  // This happens when multiple validators try to run Claude CLI in the same workspace
  const isLockError = error.message && error.message.includes('Lock file');

  logTaskAttemptFailure(agent, attempt, maxRetries, error);

  if (isLockError) {
    await handleLockContention();
  } else if (attempt < maxRetries) {
    console.error(`Will retry in ${baseDelay * Math.pow(2, attempt - 1)}ms...`);
  }
  console.error(`${'='.repeat(80)}
`);

  if (attempt >= maxRetries) {
    await handleFinalFailure(agent, triggeringMessage, error, maxRetries);
    return true;
  }

  await scheduleRetry(agent, error, attempt, maxRetries, baseDelay);
  return false;
}

function maybeExtendMaxRetries({
  error,
  attempt,
  maxRetries,
  sigtermRetryGranted,
  noMessagesRetryGranted,
}) {
  const message = error?.message || '';
  if (!message || attempt < maxRetries) {
    return { maxRetries, sigtermRetryGranted, noMessagesRetryGranted };
  }

  if (message.includes('SIGTERM') && !sigtermRetryGranted) {
    return { maxRetries: maxRetries + 1, sigtermRetryGranted: true, noMessagesRetryGranted };
  }

  if (message.toLowerCase().includes('no messages returned') && !noMessagesRetryGranted) {
    return { maxRetries: maxRetries + 1, sigtermRetryGranted, noMessagesRetryGranted: true };
  }

  return { maxRetries, sigtermRetryGranted, noMessagesRetryGranted };
}

const RECOVERABLE_STUCK_TASK_CODES = new Set(['PROVIDER_INACTIVITY_TIMEOUT', 'AGENT_TASK_TIMEOUT']);

function readRestartHistory(agent) {
  const lifecycle = agent.messageBus.query({
    cluster_id: agent.cluster.id,
    topic: 'AGENT_LIFECYCLE',
    sender: agent.id,
  });
  let lastCompletedIndex = -1;
  let totalRestarts = 0;

  lifecycle.forEach((message, index) => {
    const event = message.content?.data?.event;
    if (event === 'TASK_COMPLETED') {
      lastCompletedIndex = index;
    } else if (event === 'AGENT_RESTART_ATTEMPT') {
      totalRestarts += 1;
    }
  });

  const restartsSinceCompletion = lifecycle
    .slice(lastCompletedIndex + 1)
    .filter((message) => message.content?.data?.event === 'AGENT_RESTART_ATTEMPT').length;

  return { restartsSinceCompletion, totalRestarts };
}

function resolveRestartBudget(agent, settings) {
  const history = readRestartHistory(agent);
  const maxRestartAttempts = settings.maxRestartAttempts ?? 3;
  const maxTotalRestarts = settings.maxTotalRestarts ?? 10;
  const allowed =
    history.restartsSinceCompletion < maxRestartAttempts &&
    history.totalRestarts < maxTotalRestarts;

  return {
    ...history,
    maxRestartAttempts,
    maxTotalRestarts,
    allowed,
  };
}

async function handleRecoverableStuckTaskFailure({
  agent,
  triggeringMessage,
  error,
  attempt,
  maxRetries,
  baseDelay,
  settings,
}) {
  if (!RECOVERABLE_STUCK_TASK_CODES.has(error.code)) {
    return { handled: false, maxRetries };
  }

  logTaskAttemptFailure(agent, attempt, maxRetries, error);
  const budget = resolveRestartBudget(agent, settings);
  if (!budget.allowed) {
    agent._publishLifecycle('AGENT_RESTART_EXHAUSTED', {
      taskId: error.taskId,
      reason: error.message,
      code: error.code,
      attempts: attempt,
      restartsSinceCompletion: budget.restartsSinceCompletion,
      totalRestarts: budget.totalRestarts,
      maxRestartAttempts: budget.maxRestartAttempts,
      maxTotalRestarts: budget.maxTotalRestarts,
    });
    error.restartExhausted = true;
    await handleFinalFailure(agent, triggeringMessage, error, attempt);
    return { handled: true, shouldStop: true, maxRetries };
  }

  const nextRestartAttempt = budget.restartsSinceCompletion + 1;
  const nextTotalRestart = budget.totalRestarts + 1;
  agent._publishLifecycle('AGENT_RESTART_ATTEMPT', {
    taskId: error.taskId,
    reason: error.message,
    code: error.code,
    attempt: nextRestartAttempt,
    totalRestartAttempt: nextTotalRestart,
    maxRestartAttempts: budget.maxRestartAttempts,
    maxTotalRestarts: budget.maxTotalRestarts,
  });

  const extendedMaxRetries = Math.max(maxRetries, attempt + 1);
  await scheduleRetry(agent, error, attempt, extendedMaxRetries, baseDelay);
  return { handled: true, shouldStop: false, maxRetries: extendedMaxRetries };
}

/**
 * Execute claude-zeroshots with built context
 * Default: uses settings.maxRetries (default 3) for exponential backoff retries.
 * Override via agent config `maxRetries` to change retry behavior.
 * @param {AgentWrapper} agent - Agent instance
 * @param {Object} triggeringMessage - Message that triggered execution
 */
async function executeTask(agent, triggeringMessage) {
  // Early exit if agent was stopped
  if (!agent.running) {
    return;
  }

  // Default: uses settings.maxRetries (default 3)
  // Override via agent config `maxRetries` to change retry behavior
  const settings = loadSettings();
  let maxRetries = agent.config.maxRetries ?? settings.maxRetries ?? 3;
  const baseDelay = settings.backoffBaseMs ?? 2000;
  let sigtermRetryGranted = false;
  let noMessagesRetryGranted = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Check if agent was stopped between retries
    if (!agent.running) {
      return;
    }

    try {
      await runTaskAttempt(agent, triggeringMessage);
      return;
    } catch (error) {
      // Any failed logical attempt invalidates continuation before TASK_FAILED is
      // published and persisted. Retries must reconstruct a fresh full context.
      updateAgentProviderSession(agent, null);
      if (!agent.running || agent.state === 'stopped') {
        agent._log(`[${agent.id}] Task interrupted during shutdown; skipping retry`);
        return;
      }
      if (error?.permanent) {
        await handleFinalFailure(agent, triggeringMessage, error, attempt);
        return;
      }
      if (error instanceof HookExecutionError) {
        // Hook failures are deterministic; do not waste tokens retrying the provider task.
        await handleFinalFailure(agent, triggeringMessage, error, 1);
        return;
      }
      if (error.vertexModelError) {
        agent._publishLifecycle('TASK_FAILED', {
          iteration: agent.iteration,
          taskId: error.taskId || agent.currentTaskId,
          error: error.message,
          code: error.code || null,
          attempt,
        });
        clearTransientTaskState(agent, error);
        logTaskAttemptFailure(agent, attempt, maxRetries, error);
        // Model unavailability on Vertex is deterministic — retrying wastes nothing but time.
        await handleFinalFailure(agent, triggeringMessage, error, attempt);
        return;
      }
      agent._publishLifecycle('TASK_FAILED', {
        iteration: agent.iteration,
        taskId: error.taskId || agent.currentTaskId,
        error: error.message,
        code: error.code || null,
        attempt,
      });
      clearTransientTaskState(agent, error);
      const stuckTaskResult = await handleRecoverableStuckTaskFailure({
        agent,
        triggeringMessage,
        error,
        attempt,
        maxRetries,
        baseDelay,
        settings,
      });
      if (stuckTaskResult.handled) {
        maxRetries = stuckTaskResult.maxRetries;
        if (stuckTaskResult.shouldStop) {
          return;
        }
        continue;
      }
      const updated = maybeExtendMaxRetries({
        error,
        attempt,
        maxRetries,
        sigtermRetryGranted,
        noMessagesRetryGranted,
      });
      maxRetries = updated.maxRetries;
      sigtermRetryGranted = updated.sigtermRetryGranted;
      noMessagesRetryGranted = updated.noMessagesRetryGranted;
      const shouldStop = await handleTaskAttemptFailure({
        agent,
        triggeringMessage,
        error,
        attempt,
        maxRetries,
        baseDelay,
      });
      if (shouldStop) {
        return;
      }
    }
  }
}
function startLivenessCheck(agent) {
  if (agent.livenessCheckInterval) {
    clearInterval(agent.livenessCheckInterval);
  }

  const settings = loadSettings();
  const warningsBeforeKill = Math.max(1, settings.staleWarningsBeforeKill ?? 2);
  const staleDuration = Math.max(1, agent.staleDuration);
  const configuredTimeout = agent.timeout > 0 ? agent.timeout : null;
  const shortestLimit = configuredTimeout
    ? Math.min(staleDuration, configuredTimeout)
    : staleDuration;
  const checkIntervalMs = Math.min(60 * 1000, Math.max(10, Math.floor(shortestLimit / 4)));

  agent.consecutiveStaleWarnings = 0;
  agent.livenessTerminationStarted = false;
  agent.livenessTerminationContext = null;
  agent.livenessTerminationAttempts = 0;
  agent.livenessTerminationRetryAt = 0;

  agent.livenessCheckInterval = setInterval(() => {
    const hasRecoverableTask =
      Boolean(agent.currentTask) || Boolean(agent.isolation?.enabled && agent.currentTaskId);
    if (!hasRecoverableTask || agent.livenessTerminationStarted) {
      return;
    }

    const now = Date.now();
    if (agent.livenessTerminationContext) {
      if (now >= agent.livenessTerminationRetryAt) {
        attemptLivenessTermination(agent, settings);
      }
      return;
    }

    const taskStartedAt = agent.taskStartedAt || agent.lastOutputTime || now;
    const lastOutputTime = agent.lastOutputTime || taskStartedAt;
    const taskRuntime = now - taskStartedAt;
    const timeSinceLastOutput = now - lastOutputTime;

    if (configuredTimeout && taskRuntime >= configuredTimeout) {
      const reason = `Task timed out after ${configuredTimeout}ms`;
      beginLivenessTermination(agent, settings, reason, 'AGENT_TASK_TIMEOUT', {
        taskId: agent.currentTaskId,
        taskRuntime,
        timeout: configuredTimeout,
      });
      return;
    }

    if (timeSinceLastOutput < staleDuration) {
      agent.consecutiveStaleWarnings = 0;
      return;
    }

    agent.consecutiveStaleWarnings += 1;
    agent._publishLifecycle('AGENT_STALE_WARNING', {
      taskId: agent.currentTaskId,
      timeSinceLastOutput,
      staleDuration,
      lastOutputTime,
      consecutiveWarnings: agent.consecutiveStaleWarnings,
      warningsBeforeKill,
      processDiagnosticsAvailable: isPlatformSupported(),
      analysis: `Provider produced no output for ${timeSinceLastOutput}ms`,
    });

    if (agent.consecutiveStaleWarnings < warningsBeforeKill) {
      return;
    }

    const reason = `Provider produced no output for ${timeSinceLastOutput}ms`;
    beginLivenessTermination(agent, settings, reason, 'PROVIDER_INACTIVITY_TIMEOUT', {
      taskId: agent.currentTaskId,
      timeSinceLastOutput,
      staleDuration,
      consecutiveWarnings: agent.consecutiveStaleWarnings,
    });
  }, checkIntervalMs);
}

const MAX_LIVENESS_TERMINATION_ATTEMPTS = 3;

function beginLivenessTermination(agent, settings, reason, code, eventData) {
  agent.livenessTerminationContext = {
    taskId: agent.currentTaskId,
    reason,
    code,
    eventData,
    eventPublished: false,
  };
  agent.livenessTerminationAttempts = 0;
  agent.livenessTerminationRetryAt = 0;
  attemptLivenessTermination(agent, settings);
}

function publishLivenessTerminationEvent(agent, context) {
  if (context.eventPublished) return;
  context.eventPublished = true;
  agent._publishLifecycle(
    context.code === 'AGENT_TASK_TIMEOUT' ? 'AGENT_TASK_TIMEOUT' : 'AGENT_INACTIVITY_TIMEOUT',
    context.eventData
  );
}

function terminationRetryDelay(settings, attempt) {
  const baseDelay = Math.max(0, settings.backoffBaseMs ?? 2000);
  const maxDelay = Math.max(0, settings.backoffMaxMs ?? 30000);
  return Math.min(maxDelay, baseDelay * Math.pow(2, Math.max(0, attempt - 1)));
}

function attemptLivenessTermination(agent, settings) {
  const context = agent.livenessTerminationContext;
  if (!context || agent.livenessTerminationStarted) return;

  agent.livenessTerminationStarted = true;
  agent.livenessTerminationAttempts += 1;
  const attempt = agent.livenessTerminationAttempts;

  Promise.resolve()
    .then(() => agent._killTask({ reason: context.reason, code: context.code }))
    .then((termination) => {
      if (termination?.forced === false) {
        throw new Error(termination.reason || 'Task termination was not confirmed');
      }
      publishLivenessTerminationEvent(agent, context);
    })
    .catch((error) => {
      if (agent.livenessTerminationContext !== context) return;
      if (attempt >= MAX_LIVENESS_TERMINATION_ATTEMPTS) {
        exhaustLivenessTermination(agent, context, error);
        return;
      }

      const delayMs = terminationRetryDelay(settings, attempt);
      agent.livenessTerminationRetryAt = Date.now() + delayMs;
      agent.livenessTerminationStarted = false;
      agent._publishLifecycle('AGENT_TERMINATION_RETRY', {
        taskId: context.taskId,
        reason: context.reason,
        code: context.code,
        error: error.message,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: MAX_LIVENESS_TERMINATION_ATTEMPTS,
        delayMs,
      });
      agent._log(
        `[${agent.id}] Failed to terminate task (attempt ${attempt}/${MAX_LIVENESS_TERMINATION_ATTEMPTS}); ` +
          `retrying in ${delayMs}ms: ${error.message}`
      );
    });
}

function exhaustLivenessTermination(agent, context, terminationError) {
  if (agent.livenessCheckInterval) {
    clearInterval(agent.livenessCheckInterval);
    agent.livenessCheckInterval = null;
  }

  const attempts = agent.livenessTerminationAttempts;
  publishLivenessTerminationEvent(agent, context);
  const error = new Error(
    `Failed to terminate isolated task ${context.taskId} after ${attempts} attempts; ` +
      `the provider task may still be running. Manual recovery is required before resume. ` +
      `Last error: ${terminationError.message}`
  );
  error.code = 'ISOLATED_TASK_TERMINATION_EXHAUSTED';
  error.taskId = context.taskId;
  error.permanent = true;
  error.restartExhausted = true;
  error.terminationExhausted = true;
  error.terminationAttempts = attempts;
  error.retainTaskHandle = true;

  agent.state = 'error';
  agent.cluster.failureInfo = {
    agentId: agent.id,
    taskId: context.taskId,
    iteration: agent.iteration,
    type: 'task_termination',
    reason: 'termination_unverified',
    error: error.message,
    attempts,
    timestamp: Date.now(),
  };
  agent._publishLifecycle('AGENT_TERMINATION_EXHAUSTED', {
    taskId: context.taskId,
    reason: context.reason,
    code: error.code,
    terminationCode: context.code,
    attempts,
    maxAttempts: MAX_LIVENESS_TERMINATION_ATTEMPTS,
    error: terminationError.message,
    requiresManualRecovery: true,
  });

  if (typeof agent.currentTask?.failClosed === 'function') {
    agent.currentTask.failClosed(error);
    return;
  }

  agent._log(`[${agent.id}] ${error.message}`);
}

/**
 * Stop liveness monitoring
 * @param {AgentWrapper} agent - Agent instance
 */
function stopLivenessCheck(agent) {
  if (agent.livenessCheckInterval) {
    clearInterval(agent.livenessCheckInterval);
    agent.livenessCheckInterval = null;
  }
  agent.consecutiveStaleWarnings = 0;
  agent.livenessTerminationStarted = false;
  agent.livenessTerminationContext = null;
  agent.livenessTerminationAttempts = 0;
  agent.livenessTerminationRetryAt = 0;
}

module.exports = {
  start,
  stop,
  handleMessage,
  executeTriggerAction,
  executeTask,
  startLivenessCheck,
  stopLivenessCheck,
};
