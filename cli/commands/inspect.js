const fs = require('fs');
const Orchestrator = require('../../src/orchestrator');
const { detectIdType } = require('../../lib/id-detector');
const { getTask } = require('../../task-lib/store.js');
const { isProcessRunning } = require('../../task-lib/runner.js');
const {
  getProcessMetrics,
  isPlatformSupported: metricsPlatformSupported,
} = require('../../src/process-metrics');
const {
  analyzeProcessHealth,
  isPlatformSupported: stuckDetectorPlatformSupported,
} = require('../../src/agent/agent-stuck-detector');
const { printClusterInspectionHuman, printTaskInspectionHuman } = require('./inspect-render');

const DEFAULT_SAMPLE_MS = 1000;
const TASK_STALE_WARNING_MS = 5 * 60 * 1000;

function parseSampleMs(rawValue) {
  const parsed = parseInt(rawValue ?? String(DEFAULT_SAMPLE_MS), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid sample period: ${rawValue}`);
  }
  return parsed;
}

function safeDate(dateString) {
  const date = new Date(dateString);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatAgeMs(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return 'unknown';
  }

  const totalSeconds = Math.floor(ageMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return `${hours}h ${minutes}m`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours}h`;
}

function inferActivity(metrics, health) {
  if (!metrics) {
    return 'unknown';
  }

  if (!metrics.exists) {
    return 'not-running';
  }

  if (health?.isLikelyStuck) {
    return 'likely-stuck';
  }

  if (metrics.cpuPercent >= 5) {
    return 'cpu-active';
  }

  if (metrics.network?.hasActivity) {
    return 'network-active';
  }

  if (metrics.childCount > 0) {
    return 'child-active';
  }

  if (metrics.state === 'R') {
    return 'running';
  }

  return 'idle';
}

function buildTaskWarnings(task, details) {
  const warnings = [];

  if (task.status === 'running' && task.pid && !details.processRunning) {
    warnings.push('task store says running but PID is not alive');
  }
  if (task.status === 'running' && task.logFile && !details.logFileExists) {
    warnings.push('task log file missing');
  }
  if (
    task.status === 'running' &&
    details.updatedAgeMs !== null &&
    details.updatedAgeMs > TASK_STALE_WARNING_MS
  ) {
    warnings.push(`task record stale for ${formatAgeMs(details.updatedAgeMs)}`);
  }

  return warnings;
}

function getOptionalPathState(filePath, existsSync) {
  return {
    path: filePath || null,
    exists: Boolean(filePath && existsSync(filePath)),
  };
}

function buildTaskDetails(task, now, existsSync) {
  const updatedAt = safeDate(task.updatedAt);
  const logFile = getOptionalPathState(task.logFile, existsSync);
  const socketPath = getOptionalPathState(task.socketPath, existsSync);

  return {
    updatedAgeMs: updatedAt ? now - updatedAt.getTime() : null,
    processRunning: task.pid ? isProcessRunning(task.pid) : false,
    logFile,
    socketPath,
  };
}

function formatUpdatedAgeHuman(updatedAgeMs) {
  return updatedAgeMs === null ? 'unknown' : formatAgeMs(updatedAgeMs);
}

function buildTaskSummary(task, details) {
  return {
    id: task.id,
    status: task.status,
    pid: task.pid || null,
    exitCode: task.exitCode ?? null,
    error: task.error || null,
    cwd: task.cwd || null,
    sessionId: task.sessionId || null,
    requestedResumeSessionId: task.requestedResumeSessionId || null,
    attachable: Boolean(task.attachable),
    socketPath: details.socketPath.path,
    socketPathExists: details.socketPath.exists,
    logFile: details.logFile.path,
    logFileExists: details.logFile.exists,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    updatedAgeMs: details.updatedAgeMs,
    updatedAgeHuman: formatUpdatedAgeHuman(details.updatedAgeMs),
    processRunning: details.processRunning,
    warnings: buildTaskWarnings(task, {
      ...details,
      logFileExists: details.logFile.exists,
      socketPathExists: details.socketPath.exists,
    }),
  };
}

function summarizeTaskRecord(task, now = Date.now(), existsSync = fs.existsSync) {
  if (!task) {
    return null;
  }

  return buildTaskSummary(task, buildTaskDetails(task, now, existsSync));
}

async function inspectProcess(pid, sampleMs, options = {}) {
  if (!pid) {
    return null;
  }

  const includeHealth = options.includeHealth !== false;
  const metricsPromise = metricsPlatformSupported()
    ? getProcessMetrics(pid, { samplePeriodMs: sampleMs })
    : Promise.resolve(null);
  const healthPromise =
    includeHealth && stuckDetectorPlatformSupported()
      ? analyzeProcessHealth(pid, sampleMs)
      : Promise.resolve(null);

  const [metrics, health] = await Promise.all([metricsPromise, healthPromise]);
  return {
    pid,
    metrics,
    health,
    activity: inferActivity(metrics, health),
  };
}

async function inspectAgent(agent, options, deps = {}) {
  const getTaskImpl = deps.getTask || getTask;
  const existsSync = deps.existsSync || fs.existsSync;

  const process = await inspectProcess(agent.pid, options.sampleMs);
  const task = agent.currentTaskId
    ? summarizeTaskRecord(getTaskImpl(agent.currentTaskId), Date.now(), existsSync)
    : null;

  const warnings = [];
  if (agent.currentTask && !agent.currentTaskId) {
    warnings.push('agent reports running task but currentTaskId is missing');
  }

  return {
    ...agent,
    process,
    task,
    warnings,
  };
}

async function buildClusterInspection(clusterId, options = {}, deps = {}) {
  const sampleMs = parseSampleMs(options.sampleMs);
  const orchestrator =
    deps.orchestrator ||
    (deps.createOrchestrator
      ? await deps.createOrchestrator()
      : await Orchestrator.create({ quiet: true }));

  const status = deps.status || orchestrator.getStatus(clusterId);
  const clusterProcess = await inspectProcess(status.pid, sampleMs, { includeHealth: false });
  const agents = await Promise.all(
    status.agents.map((agent) => inspectAgent(agent, { sampleMs }, deps))
  );

  return {
    type: 'cluster',
    id: clusterId,
    sampleMs,
    inspectedAt: new Date().toISOString(),
    cluster: status,
    process: clusterProcess,
    agents,
  };
}

async function buildTaskInspection(taskId, options = {}, deps = {}) {
  const sampleMs = parseSampleMs(options.sampleMs);
  const getTaskImpl = deps.getTask || getTask;
  const existsSync = deps.existsSync || fs.existsSync;
  const task = getTaskImpl(taskId);

  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  return {
    type: 'task',
    id: taskId,
    sampleMs,
    inspectedAt: new Date().toISOString(),
    task: summarizeTaskRecord(task, Date.now(), existsSync),
    process: await inspectProcess(task.pid, sampleMs),
  };
}

async function runInspectCommand(id, options = {}, deps = {}) {
  const type = deps.detectIdType ? deps.detectIdType(id) : detectIdType(id);

  if (!type) {
    throw new Error(`ID not found: ${id}`);
  }

  const inspection =
    type === 'cluster'
      ? await buildClusterInspection(id, options, deps)
      : await buildTaskInspection(id, options, deps);

  if (options.json) {
    console.log(JSON.stringify(inspection, null, 2));
    return inspection;
  }

  if (inspection.type === 'cluster') {
    printClusterInspectionHuman(inspection);
  } else {
    printTaskInspectionHuman(inspection);
  }

  return inspection;
}

module.exports = {
  DEFAULT_SAMPLE_MS,
  TASK_STALE_WARNING_MS,
  buildClusterInspection,
  buildTaskInspection,
  inferActivity,
  parseSampleMs,
  runInspectCommand,
  summarizeTaskRecord,
};
