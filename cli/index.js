#!/usr/bin/env node

/**
 * zeroshot CLI
 *
 * Commands:
 * - run: Start a multi-agent cluster
 * - list: List all clusters and tasks
 * - status: Get cluster/task status
 * - logs: View cluster/task logs
 * - stop: Stop a cluster gracefully
 * - kill: Force kill a task or cluster
 * - kill-all: Kill all running tasks and clusters
 * - export: Export cluster conversation
 */

const { program } = require('commander');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { URL } = require('url');
const chalk = require('chalk');
const Orchestrator = require('../src/orchestrator');
const { setupCompletion } = require('../lib/completion');
const { resolveRunMode, describeRunMode } = require('../lib/run-mode');
const { formatWatchMode } = require('./message-formatters-watch');
const {
  formatAgentLifecycle,
  formatAgentError: formatAgentErrorNormal,
  formatIssueOpened: formatIssueOpenedNormal,
  formatImplementationReady: formatImplementationReadyNormal,
  formatValidationResult: formatValidationResultNormal,
  formatPrCreated,
  formatClusterComplete,
  formatClusterFailed,
  formatGenericMessage,
} = require('./message-formatters-normal');
const {
  getColorForSender,
  buildMessagePrefix,
  buildClusterPrefix,
} = require('./message-formatter-utils');
const {
  loadSettings,
  saveSettings,
  validateSetting,
  coerceValue,
  DEFAULT_SETTINGS,
  settingsFileExists,
} = require('../lib/settings');
const { VALID_PROVIDERS, normalizeProviderName } = require('../lib/provider-names');
const { getProvider, parseProviderChunk } = require('../src/providers');
const { readClustersFileSync } = require('../lib/clusters-registry');
const { MOUNT_PRESETS, resolveEnvs } = require('../lib/docker-config');
const {
  detectGitRepoRoot,
  detectRunInput,
  isStdinInput,
  readStdinText,
  encodeStdinEnv,
  decodeStdinEnv,
  buildTextInput,
  loadClusterConfig,
  resolveConfigPath,
  resolveProviderOverride,
  startClusterFromFile,
  startClusterFromIssue,
  startClusterFromText,
} = require('../lib/start-cluster');
const { requirePreflight } = require('../src/preflight');
const { providersCommand, setDefaultCommand, setupCommand } = require('./commands/providers');
const { runInspectCommand } = require('./commands/inspect');
const { runCmdproof } = require('./commands/cmdproof');
const {
  markDetachedSetupFailed,
  patchDetachedResumeCluster,
  registerDetachedSetupCluster,
  removeDetachedSetupCluster,
  revertDetachedResumeCluster,
  waitForResumeOwnership,
} = require('../lib/detached-startup');
const { isProcessRunning: isClusterProcessAlive } = require('../lib/process-liveness');
// Setup wizard removed - use: zeroshot settings set <key> <value>
const { checkForUpdates, printLegacyDistroNotice } = require('./lib/update-checker');
const { checkBinDirOnPath, printPathWarning } = require('../lib/path-check');
const { StatusFooter, AGENT_STATE, ACTIVE_STATES } = require('../src/status-footer');
const { EVENT_COPY, formatMergeStatus } = require('./event-copy');

// =============================================================================
// GLOBAL ERROR HANDLERS - Prevent silent process death
// =============================================================================
// Track active cluster ID for cleanup on crash
/** @type {string | null} */
let activeClusterId = null;
/** @type {import('../src/orchestrator') | null} */
let orchestratorInstance = null;
const PROVIDER_CHOICES = VALID_PROVIDERS.join(', ');

// Track active status footer for safe output routing
// When set, all output routes through statusFooter.print() to prevent garbling
/** @type {import('../src/status-footer').StatusFooter | null} */
let activeStatusFooter = null;

/**
 * Safe print - routes through statusFooter when active to prevent garbling
 * @param {...any} args - Arguments to print (like console.log)
 */
function safePrint(...args) {
  const text = args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ');

  if (activeStatusFooter) {
    activeStatusFooter.print(text + '\n');
  } else {
    console.log(...args);
  }
}

/**
 * Safe write - routes through statusFooter when active
 * @param {string} text - Text to write
 */
function safeWrite(text) {
  if (activeStatusFooter) {
    activeStatusFooter.print(text);
  } else {
    process.stdout.write(text);
  }
}

/**
 * Handle fatal errors: log, cleanup cluster state, exit
 * @param {string} type - 'uncaughtException' or 'unhandledRejection'
 * @param {Error|unknown} error - The error that caused the crash
 */
function handleFatalError(type, error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : '';

  console.error(chalk.red(`\n${'='.repeat(80)}`));
  console.error(chalk.red.bold(`🔴 FATAL: ${type}`));
  console.error(chalk.red(`${'='.repeat(80)}`));
  console.error(chalk.red(`Error: ${errorMessage}`));
  if (errorStack) {
    console.error(chalk.dim(errorStack));
  }
  console.error(chalk.red(`${'='.repeat(80)}\n`));

  // Try to update cluster state to 'failed' before exiting
  if (activeClusterId && orchestratorInstance) {
    try {
      console.error(chalk.yellow(`Attempting to mark cluster ${activeClusterId} as failed...`));
      const cluster = orchestratorInstance.clusters.get(activeClusterId);
      if (cluster) {
        cluster.state = 'failed';
        cluster.pid = null;
        cluster.failureInfo = {
          type,
          error: errorMessage,
          timestamp: Date.now(),
        };
        orchestratorInstance._saveClusters();
        console.error(chalk.yellow(`Cluster ${activeClusterId} marked as failed.`));
      }
    } catch (cleanupErr) {
      const errMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.error(chalk.red(`Failed to update cluster state: ${errMsg}`));
    }
  }

  process.exit(1);
}

process.on('uncaughtException', (error) => {
  handleFatalError('Uncaught Exception', error);
});

process.on('unhandledRejection', (reason) => {
  handleFatalError('Unhandled Promise Rejection', reason);
});
// =============================================================================

// Package root directory (for resolving default config paths)
const PACKAGE_ROOT = path.resolve(__dirname, '..');

function normalizeRunOptions(options) {
  if (options.ship) {
    options.pr = true;
    if (!options.docker) {
      options.worktree = true;
    }
  }
  if (options.pr && !options.docker && !options.worktree) {
    options.worktree = true;
  }
  if (options.docker) {
    options.worktree = false;
  }
  // autoMerge is NOT stored here — it is derived from the run plan (delivery ===
  // 'ship') at every consumer. Writing it here unconditionally would clobber an
  // explicit autoMerge intent (e.g. a future `--auto-merge` flag) back to false.
}

async function runClusterPreflight({ input, options, providerOverride, settings, forceProvider }) {
  // Detect which issue provider tool is needed
  let issueProvider = null;
  let targetHost = null;

  if (input.issue) {
    const { detectProvider: detectIssueProvider } = require('../src/issue-providers');
    const ProviderClass = detectIssueProvider(input.issue, settings, forceProvider);
    if (ProviderClass) {
      issueProvider = ProviderClass.id;
    }

    // Extract hostname from URL input for auth checks
    // This ensures we check auth for the target host, not the current git repo
    if (/^https?:\/\//.test(input.issue)) {
      try {
        const url = new URL(input.issue);
        targetHost = url.hostname;
      } catch {
        // Invalid URL - let provider handle the error
      }
    }
  }

  await requirePreflight({
    requireGh: issueProvider === 'github', // gh CLI required for GitHub
    requireDocker: options.docker,
    requireGit: options.worktree,
    quiet: process.env.ZEROSHOT_DAEMON === '1',
    provider: providerOverride,
    issueProvider, // Pass detected issue provider for tool checking
    targetHost, // Pass target host for multi-instance auth checks (e.g., GitLab self-hosted)
  });
}

function shouldRunDetached(options) {
  return options.detach && !process.env.ZEROSHOT_DAEMON;
}

function printDetachedClusterStart(options, clusterId, logPath) {
  const runMode = resolveRunMode(options);
  console.log(runMode ? `Started ${clusterId} (${runMode})` : `Started ${clusterId}`);
  if (logPath) {
    console.log(`Setup log: ${logPath}`);
  }
  console.log(`Monitor: zeroshot logs ${clusterId} -f`);
  console.log(`Attach:  zeroshot attach ${clusterId}`);
}

function createDaemonLogFile(logName) {
  const storageDir = path.join(os.homedir(), '.zeroshot');
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  const logPath = path.join(storageDir, `${logName}-daemon.log`);
  return fs.openSync(logPath, 'w');
}

function serializeRunOptions(options) {
  try {
    return JSON.stringify(options);
  } catch {
    return '';
  }
}

function resolveMergeQueueEnv(value) {
  if (value === true) return '1';
  if (value === false) return '0';
  return '';
}

function buildDaemonEnv(options, clusterId, targetCwd, stdinText) {
  const mergeQueueEnv = resolveMergeQueueEnv(options.mergeQueue);
  const runOptionsEnv = serializeRunOptions(options);
  return {
    ...process.env,
    ZEROSHOT_DAEMON: '1',
    ZEROSHOT_CLUSTER_ID: clusterId,
    ZEROSHOT_DOCKER: options.docker ? '1' : '',
    ZEROSHOT_DOCKER_IMAGE: options.dockerImage || '',
    ZEROSHOT_PR: options.pr ? '1' : '',
    ZEROSHOT_WORKTREE: options.worktree ? '1' : '',
    ZEROSHOT_WORKERS: options.workers?.toString() || '',
    ZEROSHOT_MODEL: options.model || '',
    ZEROSHOT_PROVIDER: options.provider || '',
    ZEROSHOT_RUN_OPTIONS: runOptionsEnv,
    ZEROSHOT_PR_BASE: options.prBase || '',
    ZEROSHOT_MERGE_QUEUE: mergeQueueEnv,
    ZEROSHOT_CLOSE_ISSUE: options.closeIssue || '',
    ZEROSHOT_CWD: targetCwd,
    ZEROSHOT_STDIN_TASK: stdinText !== undefined ? encodeStdinEnv(stdinText) : '',
  };
}

// Generic detached-child primitive shared by `run --detach` and
// `resume --detach`: spawn a re-invocation of this same CLI (same argv) with
// daemon env vars set, detach it from this process, and return its PID.
// Callers own registering/patching cluster state around the spawn - this
// function knows nothing about run vs. resume.
function spawnDetachedChild(env, cwd, logFd) {
  const { spawn } = require('child_process');
  const daemon = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd,
    env,
  });
  daemon.unref();
  return daemon;
}

async function spawnDetachedCluster(options, clusterId, stdinText) {
  const logFd = createDaemonLogFile(clusterId);
  const targetCwd = detectGitRepoRoot();
  const logPath = path.join(os.homedir(), '.zeroshot', `${clusterId}-daemon.log`);
  const daemon = spawnDetachedChild(
    buildDaemonEnv(options, clusterId, targetCwd, stdinText),
    targetCwd,
    logFd
  );
  await registerDetachedSetupCluster({
    clusterId,
    pid: daemon.pid,
    storageDir: path.join(os.homedir(), '.zeroshot'),
    logPath,
    runOptions: options,
    cwd: targetCwd,
  });
  fs.closeSync(logFd);
  printDetachedClusterStart(options, clusterId, logPath);
}

// Resume's daemon env is deliberately NOT buildDaemonEnv: run-only keys like
// ZEROSHOT_DOCKER/ZEROSHOT_WORKTREE/ZEROSHOT_PR are derived by resume from
// the cluster's own persisted state, and spreading them here would fight
// that. The resumed process needs only to know it's the daemon and which
// cluster it owns; `id`/`prompt` already travel as plain argv (commander
// re-parses the same argv in the child), not through env.
function buildResumeDaemonEnv(clusterId, targetCwd) {
  return {
    ...process.env,
    ZEROSHOT_DAEMON: '1',
    ZEROSHOT_CLUSTER_ID: clusterId,
    ZEROSHOT_CWD: targetCwd,
  };
}

// Parent-side half of `resume --detach`: spawn the daemon, then atomically
// hand it ownership of the cluster record (patchDetachedResumeCluster).
// If another live daemon already owns this cluster (a concurrent resume
// won the race), abort and kill the child we just spawned rather than
// leaving a duplicate process running.
async function spawnDetachedResume(clusterId) {
  const logFd = createDaemonLogFile(`${clusterId}-resume`);
  const targetCwd = detectGitRepoRoot();
  const logPath = path.join(os.homedir(), '.zeroshot', `${clusterId}-resume-daemon.log`);
  const storageDir = path.join(os.homedir(), '.zeroshot');
  const daemon = spawnDetachedChild(buildResumeDaemonEnv(clusterId, targetCwd), targetCwd, logFd);

  try {
    await patchDetachedResumeCluster({ clusterId, daemonPid: daemon.pid, storageDir });
  } catch (patchError) {
    try {
      process.kill(daemon.pid, 'SIGTERM');
    } catch {
      // Already gone - nothing to clean up.
    }
    fs.closeSync(logFd);
    throw patchError;
  }

  fs.closeSync(logFd);
  return { pid: daemon.pid, logPath };
}

function resolveClusterId(generateName) {
  const clusterId = process.env.ZEROSHOT_CLUSTER_ID || generateName('cluster');
  process.env.ZEROSHOT_CLUSTER_ID = clusterId;
  return clusterId;
}

function resolveConfigName(options, settings) {
  return options.config || settings.defaultConfig;
}

function trackActiveCluster(clusterId, orchestrator) {
  activeClusterId = clusterId;
  orchestratorInstance = orchestrator;
}

function printForegroundStartInfo(options, clusterId, configName) {
  if (process.env.ZEROSHOT_DAEMON) {
    return;
  }
  const runMode = resolveRunMode(options);
  console.log(runMode ? `Starting ${clusterId} (${runMode})` : `Starting ${clusterId}`);
  console.log(chalk.dim(`Config: ${configName}`));
  console.log(chalk.dim('Ctrl+C to stop following (cluster keeps running)\n'));
}

function resolveStrictSchema(options, settings) {
  return (
    options.strictSchema || process.env.ZEROSHOT_STRICT_SCHEMA === '1' || settings.strictSchema
  );
}

function applyStrictSchema(config, strictSchema) {
  if (!strictSchema) {
    return;
  }
  for (const agent of config.agents) {
    agent.strictSchema = true;
  }
}

function resolveModelOverride(options) {
  return options.model || process.env.ZEROSHOT_MODEL;
}

function applyModelOverrideToConfig(config, modelOverride, providerOverride, settings) {
  if (!modelOverride) {
    return;
  }

  const providerName = normalizeProviderName(
    providerOverride || config.defaultProvider || settings.defaultProvider || 'claude'
  );
  const provider = getProvider(providerName);
  try {
    provider.validateModelId(modelOverride);
  } catch (err) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }

  if (providerName === 'claude') {
    const { validateModelAgainstMax, VALID_MODELS } = require('../lib/settings');
    if (VALID_MODELS.includes(modelOverride)) {
      try {
        validateModelAgainstMax(modelOverride, settings.maxModel);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    }
  }

  for (const agent of config.agents) {
    agent.model = modelOverride;
    if (agent.modelRules) {
      delete agent.modelRules;
    }
  }
  console.log(chalk.dim(`Model override: ${modelOverride} (all agents)`));
}

function createStatusFooter(clusterId, messageBus, runMode) {
  const statusFooter = new StatusFooter({
    refreshInterval: 1000,
    enabled: process.stdout.isTTY,
  });
  statusFooter.setCluster(clusterId);
  statusFooter.setClusterState('running');
  statusFooter.setRunMode(runMode);
  statusFooter.setMessageBus(messageBus);
  activeStatusFooter = statusFooter;
  return statusFooter;
}

function createLifecycleHandler(statusFooter) {
  return (msg) => {
    const data = msg.content?.data || {};
    const event = data.event;
    const agentId = data.agent || msg.sender;

    if (event === 'STARTED') {
      statusFooter.updateAgent({
        id: agentId,
        state: AGENT_STATE.IDLE,
        processPid: null,
        iteration: data.iteration || 0,
      });
      return;
    }

    if (event === 'TASK_STARTED') {
      statusFooter.updateAgent({
        id: agentId,
        state: AGENT_STATE.EXECUTING_TASK,
        processPid: statusFooter.agents.get(agentId)?.processPid || null,
        iteration: data.iteration || 0,
      });
      return;
    }

    if (event === 'PROCESS_SPAWNED') {
      const current = statusFooter.agents.get(agentId) || { iteration: 0 };
      statusFooter.updateAgent({
        id: agentId,
        state: AGENT_STATE.EXECUTING_TASK,
        processPid: data.pid,
        iteration: current.iteration,
      });
      return;
    }

    if (event === 'TASK_COMPLETED' || event === 'TASK_FAILED') {
      statusFooter.updateAgent({
        id: agentId,
        state: AGENT_STATE.IDLE,
        processPid: null,
        iteration: data.iteration || 0,
      });
      return;
    }

    if (event === 'STOPPED') {
      statusFooter.removeAgent(agentId);
    }
  };
}

function replayLifecycleMessages(cluster, clusterId, handler) {
  const historicalLifecycle = cluster.messageBus
    .getAll(clusterId)
    .filter((msg) => msg.topic === 'AGENT_LIFECYCLE');
  for (const msg of historicalLifecycle) {
    handler(msg);
  }
}

function createClusterMessageHandler(clusterId, processedMessageIds, sendersWithOutput) {
  return (msg) => {
    if (msg.cluster_id !== clusterId) return;
    if (processedMessageIds.has(msg.id)) return;
    processedMessageIds.add(msg.id);

    if (msg.topic === 'AGENT_OUTPUT' && msg.sender) {
      sendersWithOutput.add(msg.sender);
    }
    printMessage(msg, false, false, true);
  };
}

function replayClusterMessages(cluster, clusterId, handler) {
  const historicalMessages = cluster.messageBus.getAll(clusterId);
  for (const msg of historicalMessages) {
    handler(msg);
  }
}

function flushForegroundSenders(sendersWithOutput) {
  for (const sender of sendersWithOutput) {
    const prefix = getColorForSender(sender)(`${sender.padEnd(15)} |`);
    flushLineBuffer(prefix, sender);
  }
}

function createForegroundCleanup({
  statusFooter,
  lifecycleUnsubscribe,
  unsubscribe,
  flushInterval,
  sendersWithOutput,
}) {
  const stop = () => {
    clearInterval(flushInterval);
    lifecycleUnsubscribe();
    unsubscribe();
    statusFooter.stop();
    activeStatusFooter = null;
  };

  const stopWithFlush = () => {
    flushForegroundSenders(sendersWithOutput);
    stop();
  };

  return { stop, stopWithFlush };
}

function setupForegroundSigintHandler({ orchestrator, clusterId, cleanup, stopChecking }) {
  const handler = async () => {
    cleanup.stop();
    stopChecking();
    console.log(chalk.dim('\n\n--- Interrupted ---'));

    try {
      console.log(chalk.dim(`Stopping cluster ${clusterId}...`));
      await orchestrator.stop(clusterId);
      console.log(chalk.dim(`Cluster ${clusterId} stopped.`));
    } catch (stopErr) {
      console.error(chalk.red(`Failed to stop cluster: ${stopErr.message}`));
    }

    process.exit(0);
  };

  process.on('SIGINT', handler);
  return () => {
    process.off('SIGINT', handler);
  };
}

function waitForClusterCompletion(orchestrator, clusterId, cleanup) {
  return new Promise((resolve) => {
    let checkInterval;
    const stopChecking = () => {
      if (checkInterval) {
        clearInterval(checkInterval);
      }
    };
    const removeSigint = setupForegroundSigintHandler({
      orchestrator,
      clusterId,
      cleanup,
      stopChecking,
    });

    const finish = (finalizer) => {
      stopChecking();
      removeSigint();
      finalizer();
      resolve();
    };

    checkInterval = setInterval(() => {
      try {
        const status = orchestrator.getStatus(clusterId);
        if (status.state !== 'running') {
          finish(cleanup.stopWithFlush);
        }
      } catch {
        finish(cleanup.stop);
      }
    }, 500);
  });
}

async function streamClusterInForeground(cluster, orchestrator, clusterId, options) {
  const sendersWithOutput = new Set();
  const processedMessageIds = new Set();

  const statusFooter = createStatusFooter(clusterId, cluster.messageBus, resolveRunMode(options));
  const handleLifecycleMessage = createLifecycleHandler(statusFooter);
  const lifecycleUnsubscribe = cluster.messageBus.subscribeTopic(
    'AGENT_LIFECYCLE',
    handleLifecycleMessage
  );
  replayLifecycleMessages(cluster, clusterId, handleLifecycleMessage);
  statusFooter.start();

  const handleMessage = createClusterMessageHandler(
    clusterId,
    processedMessageIds,
    sendersWithOutput
  );
  const unsubscribe = cluster.messageBus.subscribe(handleMessage);
  replayClusterMessages(cluster, clusterId, handleMessage);

  const flushInterval = setInterval(() => {
    flushForegroundSenders(sendersWithOutput);
  }, 250);

  const cleanup = createForegroundCleanup({
    statusFooter,
    lifecycleUnsubscribe,
    unsubscribe,
    flushInterval,
    sendersWithOutput,
  });

  await waitForClusterCompletion(orchestrator, clusterId, cleanup);
  console.log(chalk.dim(`\nCluster ${clusterId} completed.`));
}

function setupDaemonCleanup(orchestrator, clusterId) {
  if (!process.env.ZEROSHOT_DAEMON) {
    return;
  }

  const cleanup = async (signal) => {
    console.log(`\n[DAEMON] Received ${signal}, cleaning up cluster ${clusterId}...`);
    try {
      await orchestrator.stop(clusterId);
      console.log(`[DAEMON] Cluster ${clusterId} stopped.`);
    } catch (e) {
      console.error(`[DAEMON] Cleanup error: ${e.message}`);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));
}

function readClusterTokenTotals(orchestrator, clusterId) {
  try {
    const clusterObj = orchestrator.getCluster(clusterId);
    if (!clusterObj?.messageBus) {
      return { totalTokens: 0, totalCostUsd: 0 };
    }
    const { tokensByRole } = clusterObj.messageBus.readSnapshot(clusterId);
    const total = tokensByRole?._total;
    if (!total || total.count === 0) {
      return { totalTokens: 0, totalCostUsd: 0 };
    }
    return {
      totalTokens: (total.inputTokens || 0) + (total.outputTokens || 0),
      totalCostUsd: total.totalCostUsd || 0,
    };
  } catch (error) {
    // A confirmed-empty ledger (0) and a failed read must stay distinguishable -
    // fabricating 0 here is what produced phantom "msgs=0 $0" rows in `list --json`.
    console.error(
      `[cli] Failed to read token totals for cluster ${clusterId}: ${error.message || String(error)}`
    );
    return { totalTokens: null, totalCostUsd: null };
  }
}

function enrichClustersWithTokens(clusters, orchestrator) {
  return clusters.map((cluster) => {
    const totals = readClusterTokenTotals(orchestrator, cluster.id);
    return {
      ...cluster,
      ...totals,
    };
  });
}

function filterClustersByStatus(clusters, status) {
  if (!status) {
    return clusters;
  }
  return clusters.filter((cluster) => cluster.state === status);
}

function formatClusterRow(cluster) {
  const created = new Date(cluster.createdAt).toLocaleString();
  const tokenDisplay = cluster.totalTokens > 0 ? cluster.totalTokens.toLocaleString() : '-';
  const costDisplay = cluster.totalCostUsd > 0 ? '$' + cluster.totalCostUsd.toFixed(3) : '-';

  const stateDisplay =
    cluster.state === 'zombie' ? chalk.red(cluster.state.padEnd(12)) : cluster.state.padEnd(12);
  const rowColor = cluster.state === 'zombie' ? chalk.red : (text) => text;
  const modeDisplay = (cluster.runMode || '-').padEnd(10);

  return `${rowColor(cluster.id.padEnd(25))} ${stateDisplay} ${modeDisplay} ${cluster.agentCount
    .toString()
    .padEnd(8)} ${tokenDisplay.padEnd(12)} ${costDisplay.padEnd(8)} ${created}`;
}

function printClusterTable(enrichedClusters) {
  if (enrichedClusters.length === 0) {
    console.log(chalk.dim('\n=== Clusters ==='));
    console.log('No active clusters');
    return;
  }

  console.log(chalk.bold('\n=== Clusters ==='));
  console.log(
    `${'ID'.padEnd(25)} ${'State'.padEnd(12)} ${'Mode'.padEnd(10)} ${'Agents'.padEnd(
      8
    )} ${'Tokens'.padEnd(12)} ${'Cost'.padEnd(8)} Created`
  );
  console.log('-'.repeat(110));
  for (const cluster of enrichedClusters) {
    console.log(formatClusterRow(cluster));
  }
}

async function tryGetTasksData(getTasksData, options) {
  if (typeof getTasksData !== 'function') {
    return [];
  }
  try {
    return await getTasksData(options);
  } catch {
    return [];
  }
}

function printListJson(enrichedClusters, tasks) {
  console.log(
    JSON.stringify(
      {
        clusters: enrichedClusters,
        tasks,
      },
      null,
      2
    )
  );
}

function reportMissingId(id, options) {
  if (options.json) {
    console.log(JSON.stringify({ error: 'ID not found', id }, null, 2));
  } else {
    console.error(`ID not found: ${id}`);
    console.error('Not found in tasks or clusters');
  }
  process.exit(1);
}

function getClusterTokensByRole(orchestrator, clusterId) {
  try {
    const cluster = orchestrator.getCluster(clusterId);
    if (!cluster?.messageBus) {
      return null;
    }
    return cluster.messageBus.readSnapshot(clusterId).tokensByRole;
  } catch (error) {
    console.error(
      `[cli] Failed to read tokens by role for cluster ${clusterId}: ${error.message || String(error)}`
    );
    return null;
  }
}

function printClusterStatusJson(status, tokensByRole) {
  console.log(
    JSON.stringify(
      {
        type: 'cluster',
        ...status,
        createdAtISO: new Date(status.createdAt).toISOString(),
        tokensByRole,
      },
      null,
      2
    )
  );
}

function printClusterStatusHeader(status, clusterId) {
  console.log(`\nCluster: ${status.id}`);
  if (status.isZombie) {
    console.log(
      chalk.red(
        `State: ${status.state} (process ${status.pid} died, cluster has no backing process)`
      )
    );
    console.log(
      chalk.yellow(
        `  → Run 'zeroshot kill ${clusterId}' to clean up, or 'zeroshot resume ${clusterId}' to restart`
      )
    );
  } else {
    console.log(`State: ${status.state}`);
  }
  if (status.runMode) {
    console.log(`Mode: ${describeRunMode(status.runMode)}`);
  }
  if (status.pid) {
    console.log(`PID: ${status.pid}`);
  }
  if (status.setupStage) {
    console.log(`Setup: ${status.setupStage}`);
  }
  if (status.setupLogPath) {
    console.log(`Setup log: ${status.setupLogPath}`);
  }
  if (status.failureInfo?.error) {
    console.log(`Failure: ${status.failureInfo.error}`);
  }
  console.log(`Created: ${new Date(status.createdAt).toLocaleString()}`);
  console.log(`Messages: ${status.messageCount}`);
}

function printClusterTokenUsage(tokensByRole) {
  if (!tokensByRole) {
    return;
  }
  const tokenLines = formatTokenUsage(tokensByRole);
  if (!tokenLines) {
    return;
  }
  console.log('');
  for (const line of tokenLines) {
    console.log(line);
  }
}

function printClusterAgent(agent) {
  if (agent.type === 'subcluster') {
    console.log(`  - ${agent.id} (${agent.role}) [SubCluster]`);
    console.log(`    State: ${agent.state}`);
    console.log(`    Iteration: ${agent.iteration}`);
    console.log(`    Child Cluster: ${agent.childClusterId || 'none'}`);
    console.log(`    Child Running: ${agent.childRunning ? 'Yes' : 'No'}`);
    return;
  }
  const modelLabel = agent.model ? ` [${agent.model}]` : '';
  console.log(`  - ${agent.id} (${agent.role})${modelLabel}`);
  console.log(`    State: ${agent.state}`);
  console.log(`    Iteration: ${agent.iteration}`);
  console.log(`    Running task: ${agent.currentTask ? 'Yes' : 'No'}`);
}

function printClusterAgents(status) {
  console.log(`\nAgents:`);
  for (const agent of status.agents) {
    printClusterAgent(agent);
  }
  console.log('');
}

function printClusterStatusHuman(status, tokensByRole, clusterId) {
  printClusterStatusHeader(status, clusterId);
  printClusterTokenUsage(tokensByRole);
  printClusterAgents(status);
}

async function tryGetTaskStatusData(getStatusData, id) {
  if (typeof getStatusData !== 'function') {
    return null;
  }
  try {
    return await getStatusData(id);
  } catch {
    return null;
  }
}

async function showTaskStatus(id, options) {
  const { showStatus, getStatusData } = await import('../task-lib/commands/status.js');
  if (options.json) {
    const taskData = await tryGetTaskStatusData(getStatusData, id);
    console.log(JSON.stringify({ type: 'task', id, ...taskData }, null, 2));
    return;
  }
  await showStatus(id);
}

async function showTaskLogs(id, options) {
  const { showLogs } = await import('../task-lib/commands/logs.js');
  await showLogs(id, options);
}

async function handleLogsById(id, options) {
  const { detectIdType } = require('../lib/id-detector');
  const type = detectIdType(id);

  if (!type) {
    console.error(`ID not found: ${id}`);
    process.exit(1);
  }

  if (type === 'task') {
    await showTaskLogs(id, options);
    return true;
  }

  return false;
}

function parseLogLimit(options) {
  return parseInt(options.limit, 10);
}

function printClusterFollowHeader(allClusters, activeClusters) {
  if (activeClusters.length === 0) {
    console.log(
      chalk.dim(
        `--- Showing history from ${allClusters.length} cluster(s), waiting for new activity (Ctrl+C to stop) ---\n`
      )
    );
    return;
  }
  if (activeClusters.length === 1) {
    console.log(chalk.dim(`--- Following ${activeClusters[0].id} (Ctrl+C to stop) ---\n`));
    return;
  }
  console.log(
    chalk.dim(`--- Following ${activeClusters.length} active clusters (Ctrl+C to stop) ---`)
  );
  for (const cluster of activeClusters) {
    console.log(chalk.dim(`    • ${cluster.id} [${cluster.state}]`));
  }
  console.log('');
}

function printClusterHistory(quietOrchestrator, allClusters, limit, options) {
  for (const clusterInfo of allClusters) {
    const cluster = quietOrchestrator.getCluster(clusterInfo.id);
    if (!cluster) {
      continue;
    }
    const messages = cluster.messageBus.getAll(clusterInfo.id);
    const recentMessages = messages.slice(-limit);
    const isActive = clusterInfo.state === 'running';
    for (const msg of recentMessages) {
      printMessage(msg, clusterInfo.id, options.watch, isActive);
    }
  }
}

function collectClusterTaskTitles(quietOrchestrator, allClusters) {
  const taskTitles = [];
  for (const clusterInfo of allClusters) {
    const cluster = quietOrchestrator.getCluster(clusterInfo.id);
    if (!cluster) {
      continue;
    }
    const messages = cluster.messageBus.getAll(clusterInfo.id);
    const issueOpened = messages.find((m) => m.topic === 'ISSUE_OPENED');
    if (issueOpened) {
      taskTitles.push({
        id: clusterInfo.id,
        summary: formatTaskSummary(issueOpened, 30),
      });
    }
  }
  return taskTitles;
}

function setTerminalTitleForClusters(taskTitles) {
  if (taskTitles.length === 1) {
    setTerminalTitle(`zeroshot [${taskTitles[0].id}]: ${taskTitles[0].summary}`);
    return;
  }
  if (taskTitles.length > 1) {
    setTerminalTitle(`zeroshot: ${taskTitles.length} clusters`);
    return;
  }
  setTerminalTitle('zeroshot: waiting...');
}

function printInitialWatchTasks(quietOrchestrator, allClusters, multiCluster) {
  for (const clusterInfo of allClusters) {
    const cluster = quietOrchestrator.getCluster(clusterInfo.id);
    if (!cluster) {
      continue;
    }
    const messages = cluster.messageBus.getAll(clusterInfo.id);
    const issueOpened = messages.find((m) => m.topic === 'ISSUE_OPENED');
    if (!issueOpened) {
      continue;
    }
    const clusterLabel = multiCluster ? `[${clusterInfo.id}] ` : '';
    const taskSummary = formatTaskSummary(issueOpened);
    console.log(chalk.cyan(`${clusterLabel}Task: ${chalk.bold(taskSummary)}\n`));
  }
}

function buildClusterStatesMap(allClusters) {
  const clusterStates = new Map();
  for (const cluster of allClusters) {
    clusterStates.set(cluster.id, cluster.state);
  }
  return clusterStates;
}

function createLogsStatusFooter(allClusters, clusterStates, options) {
  if (!process.stdout.isTTY) {
    return null;
  }
  if (!options.follow && !options.watch) {
    return null;
  }
  const statusFooter = new StatusFooter({
    refreshInterval: 1000,
    enabled: true,
  });
  if (allClusters.length > 0) {
    statusFooter.setCluster(allClusters[0].id);
    statusFooter.setClusterState(clusterStates.get(allClusters[0].id) || 'running');
  }
  activeStatusFooter = statusFooter;
  statusFooter.start();
  return statusFooter;
}

function collectSendersFromBuffer(messageBuffer) {
  const sendersWithOutput = new Set();
  for (const msg of messageBuffer) {
    if (msg.topic === 'AGENT_OUTPUT' && msg.sender) {
      sendersWithOutput.add(msg.sender);
    }
  }
  return sendersWithOutput;
}

function flushBufferedSenders(sendersWithOutput, clusterId) {
  for (const sender of sendersWithOutput) {
    const senderLabel = `${clusterId || ''}/${sender}`;
    const prefix = getColorForSender(sender)(`${senderLabel.padEnd(25)} |`);
    flushLineBuffer(prefix, sender);
  }
}

function buildMessageBufferFlusher({ messageBuffer, options, clusterStates, statusFooter }) {
  const handleLifecycleMessage = statusFooter ? createLifecycleHandler(statusFooter) : null;
  return () => {
    if (messageBuffer.length === 0) {
      return;
    }
    messageBuffer.sort((a, b) => a.timestamp - b.timestamp);
    const sendersWithOutput = collectSendersFromBuffer(messageBuffer);
    for (const msg of messageBuffer) {
      if (msg.topic === 'AGENT_LIFECYCLE' && handleLifecycleMessage) {
        handleLifecycleMessage(msg);
      }
      const isActive = clusterStates.get(msg.cluster_id) === 'running';
      printMessage(msg, true, options.watch, isActive);
    }
    const firstClusterId = messageBuffer[0]?.cluster_id;
    messageBuffer.length = 0;
    flushBufferedSenders(sendersWithOutput, firstClusterId);
  };
}

function addClusterPollers(quietOrchestrator, allClusters, messageBuffer, stopPollers) {
  for (const clusterInfo of allClusters) {
    const cluster = quietOrchestrator.getCluster(clusterInfo.id);
    if (!cluster) {
      continue;
    }
    const stopPoll = cluster.ledger.pollForMessages(
      clusterInfo.id,
      (msg) => {
        messageBuffer.push(msg);
      },
      300
    );
    stopPollers.push(stopPoll);
  }
}

function watchForNewClusters(quietOrchestrator, clusterStates, messageBuffer, stopPollers) {
  return quietOrchestrator.watchForNewClusters((newCluster) => {
    console.log(chalk.green(`\n✓ New cluster detected: ${newCluster.id}\n`));
    clusterStates.set(newCluster.id, 'running');
    const stopPoll = newCluster.ledger.pollForMessages(
      newCluster.id,
      (msg) => {
        messageBuffer.push(msg);
      },
      300
    );
    stopPollers.push(stopPoll);
  });
}

function cleanupClusterFollow({
  flushInterval,
  flushMessages,
  stopPollers,
  stopWatching,
  statusFooter,
}) {
  clearInterval(flushInterval);
  flushMessages();
  stopPollers.forEach((stop) => stop());
  stopWatching();
  if (statusFooter) {
    statusFooter.stop();
    activeStatusFooter = null;
  }
  restoreTerminalTitle();
}

function followAllClusters(quietOrchestrator, allClusters, options, multiCluster) {
  const taskTitles = collectClusterTaskTitles(quietOrchestrator, allClusters);
  setTerminalTitleForClusters(taskTitles);

  if (options.watch) {
    printInitialWatchTasks(quietOrchestrator, allClusters, multiCluster);
  }

  const stopPollers = [];
  const messageBuffer = [];
  const clusterStates = buildClusterStatesMap(allClusters);
  const statusFooter = createLogsStatusFooter(allClusters, clusterStates, options);

  // Replay historical lifecycle messages to initialize agent states
  // Without this, agents that completed before logs -f started show "(starting...)"
  if (statusFooter) {
    const lifecycleHandler = createLifecycleHandler(statusFooter);
    for (const clusterInfo of allClusters) {
      const cluster = quietOrchestrator.getCluster(clusterInfo.id);
      if (cluster) {
        replayLifecycleMessages(cluster, clusterInfo.id, lifecycleHandler);
      }
    }
  }

  const flushMessages = buildMessageBufferFlusher({
    messageBuffer,
    options,
    clusterStates,
    statusFooter,
  });
  const flushInterval = setInterval(flushMessages, 250);

  addClusterPollers(quietOrchestrator, allClusters, messageBuffer, stopPollers);
  const stopWatching = watchForNewClusters(
    quietOrchestrator,
    clusterStates,
    messageBuffer,
    stopPollers
  );

  keepProcessAlive(() => {
    cleanupClusterFollow({
      flushInterval,
      flushMessages,
      stopPollers,
      stopWatching,
      statusFooter,
    });
  });
}

function showAllClusterLogs(quietOrchestrator, options, limit) {
  const allClusters = quietOrchestrator.listClusters();
  const activeClusters = allClusters.filter((cluster) => cluster.state === 'running');

  if (allClusters.length === 0) {
    if (options.follow) {
      console.log('No clusters found. Waiting for new clusters...\n');
      console.log(chalk.dim('--- Waiting for clusters (Ctrl+C to stop) ---\n'));
    } else {
      console.log('No clusters found');
      return;
    }
  }

  const multiCluster = allClusters.length > 1;
  if (options.follow && allClusters.length > 0) {
    printClusterFollowHeader(allClusters, activeClusters);
  }

  printClusterHistory(quietOrchestrator, allClusters, limit, options);

  if (options.follow) {
    followAllClusters(quietOrchestrator, allClusters, options, multiCluster);
  }
}

function getClusterOrExit(quietOrchestrator, id) {
  const cluster = quietOrchestrator.getCluster(id);
  if (!cluster) {
    console.error(`Cluster ${id} not found`);
    process.exit(1);
  }
  return cluster;
}

function getClusterActiveState(quietOrchestrator, id) {
  const clusterInfo = quietOrchestrator.listClusters().find((cluster) => cluster.id === id);
  return clusterInfo?.state === 'running';
}

function getClusterMessages(cluster, id) {
  if (cluster.provisional || cluster.state === 'setup') {
    return { dbMessages: [], allMessages: [] };
  }
  const dbMessages = cluster.messageBus.getAll(id);
  const taskLogMessages = readAgentTaskLogs(cluster);
  const allMessages = [...dbMessages, ...taskLogMessages].sort((a, b) => a.timestamp - b.timestamp);
  return { dbMessages, allMessages };
}

function readSetupLogLines(logPath, limit) {
  if (!logPath || !fs.existsSync(logPath)) {
    return [];
  }
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n').filter((line) => line.length > 0);
  return lines.slice(-limit);
}

function printSetupLogLines(logPath, limit) {
  const lines = readSetupLogLines(logPath, limit);
  for (const line of lines) {
    console.log(line);
  }
}

function followSetupLog(logPath) {
  if (!logPath) {
    console.log(chalk.dim('No setup log path recorded yet.'));
    return;
  }
  console.log(chalk.dim(`\n--- Following setup log ${logPath} (Ctrl+C to stop) ---\n`));
  const proc = require('child_process').spawn('tail', ['-f', logPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  keepProcessAlive(() => {
    proc.kill('SIGTERM');
  });
}

function printRecentMessages(messages, limit, isActive, options) {
  if (options.watch) {
    const recentMessages = selectRecentPrintableMessages(messages, limit);
    for (const msg of recentMessages) {
      printMessage(msg, true, true, isActive);
    }
    if (recentMessages.length === 0 && messages.length > 0) {
      console.log(chalk.dim(`No printable history in ${messages.length} stored messages.`));
    }
    return;
  }

  const output = renderRecentMessagesToTerminal(messages, limit);

  if (output) {
    console.log(output);
    return;
  }

  if (messages.length > 0) {
    console.log(chalk.dim(`No printable history in ${messages.length} stored messages.`));
  }
}

function setTerminalTitleForCluster(clusterId, dbMessages) {
  const issueOpened = dbMessages.find((m) => m.topic === 'ISSUE_OPENED');
  if (issueOpened) {
    setTerminalTitle(`zeroshot [${clusterId}]: ${formatTaskSummary(issueOpened, 30)}`);
  } else {
    setTerminalTitle(`zeroshot [${clusterId}]`);
  }
}

function startClusterDbPolling(cluster, clusterId, isActive, options) {
  return cluster.ledger.pollForMessages(
    clusterId,
    (msg) => {
      printMessage(msg, true, options.watch, isActive);
      if (msg.topic === 'AGENT_OUTPUT' && msg.sender) {
        const senderLabel = `${msg.cluster_id || ''}/${msg.sender}`;
        const prefix = getColorForSender(msg.sender)(`${senderLabel.padEnd(25)} |`);
        flushLineBuffer(prefix, msg.sender);
      }
    },
    500
  );
}

function parseIncrementalTaskLogLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }

  let timestamp = Date.now();
  let jsonContent = trimmed;

  const timestampMatch = jsonContent.match(/^\[(\d{13})\](.*)$/);
  if (timestampMatch) {
    timestamp = parseInt(timestampMatch[1], 10);
    jsonContent = timestampMatch[2];
  }

  if (!jsonContent.startsWith('{')) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonContent);
    if (parsed.type === 'system' && parsed.subtype === 'init') {
      return null;
    }
  } catch {
    return null;
  }

  return { timestamp, jsonContent };
}

function readNewTaskLogContent(logPath, lastSize) {
  const stats = fs.statSync(logPath);
  const currentSize = stats.size;
  if (currentSize <= lastSize) {
    return null;
  }

  const fd = fs.openSync(logPath, 'r');
  const buffer = Buffer.alloc(currentSize - lastSize);
  fs.readSync(fd, buffer, 0, buffer.length, lastSize);
  fs.closeSync(fd);

  return { content: buffer.toString('utf-8'), size: currentSize };
}

function extractTaskLogLines(content) {
  return content.split('\n').filter((line) => line.trim());
}

function processTaskLogLines({ lines, agent, state, cluster, isActive, options, taskId }) {
  for (const line of lines) {
    const parsed = parseIncrementalTaskLogLine(line);
    if (!parsed) {
      continue;
    }
    const msg = buildTaskLogMessage({
      taskId,
      timestamp: parsed.timestamp,
      jsonContent: parsed.jsonContent,
      cluster,
      agent,
      iteration: state.iteration,
    });

    printMessage(msg, true, options.watch, isActive);
    const senderLabel = `${cluster.id}/${agent.id}`;
    const prefix = getColorForSender(agent.id)(`${senderLabel.padEnd(25)} |`);
    flushLineBuffer(prefix, agent.id);
  }
}

function pollTaskLogs(cluster, isActive, options, taskLogSizes) {
  for (const agent of cluster.agents) {
    const state = agent.getState();
    const taskId = state.currentTaskId;
    if (!taskId) {
      continue;
    }

    const logPath = path.join(os.homedir(), '.claude-zeroshot', 'logs', `${taskId}.log`);
    if (!fs.existsSync(logPath)) {
      continue;
    }

    try {
      const lastSize = taskLogSizes.get(taskId) || 0;
      const update = readNewTaskLogContent(logPath, lastSize);
      if (!update) {
        continue;
      }

      const lines = extractTaskLogLines(update.content);
      processTaskLogLines({
        lines,
        agent,
        state,
        cluster,
        isActive,
        options,
        taskId,
      });
      taskLogSizes.set(taskId, update.size);
    } catch {
      // File read error - skip
    }
  }
}

function startTaskLogPolling(cluster, isActive, options) {
  const taskLogSizes = new Map();
  const interval = setInterval(() => {
    pollTaskLogs(cluster, isActive, options, taskLogSizes);
  }, 300);
  return () => clearInterval(interval);
}

function followClusterLogs(cluster, id, dbMessages, isActive, options) {
  setTerminalTitleForCluster(id, dbMessages);
  console.log('\n--- Following logs (Ctrl+C to stop) ---\n');

  const stopDbPoll = startClusterDbPolling(cluster, id, isActive, options);
  const stopTaskLogPolling = startTaskLogPolling(cluster, isActive, options);

  keepProcessAlive(() => {
    stopDbPoll();
    stopTaskLogPolling();
    restoreTerminalTitle();
  });
}

function showClusterLogsById(quietOrchestrator, id, options, limit) {
  const cluster = getClusterOrExit(quietOrchestrator, id);
  if (cluster.provisional || cluster.state === 'setup') {
    printSetupLogLines(cluster.setupLogPath, limit);
    if (options.follow) {
      followSetupLog(cluster.setupLogPath);
    }
    return;
  }
  const isActive = getClusterActiveState(quietOrchestrator, id);
  const { dbMessages, allMessages } = getClusterMessages(cluster, id);
  printRecentMessages(allMessages, limit, isActive, options);

  if (options.follow) {
    followClusterLogs(cluster, id, dbMessages, isActive, options);
  }
}

async function listAttachableProcesses(socketDiscovery) {
  const tasks = await socketDiscovery.listAttachableTasks();
  const clusters = await socketDiscovery.listAttachableClusters();

  if (tasks.length === 0 && clusters.length === 0) {
    console.log(chalk.dim('No attachable tasks or clusters found.'));
    console.log(chalk.dim('Start a task with: zeroshot task run "prompt"'));
    return;
  }

  console.log(chalk.bold('\nAttachable processes:\n'));

  if (tasks.length > 0) {
    console.log(chalk.cyan('Tasks:'));
    for (const taskId of tasks) {
      console.log(`  ${taskId}`);
    }
  }

  if (clusters.length > 0) {
    await printAttachableClusters(clusters, socketDiscovery);
  }

  console.log(chalk.dim('\nUsage: zeroshot attach <id> [--agent <name>]'));
}

function getClusterAgentInfo(OrchestratorModule, clusterId) {
  const agentModels = {};
  let tokenUsageLines = null;
  try {
    const orchestrator = OrchestratorModule.getInstance();
    const status = orchestrator.getStatus(clusterId);
    for (const agent of status.agents) {
      agentModels[agent.id] = agent.model;
    }
    const cluster = orchestrator.getCluster(clusterId);
    if (cluster?.messageBus) {
      const tokensByRole = cluster.messageBus.getTokensByRole(clusterId);
      tokenUsageLines = formatTokenUsage(tokensByRole);
    }
  } catch {
    /* orchestrator not running - models/tokens unavailable */
  }
  return { agentModels, tokenUsageLines };
}

async function printAttachableClusters(clusters, socketDiscovery) {
  console.log(chalk.yellow('\nClusters:'));
  const OrchestratorModule = require('../src/orchestrator');
  for (const clusterId of clusters) {
    const agents = await socketDiscovery.listAttachableAgents(clusterId);
    console.log(`  ${clusterId}`);
    const { agentModels, tokenUsageLines } = getClusterAgentInfo(OrchestratorModule, clusterId);
    if (tokenUsageLines) {
      for (const line of tokenUsageLines) {
        console.log(`    ${line}`);
      }
    }
    for (const agent of agents) {
      const modelLabel = agentModels[agent] ? chalk.dim(` [${agentModels[agent]}]`) : '';
      console.log(chalk.dim(`    --agent ${agent}`) + modelLabel);
    }
  }
}

function readClusterFromDisk(id) {
  try {
    const clusters = readClustersFileSync(path.join(os.homedir(), '.zeroshot'));
    return clusters[id] || null;
  } catch {
    return null;
  }
}

function ensureClusterRunning(cluster, id) {
  if (!cluster) {
    console.error(chalk.red(`Cluster ${id} not found`));
    process.exit(1);
  }
  if (cluster.state !== 'running') {
    console.error(chalk.red(`Cluster ${id} is not running (state: ${cluster.state})`));
    console.error(chalk.dim('Only running clusters have attachable agents.'));
    process.exit(1);
  }
}

function getActiveAgents(status) {
  return status.agents.filter((agent) => ACTIVE_STATES.has(agent.state));
}

function reportNoActiveAgents(status, id) {
  console.error(chalk.yellow(`No agents currently executing tasks in cluster ${id}`));
  console.log(chalk.dim('\nAgent states:'));
  for (const agent of status.agents) {
    const modelLabel = agent.model ? chalk.dim(` [${agent.model}]`) : '';
    console.log(
      chalk.dim(
        `  ${agent.id}${modelLabel}: ${agent.state}${agent.currentTaskId ? ` (last task: ${agent.currentTaskId})` : ''}`
      )
    );
  }
}

async function inspectAgentAttachment(agent, socketDiscovery, readTask = readTaskFromDisk) {
  if (!agent.currentTaskId) {
    return { agent, state: 'starting', task: null, socketPath: null };
  }

  const task = await readTask(agent.currentTaskId);
  if (task?.pid && !task.attachable) {
    return { agent, state: 'non_attachable', task, socketPath: null };
  }

  const socketPath = task?.socketPath || socketDiscovery.getTaskSocketPath(agent.currentTaskId);
  if (await socketDiscovery.isSocketAlive(socketPath)) {
    return { agent, state: 'attachable', task, socketPath };
  }
  return { agent, state: 'unavailable', task, socketPath };
}

function printLiveAttachableAgents(attachments) {
  for (const { agent } of attachments) {
    const modelLabel = agent.model ? chalk.dim(` [${agent.model}]`) : '';
    console.log(
      `  ${chalk.cyan(agent.id)}${modelLabel} → task ${chalk.green(agent.currentTaskId)}`
    );
    console.log(chalk.dim(`    zeroshot attach ${agent.currentTaskId}`));
  }
}

function printNonAttachableAgents(id, attachments) {
  if (attachments.length === 0) {
    return;
  }

  console.log(chalk.yellow('\nRunning without PTY attach support:'));
  for (const { agent, task } of attachments) {
    const modelLabel = agent.model ? chalk.dim(` [${agent.model}]`) : '';
    const providerLabel = task?.provider ? chalk.dim(` [provider: ${task.provider}]`) : '';
    console.log(
      `  ${chalk.cyan(agent.id)}${modelLabel} → task ${chalk.green(agent.currentTaskId)}${providerLabel}`
    );
  }
  console.log(chalk.dim(`  Follow output instead: zeroshot logs ${id} -f`));
}

function printUnavailableAgents(attachments) {
  if (attachments.length === 0) {
    return;
  }

  console.log(chalk.yellow('\nActive agents without a live attach socket:'));
  for (const { agent, state } of attachments) {
    const modelLabel = agent.model ? chalk.dim(` [${agent.model}]`) : '';
    const detail =
      state === 'starting'
        ? 'task ID not yet assigned'
        : `task ${agent.currentTaskId} socket not ready`;
    console.log(`  ${chalk.cyan(agent.id)}${modelLabel} → ${chalk.yellow(detail)}`);
  }
}

async function printAttachableAgentList(
  id,
  activeAgents,
  socketDiscovery,
  readTask = readTaskFromDisk
) {
  const inspected = await Promise.all(
    activeAgents.map((agent) => inspectAgentAttachment(agent, socketDiscovery, readTask))
  );
  const attachable = inspected.filter(({ state }) => state === 'attachable');
  const nonAttachable = inspected.filter(({ state }) => state === 'non_attachable');
  const unavailable = inspected.filter(({ state }) => ['starting', 'unavailable'].includes(state));

  console.log(chalk.yellow(`\nCluster ${id} - attachable agents:\n`));
  if (attachable.length === 0) {
    console.log(chalk.dim('  No live attach sockets.'));
  } else {
    printLiveAttachableAgents(attachable);
    console.log(chalk.dim('\nAttach to an agent by running: zeroshot attach <taskId>'));
  }
  printNonAttachableAgents(id, nonAttachable);
  printUnavailableAgents(unavailable);
}

function reportMissingAgent(agentName, status) {
  console.error(chalk.red(`Agent '${agentName}' not found in cluster`));
  console.log(chalk.dim('Available agents: ' + status.agents.map((a) => a.id).join(', ')));
  process.exit(1);
}

function reportAgentWithoutTask(agent, agentName) {
  if (ACTIVE_STATES.has(agent.state)) {
    console.error(
      chalk.yellow(
        `Agent '${agentName}' is working (state: ${agent.state}, task ID not yet assigned)`
      )
    );
    console.log(chalk.dim('Try again in a moment...'));
    return;
  }
  console.error(chalk.yellow(`Agent '${agentName}' is not currently running a task`));
  console.log(chalk.dim(`State: ${agent.state}`));
}

async function reportClusterStatusUnavailable(err, socketDiscovery) {
  console.error(chalk.yellow(`Could not get cluster status: ${err.message}`));
  console.log(chalk.dim('Try attaching directly to a task ID instead: zeroshot attach <taskId>'));

  const tasks = await socketDiscovery.listAttachableTasks();
  if (tasks.length === 0) {
    return;
  }
  console.log(chalk.dim('\nAttachable tasks:'));
  for (const taskId of tasks) {
    console.log(chalk.dim(`  zeroshot attach ${taskId}`));
  }
}

async function readTaskFromDisk(taskId) {
  try {
    const { getTask } = await import('../task-lib/store.js');
    return getTask(taskId);
  } catch {
    return null;
  }
}

function reportAgentTaskNotAttachable(id, agent, task) {
  console.error(
    chalk.yellow(
      `Agent '${agent.id}' is running task ${agent.currentTaskId} without PTY attach support`
    )
  );
  if (task.provider) {
    console.error(chalk.dim(`Provider: ${task.provider}`));
  }
  console.error(chalk.dim(`Follow output instead: zeroshot logs ${id} -f`));
}

async function resolveClusterSocketPath(id, options, socketDiscovery) {
  const cluster = readClusterFromDisk(id);
  ensureClusterRunning(cluster, id);

  const orchestrator = await Orchestrator.create({ quiet: true, readonly: true });
  try {
    const status = orchestrator.getStatus(id);
    const activeAgents = getActiveAgents(status);
    if (activeAgents.length === 0) {
      reportNoActiveAgents(status, id);
      return null;
    }

    if (!options.agent) {
      await printAttachableAgentList(id, activeAgents, socketDiscovery);
      return null;
    }

    const agent = status.agents.find((item) => item.id === options.agent);
    if (!agent) {
      reportMissingAgent(options.agent, status);
      return null;
    }

    if (!agent.currentTaskId) {
      reportAgentWithoutTask(agent, options.agent);
      return null;
    }

    console.log(
      chalk.dim(`Attaching to agent ${options.agent} via task ${agent.currentTaskId}...`)
    );
    const task = await readTaskFromDisk(agent.currentTaskId);
    if (task?.pid && !task.attachable) {
      reportAgentTaskNotAttachable(id, agent, task);
      return null;
    }
    return task?.socketPath || socketDiscovery.getTaskSocketPath(agent.currentTaskId);
  } catch (err) {
    await reportClusterStatusUnavailable(err, socketDiscovery);
    return null;
  }
}

function resolveAttachSocketPath(id, options, socketDiscovery) {
  if (id.startsWith('task-')) {
    return socketDiscovery.getTaskSocketPath(id);
  }
  if (id.startsWith('cluster-') || socketDiscovery.isKnownCluster(id)) {
    return resolveClusterSocketPath(id, options, socketDiscovery);
  }
  return socketDiscovery.getSocketPath(id, options.agent);
}

function reportCannotAttach(id) {
  console.error(chalk.red(`Cannot attach to ${id}`));

  const { detectIdType } = require('../lib/id-detector');
  const type = detectIdType(id);

  if (type === 'task') {
    console.error(chalk.dim('Task may have been spawned before attach support was added.'));
    console.error(chalk.dim(`Try: zeroshot logs ${id} -f`));
    return;
  }
  if (type === 'cluster') {
    console.error(chalk.dim('Cluster may not be running or agent may not exist.'));
    console.error(chalk.dim(`Check status: zeroshot status ${id}`));
    return;
  }
  console.error(chalk.dim('Process not found or not attachable.'));
}

async function connectAttachClient({ AttachClient, socketPath, id, agentName }) {
  console.log(chalk.dim(`Attaching to ${id}${agentName ? ` (agent: ${agentName})` : ''}...`));
  console.log(chalk.dim('Press Ctrl+B ? for help, Ctrl+B d to detach\n'));

  const client = new AttachClient({ socketPath });
  client.on('state', (_state) => {
    // Could show status bar here in future
  });
  client.on('exit', ({ code, signal }) => {
    console.log(chalk.dim(`\n\nProcess exited (code: ${code}, signal: ${signal})`));
    process.exit(code || 0);
  });
  client.on('error', (err) => {
    console.error(chalk.red(`\nConnection error: ${err.message}`));
    process.exit(1);
  });
  client.on('detach', () => {
    console.log(chalk.dim('\n\nDetached. Task continues running.'));
    console.log(
      chalk.dim(`Re-attach: zeroshot attach ${id}${agentName ? ` --agent ${agentName}` : ''}`)
    );
    process.exit(0);
  });
  client.on('close', () => {
    console.log(chalk.dim('\n\nConnection closed.'));
    process.exit(0);
  });

  await client.connect();
}

function getFinishCluster(orchestrator, id) {
  const cluster = orchestrator.getCluster(id);
  if (!cluster) {
    console.error(chalk.red(`Error: Cluster ${id} not found`));
    console.error(chalk.dim('Use "zeroshot list" to see available clusters'));
    process.exit(1);
  }
  return cluster;
}

async function promptStopCluster(id) {
  console.log(chalk.yellow(`Cluster ${id} is still running.`));
  console.log(chalk.dim('Stopping it before converting to completion task...'));
  console.log('');

  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise((resolve) => {
    rl.question(chalk.yellow('Continue? (y/N) '), resolve);
  });
  rl.close();

  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

async function stopClusterIfRunning(cluster, id, options, orchestrator) {
  if (cluster.state !== 'running') {
    return;
  }

  if (!options.y && !options.yes) {
    const shouldContinue = await promptStopCluster(id);
    if (!shouldContinue) {
      console.log(chalk.red('Aborted'));
      process.exit(0);
    }
  }

  console.log(chalk.cyan('Stopping cluster...'));
  await orchestrator.stop(id);
  console.log(chalk.green('✓ Cluster stopped'));
  console.log('');
}

function extractFinishContext(messages) {
  const issueOpened = messages.find((m) => m.topic === 'ISSUE_OPENED');
  const taskText = issueOpened?.content?.text || 'Unknown task';
  const issueNumber = issueOpened?.content?.data?.issue_number;
  const issueTitle = issueOpened?.content?.data?.title || 'Implementation';
  const agentOutputs = messages.filter((m) => m.topic === 'AGENT_OUTPUT');
  const validations = messages.filter((m) => m.topic === 'VALIDATION_RESULT');
  const approvedValidations = validations.filter(
    (validation) =>
      validation.content?.data?.approved === true || validation.content?.data?.approved === 'true'
  );
  return {
    taskText,
    issueNumber,
    issueTitle,
    agentOutputs,
    validations,
    approvedValidations,
  };
}

function buildContextSummary({
  taskText,
  issueNumber,
  issueTitle,
  agentOutputs,
  validations,
  approvedValidations,
}) {
  let contextSummary = `# Original Task\n\n${taskText}\n\n`;

  if (issueNumber) {
    contextSummary += `Issue: #${issueNumber} - ${issueTitle}\n\n`;
  }

  contextSummary += `# Progress So Far\n\n`;
  contextSummary += `- ${agentOutputs.length} agent outputs\n`;
  contextSummary += `- ${validations.length} validation results\n`;
  contextSummary += `- ${approvedValidations.length} approvals\n\n`;

  if (validations.length > 0) {
    contextSummary += `## Recent Validations\n\n`;
    for (const validation of validations.slice(-3)) {
      const approved =
        validation.content?.data?.approved === true ||
        validation.content?.data?.approved === 'true';
      const icon = approved ? '✅' : '❌';
      contextSummary += `${icon} **${validation.sender}**: ${validation.content?.data?.summary || 'No summary'}\n`;
    }
    contextSummary += '\n';
  }

  return contextSummary;
}

function buildCompletionPrompt({ contextSummary, taskText, issueNumber, issueTitle }) {
  const mergeGoal = 'CREATE PR AND MERGE IT';
  const mergeStep = `
8. MERGE THE PR - THIS IS MANDATORY:
   \`\`\`bash
   gh pr merge --merge --auto
   \`\`\`

   IF MERGE FAILS DUE TO CONFLICTS:
   a) Pull and rebase: \`git fetch origin main && git rebase origin/main\`
   b) Resolve conflicts manually (read files, make decisions, edit)
   c) \`git add <resolved-files> && git rebase --continue\`
   d) Force push: \`git push --force-with-lease\`
   e) Retry merge: \`gh pr merge --merge\`

   REPEAT UNTIL MERGED. DO NOT GIVE UP.`;

  return `# YOUR MISSION: ${mergeGoal}

${contextSummary}

# WHAT YOU MUST DO NOW

You are the FINISHER. Your ONLY job is to take this cluster's work and push it across the finish line.

**FAILURE IS NOT AN OPTION. YOU MUST COMPLETE THIS TASK.**

## Steps (MUST complete ALL):

1. REVIEW CURRENT STATE - Check git status, see what's changed:
   \`\`\`bash
   git status
   git diff
   \`\`\`

2. COMMIT ALL CHANGES - Stage and commit everything:
   \`\`\`bash
   git add .
   git commit -m "${issueTitle || 'feat: implement task'}"
   \`\`\`

3. CREATE BRANCH - Use issue number if available:
   \`\`\`bash
   ${issueNumber ? `git checkout -b issue-${issueNumber}` : 'git checkout -b feature/implementation'}
   \`\`\`

4. PUSH TO REMOTE:
   \`\`\`bash
   git push -u origin HEAD
   \`\`\`

5. CREATE PULL REQUEST:
   \`\`\`bash
   gh pr create --title "${issueTitle || 'Implementation'}" --body "Closes #${issueNumber || 'N/A'}

## Summary
${taskText.slice(0, 200)}...

## Changes
- Implementation complete
- All validations addressed

🤖 Generated with zeroshot finish"
   \`\`\`

6. GET PR URL:
   \`\`\`bash
   gh pr view --json url -q .url
   \`\`\`

7. OUTPUT THE PR URL - Print it clearly so user can see it
${mergeStep}

## RULES

- NO EXCUSES: If something fails, FIX IT and retry
- NO SHORTCUTS: Follow ALL steps above
- NO PARTIAL WORK: Must reach PR creation and merge
- IF TESTS FAIL: Fix them until they pass
- IF CI FAILS: Wait for it, fix issues, retry
- IF CONFLICTS: Resolve them intelligently

**DO NOT STOP UNTIL YOU HAVE A MERGED PR.**`;
}

function printCompletionPromptPreview(completionPrompt) {
  console.log(chalk.dim('='.repeat(80)));
  console.log(chalk.dim('Task prompt preview:'));
  console.log(chalk.dim('='.repeat(80)));
  console.log(completionPrompt.split('\n').slice(0, 20).join('\n'));
  console.log(chalk.dim('... (truncated) ...\n'));
  console.log(chalk.dim('='.repeat(80)));
  console.log('');
}

function buildFinishTaskOptions(cluster) {
  const taskOptions = {
    cwd: process.cwd(),
  };

  if (cluster.isolation?.enabled && cluster.isolation?.containerId) {
    console.log(chalk.dim(`Using isolation container: ${cluster.isolation.containerId}`));
    taskOptions.isolation = {
      containerId: cluster.isolation.containerId,
      workDir: '/workspace',
    };
  }

  return taskOptions;
}

function printFinishTaskStarted(cluster) {
  console.log('');
  console.log(chalk.green(`✓ Completion task started`));
  if (cluster.isolation?.enabled) {
    console.log(chalk.dim('Running in isolation container (same as cluster)'));
  }
  console.log(chalk.dim('Monitor with: zeroshot list'));
}

async function getPurgeData(orchestrator) {
  const clusters = orchestrator.listClusters();
  const runningClusters = clusters.filter(
    (cluster) =>
      cluster.state === 'running' || cluster.state === 'initializing' || cluster.state === 'setup'
  );
  const { loadTasks } = await import('../task-lib/store.js');
  const { isProcessRunning } = await import('../task-lib/runner.js');
  const tasks = Object.values(loadTasks());
  const runningTasks = tasks.filter(
    (task) => task.status === 'running' && isProcessRunning(task.pid)
  );
  return { clusters, runningClusters, tasks, runningTasks, isProcessRunning };
}

function printPurgeSummary({ clusters, runningClusters, tasks, runningTasks }) {
  console.log(chalk.bold('\nWill kill and delete:'));
  if (clusters.length > 0) {
    console.log(chalk.cyan(`  ${clusters.length} cluster(s) with all history`));
    if (runningClusters.length > 0) {
      console.log(chalk.yellow(`    ${runningClusters.length} running`));
    }
  }
  if (tasks.length > 0) {
    console.log(chalk.yellow(`  ${tasks.length} task(s) with all logs`));
    if (runningTasks.length > 0) {
      console.log(chalk.yellow(`    ${runningTasks.length} running`));
    }
  }
  console.log('');
}

async function confirmPurge(options) {
  if (options.yes) {
    return true;
  }
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise((resolve) => {
    rl.question(
      chalk.bold.red(
        'This will kill all processes and permanently delete all data. Proceed? [y/N] '
      ),
      resolve
    );
  });
  rl.close();
  return answer.toLowerCase() === 'y';
}

async function killRunningClusters(orchestrator, runningClusters) {
  if (runningClusters.length === 0) {
    return;
  }
  console.log(chalk.bold('Killing running clusters...'));
  const clusterResults = await orchestrator.killAll();
  for (const id of clusterResults.killed) {
    console.log(chalk.green(`✓ Killed cluster: ${id}`));
  }
  for (const err of clusterResults.errors) {
    console.log(chalk.red(`✗ Failed to kill cluster ${err.id}: ${err.error}`));
  }
}

async function killRunningTasks(runningTasks, isProcessRunning) {
  if (runningTasks.length === 0) {
    return;
  }
  console.log(chalk.bold('Killing running tasks...'));
  const { killTask } = await import('../task-lib/runner.js');
  const { updateTask } = await import('../task-lib/store.js');

  for (const task of runningTasks) {
    if (!isProcessRunning(task.pid)) {
      updateTask(task.id, {
        status: 'stale',
        error: 'Process died unexpectedly',
      });
      console.log(chalk.yellow(`○ Task ${task.id} was already dead, marked stale`));
      continue;
    }

    const killed = killTask(task.pid);
    if (killed) {
      updateTask(task.id, { status: 'killed', error: 'Killed by clear' });
      console.log(chalk.green(`✓ Killed task: ${task.id}`));
    } else {
      console.log(chalk.red(`✗ Failed to kill task: ${task.id}`));
    }
  }
}

function deleteClusterData(orchestrator, clusters) {
  if (clusters.length === 0) {
    return;
  }
  console.log(chalk.bold('Deleting cluster data...'));
  const clustersFile = path.join(orchestrator.storageDir, 'clusters.json');
  const clustersDir = path.join(orchestrator.storageDir, 'clusters');

  for (const cluster of clusters) {
    const dbPath = path.join(orchestrator.storageDir, `${cluster.id}.db`);
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log(chalk.green(`✓ Deleted cluster database: ${cluster.id}.db`));
    }
  }

  if (fs.existsSync(clustersFile)) {
    fs.unlinkSync(clustersFile);
    console.log(chalk.green(`✓ Deleted clusters.json`));
  }

  if (fs.existsSync(clustersDir)) {
    fs.rmSync(clustersDir, { recursive: true, force: true });
    console.log(chalk.green(`✓ Deleted clusters/ directory`));
  }

  orchestrator.clusters.clear();
}

async function deleteTaskData(tasks) {
  if (tasks.length === 0) {
    return;
  }
  console.log(chalk.bold('Deleting task data...'));
  const { cleanTasks } = await import('../task-lib/commands/clean.js');
  await cleanTasks({ all: true });
}

// Lazy-loaded orchestrator (quiet by default) - created on first use
/** @type {import('../src/orchestrator') | null} */
let _orchestrator = null;
/** @type {Promise<import('../src/orchestrator')> | null} */
let _orchestratorPromise = null;
/**
 * @returns {Promise<import('../src/orchestrator')>}
 */
function getOrchestrator() {
  if (_orchestrator) {
    return Promise.resolve(_orchestrator);
  }
  // Use a promise to prevent multiple concurrent initializations
  if (!_orchestratorPromise) {
    _orchestratorPromise = Orchestrator.create({ quiet: true }).then((orch) => {
      _orchestrator = orch;
      return orch;
    });
  }
  return _orchestratorPromise;
}

// Separate lazy-loaded read-only orchestrator for commands that only ever read
// cluster state (list/status/logs). Read-only ledgers can never contend with a
// live daemon's writer connection or mutate clusters.json as a side effect.
/** @type {import('../src/orchestrator') | null} */
let _readonlyOrchestrator = null;
/** @type {Promise<import('../src/orchestrator')> | null} */
let _readonlyOrchestratorPromise = null;
/**
 * @returns {Promise<import('../src/orchestrator')>}
 */
function getReadonlyOrchestrator() {
  if (_readonlyOrchestrator) {
    return Promise.resolve(_readonlyOrchestrator);
  }
  if (!_readonlyOrchestratorPromise) {
    _readonlyOrchestratorPromise = Orchestrator.create({ quiet: true, readonly: true }).then(
      (orch) => {
        _readonlyOrchestrator = orch;
        return orch;
      }
    );
  }
  return _readonlyOrchestratorPromise;
}

/**
 * @typedef {Object} TaskLogMessage
 * @property {string} topic
 * @property {string} sender
 * @property {Object} content
 * @property {number} timestamp
 */

/**
 * Read task logs from zeroshot task log files for agents in a cluster
 * Returns messages in cluster message format (topic, sender, content, timestamp)
 * @param {Object} cluster - Cluster object from orchestrator
 * @returns {TaskLogMessage[]} Messages from task logs
 */
function readAgentTaskLogs(cluster) {
  /** @type {TaskLogMessage[]} */
  const messages = [];
  const zeroshotLogsDir = getZeroshotLogsDir();

  if (!fs.existsSync(zeroshotLogsDir)) {
    return messages;
  }

  const lifecycleMessages = cluster.messageBus.query({
    cluster_id: cluster.id,
    topic: 'AGENT_LIFECYCLE',
  });

  const taskIds = collectTaskIds(cluster, lifecycleMessages, zeroshotLogsDir);

  for (const taskId of taskIds) {
    const logPath = path.join(zeroshotLogsDir, `${taskId}.log`);
    const lines = readTaskLogLines(taskId, logPath);
    if (!lines || lines.length === 0) {
      continue;
    }

    const agent = resolveAgentForTask(cluster, taskId, lifecycleMessages);
    if (!agent) {
      continue;
    }

    const state = agent.getState();
    for (const line of lines) {
      const parsed = parseTaskLogLine(line);
      if (!parsed) {
        continue;
      }
      messages.push(
        buildTaskLogMessage({
          taskId,
          timestamp: parsed.timestamp,
          jsonContent: parsed.jsonContent,
          cluster,
          agent,
          iteration: state.iteration,
        })
      );
    }
  }

  return messages;
}

function getZeroshotLogsDir() {
  return path.join(os.homedir(), '.claude-zeroshot', 'logs');
}

function collectTaskIds(cluster, lifecycleMessages, logsDir) {
  const taskIds = new Set();
  addTaskIds(taskIds, collectTaskIdsFromLifecycle(lifecycleMessages));
  addTaskIds(taskIds, collectTaskIdsFromAgents(cluster.agents));
  addTaskIds(taskIds, collectTaskIdsFromLogFiles(logsDir, cluster.createdAt));
  return taskIds;
}

function addTaskIds(target, ids) {
  for (const id of ids) {
    target.add(id);
  }
}

function collectTaskIdsFromLifecycle(lifecycleMessages) {
  const taskIds = new Set();
  for (const msg of lifecycleMessages) {
    const taskId = msg.content?.data?.taskId;
    if (taskId) {
      taskIds.add(taskId);
    }
  }
  return taskIds;
}

function collectTaskIdsFromAgents(agents) {
  const taskIds = new Set();
  for (const agent of agents) {
    const state = agent.getState();
    if (state.currentTaskId) {
      taskIds.add(state.currentTaskId);
    }
  }
  return taskIds;
}

function collectTaskIdsFromLogFiles(logsDir, clusterStartTime) {
  const taskIds = new Set();
  const logFiles = fs.readdirSync(logsDir);
  for (const logFile of logFiles) {
    if (!logFile.endsWith('.log')) {
      continue;
    }
    const taskId = logFile.replace(/\.log$/, '');
    const logPath = path.join(logsDir, logFile);
    try {
      const stats = fs.statSync(logPath);
      if (stats.mtimeMs >= clusterStartTime) {
        taskIds.add(taskId);
      }
    } catch {
      // Skip files we can't stat
    }
  }
  return taskIds;
}

function readTaskLogLines(taskId, logPath) {
  if (!fs.existsSync(logPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    return content.split('\n').filter((line) => line.trim());
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: Could not read log for ${taskId}: ${errMessage}`);
    return null;
  }
}

function resolveAgentForTask(cluster, taskId, lifecycleMessages) {
  const directMatch = findAgentByTaskId(cluster.agents, taskId);
  if (directMatch) {
    return directMatch;
  }
  const inferredMatch = findAgentFromLifecycle(cluster.agents, taskId, lifecycleMessages);
  return inferredMatch || cluster.agents[0] || null;
}

function findAgentByTaskId(agents, taskId) {
  for (const agent of agents) {
    const state = agent.getState();
    if (state.currentTaskId === taskId) {
      return agent;
    }
  }
  return null;
}

function findAgentFromLifecycle(agents, taskId, lifecycleMessages) {
  for (const msg of lifecycleMessages) {
    if (msg.content?.data?.taskId === taskId) {
      const agentId = msg.content?.data?.agent || msg.sender;
      return agents.find((agent) => agent.id === agentId) || null;
    }
  }
  return null;
}

function parseTaskLogLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[')) {
    return null;
  }

  const parsed = parseTimestampedLine(trimmed);
  if (!parsed.jsonContent.startsWith('{')) {
    return null;
  }

  try {
    const json = JSON.parse(parsed.jsonContent);
    if (json.type === 'system' && json.subtype === 'init') {
      return null;
    }
  } catch {
    return null;
  }

  return parsed;
}

function parseTimestampedLine(line) {
  const timestampMatch = line.match(/^\[(\d{13})\](.*)$/);
  if (!timestampMatch) {
    return { timestamp: Date.now(), jsonContent: line };
  }
  return {
    timestamp: parseInt(timestampMatch[1], 10),
    jsonContent: timestampMatch[2],
  };
}

function buildTaskLogMessage({ taskId, timestamp, jsonContent, cluster, agent, iteration }) {
  return {
    id: `task-${taskId}-${timestamp}`,
    timestamp,
    topic: 'AGENT_OUTPUT',
    sender: agent.id,
    receiver: 'broadcast',
    cluster_id: cluster.id,
    content: {
      text: jsonContent,
      data: {
        type: 'stdout',
        line: jsonContent,
        agent: agent.id,
        role: agent.role,
        iteration,
        fromTaskLog: true,
      },
    },
  };
}

// Setup shell completion
setupCompletion();

// Banner disabled
function showBanner() {
  // Banner removed for cleaner output
}

// Show banner on startup (but not for completion, help, or daemon child)
const shouldShowBanner =
  !process.env.ZEROSHOT_DAEMON &&
  !process.argv.includes('--completion') &&
  !process.argv.includes('-h') &&
  !process.argv.includes('--help') &&
  process.argv.length > 2;
if (shouldShowBanner) {
  showBanner();
}

// NOTE: Agent color handling moved to message-formatter-utils.js

program
  .name('zeroshot')
  .description('Multi-agent orchestration and task management for Claude, Codex, and Gemini')
  .version(require('../package.json').version)
  .option('-q, --quiet', 'Suppress prompts (first-run wizard, update checks)')
  .addHelpText(
    'after',
    `
Examples:
  ${chalk.cyan('zeroshot run 123 --ship')}             Full automation: isolated + auto-merge PR
  ${chalk.cyan('zeroshot run 123')}                    Run cluster from GitHub issue
  ${chalk.cyan('zeroshot run feature.md')}             Run cluster from markdown file
  ${chalk.cyan('zeroshot run "Implement feature X"')}  Run cluster from plain text
  ${chalk.cyan('zeroshot run 123 -d')}                 Run in background (detached)
  ${chalk.cyan('zeroshot run 123 --docker')}           Run in Docker container (safe for e2e tests)
  ${chalk.cyan('zeroshot task run "Fix the bug"')}     Run single-agent background task
  ${chalk.cyan('zeroshot list')}                       List all tasks and clusters
  ${chalk.cyan('zeroshot task list')}                  List tasks only
  ${chalk.cyan('zeroshot attach <id>')}                Attach to running task (Ctrl+B d to detach)
  ${chalk.cyan('zeroshot logs -f')}                    Stream logs in real-time (like tail -f)
  ${chalk.cyan('zeroshot logs -w')}                    Watch cluster lifecycle and event summaries
  ${chalk.cyan('zeroshot logs <id> -f')}               Stream logs for specific cluster/task
  ${chalk.cyan('zeroshot status <id>')}                Detailed status of task or cluster
  ${chalk.cyan('zeroshot finish <id>')}                Convert cluster to completion task (creates and merges PR)
  ${chalk.cyan('zeroshot kill <id>')}                  Kill a running task or cluster
  ${chalk.cyan('zeroshot purge')}                      Kill all processes and delete all data (with confirmation)
  ${chalk.cyan('zeroshot purge -y')}                   Purge everything without confirmation
  ${chalk.cyan('zeroshot settings')}                   Show/manage zeroshot settings (maxModel, config, etc.)
  ${chalk.cyan('zeroshot settings set <key> <val>')}   Set a setting (e.g., maxModel haiku)
  ${chalk.cyan('zeroshot providers')}                  Show provider status and defaults
  ${chalk.cyan('zeroshot config list')}                List available cluster configs
  ${chalk.cyan('zeroshot config show <name>')}         Visualize a cluster config (agents, triggers, flow)
  ${chalk.cyan('zeroshot export <id>')}                Export cluster conversation to file

Automation levels (cascading: --ship → --pr → --worktree):
  ${chalk.yellow('zeroshot run 123')}            → Local run, no isolation
  ${chalk.yellow('zeroshot run 123 --docker')}   → Docker isolation, no PR
  ${chalk.yellow('zeroshot run 123 --worktree')} → Git worktree isolation, no PR
  ${chalk.yellow('zeroshot run 123 --pr')}       → Worktree + PR (human reviews)
  ${chalk.yellow('zeroshot run 123 --ship')}     → Worktree + PR + auto-merge (full automation)
  ${chalk.yellow('zeroshot task run')}           → Single-agent background task (simpler, faster)

Shell completion:
  ${chalk.dim('zeroshot --completion >> ~/.bashrc && source ~/.bashrc')}
`
  );

// Run command - CLUSTER with auto-detection
program
  .command('run <input>')
  .description(
    'Start a multi-agent cluster (GitHub issue, markdown file, plain text, or "-" for stdin)'
  )
  .option('--config <file>', 'Path to cluster config JSON (default: conductor-bootstrap)')
  .option('--docker', 'Run cluster inside Docker container (full isolation)')
  .option('--worktree', 'Use git worktree for isolation (lightweight, no Docker required)')
  .option(
    '--docker-image <image>',
    'Docker image for --docker mode (default: zeroshot-cluster-base)'
  )
  .option(
    '--strict-schema',
    'Enforce JSON schema via CLI (no live streaming). Default: live streaming with local validation'
  )
  .option(
    '--pr',
    'Create PR for human review (uses worktree isolation by default, use --docker for Docker). Never auto-merges itself; a repo-side branch-protection auto-merge rule or merge queue may still merge the PR independently of zeroshot.'
  )
  .option(
    '--ship',
    'Full automation: worktree isolation + PR + auto-merge (use --docker for Docker)'
  )
  .option('--pr-base <branch>', 'Target branch for PRs (default: repo default branch)')
  .option('--merge-queue', 'Use GitHub merge queue instead of direct merge')
  .option(
    '--close-issue <mode>',
    'When to close issue after merge: auto|always|never (default: from .zeroshot/settings.json or never)'
  )
  .option('--workers <n>', 'Max sub-agents for worker to spawn in parallel', parseInt)
  .option('--provider <provider>', `Override all agents to use a provider (${PROVIDER_CHOICES})`)
  .option('--model <model>', 'Override all agent models (provider-specific model id)')
  .option(
    '--sim <mode>',
    'Token-free simulation gate for templates (off|fast|deep). Default: fast',
    'fast'
  )
  .option('-G, --github', 'Force GitHub as issue source')
  .option('-L, --gitlab', 'Force GitLab as issue source')
  .option('-J, --jira', 'Force Jira as issue source')
  .option('-D, --devops', 'Force Azure DevOps as issue source')
  .option('-N, --linear', 'Force Linear as issue source')
  .option('-d, --detach', 'Run in background (default: attach to first agent)')
  .option('--mount <spec...>', 'Add Docker mount (host:container[:ro]). Repeatable.')
  .option('--no-mounts', 'Disable all Docker credential mounts')
  .option(
    '--container-home <path>',
    'Container home directory for $HOME expansion (default: /root)'
  )
  .addHelpText(
    'after',
    `
Input formats:
  GitHub:
    123                              Issue number (uses current repo)
    org/repo#123                     Issue with explicit repo
    https://github.com/.../issues/1  Full issue URL

  GitLab:
    https://gitlab.com/org/repo/-/issues/123   GitLab cloud
    https://gitlab.company.com/.../issues/123  Self-hosted

  Jira:
    PROJ-123                         Issue key
    https://company.atlassian.net/browse/PROJ-123

  Azure DevOps:
    https://dev.azure.com/org/proj/_workitems/edit/123

  Linear:
    ENG-42                            Issue key
    https://linear.app/<workspace>/issue/ENG-42/...

  File/Text:
    feature.md                       Markdown file
    "Implement feature X"            Plain text task

  Stdin:
    -                                 Read task body from stdin (pipe/redirect)
      pbpaste | zeroshot run -
      zeroshot run - < issue.md

Force provider flags: -G (GitHub), -L (GitLab), -J (Jira), -D (DevOps), -N (Linear)
`
  )
  .action(async (inputArg, options) => {
    try {
      // Normalize options (--ship → --pr → --worktree flags)
      normalizeRunOptions(options);

      // Determine force provider from CLI flags
      let forceProvider = null;
      if (options.github) forceProvider = 'github';
      else if (options.gitlab) forceProvider = 'gitlab';
      else if (options.jira) forceProvider = 'jira';
      else if (options.devops) forceProvider = 'azure-devops';
      else if (options.linear) forceProvider = 'linear';

      // Stdin input ('-'): read task body from stdin to avoid shell-quoting breakage
      let stdinText;
      if (isStdinInput(inputArg)) {
        if (process.env.ZEROSHOT_DAEMON === '1') {
          const encoded = process.env.ZEROSHOT_STDIN_TASK;
          if (!encoded) {
            throw new Error('zeroshot run -: daemon mode missing forwarded stdin content');
          }
          stdinText = decodeStdinEnv(encoded);
        } else if (process.stdin.isTTY) {
          throw new Error(
            'zeroshot run -: no piped input detected. Pipe or redirect a task body, e.g.\n' +
              '  pbpaste | zeroshot run -\n' +
              '  zeroshot run - < issue.md'
          );
        } else {
          stdinText = await readStdinText();
        }
        if (!stdinText) {
          throw new Error('zeroshot run -: stdin was empty, no task content received');
        }
      }

      // Auto-detect input type
      const settings = loadSettings();
      const input =
        stdinText !== undefined
          ? buildTextInput(stdinText)
          : detectRunInput(inputArg, settings, forceProvider);
      const providerOverride = resolveProviderOverride(options);

      // Preflight checks
      await runClusterPreflight({ input, options, providerOverride, settings, forceProvider });

      // Secondary preflight: token-free template simulation/validation
      const simMode = String(options.sim || 'fast').toLowerCase();
      if (simMode !== 'off') {
        const { validateTemplates } = require('../src/template-validation');
        const templatesDir = path.join(PACKAGE_ROOT, 'cluster-templates');
        const deep = simMode === 'deep';
        const report = await validateTemplates({ templatesDir, deep });
        if (!report.valid) {
          console.error('\n' + '='.repeat(60));
          console.error(`TEMPLATE VALIDATION FAILED (sim=${simMode})`);
          console.error('='.repeat(60));
          for (const { filePath, result } of report.results) {
            if (result.valid) continue;
            const rel = path.relative(process.cwd(), filePath);
            console.error(`\n❌ ${rel}`);
            for (const err of result.errors) {
              console.error(`   ERROR: ${err}`);
            }
          }
          console.error('\nFix template errors before running to avoid token burn.\n');
          process.exit(1);
        }
      }

      const { generateName } = require('../src/name-generator');

      if (shouldRunDetached(options)) {
        const clusterId = generateName('cluster');
        await spawnDetachedCluster(options, clusterId, stdinText);
        return;
      }

      const clusterId = resolveClusterId(generateName);

      // === LOAD CONFIG ===
      // Priority: CLI --config > settings.defaultConfig
      const configName = resolveConfigName(options, settings);
      const configPath = resolveConfigPath(configName);
      const orchestrator = await getOrchestrator();
      const config = loadClusterConfig(orchestrator, configPath, settings, providerOverride);
      trackActiveCluster(clusterId, orchestrator);
      printForegroundStartInfo(options, clusterId, configName);

      const strictSchema = resolveStrictSchema(options, settings);
      applyStrictSchema(config, strictSchema);

      const modelOverride = resolveModelOverride(options);
      applyModelOverrideToConfig(config, modelOverride, providerOverride, settings);

      let cluster = null;
      if (input.text) {
        cluster = await startClusterFromText({
          orchestrator,
          text: input.text,
          config,
          settings,
          providerOverride,
          modelOverride,
          forceProvider,
          clusterId,
          options,
        });
      } else if (input.issue) {
        cluster = await startClusterFromIssue({
          orchestrator,
          issue: input.issue,
          config,
          settings,
          providerOverride,
          modelOverride,
          forceProvider,
          clusterId,
          options,
        });
      } else if (input.file) {
        cluster = await startClusterFromFile({
          orchestrator,
          file: input.file,
          config,
          settings,
          providerOverride,
          modelOverride,
          forceProvider,
          clusterId,
          options,
        });
      } else {
        throw new Error(
          `Invalid run input for cluster ${clusterId}: expected text, issue, or file`
        );
      }

      if (!process.env.ZEROSHOT_DAEMON) {
        await streamClusterInForeground(cluster, orchestrator, clusterId, options);
        orchestrator.close();
      }

      setupDaemonCleanup(orchestrator, clusterId);
    } catch (error) {
      if (error.code === 'DUPLICATE_CLUSTER') {
        // Benign guard rejection, not a crash: nothing was allocated, so there is
        // nothing to roll back. No stack trace, no "Error:" framing.
        if (process.env.ZEROSHOT_DAEMON && process.env.ZEROSHOT_CLUSTER_ID) {
          try {
            await removeDetachedSetupCluster({
              clusterId: process.env.ZEROSHOT_CLUSTER_ID,
              storageDir: path.join(os.homedir(), '.zeroshot'),
            });
          } catch (removeError) {
            console.error('Failed to remove provisional setup cluster:', removeError.message);
          }
        }
        console.log(chalk.yellow(error.message));
        process.exit(1);
      }

      if (process.env.ZEROSHOT_DAEMON && process.env.ZEROSHOT_CLUSTER_ID) {
        try {
          await markDetachedSetupFailed({
            clusterId: process.env.ZEROSHOT_CLUSTER_ID,
            storageDir: path.join(os.homedir(), '.zeroshot'),
            error,
            logPath: path.join(
              os.homedir(),
              '.zeroshot',
              `${process.env.ZEROSHOT_CLUSTER_ID}-daemon.log`
            ),
          });
        } catch (markError) {
          console.error('Failed to mark detached setup failure:', markError.message);
        }
      }
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// === TASK COMMANDS ===
// Task run - single-agent background task
const taskCmd = program.command('task').description('Single-agent task management');

const cmdproofCmd = program
  .command('cmdproof')
  .description('Run configured cmdproof command proofs');

for (const mode of ['prove', 'verify', 'check']) {
  cmdproofCmd
    .command(`${mode} <id>`)
    .description(`${mode} a configured command proof`)
    .action((id) => {
      try {
        const exitCode = runCmdproof({ mode, id });
        process.exit(exitCode);
      } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
      }
    });
}

taskCmd
  .command('run <prompt>')
  .description('Run a single-agent background task')
  .option('-C, --cwd <path>', 'Working directory for task')
  .option('--provider <provider>', `Provider to use (${PROVIDER_CHOICES})`)
  .option('--model <model>', 'Model id override for the provider')
  .option('--model-level <level>', 'Model level override (level1, level2, level3)')
  .option('--reasoning-effort <effort>', 'Reasoning effort (low, medium, high, xhigh, max)')
  .option('-r, --resume <sessionId>', 'Resume a specific Claude session (claude only)')
  .option('-c, --continue', 'Continue the most recent Claude session (claude only)')
  .option(
    '-o, --output-format <format>',
    'Output format: stream-json (default), text, json',
    'stream-json'
  )
  .option('--json-schema <schema>', 'JSON schema for structured output')
  .option(
    '--mcp-config <config>',
    'MCP server config for providers that accept an MCP config flag (e.g. Copilot). ' +
      'Inline JSON string ({"mcpServers":{...}}) or @<path>. Repeatable.',
    (value, previous) => (previous || []).concat([value])
  )
  .option('--silent-json-output', 'Log ONLY final structured output')
  .action(async (prompt, options) => {
    try {
      // === PREFLIGHT CHECKS ===
      // Provider CLI must be installed for task execution
      const settings = loadSettings();
      const providerOverride = normalizeProviderName(
        options.provider || process.env.ZEROSHOT_PROVIDER || settings.defaultProvider
      );
      await requirePreflight({
        requireGh: false, // gh not needed for plain tasks
        requireDocker: false, // Docker not needed for plain tasks
        quiet: false,
        provider: providerOverride,
      });

      // Dynamically import task command (ESM module)
      const { runTask } = await import('../task-lib/commands/run.js');
      await runTask(prompt, options);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

taskCmd
  .command('list')
  .alias('ls')
  .description('List all tasks (use "zeroshot list" to see both tasks and clusters)')
  .option('-s, --status <status>', 'Filter tasks by status (running, completed, failed)')
  .option('-n, --limit <n>', 'Limit number of results', parseInt)
  .option('-v, --verbose', 'Show detailed information (default: table view)')
  .action(async (options) => {
    try {
      // Get tasks only (dynamic import)
      const { listTasks } = await import('../task-lib/commands/list.js');
      await listTasks(options);
    } catch (error) {
      console.error('Error listing tasks:', error.message);
      process.exit(1);
    }
  });

// List command - unified (shows both tasks and clusters)
program
  .command('list')
  .alias('ls')
  .description('List all tasks and clusters')
  .option('-s, --status <status>', 'Filter tasks by status (running, completed, failed)')
  .option('-n, --limit <n>', 'Limit number of results', parseInt)
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const orchestrator = await getReadonlyOrchestrator();
      const clusters = filterClustersByStatus(orchestrator.listClusters(), options.status);
      const enrichedClusters = enrichClustersWithTokens(clusters, orchestrator);

      const { listTasks, getTasksData } = await import('../task-lib/commands/list.js');

      if (options.json) {
        const tasks = await tryGetTasksData(getTasksData, options);
        printListJson(enrichedClusters, tasks);
        return;
      }

      printClusterTable(enrichedClusters);

      console.log(chalk.bold('\n=== Tasks ==='));
      await listTasks(options);
    } catch (error) {
      console.error('Error listing:', error.message);
      process.exit(1);
    }
  });

// Status command - smart (works for both tasks and clusters)
program
  .command('status <id>')
  .description('Get detailed status of a task or cluster')
  .option('--json', 'Output as JSON')
  .action(async (id, options) => {
    try {
      const { detectIdType } = require('../lib/id-detector');
      const type = detectIdType(id);

      if (!type) {
        reportMissingId(id, options);
        return;
      }

      if (type === 'cluster') {
        const orchestrator = await getReadonlyOrchestrator();
        const status = orchestrator.getStatus(id);
        const tokensByRole = getClusterTokensByRole(orchestrator, id);
        if (options.json) {
          printClusterStatusJson(status, tokensByRole);
          return;
        }
        printClusterStatusHuman(status, tokensByRole, id);
        return;
      }

      await showTaskStatus(id, options);
    } catch (error) {
      if (options.json) {
        console.log(JSON.stringify({ error: error.message }, null, 2));
      } else {
        console.error('Error getting status:', error.message);
      }
      process.exit(1);
    }
  });

program
  .command('inspect <id>')
  .description('Inspect live process activity for a task or cluster')
  .option('--json', 'Output as JSON')
  .option('--sample-ms <ms>', 'Sampling period for process activity checks', '1000')
  .action(async (id, options) => {
    try {
      await runInspectCommand(id, options);
    } catch (error) {
      if (options.json) {
        console.log(JSON.stringify({ error: error.message }, null, 2));
      } else {
        console.error('Error inspecting:', error.message);
      }
      process.exit(1);
    }
  });

// Logs command - smart (works for both tasks and clusters)
program
  .command('logs [id]')
  .description('View logs (omit ID for all clusters)')
  .option('-f, --follow', 'Follow logs in real-time (stream output like tail -f)')
  .option('-n, --limit <number>', 'Number of recent messages to show (default: 50)', '50')
  .option('--lines <number>', 'Number of lines to show (task mode)', parseInt)
  .option('-w, --watch', 'Watch mode: high-level events for clusters')
  .action(async (id, options) => {
    try {
      if (id) {
        const handled = await handleLogsById(id, options);
        if (handled) {
          return;
        }
      }

      const limit = parseLogLimit(options);
      const quietOrchestrator = await Orchestrator.create({ quiet: true, readonly: true });

      if (!id) {
        showAllClusterLogs(quietOrchestrator, options, limit);
        return;
      }

      showClusterLogsById(quietOrchestrator, id, options, limit);
    } catch (error) {
      console.error('Error viewing logs:', error.message);
      process.exit(1);
    }
  });

// Stop command (cluster-only)
program
  .command('stop <cluster-id>')
  .description('Stop a cluster gracefully')
  .action(async (clusterId) => {
    try {
      console.log(`Stopping cluster ${clusterId}...`);
      await (await getOrchestrator()).stop(clusterId);
      console.log('Cluster stopped successfully');
    } catch (error) {
      console.error('Error stopping cluster:', error.message);
      process.exit(1);
    }
  });

// Kill command - smart (works for both tasks and clusters)
program
  .command('kill <id>')
  .description('Kill a task or cluster')
  .action(async (id) => {
    try {
      const { detectIdType } = require('../lib/id-detector');
      const type = detectIdType(id);

      if (!type) {
        console.error(`ID not found: ${id}`);
        process.exit(1);
      }

      if (type === 'cluster') {
        console.log(`Killing cluster ${id}...`);
        await (await getOrchestrator()).kill(id);
        console.log('Cluster killed successfully');
      } else {
        // Kill task
        const { killTaskCommand } = await import('../task-lib/commands/kill.js');
        await killTaskCommand(id);
      }
    } catch (error) {
      console.error('Error killing:', error.message);
      process.exit(1);
    }
  });

// Attach command - tmux-style attach to running task or cluster agent
program
  .command('attach [id]')
  .description('Attach to a running task or cluster agent (Ctrl+C to detach, task keeps running)')
  .option('-a, --agent <name>', 'Attach to specific agent in cluster (required for clusters)')
  .addHelpText(
    'after',
    `
Examples:
  ${chalk.cyan('zeroshot attach')}                           List attachable tasks/clusters
  ${chalk.cyan('zeroshot attach task-xxx')}                  Attach to task
  ${chalk.cyan('zeroshot attach cluster-xxx --agent worker')} Attach to specific agent in cluster

Key bindings:
  ${chalk.yellow('Ctrl+C')}      Detach (task continues running)
  ${chalk.yellow('Ctrl+B d')}    Also detach (for tmux muscle memory)
  ${chalk.yellow('Ctrl+B ?')}    Show help
  ${chalk.yellow('Ctrl+B c')}    Interrupt agent (sends SIGINT) - USE WITH CAUTION
`
  )
  .action(async (id, options) => {
    try {
      const { AttachClient, socketDiscovery } = require('../src/attach');

      if (!id) {
        await listAttachableProcesses(socketDiscovery);
        return;
      }

      const socketPath = await resolveAttachSocketPath(id, options, socketDiscovery);
      if (!socketPath) {
        return;
      }

      const socketAlive = await socketDiscovery.isSocketAlive(socketPath);
      if (!socketAlive) {
        reportCannotAttach(id);
        process.exit(1);
      }

      await connectAttachClient({
        AttachClient,
        socketPath,
        id,
        agentName: options.agent,
      });
    } catch (error) {
      console.error(chalk.red(`Error attaching: ${error.message}`));
      process.exit(1);
    }
  });

// Kill-all command - kills all running tasks and clusters
program
  .command('kill-all')
  .description('Kill all running tasks and clusters')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (options) => {
    try {
      // Get counts first
      const orchestrator = await getOrchestrator();
      const clusters = orchestrator.listClusters();
      const runningClusters = clusters.filter(
        (c) => c.state === 'running' || c.state === 'initializing' || c.state === 'setup'
      );

      const { loadTasks } = await import('../task-lib/store.js');
      const { isProcessRunning } = await import('../task-lib/runner.js');
      const tasks = loadTasks();
      const runningTasks = Object.values(tasks).filter(
        (t) => t.status === 'running' && isProcessRunning(t.pid)
      );

      const totalCount = runningClusters.length + runningTasks.length;

      if (totalCount === 0) {
        console.log(chalk.dim('No running tasks or clusters to kill.'));
        return;
      }

      // Show what will be killed
      console.log(chalk.bold(`\nWill kill:`));
      if (runningClusters.length > 0) {
        console.log(chalk.cyan(`  ${runningClusters.length} cluster(s)`));
        for (const c of runningClusters) {
          console.log(chalk.dim(`    - ${c.id}`));
        }
      }
      if (runningTasks.length > 0) {
        console.log(chalk.yellow(`  ${runningTasks.length} task(s)`));
        for (const t of runningTasks) {
          console.log(chalk.dim(`    - ${t.id}`));
        }
      }

      // Confirm unless -y flag
      if (!options.yes) {
        const readline = require('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await new Promise((resolve) => {
          rl.question(chalk.bold('\nProceed? [y/N] '), resolve);
        });
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          console.log('Aborted.');
          return;
        }
      }

      console.log('');

      // Kill clusters
      if (runningClusters.length > 0) {
        const clusterResults = await orchestrator.killAll();
        for (const id of clusterResults.killed) {
          console.log(chalk.green(`✓ Killed cluster: ${id}`));
        }
        for (const err of clusterResults.errors) {
          console.log(chalk.red(`✗ Failed to kill cluster ${err.id}: ${err.error}`));
        }
      }

      // Kill tasks
      if (runningTasks.length > 0) {
        const { killTask, isProcessRunning: checkPid } = await import('../task-lib/runner.js');
        const { updateTask } = await import('../task-lib/store.js');

        for (const task of runningTasks) {
          if (!checkPid(task.pid)) {
            updateTask(task.id, {
              status: 'stale',
              error: 'Process died unexpectedly',
            });
            console.log(chalk.yellow(`○ Task ${task.id} was already dead, marked stale`));
            continue;
          }

          const killed = killTask(task.pid);
          if (killed) {
            updateTask(task.id, {
              status: 'killed',
              error: 'Killed by kill-all',
            });
            console.log(chalk.green(`✓ Killed task: ${task.id}`));
          } else {
            console.log(chalk.red(`✗ Failed to kill task: ${task.id}`));
          }
        }
      }

      console.log(chalk.bold.green(`\nDone.`));
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// Export command (cluster-only)
program
  .command('export <cluster-id>')
  .description('Export cluster conversation')
  .option('-f, --format <format>', 'Export format: json, markdown, html', 'html')
  .option('-o, --output <file>', 'Output file (auto-generated for html)')
  .action((clusterId, options) => {
    try {
      // Get messages from DB
      const Ledger = require('../src/ledger');
      const homeDir = require('os').homedir();
      const dbPath = path.join(homeDir, '.zeroshot', `${clusterId}.db`);

      if (!require('fs').existsSync(dbPath)) {
        throw new Error(`Cluster ${clusterId} not found (no DB file)`);
      }

      const ledger = new Ledger(dbPath);
      const messages = ledger.getAll(clusterId);
      ledger.close();

      // JSON export
      if (options.format === 'json') {
        const data = JSON.stringify({ cluster_id: clusterId, messages }, null, 2);
        if (options.output) {
          require('fs').writeFileSync(options.output, data, 'utf8');
          console.log(`Exported to ${options.output}`);
        } else {
          console.log(data);
        }
        return;
      }

      // Terminal-style export (for markdown and pdf)
      const terminalOutput = renderMessagesToTerminal(clusterId, messages);

      if (options.format === 'markdown') {
        // Strip ANSI codes for markdown
        const plainText = terminalOutput.replace(/\\x1b\[[0-9;]*m/g, '');
        if (options.output) {
          require('fs').writeFileSync(options.output, plainText, 'utf8');
          console.log(`Exported to ${options.output}`);
        } else {
          console.log(plainText);
        }
        return;
      }

      // HTML export - convert ANSI to a self-contained, print-ready HTML file.
      // Open it in any browser and use Print -> Save as PDF for a PDF copy.
      // `pdf` is accepted as a migration alias for the previous puppeteer-based export.
      const isLegacyPdfFormat = options.format === 'pdf';
      const outputFile = options.output || `${clusterId}.html`;
      const AnsiToHtml = require('ansi-to-html');

      const ansiConverter = new AnsiToHtml({
        fg: '#d4d4d4',
        bg: '#1e1e1e',
        colors: {
          0: '#1e1e1e',
          1: '#f44747',
          2: '#6a9955',
          3: '#dcdcaa',
          4: '#569cd6',
          5: '#c586c0',
          6: '#4ec9b0',
          7: '#d4d4d4',
          8: '#808080',
          9: '#f44747',
          10: '#6a9955',
          11: '#dcdcaa',
          12: '#569cd6',
          13: '#c586c0',
          14: '#4ec9b0',
          15: '#ffffff',
        },
      });

      const htmlContent = ansiConverter.toHtml(terminalOutput);
      const fullHtml = `<!doctype html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>
            @page { size: A4 landscape; }
            body {
              margin: 0; padding: 16px;
              background: #1e1e1e; color: #d4d4d4;
              font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
              font-size: 9pt; line-height: 1.4;
            }
            pre { margin: 0; font-family: inherit; }
            </style>
          </head>
          <body>
            <pre style="margin:0;padding:0;white-space:pre-wrap;word-wrap:break-word;">${htmlContent}</pre>
          </body>
        </html>`;

      require('fs').writeFileSync(outputFile, fullHtml, 'utf8');
      console.log(`Exported to ${outputFile}`);
      if (isLegacyPdfFormat) {
        console.log(
          'Note: PDF export now produces print-ready HTML. Open it in a browser and use Print -> Save as PDF.'
        );
      }
    } catch (error) {
      console.error('Error exporting cluster:', error.message);
      process.exit(1);
    }
  });

// === TASK-SPECIFIC COMMANDS ===

// Resume task or cluster
program
  .command('resume <id> [prompt]')
  .description('Resume a failed task or cluster')
  .option('-d, --detach', 'Resume in background (daemon mode)')
  .action(async (id, prompt, options) => {
    let orchestrator = null;
    let keepOrchestratorOpen = false;
    try {
      // Try cluster first, then task (both use same ID format: "adjective-noun-number")
      const OrchestratorModule = require('../src/orchestrator');
      orchestrator = await OrchestratorModule.create();

      // Check if cluster exists
      const cluster = orchestrator.getCluster(id);

      const settings = loadSettings();

      if (cluster) {
        // === PREFLIGHT CHECKS ===
        // Provider CLI must be installed; Docker needed if isolation was used
        const requiresDocker = cluster?.isolation?.enabled || false;
        const providerName =
          cluster.config?.forceProvider ||
          cluster.config?.defaultProvider ||
          settings.defaultProvider;

        await requirePreflight({
          requireGh: false, // Resume doesn't fetch new issues
          requireDocker: requiresDocker,
          quiet: false,
          provider: providerName,
        });

        // === DETACH HANDOFF: hand the resume off to a daemon and return ===
        // This is the parent's half only - it never calls orchestrator.resume()
        // itself. Fail fast here (before spawning anything) on the same
        // liveness check orchestrator.resume() would otherwise apply, so a
        // cluster that's genuinely still running doesn't waste a daemon spawn.
        if (shouldRunDetached(options)) {
          if (cluster.state === 'running' && isClusterProcessAlive(cluster.pid)) {
            throw new Error(
              `Cluster ${id} is still running. Use 'zeroshot stop' first if you want to restart it.`
            );
          }
          orchestrator.close();
          const { pid, logPath } = await spawnDetachedResume(id);
          console.log(chalk.green(`✓ Resume daemon started for ${id}`));
          console.log(`  Daemon PID: ${pid}`);
          console.log(`  Daemon log: ${logPath}`);
          console.log('');
          console.log(chalk.dim(`Monitor: zeroshot logs ${id} -f`));
          console.log(chalk.dim(`Status:  zeroshot status ${id}`));
          return;
        }

        // === DAEMON SIDE: this process IS the spawned resume daemon ===
        // Wait for the parent's atomic pid/state patch to name *this* PID as
        // owner before touching the cluster - closes the gap between spawn()
        // returning a PID and that patch landing, so a daemon that lost a
        // concurrent resume --detach race never gets to call resume() at all.
        const isResumeDaemon =
          Boolean(options.detach) &&
          process.env.ZEROSHOT_DAEMON === '1' &&
          process.env.ZEROSHOT_CLUSTER_ID === id;

        if (isResumeDaemon) {
          const storageDir = path.join(os.homedir(), '.zeroshot');
          const owned = await waitForResumeOwnership({
            clusterId: id,
            daemonPid: process.pid,
            storageDir,
          });
          if (!owned) {
            console.error(
              chalk.red(
                `Resume daemon for ${id} never received ownership handoff from parent process; aborting.`
              )
            );
            process.exit(1);
          }
        }

        // Resume cluster
        console.log(chalk.cyan(`Resuming cluster ${id}...`));
        let result;
        try {
          result = await orchestrator.resume(id, prompt);
        } catch (resumeError) {
          if (isResumeDaemon) {
            await revertDetachedResumeCluster({
              clusterId: id,
              storageDir: path.join(os.homedir(), '.zeroshot'),
              error: resumeError,
            });
          }
          throw resumeError;
        }

        console.log(chalk.green(`✓ Cluster resumed`));
        if (result.resumeType === 'failure') {
          console.log(`  Resume type: ${chalk.yellow('From failure')}`);
          console.log(`  Resumed agent: ${result.resumedAgent}`);
          console.log(`  Previous error: ${result.previousError}`);
        } else {
          console.log(`  Resume type: ${chalk.cyan('Clean continuation')}`);
          if (result.resumedAgents && result.resumedAgents.length > 0) {
            console.log(`  Resumed agents: ${result.resumedAgents.join(', ')}`);
          } else {
            console.log(`  Published CLUSTER_RESUMED to trigger workflow`);
          }
        }

        // === DAEMON MODE: stay alive in the background, let signals stop the cluster ===
        if (isResumeDaemon) {
          setupDaemonCleanup(orchestrator, id);
          keepOrchestratorOpen = true;
          console.log('');
          console.log(chalk.dim(`Follow logs with: zeroshot logs ${id} -f`));
          return;
        }

        // === FOREGROUND MODE: Stream logs in real-time (same as 'run' command) ===
        console.log('');
        console.log(chalk.dim('Streaming logs... (Ctrl+C to stop cluster)'));
        console.log('');

        // Get the cluster's message bus for streaming
        const resumedCluster = orchestrator.getCluster(id);
        if (!resumedCluster || !resumedCluster.messageBus) {
          console.error(chalk.red('Failed to get message bus for resumed cluster'));
          process.exit(1);
        }

        // Track senders that have output (for periodic flushing)
        const sendersWithOutput = new Set();
        // Track messages we've already processed (to avoid duplicates between history and subscription)
        const processedMessageIds = new Set();

        // Message handler - processes messages, deduplicates by ID
        const handleMessage = (msg) => {
          if (msg.cluster_id !== id) return;
          if (processedMessageIds.has(msg.id)) return;
          processedMessageIds.add(msg.id);

          if (msg.topic === 'AGENT_OUTPUT' && msg.sender) {
            sendersWithOutput.add(msg.sender);
          }
          printMessage(msg, false, false, true);
        };

        // Subscribe to NEW messages
        const unsubscribe = resumedCluster.messageBus.subscribe(handleMessage);

        // Periodic flush of text buffers (streaming text may not have newlines)
        const flushInterval = setInterval(() => {
          for (const sender of sendersWithOutput) {
            const prefix = getColorForSender(sender)(`${sender.padEnd(15)} |`);
            flushLineBuffer(prefix, sender);
          }
        }, 250);

        // Wait for cluster to complete
        await new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            try {
              const status = orchestrator.getStatus(id);
              if (status.state !== 'running') {
                clearInterval(checkInterval);
                clearInterval(flushInterval);
                // Final flush
                for (const sender of sendersWithOutput) {
                  const prefix = getColorForSender(sender)(`${sender.padEnd(15)} |`);
                  flushLineBuffer(prefix, sender);
                }
                unsubscribe();
                resolve();
              }
            } catch {
              // Cluster may have been removed
              clearInterval(checkInterval);
              clearInterval(flushInterval);
              unsubscribe();
              resolve();
            }
          }, 500);

          // Handle Ctrl+C: Stop cluster since foreground mode has no daemon
          // CRITICAL: In foreground mode, the cluster runs IN this process.
          // If we exit without stopping, the cluster becomes a zombie (state=running but no process).
          process.on('SIGINT', async () => {
            console.log(chalk.dim('\n\n--- Interrupted ---'));
            clearInterval(checkInterval);
            clearInterval(flushInterval);
            unsubscribe();

            // Stop the cluster properly so state is updated
            try {
              console.log(chalk.dim(`Stopping cluster ${id}...`));
              await orchestrator.stop(id);
              console.log(chalk.dim(`Cluster ${id} stopped.`));
            } catch (stopErr) {
              console.error(chalk.red(`Failed to stop cluster: ${stopErr.message}`));
            }

            process.exit(0);
          });
        });

        console.log(chalk.dim(`\nCluster ${id} completed.`));
      } else {
        let providerName = settings.defaultProvider;
        try {
          const { getTask } = await import('../task-lib/store.js');
          const task = getTask(id);
          if (task?.provider) {
            providerName = task.provider;
          }
        } catch {
          // If task store is unavailable, fall back to default provider
        }

        await requirePreflight({
          requireGh: false,
          requireDocker: false,
          quiet: false,
          provider: providerName,
        });

        // Try resuming as task
        const { resumeTask } = await import('../task-lib/commands/resume.js');
        await resumeTask(id, prompt);
      }
    } catch (error) {
      console.error(chalk.red('Error resuming:'), error.message);
      process.exitCode = 1;
    } finally {
      if (orchestrator && !keepOrchestratorOpen) {
        orchestrator.close();
      }
    }
  });

// Finish cluster - convert to single-agent completion task
program
  .command('finish <id>')
  .description('Take existing cluster and create completion-focused task (creates PR and merges)')
  .option('-y, --yes', 'Skip confirmation if cluster is running')
  .action(async (id, options) => {
    try {
      const orchestrator = await getOrchestrator();

      const cluster = getFinishCluster(orchestrator, id);
      await stopClusterIfRunning(cluster, id, options, orchestrator);

      console.log(chalk.cyan(`Converting cluster ${id} to completion task...`));
      console.log('');

      const messages = cluster.messageBus.getAll(id);
      const context = extractFinishContext(messages);
      const contextSummary = buildContextSummary(context);
      const completionPrompt = buildCompletionPrompt({
        contextSummary,
        taskText: context.taskText,
        issueNumber: context.issueNumber,
        issueTitle: context.issueTitle,
      });
      printCompletionPromptPreview(completionPrompt);

      // Launch as task (preserve isolation if cluster was isolated)
      console.log(chalk.cyan('Launching completion task...'));
      const { runTask } = await import('../task-lib/commands/run.js');
      const taskOptions = buildFinishTaskOptions(cluster);
      await runTask(completionPrompt, taskOptions);
      printFinishTaskStarted(cluster);
    } catch (error) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

// Clean tasks
program
  .command('clean')
  .description('Remove old task records and logs')
  .option('-a, --all', 'Remove all tasks')
  .option('-c, --completed', 'Remove completed tasks')
  .option('-f, --failed', 'Remove failed/stale/killed tasks')
  .action(async (options) => {
    try {
      const { cleanTasks } = await import('../task-lib/commands/clean.js');
      await cleanTasks(options);
    } catch (error) {
      console.error('Error cleaning tasks:', error.message);
      process.exit(1);
    }
  });

// Garbage-collect orphaned worktrees and database files
function printGcResult(result, dryRun) {
  const verb = dryRun ? 'Would remove' : 'Removed';
  if (result.orphanedWorktrees.length === 0 && result.orphanedDbs.length === 0) {
    console.log(chalk.dim('No orphaned worktrees or database files found.'));
    return;
  }
  if (result.orphanedWorktrees.length > 0) {
    console.log(chalk.bold(`\n${verb} ${result.orphanedWorktrees.length} orphaned worktree(s):`));
    result.orphanedWorktrees.forEach((n) =>
      console.log(chalk.dim(`  ~/.zeroshot/worktrees/${n}/`))
    );
  }
  if (result.orphanedDbs.length > 0) {
    console.log(chalk.bold(`\n${verb} ${result.orphanedDbs.length} orphaned database file(s):`));
    result.orphanedDbs.forEach((n) => console.log(chalk.dim(`  ~/.zeroshot/${n}`)));
  }
  if (result.errors.length > 0) {
    console.log(chalk.yellow(`\n${result.errors.length} error(s):`));
    result.errors.forEach((e) => console.log(chalk.yellow(`  ${e}`)));
  }
  if (!dryRun) console.log(chalk.green('\n✓ Garbage collection complete.'));
}

async function runGc(dryRun) {
  try {
    const orchestrator = await getOrchestrator();
    return orchestrator.gcWorktrees({ dryRun });
  } catch {
    const { gcOrphanedWorktrees } = await import('../src/lib/gc.js');
    return gcOrphanedWorktrees({ dryRun });
  }
}

async function detectAndReportCorruptedClusters(dryRun) {
  if (dryRun) {
    return;
  }
  try {
    const orchestrator = await getOrchestrator();
    const corrupted = await orchestrator.detectCorruptedClusters();
    if (corrupted.length > 0) {
      console.log(chalk.yellow(`\nFound ${corrupted.length} corrupted cluster(s):`));
      corrupted.forEach((id) => console.log(chalk.yellow(`  ${id}`)));
      console.log(chalk.dim(`Run 'zeroshot kill <id>' to remove them.`));
    }
  } catch (error) {
    console.error(`Error detecting corrupted clusters: ${error.message}`);
  }
}

program
  .command('gc')
  .description('Clean up orphaned worktree directories and stale database files')
  .option('--dry-run', 'Show what would be removed without deleting')
  .action(async (options) => {
    try {
      printGcResult(await runGc(options.dryRun), options.dryRun);
      await detectAndReportCorruptedClusters(options.dryRun);
    } catch (error) {
      console.error('Error during garbage collection:', error.message);
      process.exit(1);
    }
  });

// Purge all runs (clusters + tasks) - NUCLEAR option
program
  .command('purge')
  .description('NUCLEAR: Kill all running processes and delete all data')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (options) => {
    try {
      const orchestrator = await getOrchestrator();
      const purgeData = await getPurgeData(orchestrator);

      if (purgeData.clusters.length === 0 && purgeData.tasks.length === 0) {
        console.log(chalk.dim('No clusters or tasks to clear.'));
        return;
      }

      printPurgeSummary(purgeData);
      const confirmed = await confirmPurge(options);
      if (!confirmed) {
        console.log('Aborted.');
        return;
      }

      console.log('');

      await killRunningClusters(orchestrator, purgeData.runningClusters);
      await killRunningTasks(purgeData.runningTasks, purgeData.isProcessRunning);
      deleteClusterData(orchestrator, purgeData.clusters);
      await deleteTaskData(purgeData.tasks);

      console.log(chalk.bold.green('\nAll runs purged.'));
    } catch (error) {
      console.error('Error clearing runs:', error.message);
      process.exit(1);
    }
  });

// Schedule a task
program
  .command('schedule <prompt>')
  .description('Create a recurring scheduled task')
  .option('-e, --every <interval>', 'Interval (e.g., "1h", "30m", "1d")')
  .option('--cron <expression>', 'Cron expression')
  .option('-C, --cwd <path>', 'Working directory')
  .action(async (prompt, options) => {
    try {
      const { createSchedule } = await import('../task-lib/commands/schedule.js');
      await createSchedule(prompt, options);
    } catch (error) {
      console.error('Error creating schedule:', error.message);
      process.exit(1);
    }
  });

// List schedules
program
  .command('schedules')
  .description('List all scheduled tasks')
  .action(async () => {
    try {
      const { listSchedules } = await import('../task-lib/commands/schedules.js');
      await listSchedules();
    } catch (error) {
      console.error('Error listing schedules:', error.message);
      process.exit(1);
    }
  });

// Unschedule a task
program
  .command('unschedule <scheduleId>')
  .description('Remove a scheduled task')
  .action(async (scheduleId) => {
    try {
      const { deleteSchedule } = await import('../task-lib/commands/unschedule.js');
      await deleteSchedule(scheduleId);
    } catch (error) {
      console.error('Error unscheduling:', error.message);
      process.exit(1);
    }
  });

// Scheduler daemon management
program
  .command('scheduler <action>')
  .description('Manage scheduler daemon (start, stop, status, logs)')
  .action(async (action) => {
    try {
      const { schedulerCommand } = await import('../task-lib/commands/scheduler-cmd.js');
      await schedulerCommand(action);
    } catch (error) {
      console.error('Error managing scheduler:', error.message);
      process.exit(1);
    }
  });

// Get log path (machine-readable)
program
  .command('get-log-path <taskId>')
  .description('Output log file path for a task (machine-readable)')
  .action(async (taskId) => {
    try {
      const { getLogPath } = await import('../task-lib/commands/get-log-path.js');
      await getLogPath(taskId);
    } catch (error) {
      console.error('Error getting log path:', error.message);
      process.exit(1);
    }
  });

function failTuiUnavailable() {
  console.error(
    'The TUI is not included in this Zeroshot release. Use `zeroshot logs -f`, `zeroshot logs -w`, or `zeroshot list` instead.'
  );
  process.exit(1);
}

program.command('watch').description('TUI unavailable in this release').action(failTuiUnavailable);

program
  .command('tui')
  .description('TUI unavailable in this release')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(failTuiUnavailable);

function registerTuiEntrypoint(commandName, providerName) {
  program
    .command(commandName)
    .description(`TUI unavailable in this release (provider: ${providerName})`)
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .action(failTuiUnavailable);
}

for (const providerName of VALID_PROVIDERS) {
  registerTuiEntrypoint(providerName, providerName);
}

// Settings management
const settingsCmd = program.command('settings').description('Manage zeroshot settings');

function printSettingsUsage() {
  const mountPresetList = Object.keys(MOUNT_PRESETS).join(', ');
  console.log(chalk.dim('Usage:'));
  console.log(chalk.dim('  zeroshot settings set <key> <value>'));
  console.log(chalk.dim('  zeroshot settings get <key>'));
  console.log(chalk.dim('  zeroshot settings reset'));
  console.log('');
  console.log(chalk.dim('Examples:'));
  console.log(chalk.dim('  zeroshot settings set maxModel opus'));
  console.log(chalk.dim('  zeroshot settings set dockerMounts \'["gh","git","ssh","aws"]\''));
  console.log(chalk.dim('  zeroshot settings set dockerEnvPassthrough \'["AWS_*","TF_VAR_*"]\''));
  console.log('');
  console.log(chalk.dim(`Available mount presets: ${mountPresetList}`));
  console.log('');
}

function printNonDockerSettings(settings) {
  const dockerKeys = new Set(['dockerMounts', 'dockerEnvPassthrough', 'dockerContainerHome']);
  for (const [key, value] of Object.entries(settings)) {
    if (dockerKeys.has(key)) {
      continue;
    }
    const displayValue =
      key === 'linearApiKey' && value ? `${String(value).slice(0, 7)}***` : value;
    const isDefault = JSON.stringify(DEFAULT_SETTINGS[key]) === JSON.stringify(value);
    const label = isDefault ? chalk.dim(key) : chalk.cyan(key);
    const val = isDefault ? chalk.dim(String(displayValue)) : chalk.white(String(displayValue));
    console.log(`  ${label.padEnd(30)} ${val}`);
  }
}

function printPresetMountRow(mountName, preset, containerHome) {
  if (!preset) {
    console.log(`      ${chalk.red(mountName.padEnd(10))} ${chalk.red('(unknown preset)')}`);
    return;
  }
  const container = preset.container.replace(/\$HOME/g, containerHome);
  const rwFlag = preset.readonly ? chalk.dim('ro') : chalk.green('rw');
  console.log(
    `      ${chalk.cyan(mountName.padEnd(10))} ${chalk.dim(preset.host.padEnd(20))} → ${container.padEnd(24)} (${rwFlag})`
  );
}

function printCustomMountRow(mount, containerHome) {
  const container = mount.container.replace(/\$HOME/g, containerHome);
  const rwFlag = mount.readonly !== false ? chalk.dim('ro') : chalk.green('rw');
  console.log(
    `      ${chalk.yellow('custom'.padEnd(10))} ${chalk.dim(mount.host.padEnd(20))} → ${container.padEnd(24)} (${rwFlag})`
  );
}

function printDockerMounts(mounts, containerHome) {
  const presets = mounts.filter((m) => typeof m === 'string');
  const customMounts = mounts.filter((m) => typeof m === 'object');
  const mountLabel =
    customMounts.length > 0
      ? `Mounts (${presets.length} presets, ${customMounts.length} custom):`
      : `Mounts (${presets.length} presets):`;
  console.log(chalk.dim(`    ${mountLabel}`));

  if (mounts.length === 0) {
    console.log(chalk.dim('      (none)'));
    return;
  }

  for (const mount of mounts) {
    if (typeof mount === 'string') {
      printPresetMountRow(mount, MOUNT_PRESETS[mount], containerHome);
    } else {
      printCustomMountRow(mount, containerHome);
    }
  }
}

function printDockerEnvironment(mounts, envPassthrough) {
  const resolvedEnvs = resolveEnvs(mounts, envPassthrough);
  if (resolvedEnvs.length === 0) {
    console.log(chalk.dim('    Environment: (none)'));
    return;
  }
  console.log(chalk.dim(`    Environment (${resolvedEnvs.length} vars):`));
  const fromPresets = resolvedEnvs.filter((env) => !envPassthrough.includes(env));
  if (fromPresets.length > 0) {
    console.log(`      ${chalk.dim('From presets:')} ${fromPresets.join(', ')}`);
  }
  if (envPassthrough.length > 0) {
    console.log(`      ${chalk.cyan('Explicit:')} ${envPassthrough.join(', ')}`);
  }
}

function printDockerContainerHome(containerHome) {
  const homeIsDefault = containerHome === '/root';
  const homeLabel = homeIsDefault ? chalk.dim('Container home:') : chalk.cyan('Container home:');
  const homeVal = homeIsDefault ? chalk.dim(containerHome) : chalk.white(containerHome);
  console.log(`    ${homeLabel} ${homeVal}`);
}

function printDockerConfiguration(settings) {
  console.log('');
  console.log(chalk.bold('  Docker Configuration:'));

  const containerHome = settings.dockerContainerHome || '/root';
  const mounts = settings.dockerMounts || [];
  const envPassthrough = settings.dockerEnvPassthrough || [];

  printDockerMounts(mounts, containerHome);
  printDockerEnvironment(mounts, envPassthrough);
  printDockerContainerHome(containerHome);
  console.log('');
}

/**
 * Format settings list with grouped Docker configuration
 * Docker mounts shown as expanded table instead of raw JSON
 */
function formatSettingsList(settings, showUsage = false) {
  console.log(chalk.bold('\nSettings:\n'));
  printNonDockerSettings(settings);
  printDockerConfiguration(settings);
  if (showUsage) {
    printSettingsUsage();
  }
}

function listConfigFiles() {
  return fs
    .readdirSync(path.join(PACKAGE_ROOT, 'cluster-templates'))
    .filter((file) => file.endsWith('.json'));
}

function printAvailableConfigs(files) {
  files.forEach((file) => console.log(chalk.dim(`  - ${file.replace('.json', '')}`)));
}

function resolveConfigPathForShow(name) {
  const configName = name.endsWith('.json') ? name : `${name}.json`;
  const configPath = path.join(PACKAGE_ROOT, 'cluster-templates', configName);
  if (fs.existsSync(configPath)) {
    return { configPath, displayName: name.replace('.json', '') };
  }

  console.error(chalk.red(`Config not found: ${configName}`));
  console.log(chalk.dim('\nAvailable configs:'));
  printAvailableConfigs(listConfigFiles());
  process.exit(1);
}

function printConfigHeader(name) {
  console.log('');
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log(chalk.bold.cyan(`  Config: ${name}`));
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log('');
}

function printConfigFooter() {
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log('');
}

function getAgentsDir() {
  return path.join(PACKAGE_ROOT, 'src', 'agents');
}

function printAgentsJson(agents) {
  console.log(JSON.stringify({ agents, error: null }, null, 2));
}

function reportMissingAgentsDir(options) {
  if (options.json) {
    printAgentsJson([]);
  } else {
    console.log(chalk.dim('No agents directory found.'));
  }
}

function reportNoAgents(options) {
  if (options.json) {
    printAgentsJson([]);
  } else {
    console.log(chalk.dim('No agent definitions found in src/agents/'));
  }
}

function parseAgentFile(file, agentsDir) {
  try {
    const agentPath = path.join(agentsDir, file);
    const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
    return {
      file: file.replace('.json', ''),
      id: agent.id || file.replace('.json', ''),
      role: agent.role || 'unspecified',
      model: agent.model || 'default',
      triggers: agent.triggers?.length || 0,
      prompt: agent.prompt || null,
      output: agent.output || null,
    };
  } catch (err) {
    console.error(chalk.yellow(`Warning: Could not parse ${file}: ${err.message}`));
    return null;
  }
}

function loadAgentDefinitions(files, agentsDir) {
  const agents = [];
  for (const file of files) {
    const agent = parseAgentFile(file, agentsDir);
    if (agent) {
      agents.push(agent);
    }
  }
  return agents;
}

function printAgentsList(agents) {
  console.log(chalk.bold('\nAvailable agent definitions:\n'));
  for (const agent of agents) {
    console.log(
      `  ${chalk.cyan(agent.id.padEnd(25))} ${chalk.dim('role:')} ${agent.role.padEnd(20)} ${chalk.dim('model:')} ${agent.model}`
    );
    console.log(chalk.dim(`    Triggers: ${agent.triggers}`));
    if (agent.output) {
      const outputTopic = typeof agent.output === 'object' ? agent.output.topic : null;
      console.log(chalk.dim(`    Output topic: ${outputTopic || 'none'}`));
    }
    if (agent.prompt) {
      const promptPreview = agent.prompt.substring(0, 100).replace(/\n/g, ' ');
      console.log(chalk.dim(`    Prompt: ${promptPreview}...`));
    }
    console.log('');
  }
}

function getTriggerTopics(triggers) {
  return triggers
    .map((trigger) => (typeof trigger === 'string' ? trigger : trigger.topic))
    .filter(Boolean);
}

function printAgentDetails(agent) {
  const color = getColorForSender(agent.id);
  console.log(color.bold(`  ${agent.id}`));
  console.log(chalk.dim(`    Role: ${agent.role || 'none'}`));

  if (agent.model) {
    console.log(chalk.dim(`    Model: ${agent.model}`));
  }

  if (agent.triggers && agent.triggers.length > 0) {
    const triggerTopics = getTriggerTopics(agent.triggers);
    console.log(chalk.dim(`    Triggers: ${triggerTopics.join(', ')}`));
  } else {
    console.log(chalk.dim(`    Triggers: none (manual only)`));
  }

  console.log('');
}

function printAgentsSection(agents) {
  console.log(chalk.bold('Agents:\n'));
  if (!agents || agents.length === 0) {
    console.log(chalk.dim('  No agents defined'));
    return;
  }
  for (const agent of agents) {
    printAgentDetails(agent);
  }
}

function buildTriggerMap(agents) {
  const triggerMap = new Map();
  for (const agent of agents) {
    if (!agent.triggers) {
      continue;
    }
    for (const trigger of agent.triggers) {
      const topic = typeof trigger === 'string' ? trigger : trigger.topic;
      if (!topic) {
        continue;
      }
      if (!triggerMap.has(topic)) {
        triggerMap.set(topic, []);
      }
      triggerMap.get(topic).push(agent.id);
    }
  }
  return triggerMap;
}

function printMessageFlow(agents) {
  if (!agents || agents.length === 0) {
    return;
  }

  console.log(chalk.bold('Message Flow:\n'));
  const triggerMap = buildTriggerMap(agents);
  if (triggerMap.size === 0) {
    console.log(chalk.dim('  No automatic triggers defined\n'));
    return;
  }

  for (const [topic, agentIds] of triggerMap) {
    const coloredAgents = agentIds.map((id) => getColorForSender(id)(id)).join(', ');
    console.log(`  ${chalk.yellow(topic)} ${chalk.dim('→')} ${coloredAgents}`);
  }
  console.log('');
}

settingsCmd
  .command('list')
  .description('Show all settings')
  .action(() => {
    const settings = loadSettings();
    formatSettingsList(settings, false);
  });

/**
 * Get nested value by dot-notation path
 * @param {object} obj - Object to traverse
 * @param {string} dotPath - Dot-notation path (e.g., 'providerSettings.claude.anthropicApiKey')
 * @returns {{ value: any, found: boolean }}
 */
function getNestedValue(obj, dotPath) {
  const parts = dotPath.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return { value: undefined, found: false };
    }
    if (!(part in current)) {
      return { value: undefined, found: false };
    }
    current = current[part];
  }
  return { value: current, found: true };
}

/**
 * Set nested value by dot-notation path, creating intermediate objects as needed
 * @param {object} obj - Object to modify
 * @param {string} dotPath - Dot-notation path
 * @param {any} value - Value to set
 */
function setNestedValue(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Parse a setting value string into appropriate type
 * Handles null, boolean, JSON, and falls back to string
 * @param {string} value - Raw value string
 * @returns {any} Parsed value
 */
function parseSettingValue(value) {
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  try {
    return JSON.parse(value);
  } catch {
    return value; // Keep as string if not valid JSON
  }
}

settingsCmd
  .command('get <key>')
  .description(
    'Get a setting value (supports dot-notation: providerSettings.claude.anthropicApiKey)'
  )
  .action((key) => {
    const settings = loadSettings();

    // Support dot-notation for nested values
    if (key.includes('.')) {
      const { value, found } = getNestedValue(settings, key);
      if (!found) {
        console.error(chalk.red(`Setting not found: ${key}`));
        process.exit(1);
      }
      console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : value);
      return;
    }

    if (!(key in settings)) {
      console.error(chalk.red(`Unknown setting: ${key}`));
      console.log(chalk.dim('\nAvailable settings:'));
      Object.keys(DEFAULT_SETTINGS).forEach((k) => console.log(chalk.dim(`  - ${k}`)));
      process.exit(1);
    }
    console.log(
      typeof settings[key] === 'object' ? JSON.stringify(settings[key], null, 2) : settings[key]
    );
  });

settingsCmd
  .command('set <key> <value>')
  .description(
    'Set a setting value (supports dot-notation: providerSettings.claude.anthropicApiKey)'
  )
  .action((key, value) => {
    const settings = loadSettings();

    // Support dot-notation for nested values
    if (key.includes('.')) {
      const parts = key.split('.');
      const rootKey = parts[0];

      // Validate root key exists in defaults
      if (!(rootKey in DEFAULT_SETTINGS)) {
        console.error(chalk.red(`Unknown setting: ${rootKey}`));
        console.log(chalk.dim('\nAvailable settings:'));
        Object.keys(DEFAULT_SETTINGS).forEach((k) => console.log(chalk.dim(`  - ${k}`)));
        process.exit(1);
      }

      const parsedValue = parseSettingValue(value);

      // Set nested value
      setNestedValue(settings, key, parsedValue);

      // Validate the root key after modification
      const validationError = validateSetting(rootKey, settings[rootKey]);
      if (validationError) {
        console.error(chalk.red(validationError));
        process.exit(1);
      }

      saveSettings(settings);
      const displayValue =
        typeof parsedValue === 'string' ? parsedValue : JSON.stringify(parsedValue);
      console.log(chalk.green(`✓ Set ${key} = ${displayValue}`));
      return;
    }

    // Original flat key handling
    if (!(key in DEFAULT_SETTINGS)) {
      console.error(chalk.red(`Unknown setting: ${key}`));
      console.log(chalk.dim('\nAvailable settings:'));
      Object.keys(DEFAULT_SETTINGS).forEach((k) => console.log(chalk.dim(`  - ${k}`)));
      process.exit(1);
    }

    // Type coercion
    let parsedValue;
    try {
      parsedValue = coerceValue(key, value);
    } catch (error) {
      console.error(chalk.red(error.message));
      process.exit(1);
    }

    // Validation
    const validationError = validateSetting(key, parsedValue);
    if (validationError) {
      console.error(chalk.red(validationError));
      process.exit(1);
    }

    settings[key] = parsedValue;
    saveSettings(settings);
    console.log(chalk.green(`✓ Set ${key} = ${JSON.stringify(parsedValue)}`));
  });

settingsCmd
  .command('reset')
  .description('Reset all settings to defaults')
  .option('-y, --yes', 'Skip confirmation')
  .action((options) => {
    if (!options.yes) {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question(chalk.yellow('Reset all settings to defaults? [y/N] '), (answer) => {
        rl.close();
        if (answer.toLowerCase() !== 'y') {
          console.log('Aborted.');
          return;
        }
        saveSettings(DEFAULT_SETTINGS);
        console.log(chalk.green('✓ Settings reset to defaults'));
      });
    } else {
      saveSettings(DEFAULT_SETTINGS);
      console.log(chalk.green('✓ Settings reset to defaults'));
    }
  });

// Add alias for settings list (just `zeroshot settings`)
settingsCmd.action(() => {
  const settings = loadSettings();
  formatSettingsList(settings, true);
});

// Providers management
const providersCmd = program.command('providers').description('Manage AI providers');
providersCmd.action(async () => {
  await providersCommand();
});

providersCmd
  .command('set-default <provider>')
  .description(`Set default provider (${PROVIDER_CHOICES})`)
  .action(async (provider) => {
    await setDefaultCommand([provider]);
  });

providersCmd
  .command('setup <provider>')
  .description('Configure provider model levels and overrides')
  .action(async (provider) => {
    await setupCommand([provider]);
  });

// Setup wizard (read-only facts + setup contract; apply/undo/TTY wizard land separately)
const setupCmd = program.command('setup').description('Setup and configuration wizard');
setupCmd
  .command('plan')
  .description('Show read-only setup facts and proposed contract (no writes)')
  .option('--json', 'Output as JSON')
  .action(() => {
    const { buildSetupPlan } = require('../lib/setup-plan');
    const { readRepoSettings } = require('../lib/repo-settings');

    const cwd = process.cwd();
    const settings = loadSettings();
    settings.__meta = { fileExists: settingsFileExists() };
    const { settings: repoSettings } = readRepoSettings(cwd);
    const plan = buildSetupPlan({
      cwd,
      settings,
      repoSettings,
      env: { ...process.env, __isTTY: !!process.stdout.isTTY },
    });
    console.log(JSON.stringify(plan, null, 2));
  });

setupCmd
  .command('apply')
  .description('Apply a decisions file to global/repo settings (writes)')
  .requiredOption('--decisions <file>', 'Path to decisions JSON file')
  .option('--json', 'Output as JSON')
  .option(
    '--allow-risky-defaults',
    'Allow storing defaultDelivery=ship as a global default (auto-merge by default)'
  )
  .action((opts) => {
    const { applyDecisions } = require('../lib/setup-apply');
    try {
      const results = applyDecisions({
        decisionsPath: opts.decisions,
        cwd: process.cwd(),
        allowRiskyDefaults: !!opts.allowRiskyDefaults,
      });
      console.log(JSON.stringify({ results }, null, 2));
    } catch (err) {
      console.error(JSON.stringify({ error: err.message }, null, 2));
      process.exitCode = 1;
    }
  });

setupCmd
  .command('undo')
  .description('Undo writes made by the most recent `zeroshot setup apply` runs')
  .option('--json', 'Output as JSON')
  .action(() => {
    const { undo } = require('../lib/setup-undo');
    try {
      const results = undo({});
      console.log(JSON.stringify({ results }, null, 2));
    } catch (err) {
      console.error(JSON.stringify({ error: err.message }, null, 2));
      process.exitCode = 1;
    }
  });

// Update command
program
  .command('update')
  .description('Update zeroshot to the latest version')
  .option('--check', 'Check for updates without installing')
  .action(async (options) => {
    const {
      getCurrentVersion,
      fetchLatestVersion,
      isNewerVersion,
      runUpdate,
    } = require('./lib/update-checker');

    const currentVersion = getCurrentVersion();
    console.log(chalk.dim(`Current version: ${currentVersion}`));
    console.log(chalk.dim('Checking for updates...'));

    const latestVersion = await fetchLatestVersion();

    if (!latestVersion) {
      console.error(chalk.red('Failed to check for updates. Check your internet connection.'));
      process.exit(1);
    }

    console.log(chalk.dim(`Latest version:  ${latestVersion}`));

    if (!isNewerVersion(currentVersion, latestVersion)) {
      console.log(chalk.green('\n✓ You are already on the latest version!'));
      return;
    }

    console.log(chalk.yellow(`\n📦 Update available: ${currentVersion} → ${latestVersion}`));

    if (options.check) {
      console.log(chalk.dim('\nRun `zeroshot update` to install the update.'));
      return;
    }

    const success = await runUpdate();
    process.exit(success ? 0 : 1);
  });

// Config visualization commands
const configCmd = program.command('config').description('Manage and visualize cluster configs');

configCmd
  .command('list')
  .description('List available cluster configs')
  .action(() => {
    try {
      const configsDir = path.join(PACKAGE_ROOT, 'cluster-templates');
      const files = fs.readdirSync(configsDir).filter((f) => f.endsWith('.json'));

      if (files.length === 0) {
        console.log(chalk.dim('No configs found in examples/'));
        return;
      }

      console.log(chalk.bold('\nAvailable configs:\n'));
      for (const file of files) {
        const configPath = path.join(configsDir, file);
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const agentCount = config.agents?.length || 0;
        const name = file.replace('.json', '');

        console.log(`  ${chalk.cyan(name.padEnd(30))} ${chalk.dim(`${agentCount} agents`)}`);
      }
      console.log('');
    } catch (error) {
      console.error('Error listing configs:', error.message);
      process.exit(1);
    }
  });

configCmd
  .command('show <name>')
  .description('Visualize a cluster config')
  .action((name) => {
    try {
      const { configPath, displayName } = resolveConfigPathForShow(name);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      printConfigHeader(displayName);
      printAgentsSection(config.agents);
      printMessageFlow(config.agents);
      printConfigFooter();
    } catch (error) {
      console.error('Error showing config:', error.message);
      process.exit(1);
    }
  });

configCmd
  .command('validate <configPath>')
  .description('Validate a cluster config for structural issues')
  .option('--strict', 'Treat warnings as errors')
  .option('--json', 'Output as JSON')
  .action((configPath, options) => {
    try {
      const { validateConfig, formatValidationResult } = require('../src/config-validator');

      // Resolve path (support relative paths and built-in names)
      let fullPath;
      if (fs.existsSync(configPath)) {
        fullPath = path.resolve(configPath);
      } else {
        // Try examples directory
        const configName = configPath.endsWith('.json') ? configPath : `${configPath}.json`;
        fullPath = path.join(PACKAGE_ROOT, 'cluster-templates', configName);
        if (!fs.existsSync(fullPath)) {
          console.error(chalk.red(`Config not found: ${configPath}`));
          console.log(chalk.dim('\nAvailable built-in configs:'));
          const files = fs
            .readdirSync(path.join(PACKAGE_ROOT, 'cluster-templates'))
            .filter((f) => f.endsWith('.json'));
          files.forEach((f) => console.log(chalk.dim(`  - ${f.replace('.json', '')}`)));
          process.exit(1);
        }
      }

      // Load and validate
      const config = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const result = validateConfig(config);

      // Apply strict mode
      if (options.strict && result.warnings.length > 0) {
        result.errors.push(...result.warnings.map((w) => `[strict] ${w}`));
        result.valid = false;
      }

      // Output
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('');
        console.log(chalk.bold(`Validating: ${path.basename(fullPath)}`));
        console.log('');
        console.log(formatValidationResult(result));
        console.log('');
      }

      // Exit code
      process.exit(result.valid ? 0 : 1);
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.error(chalk.red(`Invalid JSON: ${error.message}`));
      } else {
        console.error(chalk.red(`Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

// Agent library commands
const agentsCmd = program.command('agents').description('View available agent definitions');

agentsCmd
  .command('list')
  .alias('ls')
  .description('List available agent definitions')
  .option('--verbose', 'Show full agent details')
  .option('--json', 'Output as JSON')
  .action((options) => {
    try {
      const agentsDir = getAgentsDir();
      if (!fs.existsSync(agentsDir)) {
        reportMissingAgentsDir(options);
        return;
      }

      const files = fs.readdirSync(agentsDir).filter((file) => file.endsWith('.json'));
      if (files.length === 0) {
        reportNoAgents(options);
        return;
      }

      const agents = loadAgentDefinitions(files, agentsDir);
      agents.sort((a, b) => a.id.localeCompare(b.id));

      if (options.json) {
        printAgentsJson(agents);
        return;
      }

      if (options.verbose) {
        printAgentsList(agents);
        return;
      }

      console.log(chalk.bold('\nAvailable agent definitions:\n'));
      for (const agent of agents) {
        console.log(
          `  ${chalk.cyan(agent.id.padEnd(25))} ${chalk.dim('role:')} ${agent.role.padEnd(20)} ${chalk.dim('model:')} ${agent.model}`
        );
      }
      console.log('');
      console.log(chalk.dim('  Use --verbose for full details'));
      console.log('');
    } catch (error) {
      if (options.json) {
        console.log(JSON.stringify({ agents: [], error: error.message }, null, 2));
      } else {
        console.error(chalk.red(`Error listing agents: ${error.message}`));
      }
      process.exit(1);
    }
  });

agentsCmd
  .command('show <name>')
  .description('Show detailed agent definition')
  .option('--json', 'Output as JSON')
  .action((name, options) => {
    try {
      const agentsDir = path.join(PACKAGE_ROOT, 'src', 'agents');

      // Support both with and without .json extension
      const agentName = name.endsWith('.json') ? name : `${name}.json`;
      const agentPath = path.join(agentsDir, agentName);

      if (!fs.existsSync(agentPath)) {
        // Try with -agent.json suffix
        const altPath = path.join(agentsDir, `${name}-agent.json`);
        if (fs.existsSync(altPath)) {
          const agent = JSON.parse(fs.readFileSync(altPath, 'utf8'));
          outputAgent(agent, options);
          return;
        }

        if (options.json) {
          console.log(JSON.stringify({ error: `Agent not found: ${name}` }, null, 2));
        } else {
          console.error(chalk.red(`Agent not found: ${name}`));
          console.log(chalk.dim('\nAvailable agents:'));
          const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.json'));
          files.forEach((f) => console.log(chalk.dim(`  - ${f.replace('.json', '')}`)));
        }
        process.exit(1);
      }

      const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
      outputAgent(agent, options);
    } catch (error) {
      if (options.json) {
        console.log(JSON.stringify({ error: error.message }, null, 2));
      } else {
        console.error(chalk.red(`Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

function outputAgent(agent, options) {
  if (options.json) {
    console.log(JSON.stringify(agent, null, 2));
    return;
  }

  // Human-readable output
  console.log('');
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log(chalk.bold.cyan(`  Agent: ${agent.id}`));
  console.log(chalk.bold.cyan('═'.repeat(80)));
  console.log('');

  // Basic info
  console.log(chalk.bold('Configuration:'));
  console.log(`  ${chalk.dim('ID:')}    ${agent.id}`);
  console.log(`  ${chalk.dim('Role:')}  ${agent.role || 'unspecified'}`);
  console.log(`  ${chalk.dim('Model:')} ${agent.model || 'default'}`);
  console.log('');

  // Triggers
  if (agent.triggers && agent.triggers.length > 0) {
    console.log(chalk.bold('Triggers:'));
    for (const trigger of agent.triggers) {
      console.log(`  ${chalk.yellow('•')} Topic: ${chalk.cyan(trigger.topic)}`);
      if (trigger.action) {
        console.log(`    Action: ${trigger.action}`);
      }
      if (trigger.logic?.script) {
        const scriptPreview = trigger.logic.script.substring(0, 80).replace(/\n/g, ' ');
        console.log(chalk.dim(`    Logic: ${scriptPreview}...`));
      }
    }
    console.log('');
  }

  // Output
  if (agent.output) {
    console.log(chalk.bold('Output:'));
    console.log(`  ${chalk.dim('Topic:')} ${agent.output.topic || 'none'}`);
    if (agent.output.publishAfter) {
      console.log(`  ${chalk.dim('Publish after:')} ${agent.output.publishAfter}`);
    }
    console.log('');
  }

  // Prompt
  if (agent.prompt) {
    console.log(chalk.bold('Prompt:'));
    console.log(chalk.dim('─'.repeat(76)));
    // Show first 500 chars of prompt
    const promptLines = agent.prompt.substring(0, 500).split('\n');
    for (const line of promptLines) {
      console.log(`  ${line}`);
    }
    if (agent.prompt.length > 500) {
      console.log(chalk.dim(`  ... (${agent.prompt.length - 500} more characters)`));
    }
    console.log(chalk.dim('─'.repeat(76)));
    console.log('');
  }
}

// Helper function to keep the process alive for follow mode
function keepProcessAlive(cleanupFn) {
  // Prevent Node.js from exiting by keeping the event loop active
  // Use setInterval with a long interval (1 hour) to minimize overhead
  const keepAliveInterval = setInterval(() => {}, 3600000);

  // Handle graceful shutdown on Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(keepAliveInterval);
    if (cleanupFn) cleanupFn();
    console.log('\n\nStopped following logs.');
    process.exit(0);
  });

  // Also handle SIGTERM for graceful shutdown
  process.on('SIGTERM', () => {
    clearInterval(keepAliveInterval);
    if (cleanupFn) cleanupFn();
    process.exit(0);
  });
}

// Tool icons for different tool types
function getToolIcon(toolName) {
  const icons = {
    Read: '📖',
    Write: '📝',
    Edit: '✏️',
    Bash: '💻',
    Glob: '🔍',
    Grep: '🔎',
    WebFetch: '🌐',
    WebSearch: '🔎',
    Task: '🤖',
    TodoWrite: '📋',
    AskUserQuestion: '❓',
  };
  return icons[toolName] || '🔧';
}

function formatToolCallPath(filePath) {
  return filePath ? filePath.split('/').slice(-2).join('/') : '';
}

function formatTodoWriteCall(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return '';

  const statusCounts = {};
  for (const todo of todos) {
    statusCounts[todo.status] = (statusCounts[todo.status] || 0) + 1;
  }

  const parts = Object.entries(statusCounts).map(
    ([status, count]) => `${count} ${status.replace('_', ' ')}`
  );
  return `${todos.length} todo${todos.length === 1 ? '' : 's'} (${parts.join(', ')})`;
}

function formatAskUserQuestionCall(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return '';

  const question = questions[0];
  const preview = question.question.substring(0, 50);
  const suffix = question.question.length > 50 ? '...' : '';
  return questions.length > 1
    ? `${questions.length} questions: "${preview}..."`
    : `"${preview}${suffix}"`;
}

function formatToolCallFallback(input) {
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  const rawValue = String(input[keys[0]]);
  const preview = rawValue.substring(0, 40);
  return preview.length < rawValue.length ? preview + '...' : preview;
}

const TOOL_CALL_INPUT_FORMATTERS = {
  Bash: (input) => (input.command ? `$ ${input.command}` : ''),
  Read: (input) => formatToolCallPath(input.file_path),
  Write: (input) => (input.file_path ? `→ ${formatToolCallPath(input.file_path)}` : ''),
  Edit: (input) => formatToolCallPath(input.file_path),
  Glob: (input) => input.pattern || '',
  Grep: (input) => (input.pattern ? `/${input.pattern}/` : ''),
  WebFetch: (input) => (input.url ? input.url.substring(0, 50) : ''),
  WebSearch: (input) => (input.query ? `"${input.query}"` : ''),
  Task: (input) => input.description || '',
  TodoWrite: (input) => formatTodoWriteCall(input.todos),
  AskUserQuestion: (input) => formatAskUserQuestionCall(input.questions),
};

// Format tool call input for display
function formatToolCall(toolName, input) {
  if (!input) return '';

  const formatter = TOOL_CALL_INPUT_FORMATTERS[toolName];
  if (formatter) {
    return formatter(input);
  }

  // For unknown tools, show first key-value pair
  return formatToolCallFallback(input);
}

// Format tool result for display
function formatToolResult(content, isError, toolName, toolInput) {
  if (!content) return isError ? 'error' : 'done';

  // For errors, show full message
  if (isError) {
    const firstLine = content.split('\n')[0].substring(0, 80);
    return chalk.red(firstLine);
  }

  // For TodoWrite, show the actual todo items
  if (toolName === 'TodoWrite' && toolInput?.todos && Array.isArray(toolInput.todos)) {
    const todos = toolInput.todos;
    if (todos.length === 0) return chalk.dim('no todos');

    // Helper to get status icon
    const getStatusIcon = (todoStatus) => {
      if (todoStatus === 'completed') return '✓';
      if (todoStatus === 'in_progress') return '⧗';
      return '○';
    };

    if (todos.length === 1) {
      const status = getStatusIcon(todos[0].status);
      const suffix = todos[0].content.length > 50 ? '...' : '';
      return chalk.dim(`${status} ${todos[0].content.substring(0, 50)}${suffix}`);
    }
    // Multiple todos - show first one as preview
    const status = getStatusIcon(todos[0].status);
    return chalk.dim(
      `${status} ${todos[0].content.substring(0, 40)}... (+${todos.length - 1} more)`
    );
  }

  // For success, show summary
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return 'done';
  if (lines.length === 1) {
    const line = lines[0].substring(0, 60);
    return chalk.dim(line.length < lines[0].length ? line + '...' : line);
  }
  // Multiple lines - show count
  return chalk.dim(`${lines.length} lines`);
}

// Helper function to get deterministic color for an agent/sender based on name hash
// Uses djb2 hash algorithm for good distribution across color palette
// Track recently seen content to avoid duplicates
const recentContentHashes = new Set();
const MAX_RECENT_HASHES = 100;

// Track clusters that have already shown their NEW TASK header (suppress conductor re-publish)
const shownNewTaskForCluster = new Set();

function hashContent(content) {
  // Simple hash for deduplication
  return content.substring(0, 200);
}

function isDuplicate(content) {
  const hash = hashContent(content);
  if (recentContentHashes.has(hash)) {
    return true;
  }
  recentContentHashes.add(hash);
  // Prune old hashes
  if (recentContentHashes.size > MAX_RECENT_HASHES) {
    const arr = Array.from(recentContentHashes);
    recentContentHashes.clear();
    arr.slice(-50).forEach((h) => recentContentHashes.add(h));
  }
  return false;
}

// Format task summary from ISSUE_OPENED message - truncated for display
function formatTaskSummary(issueOpened, maxLen = 35) {
  const data = issueOpened.content?.data || {};
  const issueNum = data.issue_number || data.number;
  const title = data.title;
  const url = data.url || data.html_url;

  // Prefer: #N: Short title
  if (issueNum && title) {
    const truncatedTitle = title.length > maxLen ? title.slice(0, maxLen - 3) + '...' : title;
    return `#${issueNum}: ${truncatedTitle}`;
  }
  if (issueNum) return `#${issueNum}`;

  // Extract from URL
  if (url) {
    const match = url.match(/issues\/(\d+)/);
    if (match) return `#${match[1]}`;
  }

  // Fallback: first meaningful line (for manual prompts)
  const text = issueOpened.content?.text || 'Task';
  const firstLine = text.split('\n').find((l) => l.trim() && !l.startsWith('#')) || 'Task';
  return firstLine.slice(0, maxLen) + (firstLine.length > maxLen ? '...' : '');
}

// Format token usage for display
function formatTokenUsage(tokensByRole) {
  if (!tokensByRole || !tokensByRole._total || tokensByRole._total.count === 0) {
    return null;
  }

  const total = tokensByRole._total;
  const lines = [];

  // Format numbers with commas
  const fmt = (n) => n.toLocaleString();

  // Total line
  const inputTokens = total.inputTokens || 0;
  const outputTokens = total.outputTokens || 0;
  const cacheReadTokens = total.cacheReadInputTokens || 0;
  const uncachedInputTokens = inputTokens - cacheReadTokens;
  const totalTokens = inputTokens + outputTokens;
  const cost = total.totalCostUsd || 0;

  lines.push(
    chalk.dim('Tokens: ') +
      chalk.cyan(fmt(totalTokens)) +
      chalk.dim(' (') +
      chalk.green(fmt(inputTokens)) +
      chalk.dim(' in / ') +
      chalk.yellow(fmt(outputTokens)) +
      chalk.dim(' out)')
  );

  // Cache breakdown (if cache data available)
  if (cacheReadTokens > 0) {
    const cachePercent = Math.round((cacheReadTokens / inputTokens) * 100);
    lines.push(
      chalk.dim('Cache: ') +
        chalk.green(fmt(cacheReadTokens) + ' cached') +
        chalk.dim(' (' + cachePercent + '%) + ') +
        chalk.yellow(fmt(uncachedInputTokens) + ' new')
    );
  }

  // Cost line (if available)
  if (cost > 0) {
    lines.push(chalk.dim('Cost: ') + chalk.green('$' + cost.toFixed(4)));
  }

  // Per-role breakdown (compact)
  const roles = Object.keys(tokensByRole).filter((r) => r !== '_total');
  if (roles.length > 1) {
    const roleStats = roles
      .map((role) => {
        const r = tokensByRole[role];
        const roleTotal = (r.inputTokens || 0) + (r.outputTokens || 0);
        return `${role}: ${fmt(roleTotal)}`;
      })
      .join(chalk.dim(' | '));
    lines.push(chalk.dim('By role: ') + roleStats);
  }

  return lines;
}

// Set terminal title (works in most terminals)
function setTerminalTitle(title) {
  // ESC ] 0 ; <title> BEL
  process.stdout.write(`\\x1b]0;${title}\x07`);
}

// Restore terminal title on exit
function restoreTerminalTitle() {
  // Reset to default (empty title lets terminal use its default)
  process.stdout.write('\\x1b]0;\x07');
}

// Format markdown-style text for terminal display
function formatMarkdownLine(line) {
  let formatted = line;

  // Headers: ## Header -> bold cyan
  if (/^#{1,3}\s/.test(formatted)) {
    formatted = formatted.replace(/^#{1,3}\s*/, '');
    return chalk.bold.cyan(formatted);
  }

  // Blockquotes: > text -> dim italic with bar
  if (/^>\s/.test(formatted)) {
    formatted = formatted.replace(/^>\s*/, '');
    return chalk.dim('│ ') + chalk.italic(formatted);
  }

  // Numbered lists: 1. item -> yellow number
  const numMatch = formatted.match(/^(\d+)\.\s+(.*)$/);
  if (numMatch) {
    return chalk.yellow(numMatch[1] + '.') + ' ' + formatInlineMarkdown(numMatch[2]);
  }

  // Bullet lists: - item or * item -> dim bullet
  const bulletMatch = formatted.match(/^[-*]\s+(.*)$/);
  if (bulletMatch) {
    return chalk.dim('•') + ' ' + formatInlineMarkdown(bulletMatch[1]);
  }

  // Checkboxes: - [ ] or - [x]
  const checkMatch = formatted.match(/^[-*]\s+\[([ x])\]\s+(.*)$/i);
  if (checkMatch) {
    const checked = checkMatch[1].toLowerCase() === 'x';
    const icon = checked ? chalk.green('✓') : chalk.dim('○');
    return icon + ' ' + formatInlineMarkdown(checkMatch[2]);
  }

  return formatInlineMarkdown(formatted);
}

// Format inline markdown: **bold**, `code`
function formatInlineMarkdown(text) {
  let result = text;

  // Bold: **text** -> bold
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, content) => chalk.bold(content));

  // Inline code: `code` -> cyan dim
  result = result.replace(/`([^`]+)`/g, (_, content) => chalk.cyan.dim(content));

  return result;
}

// Line buffer per sender - tracks line state for prefix printing
const lineBuffers = new Map();

// Track current tool call per sender - needed for matching tool results with calls
const currentToolCall = new Map();

function formatLogTimestamp(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
  });
}

function getRenderPrefix(sender) {
  const color = getColorForSender(sender);
  return color(`${sender.padEnd(15)} |`);
}

function getRenderBuffer(buffers, sender) {
  if (!buffers.has(sender)) {
    buffers.set(sender, { text: '', needsPrefix: true });
  }
  return buffers.get(sender);
}

function flushRenderBuffer(buffers, sender, prefix, lines) {
  const buf = buffers.get(sender);
  if (!buf || !buf.text.trim()) {
    if (buf) {
      buf.text = '';
      buf.needsPrefix = true;
    }
    return;
  }

  const textLines = buf.text.split('\n');
  for (const line of textLines) {
    if (line.trim()) {
      lines.push(`${prefix} ${formatMarkdownLine(line)}`);
    }
  }
  buf.text = '';
  buf.needsPrefix = true;
}

function flushAllRenderBuffers(lines, buffers) {
  for (const [sender, buf] of buffers) {
    if (!buf.text.trim()) continue;
    const prefix = getRenderPrefix(sender);
    for (const line of buf.text.split('\n')) {
      if (line.trim()) {
        lines.push(`${prefix} ${line}`);
      }
    }
  }
}

function formatLifecycleEvent(data) {
  const event = data?.event;
  let icon;
  let eventText;

  switch (event) {
    case 'STARTED': {
      icon = chalk.green('▶');
      const triggers = data?.triggers?.join(', ') || 'none';
      eventText = `started (listening for: ${chalk.dim(triggers)})`;
      break;
    }
    case 'TASK_STARTED':
      icon = chalk.yellow('⚡');
      eventText = `${chalk.cyan(data.triggeredBy)} → task #${data.iteration} (${chalk.dim(data.model)})`;
      break;
    case 'TASK_COMPLETED':
      icon = chalk.green('✓');
      eventText = `task #${data.iteration} completed`;
      break;
    default:
      icon = chalk.dim('•');
      eventText = event || 'unknown event';
  }

  return { icon, eventText };
}

function handleLifecycleRender({ msg, prefix, lines }) {
  const data = msg.content?.data;
  const { icon, eventText } = formatLifecycleEvent(data);
  lines.push(`${prefix} ${icon} ${eventText}`);
}

function getIssuePreviewLine(text) {
  if (!text) return '';
  return text.split('\n').find((line) => line.trim() && line.trim() !== '# Manual Input');
}

function handleIssueOpenedRender({ msg, prefix, timestamp, lines }) {
  lines.push('');
  lines.push(chalk.bold.blue('─'.repeat(80)));

  const issueData = msg.content?.data || {};
  const issueUrl = issueData.url || issueData.html_url;
  const issueTitle = issueData.title;
  const issueNum = issueData.issue_number || issueData.number;

  if (issueUrl) {
    lines.push(
      `${prefix} ${chalk.gray(timestamp)} ${chalk.bold.blue('📋')} ${chalk.cyan(issueUrl)}`
    );
    if (issueTitle) {
      lines.push(`${prefix} ${chalk.white(issueTitle)}`);
    }
  } else if (issueNum) {
    lines.push(`${prefix} ${chalk.gray(timestamp)} ${chalk.bold.blue('📋')} Issue #${issueNum}`);
    if (issueTitle) {
      lines.push(`${prefix} ${chalk.white(issueTitle)}`);
    }
  } else {
    lines.push(`${prefix} ${chalk.gray(timestamp)} ${chalk.bold.blue('📋 TASK')}`);
    const firstLine = getIssuePreviewLine(msg.content?.text);
    if (firstLine) {
      lines.push(`${prefix} ${chalk.white(firstLine.slice(0, 100))}`);
    }
  }

  lines.push(chalk.bold.blue('─'.repeat(80)));
}

function handleImplementationReadyRender({ prefix, timestamp, lines }) {
  lines.push(
    `${prefix} ${chalk.gray(timestamp)} ${chalk.bold.yellow(`✅ ${EVENT_COPY.IMPLEMENTATION_READY.toUpperCase()}`)}`
  );
}

function normalizeIssueList(rawIssues) {
  if (!rawIssues) return [];
  if (Array.isArray(rawIssues)) return rawIssues;
  if (typeof rawIssues === 'string') {
    try {
      const parsed = JSON.parse(rawIssues);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function appendCriteriaGroup({ lines, prefix, label, items, color, reasonLabel }) {
  if (!items.length) return;
  lines.push(`${prefix}   ${color(label)} (${items.length} criteria - ${reasonLabel}):`);
  for (const item of items) {
    lines.push(`${prefix}     ${color('•')} ${item.id}: ${item.reason || 'No reason provided'}`);
  }
}

function appendCriteriaResults(lines, prefix, criteriaResults) {
  if (!Array.isArray(criteriaResults)) return;

  const cannotValidateYet = criteriaResults.filter((c) => c.status === 'CANNOT_VALIDATE_YET');
  appendCriteriaGroup({
    lines,
    prefix,
    label: '❌ Cannot validate yet',
    items: cannotValidateYet,
    color: chalk.red,
    reasonLabel: 'work incomplete',
  });

  const cannotValidate = criteriaResults.filter((c) => c.status === 'CANNOT_VALIDATE');
  appendCriteriaGroup({
    lines,
    prefix,
    label: '⚠️ Could not validate',
    items: cannotValidate,
    color: chalk.yellow,
    reasonLabel: 'permanent',
  });
}

function handleValidationResultRender({ msg, prefix, timestamp, lines }) {
  const data = msg.content?.data || {};
  const approved = data.approved === true || data.approved === 'true';
  const icon = approved ? chalk.green('✓ APPROVED') : chalk.red('✗ REJECTED');
  lines.push(`${prefix} ${chalk.gray(timestamp)} ${chalk.bold.magenta('VALIDATION_RESULT')}`);
  lines.push(`${prefix}   ${icon} ${chalk.dim(data.summary || '')}`);

  if (!approved) {
    const issues = normalizeIssueList(data.issues || data.errors);
    for (const issue of issues) {
      lines.push(`${prefix}     ${chalk.red('•')} ${issue}`);
    }
  }

  appendCriteriaResults(lines, prefix, data.criteriaResults);
}

function handlePrCreatedRender({ msg, prefix, timestamp, lines }) {
  lines.push('');
  lines.push(chalk.bold.green('─'.repeat(80)));
  lines.push(
    `${prefix} ${chalk.gray(timestamp)} ${chalk.bold.green(`🔗 ${EVENT_COPY.PR_CREATED.toUpperCase()}`)}`
  );
  if (msg.content?.data?.pr_url) {
    lines.push(`${prefix} ${chalk.cyan(msg.content.data.pr_url)}`);
  }
  const mergeStatus = formatMergeStatus(msg.content?.data?.merged);
  if (mergeStatus) {
    lines.push(
      `${prefix} ${chalk.gray('Merge:')} ${mergeStatus === 'merged' ? chalk.bold.cyan(mergeStatus) : chalk.yellow(mergeStatus)}`
    );
  }
  lines.push(chalk.bold.green('─'.repeat(80)));
}

function handleClusterCompleteRender({ prefix, timestamp, lines }) {
  lines.push('');
  lines.push(chalk.bold.green('─'.repeat(80)));
  lines.push(`${prefix} ${chalk.gray(timestamp)} ${chalk.bold.green('✅ CLUSTER COMPLETE')}`);
  lines.push(chalk.bold.green('─'.repeat(80)));
}

function handleAgentErrorRender({ msg, prefix, timestamp, lines }) {
  lines.push('');
  lines.push(chalk.bold.red('─'.repeat(80)));
  lines.push(`${prefix} ${chalk.gray(timestamp)} ${chalk.bold.red('🔴 AGENT ERROR')}`);
  if (msg.content?.text) {
    lines.push(`${prefix} ${chalk.red(msg.content.text)}`);
  }
  lines.push(chalk.bold.red('─'.repeat(80)));
}

function appendAgentTextEvent(lines, sender, prefix, buffers, text) {
  const buf = getRenderBuffer(buffers, sender);
  buf.text += text;

  while (buf.text.includes('\n')) {
    const idx = buf.text.indexOf('\n');
    const line = buf.text.slice(0, idx);
    buf.text = buf.text.slice(idx + 1);
    if (line.trim()) {
      lines.push(`${prefix} ${formatMarkdownLine(line)}`);
    }
  }
}

function appendAgentToolCallEvent({ lines, sender, prefix, buffers, toolCalls, event }) {
  flushRenderBuffer(buffers, sender, prefix, lines);
  const icon = getToolIcon(event.toolName);
  const toolDesc = formatToolCall(event.toolName, event.input);
  lines.push(`${prefix} ${icon} ${chalk.cyan(event.toolName)} ${chalk.dim(toolDesc)}`);
  toolCalls.set(sender, { toolName: event.toolName, input: event.input });
}

function appendAgentToolResultEvent(lines, sender, prefix, toolCalls, event) {
  const status = event.isError ? chalk.red('✗') : chalk.green('✓');
  const toolCall = toolCalls.get(sender);
  const resultDesc = formatToolResult(
    event.content,
    event.isError,
    toolCall?.toolName,
    toolCall?.input
  );
  lines.push(`${prefix}   ${status} ${resultDesc}`);
  toolCalls.delete(sender);
}

function handleAgentOutputRender({ msg, prefix, lines, buffers, toolCalls }) {
  const content = msg.content?.data?.line || msg.content?.data?.chunk || msg.content?.text;
  if (!content || !content.trim()) return;

  const provider = normalizeProviderName(
    msg.content?.data?.provider || msg.sender_provider || 'claude'
  );
  const events = parseProviderChunk(provider, content);
  for (const event of events) {
    if (event.type === 'text') {
      appendAgentTextEvent(lines, msg.sender, prefix, buffers, event.text);
      continue;
    }
    if (event.type === 'tool_call') {
      appendAgentToolCallEvent({
        lines,
        sender: msg.sender,
        prefix,
        buffers,
        toolCalls,
        event,
      });
      continue;
    }
    if (event.type === 'tool_result') {
      appendAgentToolResultEvent(lines, msg.sender, prefix, toolCalls, event);
      continue;
    }
    if (event.type === 'result') {
      appendAgentResultEvent(lines, prefix, event);
    }
  }

  if (events.length === 0) {
    appendRawAgentOutputLines(lines, prefix, content);
  }
}

const RENDER_TOPIC_HANDLERS = {
  AGENT_LIFECYCLE: handleLifecycleRender,
  ISSUE_OPENED: handleIssueOpenedRender,
  IMPLEMENTATION_READY: handleImplementationReadyRender,
  VALIDATION_RESULT: handleValidationResultRender,
  PR_CREATED: handlePrCreatedRender,
  CLUSTER_COMPLETE: handleClusterCompleteRender,
  AGENT_ERROR: handleAgentErrorRender,
  AGENT_OUTPUT: handleAgentOutputRender,
};

const HISTORY_NOISE_TOPICS = new Set(['STATE_SNAPSHOT', 'TOKEN_USAGE']);

function appendAgentResultEvent(lines, prefix, event) {
  if (!event.success) {
    lines.push(`${prefix} ${chalk.bold.red('✗ Error:')} ${event.error || 'Task failed'}`);
    return;
  }

  const usage = [];
  if (Number.isFinite(event.inputTokens)) usage.push(`${event.inputTokens} in`);
  if (Number.isFinite(event.outputTokens)) usage.push(`${event.outputTokens} out`);

  const suffix = usage.length > 0 ? ` (${usage.join(', ')})` : '';
  lines.push(`${prefix} ${chalk.green('✓')} completed${suffix}`);
}

function appendRawAgentOutputLines(lines, prefix, content) {
  for (const line of String(content).split('\n')) {
    const trimmed = line.trim();
    if (shouldSkipAgentOutputLine(trimmed)) continue;
    lines.push(`${prefix} ${line}`);
  }
}

function agentOutputHasPrintableHistory(msg) {
  const content = msg.content?.data?.line || msg.content?.data?.chunk || msg.content?.text;
  if (!content || !content.trim()) return false;

  const provider = normalizeProviderName(
    msg.content?.data?.provider || msg.sender_provider || 'claude'
  );
  const events = parseProviderChunk(provider, content);
  if (events.length === 0) {
    return String(content)
      .split('\n')
      .some((line) => !shouldSkipAgentOutputLine(line.trim()));
  }

  return events.some((event) =>
    ['text', 'thinking', 'thinking_start', 'tool_call', 'tool_result', 'result'].includes(
      event.type
    )
  );
}

function isPrintableHistoryMessage(msg) {
  if (!msg?.topic || HISTORY_NOISE_TOPICS.has(msg.topic)) return false;
  if (msg.topic === 'AGENT_OUTPUT') return agentOutputHasPrintableHistory(msg);
  return true;
}

function selectRecentPrintableMessages(messages, limit) {
  const printableMessages = messages.filter(isPrintableHistoryMessage);
  if (!Number.isFinite(limit) || limit <= 0) return printableMessages;
  return printableMessages.slice(-limit);
}

/**
 * Render messages to terminal-style output with ANSI colors (same as zeroshot logs)
 */
function renderMessagesToTerminal(clusterId, messages) {
  const lines = [];
  const buffers = new Map();
  const toolCalls = new Map();

  for (const msg of messages) {
    const timestamp = formatLogTimestamp(msg.timestamp);
    const prefix = getRenderPrefix(msg.sender);
    const handler = RENDER_TOPIC_HANDLERS[msg.topic];
    if (handler) {
      handler({ msg, prefix, timestamp, lines, buffers, toolCalls });
      continue;
    }

    if (msg.topic) {
      lines.push(`${prefix} ${chalk.gray(timestamp)} ${chalk.yellow(msg.topic)}`);
    }
  }

  flushAllRenderBuffers(lines, buffers);

  return lines.join('\n');
}

function renderRecentMessagesToTerminal(messages, limit) {
  const selectedMessages = selectRecentPrintableMessages(messages, limit);
  if (selectedMessages.length === 0) return '';

  return renderMessagesToTerminal(null, selectedMessages);
}

// Get terminal width for word wrapping
function getTerminalWidth() {
  return process.stdout.columns || 100;
}

// Word wrap text at terminal width, respecting word boundaries
// Returns array of lines
function wordWrap(text, maxWidth) {
  if (!text || maxWidth <= 0) return [text];

  const words = text.split(/(\s+)/); // Keep whitespace as separate tokens
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    // If adding this word exceeds width, start new line
    if (currentLine.length + word.length > maxWidth && currentLine.trim()) {
      lines.push(currentLine.trimEnd());
      currentLine = word.trimStart(); // Don't start new line with whitespace
    } else {
      currentLine += word;
    }
  }

  if (currentLine.trim()) {
    lines.push(currentLine.trimEnd());
  }

  return lines.length > 0 ? lines : [''];
}

function getLineBuffer(sender) {
  if (!lineBuffers.has(sender)) {
    // needsPrefix: true when at start of new line (need to print prefix)
    // pendingNewline: text written but no newline yet (need newline before next prefix)
    // textBuffer: accumulate text until we have a complete line
    lineBuffers.set(sender, {
      needsPrefix: true,
      pendingNewline: false,
      thinkingNeedsPrefix: true,
      thinkingPendingNewline: false,
      textBuffer: '', // NEW: buffer for accumulating text
    });
  }
  return lineBuffers.get(sender);
}

// Accumulate text and print complete lines only
// Word wrap long lines, aligning continuation with message column
function accumulateText(prefix, sender, text) {
  if (!text) return;
  const buf = getLineBuffer(sender);

  // Add incoming text to buffer
  buf.textBuffer += text;

  // Calculate widths for word wrapping
  const prefixLen = chalk.reset(prefix).replace(/\\x1b\[[0-9;]*m/g, '').length + 1;
  const termWidth = getTerminalWidth();
  const contentWidth = Math.max(40, termWidth - prefixLen - 2);
  const continuationPrefix = ' '.repeat(prefixLen);

  // Process complete lines (ending with \n)
  while (buf.textBuffer.includes('\n')) {
    const newlineIdx = buf.textBuffer.indexOf('\n');
    const completeLine = buf.textBuffer.slice(0, newlineIdx);
    buf.textBuffer = buf.textBuffer.slice(newlineIdx + 1);

    // Word wrap and print the complete line
    // CRITICAL: Batch all output into single safeWrite() to prevent interleaving with render()
    const wrappedLines = wordWrap(completeLine, contentWidth);
    let outputBuffer = '';

    for (let i = 0; i < wrappedLines.length; i++) {
      const wrappedLine = wrappedLines[i];

      // Print prefix (real or continuation)
      if (buf.needsPrefix) {
        outputBuffer += `${prefix} `;
        buf.needsPrefix = false;
      } else if (i > 0) {
        outputBuffer += `${continuationPrefix}`;
      }

      if (wrappedLine.trim()) {
        outputBuffer += formatInlineMarkdown(wrappedLine);
      }

      // Newline after each wrapped segment
      if (i < wrappedLines.length - 1) {
        outputBuffer += '\n';
      }
    }

    // Complete the line
    outputBuffer += '\n';
    buf.needsPrefix = true;
    buf.pendingNewline = false;

    // Single atomic write prevents interleaving
    if (outputBuffer) {
      safeWrite(outputBuffer);
    }
  }

  // Mark that we have pending text (no newline yet)
  if (buf.textBuffer.length > 0) {
    buf.pendingNewline = true;
  }
}

// Stream thinking text immediately with word wrapping
function accumulateThinking(prefix, sender, text) {
  if (!text) return;
  const buf = getLineBuffer(sender);

  // Calculate widths for word wrapping (same as accumulateText but with 💭 prefix)
  const prefixLen = chalk.reset(prefix).replace(/\\x1b\[[0-9;]*m/g, '').length + 4; // +4 for " 💭 "
  const termWidth = getTerminalWidth();
  const contentWidth = Math.max(40, termWidth - prefixLen - 2);
  const continuationPrefix = ' '.repeat(prefixLen);

  let remaining = text;
  while (remaining.length > 0) {
    const newlineIdx = remaining.indexOf('\n');
    const rawLine = newlineIdx === -1 ? remaining : remaining.slice(0, newlineIdx);

    // CRITICAL: Batch all output into single safeWrite() to prevent interleaving with render()
    const wrappedLines = wordWrap(rawLine, contentWidth);
    let outputBuffer = '';

    for (let i = 0; i < wrappedLines.length; i++) {
      const wrappedLine = wrappedLines[i];

      if (buf.thinkingNeedsPrefix) {
        outputBuffer += `${prefix} ${chalk.dim.italic('💭 ')}`;
        buf.thinkingNeedsPrefix = false;
      } else if (i > 0) {
        outputBuffer += `${continuationPrefix}`;
      }

      if (wrappedLine.trim()) {
        outputBuffer += chalk.dim.italic(wrappedLine);
      }

      if (i < wrappedLines.length - 1) {
        outputBuffer += '\n';
      }
    }

    if (newlineIdx === -1) {
      buf.thinkingPendingNewline = true;
      // Single atomic write
      if (outputBuffer) {
        safeWrite(outputBuffer);
      }
      break;
    } else {
      outputBuffer += '\n';
      buf.thinkingNeedsPrefix = true;
      buf.thinkingPendingNewline = false;
      remaining = remaining.slice(newlineIdx + 1);
      // Single atomic write
      if (outputBuffer) {
        safeWrite(outputBuffer);
      }
    }
  }
}

// Flush pending content - just add newline if we have pending text
function flushLineBuffer(prefix, sender) {
  const buf = lineBuffers.get(sender);
  if (!buf) return;

  // CRITICAL: Batch all output into single safeWrite() to prevent interleaving with render()
  let outputBuffer = '';

  // Flush any remaining text in textBuffer (text without trailing newline)
  if (buf.textBuffer && buf.textBuffer.length > 0) {
    // Calculate widths for word wrapping (same as accumulateText)
    const prefixLen = chalk.reset(prefix).replace(/\\x1b\[[0-9;]*m/g, '').length + 1;
    const termWidth = getTerminalWidth();
    const contentWidth = Math.max(40, termWidth - prefixLen - 2);
    const continuationPrefix = ' '.repeat(prefixLen);

    const wrappedLines = wordWrap(buf.textBuffer, contentWidth);
    for (let i = 0; i < wrappedLines.length; i++) {
      const wrappedLine = wrappedLines[i];

      if (buf.needsPrefix) {
        outputBuffer += `${prefix} `;
        buf.needsPrefix = false;
      } else if (i > 0) {
        outputBuffer += `${continuationPrefix}`;
      }

      if (wrappedLine.trim()) {
        outputBuffer += formatInlineMarkdown(wrappedLine);
      }

      if (i < wrappedLines.length - 1) {
        outputBuffer += '\n';
      }
    }

    // Clear the buffer
    buf.textBuffer = '';
    buf.pendingNewline = true; // Mark that we need a newline before next prefix
  }

  if (buf.pendingNewline) {
    outputBuffer += '\n';
    buf.needsPrefix = true;
    buf.pendingNewline = false;
  }
  if (buf.thinkingPendingNewline) {
    outputBuffer += '\n';
    buf.thinkingNeedsPrefix = true;
    buf.thinkingPendingNewline = false;
  }

  // Single atomic write prevents interleaving
  if (outputBuffer) {
    safeWrite(outputBuffer);
  }
}

// Lines to filter out (noise, metadata, errors)
const FILTERED_PATTERNS = [
  // ct internal output
  /^--- Following log/,
  /--- Following logs/,
  /Ctrl\+C to stop/,
  /^=== (Claude|Codex|Gemini) Task:/,
  /^Started:/,
  /^Finished:/,
  /^Exit code:/,
  /^CWD:/,
  /^={50}$/,
  // Agent context metadata
  /^Prompt: You are agent/,
  /^Iteration:/,
  /^## Triggering Message/,
  /^## Messages from topic:/,
  /^## Instructions/,
  /^## Output Format/,
  /^Topic: [A-Z_]+$/,
  /^Sender:/,
  /^Data: \{/,
  /^"issue_number"/,
  /^"title"/,
  /^"commit"/,
  /^\[\d{4}-\d{2}-\d{2}T/, // ISO timestamps
  /^# Manual Input$/,
  // Task errors (internal)
  /^Task not found:/,
  // JSON fragments
  /^\s*\{$/,
  /^\s*\}$/,
  /^\s*"[a-z_]+":.*,?\s*$/,
  // Template variables (unresolved)
  /\{\{[a-z.]+\}\}/,
];

function getAgentOutputContent(msg) {
  return msg.content?.data?.line || msg.content?.data?.chunk || msg.content?.text || '';
}

function parseAgentOutputEvents(msg, content) {
  const provider = normalizeProviderName(
    msg.content?.data?.provider || msg.sender_provider || 'claude'
  );
  return parseProviderChunk(provider, content);
}

function handleAgentOutputText({ msg, prefix, event }) {
  accumulateText(prefix, msg.sender, event.text);
}

function handleAgentOutputThinking({ msg, prefix, event }) {
  if (event.text) {
    accumulateThinking(prefix, msg.sender, event.text);
    return;
  }
  if (event.type === 'thinking_start') {
    safePrint(`${prefix} ${chalk.dim.italic('💭 thinking...')}`);
  }
}

function handleAgentOutputToolStart({ msg, prefix }) {
  flushLineBuffer(prefix, msg.sender);
}

function handleAgentOutputToolCall({ msg, prefix, event }) {
  flushLineBuffer(prefix, msg.sender);
  const icon = getToolIcon(event.toolName);
  const toolDesc = formatToolCall(event.toolName, event.input);
  safePrint(`${prefix} ${icon} ${chalk.cyan(event.toolName)} ${chalk.dim(toolDesc)}`);
  currentToolCall.set(msg.sender, { toolName: event.toolName, input: event.input });
}

function handleAgentOutputToolResult({ msg, prefix, event }) {
  const status = event.isError ? chalk.red('✗') : chalk.green('✓');
  const toolCall = currentToolCall.get(msg.sender);
  const resultDesc = formatToolResult(
    event.content,
    event.isError,
    toolCall?.toolName,
    toolCall?.input
  );
  safePrint(`${prefix}   ${status} ${resultDesc}`);
  currentToolCall.delete(msg.sender);
}

function handleAgentOutputResult({ msg, prefix, event }) {
  flushLineBuffer(prefix, msg.sender);
  if (!event.success) {
    safePrint(`${prefix} ${chalk.bold.red('✗ Error:')} ${event.error || 'Task failed'}`);
  }
}

function handleAgentOutputNoop() {}

const AGENT_OUTPUT_EVENT_HANDLERS = {
  text: handleAgentOutputText,
  thinking: handleAgentOutputThinking,
  thinking_start: handleAgentOutputThinking,
  tool_start: handleAgentOutputToolStart,
  tool_call: handleAgentOutputToolCall,
  tool_input: handleAgentOutputNoop,
  tool_result: handleAgentOutputToolResult,
  result: handleAgentOutputResult,
  block_end: handleAgentOutputNoop,
};

function isInlineJsonLine(trimmed) {
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  );
}

function shouldSkipAgentOutputLine(trimmed) {
  if (!trimmed) return true;
  if (FILTERED_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  if (isInlineJsonLine(trimmed)) return true;
  return isDuplicate(trimmed);
}

function printFilteredAgentOutputLines(content, prefix) {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (shouldSkipAgentOutputLine(trimmed)) continue;
    safePrint(`${prefix} ${line}`);
  }
}

// Handle AGENT_OUTPUT messages (streaming events from agent task execution)
function formatAgentOutput(msg, prefix) {
  const content = getAgentOutputContent(msg);
  if (!content || !content.trim()) return;

  const events = parseAgentOutputEvents(msg, content);
  for (const event of events) {
    const handler = AGENT_OUTPUT_EVENT_HANDLERS[event.type];
    if (handler) {
      handler({ msg, prefix, event });
    }
  }

  if (events.length === 0) {
    printFilteredAgentOutputLines(content, prefix);
  }
}

const NORMAL_MESSAGE_HANDLERS = {
  AGENT_LIFECYCLE: ({ msg, prefix }) => formatAgentLifecycle(msg, prefix),
  AGENT_ERROR: ({ msg, prefix, timestamp }) => formatAgentErrorNormal(msg, prefix, timestamp),
  ISSUE_OPENED: ({ msg, prefix, timestamp }) =>
    formatIssueOpenedNormal(msg, prefix, timestamp, shownNewTaskForCluster),
  IMPLEMENTATION_READY: ({ msg, prefix, timestamp }) =>
    formatImplementationReadyNormal(msg, prefix, timestamp),
  VALIDATION_RESULT: ({ msg, prefix, timestamp }) =>
    formatValidationResultNormal(msg, prefix, timestamp),
  PR_CREATED: ({ msg, prefix, timestamp }) => formatPrCreated(msg, prefix, timestamp, safePrint),
  CLUSTER_COMPLETE: ({ msg, prefix, timestamp }) =>
    formatClusterComplete(msg, prefix, timestamp, safePrint),
  CLUSTER_FAILED: ({ msg, prefix, timestamp }) =>
    formatClusterFailed(msg, prefix, timestamp, safePrint),
  AGENT_OUTPUT: ({ msg, prefix }) => formatAgentOutput(msg, prefix),
};

// Helper function to print a message (docker-compose style with colors)
function printMessage(msg, showClusterId = false, watchMode = false, isActive = true) {
  // Build prefix using utility function
  const prefix = buildMessagePrefix(msg, showClusterId, isActive);
  const timestamp = formatLogTimestamp(msg.timestamp);

  // Watch mode: delegate to watch mode formatter
  if (watchMode) {
    const clusterPrefix = buildClusterPrefix(msg, isActive);
    formatWatchMode(msg, clusterPrefix);
    return;
  }

  // Normal mode: delegate to appropriate formatter based on topic
  const handler = NORMAL_MESSAGE_HANDLERS[msg.topic];
  if (handler) {
    handler({ msg, prefix, timestamp });
    return;
  }

  // Fallback: generic message display for unknown topics
  formatGenericMessage(msg, prefix, timestamp, safePrint);
}

// Main async entry point
async function main() {
  const isTest = process.env.NODE_ENV === 'test';
  const isQuiet = process.argv.includes('-q') || process.argv.includes('--quiet') || isTest;

  printLegacyDistroNotice();

  try {
    const { onPath, binDir } = checkBinDirOnPath();
    if (!onPath && binDir) {
      printPathWarning(binDir);
    }
  } catch {
    // Never block CLI startup on a PATH check failure
  }

  // Check for updates (non-blocking if offline)
  if (!isTest) {
    await checkForUpdates({ quiet: isQuiet });
  }

  let args = process.argv.slice(2);

  if (args.length === 0) {
    program.outputHelp();
    return;
  }

  // Default command handling: if first arg doesn't match a known command, treat it as 'run'
  // This allows `zeroshot "task"` to work the same as `zeroshot run "task"`
  args = process.argv.slice(2);
  if (args.length > 0) {
    const firstArg = args[0];

    // Skip if it's a flag/option (starts with -)
    // Skip if it's --help or --version (these are handled by commander)
    if (!firstArg.startsWith('-')) {
      // Get all registered command names
      const commandNames = program.commands.map((cmd) => cmd.name());

      // If first arg is not a known command, prepend 'run'
      if (!commandNames.includes(firstArg)) {
        process.argv.splice(2, 0, 'run');
      }
    }
  }

  program.parse();
}

// Run main
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  applyModelOverrideToConfig,
  inspectAgentAttachment,
  printAttachableAgentList,
  renderRecentMessagesToTerminal,
  resolveRunMode,
};
