const { isPlatformSupported } = require('./agent-stuck-detector');

function hasRecoverableTask(agent) {
  return (
    Boolean(agent.currentTask) ||
    Boolean(agent.isolation?.enabled && agent.currentTaskId) ||
    agent.nestedExecutions?.hasActive === true
  );
}

function handlePendingTermination(agent, settings, now, attemptTermination) {
  if (!agent.livenessTerminationContext) return false;
  if (now >= agent.livenessTerminationRetryAt) attemptTermination(agent, settings);
  return true;
}

function taskTiming(agent, now) {
  const taskStartedAt = agent.taskStartedAt || agent.lastOutputTime || now;
  const lastOutputTime = agent.lastOutputTime || taskStartedAt;
  return {
    taskRuntime: now - taskStartedAt,
    timeSinceLastOutput: now - lastOutputTime,
    lastOutputTime,
  };
}

function handleTaskTimeout(context, timing) {
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

function publishStaleWarning(context, timing) {
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

function terminateForInactivity(context, timing) {
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

function createLivenessPoll(context) {
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

module.exports = { createLivenessPoll };
