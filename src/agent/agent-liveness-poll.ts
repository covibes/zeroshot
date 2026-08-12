interface AgentStuckDetectorModule {
  isPlatformSupported(): boolean;
}

interface LivenessIsolation {
  enabled?: boolean;
}

interface NestedExecutions {
  hasActive?: boolean;
}

interface LivenessAgent {
  currentTask?: unknown;
  currentTaskId?: unknown;
  isolation?: LivenessIsolation | null;
  nestedExecutions?: NestedExecutions | null;
  livenessTerminationStarted?: boolean;
  livenessTerminationContext?: unknown;
  livenessTerminationRetryAt: number;
  taskStartedAt?: number | null;
  lastOutputTime?: number | null;
  consecutiveStaleWarnings: number;
  _publishLifecycle(event: string, details: Record<string, unknown>): unknown;
}

interface TaskTiming {
  taskRuntime: number;
  timeSinceLastOutput: number;
  lastOutputTime: number;
}

type AttemptTermination = (agent: LivenessAgent, settings: unknown) => unknown;

type BeginTermination = (
  agent: LivenessAgent,
  settings: unknown,
  reason: string,
  code: string,
  eventData: Record<string, unknown>
) => unknown;

interface LivenessPollContext {
  agent: LivenessAgent;
  settings: unknown;
  configuredTimeout: number | null;
  staleDuration: number;
  warningsBeforeKill: number;
  attemptTermination: AttemptTermination;
  beginTermination: BeginTermination;
}

function isAgentStuckDetectorModule(value: unknown): value is AgentStuckDetectorModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isPlatformSupported' in value &&
    typeof value.isPlatformSupported === 'function'
  );
}

const agentStuckDetectorModule: unknown = require('./agent-stuck-detector');
if (!isAgentStuckDetectorModule(agentStuckDetectorModule)) {
  throw new TypeError('agent-stuck-detector must export isPlatformSupported');
}
const isPlatformSupported = agentStuckDetectorModule.isPlatformSupported;

function hasRecoverableTask(agent: LivenessAgent): boolean {
  return (
    Boolean(agent.currentTask) ||
    Boolean(agent.isolation?.enabled && agent.currentTaskId) ||
    agent.nestedExecutions?.hasActive === true
  );
}

function handlePendingTermination(
  agent: LivenessAgent,
  settings: unknown,
  now: number,
  attemptTermination: AttemptTermination
): boolean {
  if (!agent.livenessTerminationContext) return false;
  if (now >= agent.livenessTerminationRetryAt) attemptTermination(agent, settings);
  return true;
}

function taskTiming(agent: LivenessAgent, now: number): TaskTiming {
  const taskStartedAt = agent.taskStartedAt || agent.lastOutputTime || now;
  const lastOutputTime = agent.lastOutputTime || taskStartedAt;
  return {
    taskRuntime: now - taskStartedAt,
    timeSinceLastOutput: now - lastOutputTime,
    lastOutputTime,
  };
}

function handleTaskTimeout(context: LivenessPollContext, timing: TaskTiming): boolean {
  const { agent, settings, configuredTimeout, beginTermination } = context;
  if (!configuredTimeout || timing.taskRuntime < configuredTimeout) return false;
  beginTermination(
    agent,
    settings,
    `Task timed out after ${configuredTimeout}ms`,
    'AGENT_TASK_TIMEOUT',
    {
      taskId: agent.currentTaskId,
      taskRuntime: timing.taskRuntime,
      timeout: configuredTimeout,
    }
  );
  return true;
}

function publishStaleWarning(context: LivenessPollContext, timing: TaskTiming): void {
  const { agent, staleDuration, warningsBeforeKill } = context;
  agent.consecutiveStaleWarnings += 1;
  agent._publishLifecycle('AGENT_STALE_WARNING', {
    taskId: agent.currentTaskId,
    timeSinceLastOutput: timing.timeSinceLastOutput,
    staleDuration,
    lastOutputTime: timing.lastOutputTime,
    consecutiveWarnings: agent.consecutiveStaleWarnings,
    warningsBeforeKill,
    processDiagnosticsAvailable: isPlatformSupported(),
    analysis: `Provider produced no output for ${timing.timeSinceLastOutput}ms`,
  });
}

function terminateForInactivity(context: LivenessPollContext, timing: TaskTiming): void {
  const { agent, settings, staleDuration, beginTermination } = context;
  beginTermination(
    agent,
    settings,
    `Provider produced no output for ${timing.timeSinceLastOutput}ms`,
    'PROVIDER_INACTIVITY_TIMEOUT',
    {
      taskId: agent.currentTaskId,
      timeSinceLastOutput: timing.timeSinceLastOutput,
      staleDuration,
      consecutiveWarnings: agent.consecutiveStaleWarnings,
    }
  );
}

function createLivenessPoll(context: LivenessPollContext): () => void {
  const { agent, settings, staleDuration, warningsBeforeKill, attemptTermination } = context;
  return () => {
    if (!hasRecoverableTask(agent) || agent.livenessTerminationStarted) return;
    const now = Date.now();
    if (handlePendingTermination(agent, settings, now, attemptTermination)) return;
    const timing = taskTiming(agent, now);
    if (handleTaskTimeout(context, timing)) return;
    if (timing.timeSinceLastOutput < staleDuration) {
      agent.consecutiveStaleWarnings = 0;
      return;
    }
    publishStaleWarning(context, timing);
    if (agent.consecutiveStaleWarnings < warningsBeforeKill) return;
    terminateForInactivity(context, timing);
  };
}

export = { createLivenessPoll };
