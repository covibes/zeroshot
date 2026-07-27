/**
 * Orchestrator - Manages cluster lifecycle
 *
 * Provides:
 * - Cluster initialization and configuration
 * - Agent lifecycle management
 * - GitHub issue integration
 * - Cluster state tracking
 * - Crash recovery
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const lockfile = require('proper-lockfile');

// Stale lock timeout in ms - if lock file is older than this, delete it
const LOCK_STALE_MS = 5000;

/**
 * Remove lock file if it's stale (older than LOCK_STALE_MS)
 * Handles crashes that leave orphaned lock files
 */
function cleanStaleLock(lockPath) {
  try {
    if (fs.existsSync(lockPath)) {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch {
    // Ignore - another process may have cleaned it
  }
}
const { readClustersFileSync, writeClustersFileAtomic } = require('../lib/clusters-registry');
const AgentWrapper = require('./agent-wrapper');
const SubClusterWrapper = require('./sub-cluster-wrapper');
const MessageBus = require('./message-bus');
const Ledger = require('./ledger');
const InputHelpers = require('./input-helpers');
const { USER_GUIDANCE_AGENT, USER_GUIDANCE_CLUSTER } = require('./guidance-topics');
const { detectProvider } = require('./issue-providers');
const IsolationManager = require('./isolation-manager');
const { generateName } = require('./name-generator');
const configValidator = require('./config-validator');
const TemplateResolver = require('./template-resolver');
const { loadSettings } = require('../lib/settings');
const { normalizeProviderName } = require('../lib/provider-names');
const { resolveRunPlan } = require('../lib/run-plan');
const { isProcessRunning } = require('../lib/process-liveness');
const { getProvider } = require('./providers');
const StateSnapshotter = require('./state-snapshotter');
const { resolveClusterRequiredQualityGates } = require('./quality-gates');
const {
  normalizeProviderSession,
  restoreAgentProviderSession,
} = require('./agent/provider-session');
const {
  commandProofsToQualityGates,
  mergeCommandProofs,
  resolveClusterCommandProofs,
} = require('./command-proofs');
const crypto = require('crypto');

/**
 * Thrown when a run is rejected because the issue already has an active cluster.
 * This is expected control flow (a benign guard), not a crash - callers should
 * check `error.code === 'DUPLICATE_CLUSTER'` and present it without a stack trace.
 */
class DuplicateClusterError extends Error {
  constructor(message, { issueNumber, existingClusterId, existingState, existingPid, ageMinutes }) {
    super(message);
    this.name = 'DuplicateClusterError';
    this.code = 'DUPLICATE_CLUSTER';
    this.issueNumber = issueNumber;
    this.existingClusterId = existingClusterId;
    this.existingState = existingState;
    this.existingPid = existingPid;
    this.ageMinutes = ageMinutes;
  }
}

function applyModelOverride(agentConfig, modelOverride) {
  if (!modelOverride) return;

  agentConfig.model = modelOverride;
  if (agentConfig.modelRules) {
    delete agentConfig.modelRules;
  }
  if (agentConfig.modelConfig) {
    delete agentConfig.modelConfig;
  }
}

/**
 * Operation Chain Schema
 * Conductor (or any agent) can publish CLUSTER_OPERATIONS to dynamically modify cluster
 *
 * Supported operations:
 * - add_agents: Spawn new agents with given configs
 * - remove_agents: Stop and remove agents by ID
 * - update_agent: Modify existing agent config
 * - publish: Publish a message to the bus
 * - load_config: Load agents from a named cluster config template
 */
const VALID_OPERATIONS = ['add_agents', 'remove_agents', 'update_agent', 'publish', 'load_config'];

/**
 * Workflow-triggering topics that indicate cluster state progression
 * These are the topics that MATTER for resume - not AGENT_OUTPUT noise
 */
const WORKFLOW_TRIGGERS = Object.freeze([
  'ISSUE_OPENED',
  'PLAN_READY',
  'IMPLEMENTATION_READY',
  'VALIDATION_RESULT',
  'PUSH_BLOCKED',
  'CONDUCTOR_ESCALATE',
]);

const PUSH_BLOCKED_REPAIR_TRIGGER = Object.freeze({
  topic: 'PUSH_BLOCKED',
  action: 'execute_task',
});

function applyRequiredQualityGatesToAgent(agentConfig, requiredQualityGates) {
  if (!Array.isArray(requiredQualityGates) || requiredQualityGates.length === 0) {
    return;
  }

  if (agentConfig.role !== 'validator') {
    return;
  }

  if (!Array.isArray(agentConfig.requiredQualityGates)) {
    agentConfig.requiredQualityGates = requiredQualityGates;
  }
}

function applyRequiredQualityGatesToValidators(config, requiredQualityGates) {
  if (!Array.isArray(requiredQualityGates) || requiredQualityGates.length === 0) {
    return;
  }

  for (const agentConfig of config.agents || []) {
    applyRequiredQualityGatesToAgent(agentConfig, requiredQualityGates);
  }
}

function applyCommandProofsToAgent(agentConfig, commandProofs) {
  if (!Array.isArray(commandProofs) || commandProofs.length === 0) {
    return;
  }

  agentConfig.commandProofs = mergeCommandProofs(agentConfig.commandProofs, commandProofs);
}

function applyCommandProofsToAgents(config, commandProofs) {
  if (!Array.isArray(commandProofs) || commandProofs.length === 0) {
    return;
  }

  for (const agentConfig of config.agents || []) {
    applyCommandProofsToAgent(agentConfig, commandProofs);
  }
}

function mergeQualityGates(...sources) {
  const byId = new Map();
  const order = [];

  for (const source of sources) {
    if (!Array.isArray(source)) {
      continue;
    }
    for (const gate of source) {
      if (!gate?.id) {
        continue;
      }
      if (!byId.has(gate.id)) {
        order.push(gate.id);
      }
      byId.set(gate.id, gate);
    }
  }

  return order.map((id) => byId.get(id));
}

function getTriggerTopic(trigger) {
  return typeof trigger === 'string' ? trigger : trigger?.topic;
}

function shouldHandlePushBlockedRepair(agentConfig) {
  return agentConfig?.role === 'implementation';
}

function applyPushBlockedRepairTrigger(agentConfig) {
  if (!shouldHandlePushBlockedRepair(agentConfig)) {
    return;
  }

  if (!Array.isArray(agentConfig.triggers)) {
    agentConfig.triggers = [];
  }

  if (agentConfig.triggers.some((trigger) => getTriggerTopic(trigger) === 'PUSH_BLOCKED')) {
    return;
  }

  agentConfig.triggers.push({ ...PUSH_BLOCKED_REPAIR_TRIGGER });
}

function applyPushBlockedRepairTriggers(config) {
  for (const agentConfig of config?.agents || []) {
    applyPushBlockedRepairTrigger(agentConfig);
  }
}

function buildPrOptions(options, requiredQualityGates) {
  // autoMerge must always be persisted (even when no other PR fields are set) so that
  // `zeroshot run --pr` (autoMerge=false) vs `--ship` (autoMerge=true) survives resume.
  // Derived from the canonical run plan — never recomputed from ship/pr here.
  const autoMerge = resolveRunPlan(options).autoMerge;

  return {
    prBase: options.prBase || null,
    mergeQueue: options.mergeQueue || false,
    closeIssue: options.closeIssue || null,
    gitRemote: options.gitRemote || null,
    autoMerge,
    ...(requiredQualityGates.length > 0 ? { requiredQualityGates } : {}),
    cwd: options.cwd || process.cwd(),
  };
}

function serializeWorktree(worktree) {
  if (!worktree) {
    return null;
  }
  return {
    enabled: true,
    path: worktree.path,
    branch: worktree.branch,
    repoRoot: worktree.repoRoot,
    workDir: worktree.workDir,
  };
}

class Orchestrator {
  constructor(options = {}) {
    this.clusters = new Map(); // cluster_id -> cluster object
    this.quiet = options.quiet || false; // Suppress verbose logging
    // Read-only mode: opens ledgers without write access and skips schema DDL/
    // side-effecting bootstrap (state snapshotter). Used by CLI read commands
    // (list/status/logs) so they can never contend with a live daemon's writer
    // connection or mutate shared state as a side effect of a plain read.
    this.readonly = options.readonly === true;

    // TaskRunner DI - allows injecting MockTaskRunner for testing
    // When set, passed to all AgentWrappers to control task execution
    this.taskRunner = options.taskRunner || null;

    // Set up persistent storage directory (can be overridden for testing)
    this.storageDir = options.storageDir || path.join(os.homedir(), '.zeroshot');
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    // Track if orchestrator is closed (prevents _saveClusters race conditions during cleanup)
    this.closed = false;

    // Track if clusters are loaded (for lazy loading pattern)
    this._clustersLoaded = options.skipLoad === true;
  }

  /**
   * Factory method for async initialization
   * Use this instead of `new Orchestrator()` for proper async cluster loading
   * @param {Object} options - Same options as constructor
   * @returns {Promise<Orchestrator>}
   */
  static async create(options = {}) {
    const instance = new Orchestrator({ ...options, skipLoad: true });
    if (options.skipLoad !== true) {
      await instance._loadClusters();
      instance._clustersLoaded = true;
    }
    return instance;
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

  /**
   * Resolve provider for a cluster config using the standard precedence.
   * @param {Object} clusterConfig
   * @param {Object} settings
   * @returns {string}
   * @private
   */
  _resolveClusterProvider(clusterConfig = {}, settings = loadSettings()) {
    const resolved =
      clusterConfig.forceProvider ||
      clusterConfig.defaultProvider ||
      settings.defaultProvider ||
      'claude';
    return normalizeProviderName(resolved) || 'claude';
  }

  /**
   * Resolve the model level for internal completion agents.
   * Uses provider minLevel when configured, otherwise provider default min level.
   * @param {Object} clusterConfig
   * @returns {string}
   * @private
   */
  _resolveCompletionDetectorLevel(clusterConfig = {}) {
    const settings = loadSettings();
    const providerName = this._resolveClusterProvider(clusterConfig, settings);
    const provider = getProvider(providerName);
    const providerSettings = settings.providerSettings?.[providerName] || {};

    return providerSettings.minLevel || provider.getDefaultMinLevel();
  }

  /**
   * Get input source type for metadata
   * @param {Object} input - Input object
   * @returns {string} Source type: 'github', 'file', or 'text'
   * @private
   */
  _getInputSource(input) {
    if (input.issue) return 'github';
    if (input.file) return 'file';
    return 'text';
  }

  /**
   * Load clusters from persistent storage
   * Uses file locking for consistent reads
   * @private
   */
  async _loadClusters() {
    const clustersFile = path.join(this.storageDir, 'clusters.json');
    this._log(`[Orchestrator] Loading clusters from: ${clustersFile}`);

    if (!fs.existsSync(clustersFile)) {
      this._log(`[Orchestrator] No clusters file found at ${clustersFile}`);
      return;
    }

    const lockfilePath = path.join(this.storageDir, 'clusters.json.lock');
    let release;

    try {
      // Clean stale locks from crashed processes
      cleanStaleLock(lockfilePath);

      // Acquire lock with async API (proper retries without CPU spin-wait)
      release = await lockfile.lock(clustersFile, {
        lockfilePath,
        stale: LOCK_STALE_MS,
        retries: {
          retries: 20,
          minTimeout: 100,
          maxTimeout: 200,
          randomize: true,
        },
      });

      const data = readClustersFileSync(this.storageDir);
      const clusterIds = Object.keys(data);
      this._log(`[Orchestrator] Found ${clusterIds.length} clusters in file:`, clusterIds);

      // Track clusters to remove (missing .db files)
      const clustersToRemove = [];

      for (const [clusterId, clusterData] of Object.entries(data)) {
        if (clusterData?.state === 'setup' || clusterData?.provisional === true) {
          this.clusters.set(clusterId, this._loadSetupCluster(clusterId, clusterData));
          continue;
        }

        // Skip clusters whose .db file doesn't exist (orphaned registry entries)
        const dbPath = path.join(this.storageDir, `${clusterId}.db`);
        if (!fs.existsSync(dbPath)) {
          console.warn(
            `[Orchestrator] Cluster ${clusterId} has no database file, removing from registry`
          );
          clustersToRemove.push(clusterId);
          continue;
        }

        this._log(`[Orchestrator] Loading cluster: ${clusterId}`);
        try {
          this._loadSingleCluster(clusterId, clusterData);
        } catch (error) {
          console.warn(
            `[Orchestrator] Skipping cluster ${clusterId}: ${error.message || String(error)}`
          );
          continue;
        }
      }

      // Clean up orphaned entries from clusters.json. This is a write side effect,
      // so it must never run for read-only (list/status/logs) instances - only the
      // writable orchestrator that owns the registry performs cleanup.
      if (!this.readonly && clustersToRemove.length > 0) {
        for (const clusterId of clustersToRemove) {
          delete data[clusterId];
        }
        writeClustersFileAtomic(this.storageDir, data);
        this._log(
          `[Orchestrator] Removed ${clustersToRemove.length} orphaned cluster(s) from registry`
        );
      }

      this._log(`[Orchestrator] Total clusters loaded: ${this.clusters.size}`);
    } catch (error) {
      console.error('[Orchestrator] Failed to load clusters:', error.message);
      console.error(error.stack);
    } finally {
      if (release) {
        await release();
      }
    }
  }

  _loadSetupCluster(clusterId, clusterData) {
    const ledger = this._createSetupLedgerStub();
    const messageBus = this._createSetupMessageBusStub(ledger);

    return {
      ...clusterData,
      id: clusterId,
      config: clusterData.config || { agents: [] },
      state: clusterData.state || 'setup',
      createdAt: clusterData.createdAt || Date.now(),
      pid: clusterData.pid || null,
      agents: [],
      messageBus,
      ledger,
      setupLogPath: clusterData.setupLogPath || null,
      setupStage: clusterData.setupStage || null,
      failureInfo: clusterData.failureInfo || null,
      provisional: true,
    };
  }

  _createSetupLedgerStub() {
    const emptyArray = () => [];
    const noop = () => {};

    return {
      append: () => null,
      batchAppend: () => [],
      query: emptyArray,
      queryGuidanceMailbox: emptyArray,
      findLast: () => null,
      count: () => 0,
      since: emptyArray,
      getAll: emptyArray,
      getTokensByRole: () => ({
        _total: { count: 0, inputTokens: 0, outputTokens: 0, totalCostUsd: 0 },
      }),
      readSnapshot: () => ({
        messageCount: 0,
        tokensByRole: { _total: { count: 0, inputTokens: 0, outputTokens: 0, totalCostUsd: 0 } },
      }),
      pollForMessages: () => noop,
      on: noop,
      off: noop,
      close: noop,
      clear: noop,
    };
  }

  _createSetupMessageBusStub(ledger) {
    const noop = () => {};
    const unsubscribe = () => {};

    return {
      ledger,
      publish: () => null,
      batchPublish: () => [],
      subscribe: () => unsubscribe,
      subscribeTopic: () => unsubscribe,
      subscribeTopics: () => unsubscribe,
      query: (criteria) => ledger.query(criteria),
      queryGuidanceMailbox: (criteria) => ledger.queryGuidanceMailbox(criteria),
      findLast: (criteria) => ledger.findLast(criteria),
      count: (criteria) => ledger.count(criteria),
      since: (params) => ledger.since(params),
      getAll: (clusterId) => ledger.getAll(clusterId),
      getTokensByRole: (clusterId) => ledger.getTokensByRole(clusterId),
      readSnapshot: (clusterId) => ledger.readSnapshot(clusterId),
      addWebSocketClient: noop,
      removeWebSocketClient: noop,
      on: noop,
      off: noop,
      emit: () => false,
      close: noop,
      clear: noop,
    };
  }

  _isSetupCluster(cluster) {
    return Boolean(cluster?.provisional === true || cluster?.state === 'setup');
  }

  _resolveStartClusterId(requestedClusterId, dbPath) {
    if (!requestedClusterId) {
      return this._generateUniqueClusterId(null, dbPath || null);
    }

    const existingCluster = this.clusters.get(requestedClusterId);
    const candidateDbPath = dbPath || path.join(this.storageDir, `${requestedClusterId}.db`);
    if (this._isSetupCluster(existingCluster) && !fs.existsSync(candidateDbPath)) {
      this.clusters.delete(requestedClusterId);
      return requestedClusterId;
    }

    return this._generateUniqueClusterId(requestedClusterId, dbPath || null);
  }

  /**
   * Load a single cluster from data
   * @private
   */
  _loadSingleCluster(clusterId, clusterData) {
    // Skip if already loaded
    if (this.clusters.has(clusterId)) {
      return this.clusters.get(clusterId);
    }

    // Restore ledger and message bus. Read-only orchestrators (CLI list/status/logs)
    // open the ledger without write access so they can never contend with the live
    // daemon's writer connection or take a write lock on another process's database.
    const dbPath = path.join(this.storageDir, `${clusterId}.db`);
    const ledger = new Ledger(dbPath, { readonly: this.readonly });
    const messageBus = new MessageBus(ledger);

    // Restore isolation manager FIRST if cluster was running in isolation mode
    const { isolation, isolationManager } = this._restoreClusterIsolation(clusterId, clusterData);

    // Create mutable cluster context for reload path (used by AgentWrapper/SubClusterWrapper)
    const clusterContext = {
      ...clusterData,
      id: clusterId,
      isolation,
    };

    let agents;
    try {
      // Reconstruct agent metadata from config (processes are ephemeral)
      // CRITICAL: Pass isolation context to agents if cluster was running in isolation
      agents = this._rebuildClusterAgents(clusterContext, messageBus, isolation, isolationManager);
    } catch (error) {
      try {
        ledger.close();
      } catch (closeError) {
        console.warn(
          `[Orchestrator] Failed to close ledger for ${clusterId}: ${closeError.message || String(closeError)}`
        );
      }
      throw error;
    }

    const cluster = {
      ...clusterContext,
      ledger,
      messageBus,
      agents,
      isolation,
      autoPr: clusterData.autoPr || false,
      prOptions: clusterData.prOptions || null,
      commandProofs: clusterData.commandProofs || [],
      issue: clusterData.issue || null,
    };

    Object.assign(clusterContext, cluster);

    this.clusters.set(clusterId, clusterContext);
    // The snapshotter bootstraps by publishing a STATE_SNAPSHOT message if one is
    // missing - a ledger write. Read-only orchestrators must never write, so they
    // skip it; they only need to read existing snapshots, not produce new ones.
    if (!this.readonly) {
      this._registerClusterSubscriptions({
        messageBus,
        clusterId,
        isolationManager,
        containerId: isolation?.containerId || null,
      });
      if (clusterContext.state === 'running' && this._isProcessRunning(clusterContext.pid)) {
        this._startSnapshotter(clusterContext);
      }
    }
    this._log(`[Orchestrator] Loaded cluster: ${clusterId} with ${agents.length} agents`);

    return clusterContext;
  }

  _restoreClusterIsolation(clusterId, clusterData) {
    let isolation = clusterData.isolation || null;
    let isolationManager = null;

    if (isolation?.enabled && isolation.containerId) {
      isolationManager = new IsolationManager({ image: isolation.image });
      // Restore the container mapping so cleanup works
      isolationManager.containers.set(clusterId, isolation.containerId);
      // Restore isolated dir mapping for workspace preservation during cleanup
      if (isolation.workDir) {
        isolationManager.isolatedDirs.set(clusterId, {
          path: path.join(os.tmpdir(), 'zeroshot-isolated', clusterId),
          originalDir: isolation.workDir,
        });
      }
      isolation = {
        ...isolation,
        manager: isolationManager,
      };
      this._log(
        `[Orchestrator] Restored isolation manager for ${clusterId} (container: ${isolation.containerId}, workDir: ${isolation.workDir || 'unknown'})`
      );
    }

    return { isolation, isolationManager };
  }

  _resolveAgentCwd(clusterData) {
    const worktreePath = clusterData.worktree?.path;
    const isolationWorkDir = clusterData.isolation?.workDir;
    return worktreePath || isolationWorkDir || null;
  }

  _buildAgentOptions(clusterId, clusterData, isolation, isolationManager) {
    const agentOptions = {
      id: clusterId,
      quiet: this.quiet,
      modelOverride: clusterData.modelOverride || null,
      testMode: Boolean(this.taskRunner),
    };

    if (this.taskRunner) {
      agentOptions.taskRunner = this.taskRunner;
    }

    if (isolation?.enabled && isolationManager) {
      agentOptions.isolation = {
        enabled: true,
        manager: isolationManager,
        clusterId,
      };
    }

    if (clusterData.worktree?.enabled) {
      agentOptions.worktree = {
        enabled: true,
        path: clusterData.worktree.path,
        branch: clusterData.worktree.branch,
        repoRoot: clusterData.worktree.repoRoot,
      };
    }

    return agentOptions;
  }

  _instantiateAgent(agentConfig, messageBus, clusterContext, agentOptions) {
    if (agentConfig.type === 'subcluster') {
      return new SubClusterWrapper(agentConfig, messageBus, clusterContext, agentOptions);
    }

    return new AgentWrapper(agentConfig, messageBus, clusterContext, agentOptions);
  }

  _restoreAgentState(agent, agentConfig, clusterData, messageBus) {
    if (!clusterData.agentStates) return;

    const savedState = clusterData.agentStates.find((state) => state.id === agentConfig.id);
    if (!savedState) return;

    agent.state = savedState.state || 'idle';
    agent.iteration = savedState.iteration || 0;
    // currentTask is a live in-process handle, not durable state.
    // Restoring a serialized boolean here revives a fake runtime handle and
    // makes stopped/resumed agents look like they still own a running task.
    agent.currentTask = null;
    agent.currentTaskId = savedState.currentTaskId || null;
    agent.processPid = savedState.processPid || null;
    agent.providerSession = restoreAgentProviderSession({
      agent,
      savedState,
      messageBus,
      clusterId: clusterData.id,
    });
  }

  _rebuildClusterAgents(clusterContext, messageBus, isolation, isolationManager) {
    const agents = [];
    const clusterId = clusterContext.id;
    const clusterData = clusterContext;
    const agentCwd = this._resolveAgentCwd(clusterData);

    if (!clusterData.config?.agents) {
      return agents;
    }

    for (const agentConfig of clusterData.config.agents) {
      if (!agentConfig.cwd && agentCwd) {
        agentConfig.cwd = agentCwd;
        this._log(`[Orchestrator] Fixed missing cwd for agent ${agentConfig.id}: ${agentCwd}`);
      }

      if (clusterData.modelOverride) {
        applyModelOverride(agentConfig, clusterData.modelOverride);
      }

      const agentOptions = this._buildAgentOptions(
        clusterId,
        clusterData,
        isolation,
        isolationManager
      );
      const agent = this._instantiateAgent(agentConfig, messageBus, clusterContext, agentOptions);
      this._restoreAgentState(agent, agentConfig, clusterData, messageBus);
      agents.push(agent);
    }

    return agents;
  }

  _startSnapshotter(cluster) {
    if (cluster.snapshotter) {
      cluster.snapshotter.start();
      return;
    }

    const snapshotter = new StateSnapshotter({
      messageBus: cluster.messageBus,
      clusterId: cluster.id,
    });
    snapshotter.start();
    cluster.snapshotter = snapshotter;
  }

  /**
   * Ensure clusters file exists (required for file locking)
   * @private
   */
  _ensureClustersFile() {
    if (!fs.existsSync(this.storageDir)) {
      try {
        fs.mkdirSync(this.storageDir, { recursive: true });
      } catch (error) {
        console.warn(
          `[Orchestrator] Failed to create storage directory ${this.storageDir}: ${error.message}`
        );
        return null;
      }
    }

    const clustersFile = path.join(this.storageDir, 'clusters.json');
    if (!fs.existsSync(clustersFile)) {
      writeClustersFileAtomic(this.storageDir, {});
    }
    return clustersFile;
  }

  /**
   * Find active clusters for a given issue number
   * Used to prevent duplicate runs on the same issue
   * @param {number|string} issueNumber - Issue number to check
   * @returns {Array<{id: string, state: string, createdAt: number}>} Active clusters for this issue
   * @private
   */
  _getActiveClustersForIssue(issueNumber, excludeClusterId = null) {
    const activeClusters = [];
    const issueNum = Number(issueNumber);

    for (const [clusterId, cluster] of this.clusters) {
      if (excludeClusterId && clusterId === excludeClusterId) continue;
      // Skip clusters without issue numbers
      if (!cluster.issue) continue;

      // Check if same issue number
      if (Number(cluster.issue) !== issueNum) continue;

      // Check if cluster is still active (not completed/failed/stopped)
      const inactiveStates = ['completed', 'failed', 'stopped', 'corrupted'];
      if (inactiveStates.includes(cluster.state)) continue;

      // Check if process is still running (zombie detection)
      if (cluster.pid && this._isProcessRunning(cluster.pid)) {
        activeClusters.push({
          id: clusterId,
          state: cluster.state,
          createdAt: cluster.createdAt,
          pid: cluster.pid,
        });
      }
    }

    return activeClusters;
  }

  /**
   * Save clusters to persistent storage
   * Uses file locking to prevent race conditions with other processes
   * @private
   */
  async _saveClusters() {
    // Skip saving if orchestrator is closed (prevents race conditions during cleanup)
    if (this.closed) {
      return;
    }

    // Read-only orchestrators (CLI list/status/logs) must never write the registry.
    if (this.readonly) {
      return;
    }

    const clustersFile = this._ensureClustersFile();
    if (!clustersFile) {
      return;
    }
    const lockfilePath = path.join(this.storageDir, 'clusters.json.lock');
    let release;

    try {
      // Clean stale locks from crashed processes
      cleanStaleLock(lockfilePath);

      // Acquire exclusive lock with async API (proper retries without CPU spin-wait)
      release = await lockfile.lock(clustersFile, {
        lockfilePath,
        stale: LOCK_STALE_MS,
        retries: {
          retries: 50,
          minTimeout: 100,
          maxTimeout: 300,
          randomize: true,
        },
      });

      // Read existing clusters from file (other processes may have added clusters)
      let existingClusters = {};
      try {
        existingClusters = readClustersFileSync(this.storageDir);
      } catch (error) {
        console.error('[Orchestrator] Failed to read existing clusters:', error.message);
      }

      // Merge: update/add clusters from this process
      for (const [clusterId, cluster] of this.clusters.entries()) {
        // CRITICAL: Only update clusters this process actually owns or has modified
        // A process owns a cluster if: it started it (pid matches) OR it explicitly stopped/killed it
        const isOwnedByThisProcess = cluster.pid === process.pid;
        const wasModifiedByThisProcess = cluster.state === 'stopped' || cluster.state === 'killed';

        // Skip clusters we don't own and haven't modified - prevents race condition
        // where a running cluster overwrites another process's stop/kill operation
        if (!isOwnedByThisProcess && !wasModifiedByThisProcess) {
          // Preserve existing state from file for clusters we don't own
          continue;
        }

        // CRITICAL: Killed clusters are DELETED from disk, not persisted
        // This ensures they can't be accidentally resumed
        if (cluster.state === 'killed') {
          delete existingClusters[clusterId];
          continue;
        }

        existingClusters[clusterId] = {
          id: cluster.id,
          config: cluster.config,
          state: cluster.state,
          createdAt: cluster.createdAt,
          // Track PID for zombie detection (null if cluster is stopped/killed)
          pid: cluster.state === 'running' ? cluster.pid : null,
          // Persist failure info for resume capability
          failureInfo: cluster.failureInfo || null,
          // Persist PR mode for completion agent selection
          autoPr: cluster.autoPr || false,
          // Persist normalized run mode for status/list display
          runMode: cluster.runMode || null,
          // Persist PR options for resume
          prOptions: cluster.prOptions || null,
          // Persist cluster-scoped command proof configuration for resume and dynamic agents
          commandProofs: cluster.commandProofs || [],
          // Persist model override for consistent agent spawning on resume
          modelOverride: cluster.modelOverride || null,
          // Persist issue number for heroshot/external tools
          issue: cluster.issue || null,
          // Persist isolation info (excluding manager instance which can't be serialized)
          // CRITICAL: workDir is required for resume() to recreate container with same workspace
          isolation: cluster.isolation
            ? {
                enabled: cluster.isolation.enabled,
                containerId: cluster.isolation.containerId,
                image: cluster.isolation.image,
                workDir: cluster.isolation.workDir, // Required for resume
              }
            : null,
          worktree: serializeWorktree(cluster.worktree),
          // Persist agent runtime states for accurate status display from other processes
          agentStates: cluster.agents
            ? cluster.agents.map((a) => ({
                id: a.id,
                state: a.state,
                iteration: a.iteration,
                currentTask: a.currentTask ? true : false,
                currentTaskId: a.currentTaskId,
                processPid: a.processPid,
                providerSession: normalizeProviderSession(a.providerSession),
              }))
            : null,
          setupLogPath: cluster.setupLogPath || null,
          setupStage: cluster.setupStage || null,
          provisional: cluster.provisional || false,
        };
      }

      // Write merged data atomically (temp file + rename) so no reader can ever
      // observe a partially-written file.
      writeClustersFileAtomic(this.storageDir, existingClusters);
      this._log(
        `[Orchestrator] Saved ${this.clusters.size} cluster(s), file now has ${Object.keys(existingClusters).length} total`
      );
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.warn(
          `[Orchestrator] Skipping cluster save; storage directory missing: ${this.storageDir}`
        );
        return;
      }
      throw error;
    } finally {
      // Always release lock
      if (release) {
        await release();
      }
    }
  }

  /**
   * Watch for new clusters and call callback when found
   * Polls the clusters file for changes with file locking
   * @param {Function} onNewCluster - Callback(cluster) for each new cluster
   * @param {Number} intervalMs - Poll interval in ms (default: 2000)
   * @returns {Function} Stop function to cancel watching
   */
  watchForNewClusters(onNewCluster, intervalMs = 2000) {
    const clustersFile = path.join(this.storageDir, 'clusters.json');
    const lockfilePath = path.join(this.storageDir, 'clusters.json.lock');
    const knownClusterIds = new Set(this.clusters.keys());

    const intervalId = setInterval(() => {
      let release;
      try {
        if (!fs.existsSync(clustersFile)) return;

        // Clean stale locks from crashed processes
        cleanStaleLock(lockfilePath);

        // Try to acquire lock once (polling is best-effort, will retry on next cycle)
        try {
          release = lockfile.lockSync(clustersFile, {
            lockfilePath,
            stale: LOCK_STALE_MS,
          });
        } catch (lockErr) {
          // Lock busy - skip this poll cycle, try again next interval
          if (lockErr.code === 'ELOCKED') return;
          throw lockErr;
        }

        const data = readClustersFileSync(this.storageDir);

        for (const [clusterId, clusterData] of Object.entries(data)) {
          if (!knownClusterIds.has(clusterId)) {
            // New cluster found
            knownClusterIds.add(clusterId);
            const cluster = this._loadSingleCluster(clusterId, clusterData);
            if (cluster && onNewCluster) {
              onNewCluster(cluster);
            }
          }
        }
      } catch (error) {
        // File access during polling can fail transiently - log and continue
        console.error(`[Orchestrator] watchForNewClusters error (will retry): ${error.message}`);
      } finally {
        if (release) {
          release();
        }
      }
    }, intervalMs);

    // Return stop function
    return () => clearInterval(intervalId);
  }

  /**
   * Start a new cluster with mocked agent executors (TESTING ONLY)
   *
   * CRITICAL: This method PREVENTS real Claude API calls.
   * All agent behaviors must be defined in mockExecutor.
   *
   * @param {Object} config - Cluster configuration
   * @param {Object} input - Input source { issue, text, or config }
   * @param {MockAgentExecutor} mockExecutor - Mock executor with agent behaviors
   * @returns {Object} Cluster object
   */
  startWithMock(config, input, mockExecutor) {
    if (!mockExecutor) {
      throw new Error('Orchestrator.startWithMock: mockExecutor is required');
    }

    // Validate all agents that execute tasks have mock behaviors defined
    // Orchestrator agents (action: 'stop_cluster') don't execute tasks, so don't need mocks
    for (const agentConfig of config.agents) {
      const agentId = agentConfig.id;

      // Check if agent has any triggers that execute tasks
      const executesTask = agentConfig.triggers?.some(
        (trigger) => !trigger.action || trigger.action === 'execute_task'
      );

      if (executesTask && !mockExecutor.behaviors[agentId]) {
        throw new Error(
          `Orchestrator.startWithMock: No behavior defined for agent '${agentId}'. ` +
            `This would cause real Claude API calls. ABORTING.\n` +
            `Available behaviors: ${Object.keys(mockExecutor.behaviors).join(', ')}`
        );
      }
    }

    return this._startInternal(config, input, {
      mockExecutor,
      testMode: true,
    });
  }

  /**
   * Start a new cluster
   * @param {Object} config - Cluster configuration
   * @param {Object} input - Input source { issue, text, or config }
   * @param {Object} options - Start options
   * @param {boolean} options.isolation - Run in Docker container
   * @param {string} options.isolationImage - Docker image to use
   * @param {boolean} options.worktree - Run in git worktree isolation (lightweight, no Docker)
   * @returns {Object} Cluster object
   */
  start(config, input = {}, options = {}) {
    const testMode = options.testMode || !!this.taskRunner;
    const autoPr = options.autoPr ?? (testMode ? false : process.env.ZEROSHOT_PR === '1');
    return this._startInternal(config, input, {
      ...options,
      testMode,
      cwd: options.cwd || process.cwd(), // Target working directory for agents
      isolation: options.isolation || false,
      isolationImage: options.isolationImage,
      worktree: options.worktree || false,
      autoPr,
      modelOverride: options.modelOverride, // Model override for all agents
      clusterId: options.clusterId, // Explicit ID from CLI/daemon parent
      settings: options.settings, // User settings for issue provider detection
      forceProvider: options.forceProvider, // Force specific issue provider
      force: options.force || false, // Skip duplicate issue check
    });
  }

  /**
   * Resolve input (issue from provider, file, or text) and reject duplicate active
   * runs on the same issue. Deliberately allocates NOTHING (no ledger, no isolation,
   * no cluster registration) so a rejection - duplicate or otherwise - has zero side
   * effects on disk or in-memory state.
   * @private
   * @returns {Promise<{ inputData: Object, issueProviderId: string|null }>}
   */
  async _resolveClusterInput(input, options, clusterId) {
    if (input.issue) {
      const ProviderClass = detectProvider(
        input.issue,
        options.settings || {},
        options.forceProvider
      );
      if (!ProviderClass) {
        throw new Error(`No issue provider matched input: ${input.issue}`);
      }

      const provider = new ProviderClass();
      const inputData = await provider.fetchIssue(input.issue, options.settings || {});
      const issueNumber = inputData.number || null;

      // Check for duplicate active runs on same issue (unless --force)
      if (issueNumber && !options.force) {
        const activeClusters = this._getActiveClustersForIssue(issueNumber, clusterId);
        if (activeClusters.length > 0) {
          const existing = activeClusters[0];
          const age = Math.round((Date.now() - existing.createdAt) / 1000 / 60);
          throw new DuplicateClusterError(
            `Issue #${issueNumber} already has an active cluster:\n` +
              `  Cluster: ${existing.id} (state: ${existing.state}, running for ${age}min, pid: ${existing.pid})\n\n` +
              `Options:\n` +
              `  1. Kill existing: zeroshot kill ${existing.id}\n` +
              `  2. Override check: zeroshot run ${input.issue} --force\n` +
              `  3. View status:    zeroshot status ${existing.id}`,
            {
              issueNumber,
              existingClusterId: existing.id,
              existingState: existing.state,
              existingPid: existing.pid,
              ageMinutes: age,
            }
          );
        }
      }

      // Log clickable issue link
      if (inputData.url) {
        this._log(`[Orchestrator] Issue (${ProviderClass.displayName}): ${inputData.url}`);
      }

      return { inputData, issueProviderId: ProviderClass.id };
    } else if (input.file) {
      this._log(`[Orchestrator] File: ${input.file}`);
      return { inputData: InputHelpers.createFileInput(input.file), issueProviderId: null };
    } else if (input.text) {
      return { inputData: InputHelpers.createTextInput(input.text), issueProviderId: null };
    }

    throw new Error('Either issue, file, or text input is required');
  }

  /**
   * Internal start implementation (shared by start and startWithMock)
   * @private
   */
  async _startInternal(config, input = {}, options = {}) {
    // Generate a unique cluster ID for this process call.
    // IMPORTANT: Do NOT implicitly reuse ZEROSHOT_CLUSTER_ID, because:
    // - test harnesses may set it globally (breaking multi-start tests)
    // - callers may start multiple clusters in one process
    // Use it only when explicitly passed (CLI/daemon parent) via options.clusterId.
    const clusterId = this._resolveStartClusterId(
      options.clusterId || null,
      config?.dbPath || null
    );

    // Resolve input (issue/file/text) and reject duplicate active runs on the same issue
    // BEFORE allocating any resources. A duplicate-run rejection must have zero side
    // effects: no ledger db file, no worktree/container, no clusters.json entry.
    let { inputData, issueProviderId } = await this._resolveClusterInput(input, options, clusterId);

    // Create ledger and message bus with persistent storage
    const dbPath = config.dbPath || path.join(this.storageDir, `${clusterId}.db`);
    const ledger = new Ledger(dbPath);
    const messageBus = new MessageBus(ledger);

    // Handle isolation mode (Docker container OR git worktree)
    const {
      isolationManager,
      containerId,
      worktreeInfo,
      image: resolvedIsolationImage,
    } = await this._initializeIsolation(options, config, clusterId);
    let requiredQualityGates = resolveClusterRequiredQualityGates(config, options);
    let commandProofs = resolveClusterCommandProofs(config, options);
    options.requiredQualityGates = requiredQualityGates;

    // Build cluster object
    // CRITICAL: initComplete promise ensures ISSUE_OPENED is published before stop() completes
    // This prevents 0-message clusters from SIGINT during async initialization
    let resolveInitComplete;
    const initCompletePromise = new Promise((resolve) => {
      resolveInitComplete = resolve;
    });

    const cluster = {
      id: clusterId,
      config,
      state: 'initializing',
      messageBus,
      ledger,
      agents: [],
      createdAt: Date.now(),
      // Track PID for zombie detection (this process owns the cluster)
      pid: process.pid,
      // Issue number for heroshot/external tools (avoids log parsing)
      issue: inputData.number || null,
      // Initialization completion tracking (for safe SIGINT handling)
      initCompletePromise,
      _resolveInitComplete: resolveInitComplete,
      autoPr: options.autoPr || false,
      runMode: options.runMode || null,
      requiredQualityGates,
      commandProofs,
      // PR configuration options (persisted for resume)
      prOptions: buildPrOptions(options, requiredQualityGates),
      // Model override for all agents (applied to dynamically added agents)
      modelOverride: options.modelOverride || null,
      // Issue provider tracking (where issue was fetched from)
      issueProvider: issueProviderId, // null unless input.issue (github, gitlab, jira, azure-devops)
      // Git platform tracking (where PR/MR will be created - independent of issue provider)
      gitPlatform: null, // Set when --pr mode is active
      // Isolation state (only if enabled)
      // CRITICAL: Store workDir for resume capability - without this, resume() can't recreate container
      isolation: options.isolation
        ? {
            enabled: true,
            containerId,
            // Provider-specific image variant (resolved in _initializeIsolation) so resume
            // recreates the container on the same image that has the provider CLI installed.
            image: resolvedIsolationImage || options.isolationImage || 'zeroshot-cluster-base',
            manager: isolationManager,
            workDir: options.cwd || process.cwd(), // Persisted for resume
          }
        : null,
      // Worktree isolation state (lightweight alternative to Docker)
      worktree: options.worktree
        ? {
            enabled: true,
            path: worktreeInfo.path,
            branch: worktreeInfo.branch,
            repoRoot: worktreeInfo.repoRoot,
            manager: isolationManager,
            workDir: options.cwd || process.cwd(), // Persisted for resume
          }
        : null,
    };

    this.clusters.set(clusterId, cluster);
    this._startSnapshotter(cluster);

    // Persist the cluster immediately so detached runs can't create "invisible" initializing clusters.
    // Without this, an early startup failure (before ISSUE_OPENED / TASK_STARTED) may never be saved,
    // and external supervisors (e.g., heroshot) can't detect/cleanup the stuck state.
    await this._saveClusters().catch((err) => {
      console.warn(`[Orchestrator] Failed to persist initial cluster state for ${clusterId}:`, err);
    });

    try {
      if (typeof options.prepareIsolatedInput === 'function') {
        const dockerWorkspace =
          isolationManager?.isolatedDirs?.get(clusterId)?.path || options.cwd || process.cwd();
        const isolation = worktreeInfo
          ? Object.freeze({
              kind: 'worktree',
              hostRoot: worktreeInfo.path,
              runtimeRoot: worktreeInfo.path,
            })
          : containerId && dockerWorkspace
            ? Object.freeze({
                kind: 'docker',
                hostRoot: dockerWorkspace,
                runtimeRoot: '/workspace',
              })
            : null;
        if (!isolation) {
          throw new Error('Prepared input requires an allocated worktree or Docker workspace');
        }
        const preparedText = await options.prepareIsolatedInput(
          Object.freeze({ clusterId, isolation })
        );
        if (typeof preparedText !== 'string' || preparedText.trim().length === 0) {
          throw new Error('Prepared isolated input must be a nonempty string');
        }
        inputData = InputHelpers.createTextInput(preparedText);
      }

      // Input (issue/file/text) was already resolved and duplicate-checked in
      // _resolveClusterInput() before any resource was allocated (see above).
      commandProofs = mergeCommandProofs(
        commandProofs,
        resolveClusterCommandProofs(config, options, inputData.context)
      );
      requiredQualityGates = mergeQualityGates(
        requiredQualityGates,
        commandProofsToQualityGates(commandProofs)
      );
      options.requiredQualityGates = requiredQualityGates;
      cluster.requiredQualityGates = requiredQualityGates;
      cluster.commandProofs = commandProofs;
      cluster.prOptions = buildPrOptions(options, requiredQualityGates);
      applyCommandProofsToAgents(config, commandProofs);
      applyRequiredQualityGatesToValidators(config, requiredQualityGates);

      // Detect git platform for --pr mode (independent of issue provider)
      if (options.autoPr) {
        const { detectGitContext } = require('../lib/git-remote-utils');
        const gitContext = detectGitContext(options.cwd);
        cluster.gitPlatform = gitContext?.provider || null;
        options.gitRemote = gitContext?.remote || options.gitRemote || null;
        cluster.prOptions = buildPrOptions(options, requiredQualityGates);

        if (cluster.gitPlatform) {
          this._log(`[Orchestrator] Git platform detected: ${cluster.gitPlatform.toUpperCase()}`);
        }
      }

      // Inject git-pusher agent if --pr is set (replaces completion-detector)
      this._applyAutoPrConfig(config, inputData, options);
      if (options.autoPr) {
        applyPushBlockedRepairTriggers(config);
      }

      // Inject workers instruction if --workers explicitly provided and > 1
      this._applyWorkerInstruction(config);

      // Initialize agents with optional mock injection
      // Check agent type: regular agent or subcluster
      // CRITICAL: Inject cwd into each agent config for proper working directory
      // In worktree mode, agents run in the worktree path (not original cwd)
      this._initializeClusterAgents({
        config,
        cluster,
        messageBus,
        options,
        isolationManager,
        clusterId,
      });

      // ========================================================================
      // CRITICAL ORDERING INVARIANT (Issue #31 - Subscription Race Condition)
      // ========================================================================
      // MUST register ALL subscriptions BEFORE starting agents.
      //
      // WHY: EventEmitter is synchronous and doesn't replay past events to new
      // listeners. If an agent completes and publishes CLUSTER_COMPLETE before
      // we register the subscription, the orchestrator will never receive the
      // message and the cluster will appear stuck in 'executing_task' forever.
      //
      // ORDER:
      //   1. Register subscriptions (lines below)
      //   2. Start agents
      //   3. Publish ISSUE_OPENED
      //
      // DO NOT move subscriptions after agent.start() - this will reintroduce
      // the race condition fixed in issue #31.
      // ========================================================================
      this._registerClusterSubscriptions({
        messageBus,
        clusterId,
        isolationManager,
        containerId,
      });

      // Start all agents
      for (const agent of cluster.agents) {
        await agent.start();
      }

      cluster.state = 'running';

      // Publish ISSUE_OPENED message to bootstrap workflow
      messageBus.publish({
        cluster_id: clusterId,
        topic: 'ISSUE_OPENED',
        sender: 'system',
        receiver: 'broadcast',
        content: {
          text: inputData.context,
          data: {
            issue_number: inputData.number,
            title: inputData.title,
          },
        },
        metadata: {
          source: this._getInputSource(input),
        },
      });

      // CRITICAL: Mark initialization complete AFTER ISSUE_OPENED is published
      // This ensures stop() waits for at least 1 message before stopping
      if (cluster._resolveInitComplete) {
        cluster._resolveInitComplete();
      }

      this._log(`Cluster ${clusterId} started with ${cluster.agents.length} agents`);

      // DISABLED: Idle timeout auto-stop mechanism
      // WHY DISABLED: Clusters should only stop on explicit signals:
      //   - User `zeroshot kill` command
      //   - CLUSTER_COMPLETE message (successful completion)
      //   - CLUSTER_FAILED message (failure/abort)
      // Being "idle" is NOT a reason to auto-stop - agents may be legitimately
      // waiting for external events, user input (in interactive mode), or
      // processing that doesn't show as "executing" (e.g., polling, monitoring).
      //
      // Previous behavior: Stopped cluster after 2 minutes of all agents idle
      // Result: Clusters were killed while legitimately waiting, causing confusion
      //
      // cluster.idleCheckInterval = setInterval(() => { ... }, 30000);
      // ^^^^^^ REMOVED - clusters run until explicitly stopped or completed

      // Save cluster to disk
      await this._saveClusters();

      return {
        id: clusterId,
        state: cluster.state,
        agents: cluster.agents.map((a) => a.getState()),
        ledger: cluster.ledger, // Expose ledger for testing
        messageBus: cluster.messageBus, // Expose messageBus for testing
      };
    } catch (error) {
      cluster.state = 'failed';
      // CRITICAL: Resolve the promise on failure too, so stop() doesn't hang
      if (cluster._resolveInitComplete) {
        cluster._resolveInitComplete();
      }
      // Persist the failure state (prevents "invisible" failures that supervisors can't detect/cleanup).
      await this._saveClusters().catch((err) => {
        console.warn(
          `[Orchestrator] Failed to persist failed cluster state for ${clusterId}:`,
          err
        );
      });

      // Best-effort cleanup of partially initialized resources (prevents orphaned worktrees/containers).
      try {
        if (cluster.snapshotter) {
          cluster.snapshotter.stop();
        }
      } catch {
        // ignore
      }
      try {
        for (const agent of cluster.agents || []) {
          // Agent start may have partially succeeded.
          // Stop is best-effort and must not mask the original error.
          await agent.stop();
        }
      } catch {
        // ignore
      }
      try {
        if (cluster.isolation?.manager) {
          // Preserve workspace for inspection; callers can `zeroshot kill` for full cleanup.
          await cluster.isolation.manager.cleanup(clusterId, { preserveWorkspace: true });
        }
      } catch {
        // ignore
      }
      try {
        if (cluster.worktree?.manager) {
          cluster.worktree.manager.cleanupWorktreeIsolation(clusterId, { preserveBranch: true });
        }
      } catch {
        // ignore
      }
      try {
        cluster.messageBus?.close?.();
      } catch {
        // ignore
      }
      try {
        cluster.ledger?.close?.();
      } catch {
        // ignore
      }
      console.error(`Cluster ${clusterId} failed to start:`, error);
      throw error;
    }
  }

  _initializeClusterAgents({ config, cluster, messageBus, options, isolationManager, clusterId }) {
    const agentCwd = cluster.worktree ? cluster.worktree.path : options.cwd || process.cwd();

    for (const agentConfig of config.agents) {
      if (!agentConfig.cwd) {
        agentConfig.cwd = agentCwd;
      }

      if (options.modelOverride) {
        applyModelOverride(agentConfig, options.modelOverride);
        this._log(`    [model] Overridden model for ${agentConfig.id}: ${options.modelOverride}`);
      }

      const agentOptions = {
        testMode: options.testMode || !!this.taskRunner,
        quiet: this.quiet,
        modelOverride: options.modelOverride || null,
      };

      if (options.mockExecutor) {
        agentOptions.mockSpawnFn = options.mockExecutor.createMockSpawnFn(agentConfig.id);
      }

      if (this.taskRunner) {
        agentOptions.taskRunner = this.taskRunner;
      }

      if (cluster.isolation) {
        agentOptions.isolation = {
          enabled: true,
          manager: isolationManager,
          clusterId,
        };
      }

      if (cluster.worktree) {
        agentOptions.worktree = {
          enabled: true,
          path: cluster.worktree.path,
          branch: cluster.worktree.branch,
          repoRoot: cluster.worktree.repoRoot,
        };
      }

      const agent =
        agentConfig.type === 'subcluster'
          ? new SubClusterWrapper(agentConfig, messageBus, cluster, agentOptions)
          : new AgentWrapper(agentConfig, messageBus, cluster, agentOptions);

      cluster.agents.push(agent);
    }
  }

  _subscribeToClusterTopic(messageBus, clusterId, topic, handler) {
    messageBus.subscribe((message) => {
      if (message.topic === topic && message.cluster_id === clusterId) {
        handler(message);
      }
    });
  }

  _registerClusterCompletionHandlers(messageBus, clusterId) {
    this._subscribeToClusterTopic(messageBus, clusterId, 'CLUSTER_COMPLETE', (message) => {
      this._log(`\n${'='.repeat(80)}`);
      this._log(`✅ CLUSTER COMPLETED SUCCESSFULLY: ${clusterId}`);
      this._log(`${'='.repeat(80)}`);
      this._log(`Reason: ${message.content?.data?.reason || 'unknown'}`);
      this._log(`Initiated by: ${message.sender}`);
      this._log(`${'='.repeat(80)}\n`);

      this.stop(clusterId, { completedSuccessfully: true }).catch((err) => {
        console.error(`Failed to auto-stop cluster ${clusterId}:`, err.message);
      });
    });

    this._subscribeToClusterTopic(messageBus, clusterId, 'CLUSTER_FAILED', (message) => {
      this._log(`\n${'='.repeat(80)}`);
      this._log(`❌ CLUSTER FAILED: ${clusterId}`);
      this._log(`${'='.repeat(80)}`);
      this._log(`Reason: ${message.content?.data?.reason || 'unknown'}`);
      this._log(`Agent: ${message.sender}`);
      if (message.content?.text) {
        this._log(`Details: ${message.content.text}`);
      }
      this._log(`${'='.repeat(80)}\n`);

      this.stop(clusterId).catch((err) => {
        console.error(`Failed to auto-stop cluster ${clusterId}:`, err.message);
      });
    });
  }

  _registerAgentErrorHandler(messageBus, clusterId) {
    this._subscribeToClusterTopic(messageBus, clusterId, 'AGENT_ERROR', async (message) => {
      const agentRole = message.content?.data?.role;
      const attempts = message.content?.data?.attempts || 1;
      const hookFailure = message.content?.data?.hookFailure === true;
      const restartExhausted = message.content?.data?.restartExhausted === true;

      await this._saveClusters();

      const shouldStopForRole =
        agentRole === 'implementation' ||
        agentRole === 'coordinator' ||
        message.sender === 'consensus-coordinator';
      const shouldStop = shouldStopForRole && (hookFailure || restartExhausted || attempts >= 3);

      if (shouldStop) {
        this._log(`\n${'='.repeat(80)}`);
        this._log(`❌ CRITICAL AGENT FAILED: ${clusterId}`);
        this._log(`${'='.repeat(80)}`);
        this._log(
          `${message.sender} (${agentRole || 'unknown role'}) failed` +
            (hookFailure ? ` (hookFailure=true)` : ``) +
            (restartExhausted ? ` (restartExhausted=true)` : ``) +
            ` after ${attempts} attempts`
        );
        this._log(`Error: ${message.content?.data?.error || 'unknown'}`);
        this._log(`Stopping cluster - critical agent cannot continue`);
        this._log(`${'='.repeat(80)}\n`);

        this.stop(clusterId).catch((err) => {
          console.error(`Failed to auto-stop cluster ${clusterId}:`, err.message);
        });
      }
    });
  }

  _registerPushBlockedHandler(messageBus, clusterId) {
    this._subscribeToClusterTopic(messageBus, clusterId, 'PUSH_BLOCKED', async (message) => {
      const reason = message.content?.data?.blocked_reason || 'unknown';
      const prNumber = message.content?.data?.pr_number || message.content?.data?.mr_number;
      this._log(`🔁 git-pusher blocked${prNumber ? ` (${prNumber})` : ''}: ${reason}`);
      await this._saveClusters();
    });
  }

  _registerAgentLifecycleHandlers(messageBus, _clusterId) {
    messageBus.on('topic:AGENT_LIFECYCLE', async (message) => {
      const event = message.content?.data?.event;
      if (
        [
          'TASK_STARTED',
          'TASK_COMPLETED',
          'TASK_FAILED',
          'RETRY_SCHEDULED',
          'PROCESS_SPAWNED',
          'TASK_ID_ASSIGNED',
          'STARTED',
        ].includes(event)
      ) {
        await this._saveClusters();
      }
    });

    messageBus.on('topic:AGENT_LIFECYCLE', (message) => {
      if (message.content?.data?.event !== 'AGENT_STALE_WARNING') return;

      const agentId = message.content?.data?.agent;
      const timeSinceLastOutput = message.content?.data?.timeSinceLastOutput;
      const analysis = message.content?.data?.analysis || 'No analysis available';

      const consecutiveWarnings = message.content?.data?.consecutiveWarnings;
      const warningsBeforeKill = message.content?.data?.warningsBeforeKill;
      this._log(
        `⚠️  Orchestrator: Agent ${agentId} has produced no output for ${Math.round(timeSinceLastOutput / 1000)}s ` +
          `(warning ${consecutiveWarnings}/${warningsBeforeKill})`
      );
      this._log(`    Analysis: ${analysis}`);
      this._log(`    Zeroshot will terminate and restart the task if inactivity persists`);
    });
  }

  _registerConductorWatchdog(messageBus, clusterId) {
    const timeoutMs = 30000;
    let watchdogTimer = null;
    let completedAt = null;

    this._subscribeToClusterTopic(messageBus, clusterId, 'AGENT_LIFECYCLE', (message) => {
      const event = message.content?.data?.event;
      const role = message.content?.data?.role;

      if (event === 'TASK_COMPLETED' && role === 'conductor') {
        completedAt = Date.now();
        this._log(
          `⏱️  Conductor completed. Watchdog started - expecting CLUSTER_OPERATIONS within ${timeoutMs / 1000}s`
        );

        watchdogTimer = setTimeout(() => {
          const clusterOps = messageBus.query({
            cluster_id: clusterId,
            topic: 'CLUSTER_OPERATIONS',
            limit: 1,
          });
          if (clusterOps.length === 0) {
            console.error(`\n${'='.repeat(80)}`);
            console.error(`🔴 CONDUCTOR WATCHDOG TRIGGERED - CLUSTER_OPERATIONS NEVER RECEIVED`);
            console.error(`${'='.repeat(80)}`);
            console.error(`Conductor completed ${timeoutMs / 1000}s ago but no CLUSTER_OPERATIONS`);
            console.error(`This indicates the conductor's onComplete hook FAILED SILENTLY`);
            console.error(
              `Check: 1) Result parsing 2) Transform script errors 3) Schema validation`
            );
            console.error(`${'='.repeat(80)}\n`);

            messageBus.publish({
              cluster_id: clusterId,
              topic: 'CLUSTER_FAILED',
              sender: 'orchestrator',
              content: {
                text: `Conductor completed but CLUSTER_OPERATIONS never published - hook failure`,
                data: {
                  reason: 'CONDUCTOR_WATCHDOG_TIMEOUT',
                  conductorCompletedAt: completedAt,
                  timeoutMs: timeoutMs,
                },
              },
            });
          }
        }, timeoutMs);
      }
    });

    return {
      clear: () => {
        if (!watchdogTimer) {
          return;
        }
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
        const elapsed = completedAt ? Date.now() - completedAt : 0;
        this._log(
          `✅ CLUSTER_OPERATIONS received (${elapsed}ms after conductor completed) - watchdog cleared`
        );
      },
    };
  }

  _registerClusterOperationsHandler(
    messageBus,
    clusterId,
    isolationManager,
    containerId,
    watchdog
  ) {
    this._subscribeToClusterTopic(messageBus, clusterId, 'CLUSTER_OPERATIONS', (message) => {
      watchdog?.clear?.();

      let operations = message.content?.data?.operations;
      if (typeof operations === 'string') {
        try {
          operations = JSON.parse(operations);
        } catch (e) {
          this._log(`⚠️ CLUSTER_OPERATIONS has invalid operations JSON: ${e.message}`);
          return;
        }
      }

      if (!operations || !Array.isArray(operations)) {
        this._log(`⚠️ CLUSTER_OPERATIONS missing operations array, ignoring`);
        return;
      }

      this._log(`\n${'='.repeat(80)}`);
      this._log(`🔧 CLUSTER_OPERATIONS received from ${message.sender}`);
      this._log(`${'='.repeat(80)}`);
      if (message.content?.data?.reasoning) {
        this._log(`Reasoning: ${message.content.data.reasoning}`);
      }
      this._log(`Operations: ${operations.length}`);
      this._log(`${'='.repeat(80)}\n`);

      this._handleOperations(clusterId, operations, message.sender, {
        isolationManager,
        containerId,
      }).catch((err) => {
        console.error(`Failed to execute CLUSTER_OPERATIONS:`, err.message);
        messageBus.publish({
          cluster_id: clusterId,
          topic: 'CLUSTER_OPERATIONS_FAILED',
          sender: 'orchestrator',
          content: {
            text: `Operation chain failed: ${err.message}`,
            data: {
              error: err.message,
              operations: operations,
            },
          },
        });

        this._log(`\n${'='.repeat(80)}`);
        this._log(`❌ CLUSTER_OPERATIONS FAILED - STOPPING CLUSTER`);
        this._log(`${'='.repeat(80)}`);
        this._log(`Error: ${err.message}`);
        this._log(`${'='.repeat(80)}\n`);

        this.stop(clusterId).catch((stopErr) => {
          console.error(`Failed to stop cluster after operation failure:`, stopErr.message);
        });
      });
    });
  }

  _registerClusterSubscriptions({ messageBus, clusterId, isolationManager, containerId }) {
    this._registerClusterCompletionHandlers(messageBus, clusterId);
    this._registerAgentErrorHandler(messageBus, clusterId);
    this._registerPushBlockedHandler(messageBus, clusterId);
    this._registerAgentLifecycleHandlers(messageBus, clusterId);

    const watchdog = this._registerConductorWatchdog(messageBus, clusterId);
    this._registerClusterOperationsHandler(
      messageBus,
      clusterId,
      isolationManager,
      containerId,
      watchdog
    );
  }

  async _initializeIsolation(options, config, clusterId) {
    let isolationManager = null;
    let containerId = null;
    let worktreeInfo = null;
    let isolationImage = null;

    if (options.isolation) {
      if (!IsolationManager.isDockerAvailable()) {
        throw new Error('Docker is not available. Install Docker to use --docker mode.');
      }

      // Resolve the provider first so the cluster runs on that provider's image variant, which
      // installs the provider CLI as a Docker-cached layer. Providers baked into the base image
      // (e.g. Claude) resolve back to the base image unchanged.
      const providerName = this._resolveClusterProvider(config);
      const baseImage = options.isolationImage || 'zeroshot-cluster-base';
      const image = IsolationManager.imageForProvider(providerName, baseImage);
      await IsolationManager.ensureImage(
        image,
        true,
        IsolationManager.providerBuildArgs(providerName)
      );
      isolationImage = image;

      isolationManager = new IsolationManager({ image });
      this._log(`[Orchestrator] Starting cluster in isolation mode (image: ${image})`);

      const workDir = options.cwd || process.cwd();
      containerId = await isolationManager.createContainer(clusterId, {
        workDir,
        image,
        noMounts: options.noMounts,
        mounts: options.mounts,
        containerHome: options.containerHome,
        provider: providerName,
      });
      this._log(`[Orchestrator] Container created: ${containerId} (workDir: ${workDir})`);
    } else if (options.worktree) {
      const workDir = options.cwd || process.cwd();

      isolationManager = new IsolationManager({});
      const { detectGitContext } = require('../lib/git-remote-utils');
      const gitContext = detectGitContext(workDir);
      if (gitContext?.remote) {
        options.gitRemote = gitContext.remote;
      }

      // `prBase` is the PR target branch. Base isolated work on its refreshed
      // remote-tracking ref so a stale local branch cannot change the plan.
      const worktreeOptions = {};
      if (options.prBase) {
        const remoteName = options.gitRemote || 'origin';
        worktreeOptions.baseRef = `${remoteName}/${options.prBase}`;
        if (remoteName !== 'origin') {
          worktreeOptions.remoteName = remoteName;
        }
        worktreeOptions.requireFreshBase = true;
        this._log(`[Orchestrator] Using worktree base ref: ${worktreeOptions.baseRef}`);
      }
      worktreeInfo = isolationManager.createWorktreeIsolation(clusterId, workDir, worktreeOptions);

      this._log(`[Orchestrator] Starting cluster in worktree isolation mode`);
      this._log(`[Orchestrator] Worktree: ${worktreeInfo.path}`);
      this._log(`[Orchestrator] Branch: ${worktreeInfo.branch}`);
      this._log(`[Orchestrator] Worktree base commit: ${worktreeInfo.baseSha}`);
    }

    return { isolationManager, containerId, worktreeInfo, image: isolationImage };
  }

  _applyAutoPrConfig(config, inputData, options) {
    if (!options.autoPr) {
      return;
    }

    config.agents = config.agents.filter((a) => a.id !== 'completion-detector');

    // Detect git platform (independent of issue provider)
    const { getPlatformForPR } = require('./issue-providers');
    const { detectGitContext } = require('../lib/git-remote-utils');

    let platform;
    try {
      // ALWAYS use git context, regardless of issue provider
      // This allows Jira issues in GitHub repos, etc.
      platform = getPlatformForPR(options.cwd);
    } catch (error) {
      throw new Error(`--pr mode failed: ${error.message}`);
    }

    // Check for repo mismatch (issue URL repo vs current git remote)
    // This catches cases like: running `zeroshot run https://gitlab.com/foo/bar/-/issues/1`
    // from a different repo directory
    let skipCloseIssue = false;
    const gitContext = detectGitContext(options.cwd);
    if (inputData.url && gitContext) {
      const issueHost = this._extractHostFromUrl(inputData.url);
      const gitHost = gitContext.host;

      // Compare hosts - if different platforms, warn and don't close issue
      if (issueHost && gitHost && issueHost !== gitHost) {
        this._log(
          `[Orchestrator] ⚠️  WARNING: Issue is from ${issueHost} but PR will be created on ${gitHost}`
        );
        this._log(
          `[Orchestrator] ⚠️  The PR will NOT auto-close the issue (different repositories)`
        );
        this._log(`[Orchestrator] ⚠️  To fix: run zeroshot from the target repository directory`);
        skipCloseIssue = true;
      }
    }

    // Generate platform-specific git-pusher agent from template
    const { generateGitPusherAgent, isPlatformSupported } = require('./agents/git-pusher-template');

    if (!isPlatformSupported(platform)) {
      throw new Error(
        `Platform '${platform}' does not support --pr mode. Supported: github, gitlab, azure-devops`
      );
    }

    const gitPusherConfig = generateGitPusherAgent(platform, {
      prBase: options.prBase,
      mergeQueue: options.mergeQueue,
      closeIssue: options.closeIssue,
      requiredQualityGates: options.requiredQualityGates,
      autoMerge: resolveRunPlan(options).autoMerge,
      gitRemote: gitContext?.remote || options.gitRemote,
      issueNumber: inputData.number,
      issueTitle: inputData.title,
      includeIssueReference: !skipCloseIssue,
      cwd: options.cwd,
    });

    config.agents.push(gitPusherConfig);
    this._log(
      `[Orchestrator] Injected ${platform}-git-pusher agent (issue: ${inputData.number || 'N/A'}, PR platform: ${platform.toUpperCase()})`
    );
  }

  /**
   * Extract hostname from a URL
   * @private
   */
  _extractHostFromUrl(url) {
    try {
      const match = url.match(/https?:\/\/([^/]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  _applyWorkerInstruction(config) {
    const workersCount = process.env.ZEROSHOT_WORKERS ? parseInt(process.env.ZEROSHOT_WORKERS) : 0;
    if (workersCount <= 1) {
      return;
    }

    const workerAgent = config.agents.find((a) => a.id === 'worker');
    if (!workerAgent) {
      return;
    }

    const instruction = `PARALLELIZATION: Use up to ${workersCount} sub-agents to parallelize your work where appropriate.\n\n`;

    if (!workerAgent.prompt) {
      workerAgent.prompt = instruction;
    } else if (typeof workerAgent.prompt === 'string') {
      workerAgent.prompt = instruction + workerAgent.prompt;
    } else if (workerAgent.prompt.system) {
      workerAgent.prompt.system = instruction + workerAgent.prompt.system;
    }

    this._log(`[Orchestrator] Injected parallelization instruction (workers=${workersCount})`);
  }

  /**
   * Generate a unique cluster ID, safe for concurrent starts in-process.
   * If an explicit ID is provided, uses it as a base and suffixes on collision.
   * @private
   */
  _generateUniqueClusterId(explicitId, explicitDbPath) {
    const baseId = explicitId || generateName('cluster');
    const baseDbPath = explicitDbPath || path.join(this.storageDir, `${baseId}.db`);

    // Fast path: base is unused.
    if (!this.clusters.has(baseId) && !fs.existsSync(baseDbPath)) {
      return baseId;
    }

    // Collision: suffix with random bytes to avoid race conditions under concurrency.
    for (let attempt = 0; attempt < 50; attempt++) {
      const suffix = crypto.randomBytes(3).toString('hex');
      const candidateId = `${baseId}-${suffix}`;
      const candidateDbPath = explicitDbPath || path.join(this.storageDir, `${candidateId}.db`);
      if (!this.clusters.has(candidateId) && !fs.existsSync(candidateDbPath)) {
        return candidateId;
      }
    }

    // Last resort: new generated name (should never happen).
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidateId = generateName('cluster');
      const candidateDbPath = explicitDbPath || path.join(this.storageDir, `${candidateId}.db`);
      if (!this.clusters.has(candidateId) && !fs.existsSync(candidateDbPath)) {
        return candidateId;
      }
    }

    throw new Error(`Failed to generate unique cluster ID in ${this.storageDir} after 50 attempts`);
  }

  /**
   * Wait for a process to exit
   * @param {Number} pid - Process ID
   * @param {Number} timeoutMs - Timeout in milliseconds
   * @param {Number} intervalMs - Poll interval in milliseconds
   * @returns {Promise<Boolean>} True if process exited
   * @private
   */
  async _waitForProcessExit(pid, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this._isProcessRunning(pid)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return !this._isProcessRunning(pid);
  }

  /**
   * Tear down Docker Compose services in a worktree directory to free host ports.
   * Best-effort — silently ignores failures (compose may not have been started, Docker may not be running).
   * @param {string} worktreePath - Path to the worktree directory
   * @private
   */
  _teardownWorktreeCompose(worktreePath) {
    // NEVER pass --volumes (irreversible data loss) and NEVER tear down a pinned/shared
    // Compose project — only a project scoped to the worktree directory basename, which is
    // the only kind zeroshot could itself have created, is touched.
    const { resolveWorktreeComposeTeardown } = require('../lib/compose-utils');
    const teardown = resolveWorktreeComposeTeardown(worktreePath);
    if (!teardown.shouldTeardown) {
      if (teardown.composePath) {
        this._log(
          `[Orchestrator] Skipping Docker Compose teardown in ${worktreePath}: ${teardown.reason}`
        );
      }
      return;
    }

    try {
      this._log(`[Orchestrator] Tearing down Docker Compose services in ${worktreePath}...`);
      const { spawnSync } = require('child_process');
      const result = spawnSync('docker', teardown.args, {
        cwd: worktreePath,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 30000,
      });
      if (result.status !== 0 || result.error) {
        const detail = result.error?.message || result.stderr || 'no stderr';
        throw new Error(`Docker Compose teardown failed in ${worktreePath}: ${detail}`);
      }
      this._log(`[Orchestrator] Docker Compose services torn down`);
    } catch {
      // Best-effort: compose project may not have been started
    }
  }

  /**
   * Signal a remote daemon that owns the cluster and wait for exit
   * @param {Object} cluster - Cluster object
   * @param {Object} options - { action, timeoutMs, killTimeoutMs, signal }
   * @returns {Promise<Object>} { handled, remotePid, exited, forced }
   * @private
   */
  async _signalRemoteCluster(cluster, options) {
    const remotePid = cluster.pid;
    if (!remotePid || remotePid === process.pid) {
      return { handled: false };
    }

    if (!this._isProcessRunning(remotePid)) {
      return { handled: false, remotePid, alreadyExited: true };
    }

    const action = options?.action || 'stop';
    const timeoutMs = options?.timeoutMs ?? 10000;
    const killTimeoutMs = options?.killTimeoutMs ?? 5000;
    const signal = options?.signal || 'SIGTERM';

    this._log(`[Orchestrator] Sending ${signal} to daemon PID ${remotePid} for ${cluster.id}...`);
    try {
      process.kill(remotePid, signal);
    } catch (error) {
      if (error.code === 'ESRCH') {
        return { handled: true, remotePid, exited: true };
      }
      throw error;
    }

    const exited = await this._waitForProcessExit(remotePid, timeoutMs);
    if (exited) {
      return { handled: true, remotePid, exited: true };
    }

    if (action !== 'kill') {
      throw new Error(
        `Timed out waiting for daemon PID ${remotePid} to stop cluster ${cluster.id}`
      );
    }

    this._log(
      `[Orchestrator] Daemon PID ${remotePid} still running after ${timeoutMs}ms, sending SIGKILL...`
    );
    try {
      process.kill(remotePid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }

    const killed = await this._waitForProcessExit(remotePid, killTimeoutMs);
    if (!killed) {
      throw new Error(
        `Failed to kill daemon PID ${remotePid} for cluster ${cluster.id} after SIGKILL`
      );
    }

    return { handled: true, remotePid, exited: true, forced: true };
  }

  async _signalSetupProcess(clusterId, cluster) {
    const setupPid = cluster.pid;
    if (!setupPid || setupPid === process.pid || !this._isProcessRunning(setupPid)) {
      return { handled: false };
    }

    const signalTarget = process.platform === 'win32' ? setupPid : -setupPid;
    this._log(`[Orchestrator] Killing setup daemon PID ${setupPid} for ${clusterId}...`);

    this._sendSetupSignal(signalTarget, setupPid, 'SIGTERM');
    const exited = await this._waitForProcessExit(setupPid, 5000);
    if (exited) {
      return { handled: true, remotePid: setupPid, exited: true };
    }

    this._log(`[Orchestrator] Setup daemon PID ${setupPid} still running, sending SIGKILL...`);
    this._sendSetupSignal(signalTarget, setupPid, 'SIGKILL');
    const killed = await this._waitForProcessExit(setupPid, 5000);
    if (!killed) {
      throw new Error(`Failed to kill setup daemon PID ${setupPid} for cluster ${clusterId}`);
    }

    return { handled: true, remotePid: setupPid, exited: true, forced: true };
  }

  _sendSetupSignal(signalTarget, fallbackPid, signal) {
    try {
      process.kill(signalTarget, signal);
      return;
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }

    if (signalTarget === fallbackPid) {
      return;
    }

    try {
      process.kill(fallbackPid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }
  }

  async _killSetupCluster(clusterId, cluster) {
    await this._signalSetupProcess(clusterId, cluster);

    if (cluster.worktree?.path) {
      this._teardownWorktreeCompose(cluster.worktree.path);
      try {
        const manager = cluster.worktree.manager || new IsolationManager();
        manager.worktrees.set(clusterId, {
          path: cluster.worktree.path,
          branch: cluster.worktree.branch,
          repoRoot: cluster.worktree.repoRoot,
        });
        manager.cleanupWorktreeIsolation(clusterId, { preserveBranch: true });
      } catch (error) {
        this._log(`[Orchestrator] Warning: setup worktree cleanup failed: ${error.message}`);
      }
    }

    cluster.state = 'killed';
    cluster.pid = null;
    await this._saveClusters();
    this.clusters.delete(clusterId);
    this._log(`Setup cluster ${clusterId} killed`);
  }

  /**
   * Stop a cluster
   * @param {String} clusterId - Cluster ID
   * @param {Object} [options] - Stop options
   * @param {boolean} [options.completedSuccessfully=false] - Whether cluster completed successfully (vs user-initiated stop)
   */
  async stop(clusterId, options = {}) {
    const cluster = this.clusters.get(clusterId);
    if (!cluster) {
      throw new Error(`Cluster ${clusterId} not found`);
    }

    await this._signalRemoteCluster(cluster, { action: 'stop' });

    // CRITICAL: Wait for initialization to complete before stopping
    // This ensures ISSUE_OPENED is published, preventing 0-message clusters
    // Timeout after 30s to prevent infinite hang if init truly fails
    if (cluster.initCompletePromise && cluster.state === 'initializing') {
      this._log(`[Orchestrator] Waiting for initialization to complete before stopping...`);
      await Promise.race([
        cluster.initCompletePromise,
        new Promise((resolve) => setTimeout(resolve, 30000)),
      ]);
    }

    cluster.state = 'stopping';

    // Stop all agents (including subclusters which handle their own children)
    for (const agent of cluster.agents) {
      await agent.stop();
    }

    if (cluster.snapshotter) {
      cluster.snapshotter.stop();
    }

    // Clean up isolation container if enabled
    // CRITICAL: Preserve workspace for resume capability - only delete on kill()
    if (cluster.isolation?.manager) {
      this._log(
        `[Orchestrator] Stopping isolation container for ${clusterId} (preserving workspace for resume)...`
      );
      await cluster.isolation.manager.cleanup(clusterId, { preserveWorkspace: true });
      this._log(`[Orchestrator] Container stopped, workspace preserved`);
    }

    if (cluster.validatorIsolation?.manager) {
      this._log(`[Orchestrator] Cleaning up validator isolation container for ${clusterId}...`);
      await cluster.validatorIsolation.manager.cleanup(cluster.validatorIsolation.clusterId, {
        preserveWorkspace: false,
      });
      cluster.validatorIsolation = null;
    }

    // Worktree cleanup: auto-remove if completed successfully with --pr/--ship
    // (no reason to resume after PR is created/merged), otherwise preserve for resume
    const shouldAutoCleanWorktree =
      options.completedSuccessfully && cluster.autoPr && cluster.worktree?.manager;

    if (shouldAutoCleanWorktree) {
      this._log(`[Orchestrator] Auto-cleaning worktree (completed successfully with --pr/--ship)`);
      // Tear down Docker Compose first, then remove worktree entirely
      if (cluster.worktree.path) {
        this._teardownWorktreeCompose(cluster.worktree.path);
      }
      try {
        cluster.worktree.manager.cleanupWorktreeIsolation(clusterId, { preserveBranch: true });
        this._log(`[Orchestrator] Worktree removed, branch ${cluster.worktree.branch} preserved`);
      } catch (err) {
        // Best-effort cleanup — don't fail the stop operation
        this._log(`[Orchestrator] Warning: worktree cleanup failed: ${err.message}`);
      }
    } else if (cluster.worktree?.manager) {
      this._log(`[Orchestrator] Worktree preserved at ${cluster.worktree.path} for resume`);
      this._log(`[Orchestrator] Branch: ${cluster.worktree.branch}`);
      // Hook daemons run detached inside the worktree and survive agent shutdown
      // unless we explicitly reap worktree-scoped processes on stop.
      if (cluster.worktree.path) {
        cluster.worktree.manager.cleanupWorktreeProcesses(cluster.worktree.path);
      }
      // Tear down Docker Compose services in the worktree to free host ports.
      // Without this, stopped worktrees hold ports (5433, 6379, etc.) indefinitely.
      if (cluster.worktree.path) {
        this._teardownWorktreeCompose(cluster.worktree.path);
      }
      // Don't cleanup worktree itself - it will be reused on resume
    }

    cluster.state = shouldAutoCleanWorktree ? 'killed' : 'stopped';
    cluster.pid = null; // Clear PID - cluster is no longer running

    if (shouldAutoCleanWorktree) {
      // Close message bus and ledger (same as kill() path)
      cluster.messageBus.close();
    }

    this._log(`Cluster ${clusterId} ${cluster.state}`);

    // Save updated state
    // Note: 'killed' state causes _saveClusters to DELETE from disk (no stale entries)
    await this._saveClusters();

    if (shouldAutoCleanWorktree) {
      // Remove from memory after persisting (same as kill() path)
      this.clusters.delete(clusterId);
    }
  }

  /**
   * Kill a cluster (force stop)
   * @param {String} clusterId - Cluster ID
   */
  async kill(clusterId) {
    const cluster = this.clusters.get(clusterId);
    if (!cluster) {
      throw new Error(`Cluster ${clusterId} not found`);
    }

    if (this._isSetupCluster(cluster)) {
      await this._killSetupCluster(clusterId, cluster);
      return;
    }

    await this._signalRemoteCluster(cluster, { action: 'kill' });

    cluster.state = 'stopping';

    // Force stop all agents
    for (const agent of cluster.agents) {
      await agent.stop();
    }

    if (cluster.snapshotter) {
      cluster.snapshotter.stop();
    }

    // Force remove isolation container AND workspace (full cleanup, no resume)
    if (cluster.isolation?.manager) {
      this._log(
        `[Orchestrator] Force removing isolation container and workspace for ${clusterId}...`
      );
      await cluster.isolation.manager.cleanup(clusterId, { preserveWorkspace: false });
      this._log(`[Orchestrator] Container and workspace removed`);
    }

    if (cluster.validatorIsolation?.manager) {
      this._log(`[Orchestrator] Force removing validator isolation container for ${clusterId}...`);
      await cluster.validatorIsolation.manager.cleanup(cluster.validatorIsolation.clusterId, {
        preserveWorkspace: false,
      });
      cluster.validatorIsolation = null;
    }

    // Force remove worktree (full cleanup, no resume)
    // Note: Branch is preserved for potential PR creation / inspection
    if (cluster.worktree?.manager) {
      this._log(`[Orchestrator] Force removing worktree for ${clusterId}...`);
      cluster.worktree.manager.cleanupWorktreeIsolation(clusterId, { preserveBranch: true });
      this._log(`[Orchestrator] Worktree removed, branch ${cluster.worktree.branch} preserved`);
    }

    // Close message bus and ledger
    cluster.messageBus.close();

    cluster.state = 'killed';
    cluster.pid = null; // Clear PID - cluster is no longer running
    // DON'T delete from memory - keep it so it gets saved with 'killed' state
    // this.clusters.delete(clusterId);

    this._log(`Cluster ${clusterId} killed`);

    // Save updated state (will be marked as 'killed' in file)
    await this._saveClusters();

    // Now remove from memory after persisting
    this.clusters.delete(clusterId);
  }

  /**
   * Kill all running clusters
   * @returns {Object} { killed: Array<string>, errors: Array<{id, error}> }
   */
  async killAll() {
    const results = { killed: [], errors: [] };
    const runningClusters = Array.from(this.clusters.values()).filter(
      (c) => c.state === 'running' || c.state === 'initializing' || this._isSetupCluster(c)
    );

    for (const cluster of runningClusters) {
      try {
        await this.kill(cluster.id);
        results.killed.push(cluster.id);
      } catch (error) {
        results.errors.push({ id: cluster.id, error: error.message });
      }
    }

    return results;
  }

  /**
   * Close the orchestrator (prevents further _saveClusters operations)
   * Call before deleting storageDir to prevent ENOENT race conditions during cleanup
   */
  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const cluster of this.clusters.values()) {
      if (typeof cluster.snapshotter?.stop === 'function') {
        cluster.snapshotter.stop();
      }
      if (typeof cluster.messageBus?.close === 'function') {
        cluster.messageBus.close();
      }
    }
  }

  /**
   * Find the last workflow-triggering message in the ledger
   * Workflow triggers indicate cluster state progression (not AGENT_OUTPUT noise)
   * @param {Array} messages - All messages from ledger
   * @returns {Object|null} - Last workflow trigger message or null
   * @private
   */
  _findLastWorkflowTrigger(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (WORKFLOW_TRIGGERS.includes(messages[i].topic)) {
        return messages[i];
      }
    }
    return null;
  }

  /**
   * Resume a stopped cluster from where it left off
   * Handles both failed clusters (with error context) and cleanly stopped clusters
   * @param {String} clusterId - Cluster ID
   * @param {String} prompt - Optional custom resume prompt
   * @returns {Object} Resumed cluster info
   */
  async resume(clusterId, prompt) {
    const cluster = this.clusters.get(clusterId);
    if (!cluster) {
      throw new Error(`Cluster not found: ${clusterId}`);
    }

    if (cluster.state === 'running') {
      if (this._isProcessRunning(cluster.pid)) {
        throw new Error(
          `Cluster ${clusterId} is still running. Use 'zeroshot stop' first if you want to restart it.`
        );
      }
      // state says running but the recorded PID is dead: this is the same
      // zombie condition getStatus()/listClusters() already detect. Recover
      // it here instead of forcing a manual `stop` for a process that no
      // longer exists.
      this._log(
        `[Orchestrator] Cluster ${clusterId} was marked running with dead PID ${cluster.pid}; recovering as a zombie instead of rejecting resume.`
      );
    }

    if (this._isSetupCluster(cluster)) {
      const setupError = cluster.failureInfo?.error
        ? ` Previous setup error: ${cluster.failureInfo.error}.`
        : '';
      const logHint = cluster.setupLogPath ? ` Check setup log: ${cluster.setupLogPath}.` : '';
      throw new Error(
        `Cluster ${clusterId} never finished setup and cannot be resumed.` +
          setupError +
          ` Use 'zeroshot run' to start a fresh cluster.` +
          logHint
      );
    }

    const failureInfo = this._resolveFailureInfo(cluster, clusterId);
    const recentMessages = this._loadRecentMessages(cluster, clusterId, 50);
    const cleanResumePlan = failureInfo ? null : this._buildCleanResumePlan(clusterId, cluster);

    if (cleanResumePlan?.kind === 'failure') {
      return this._failResumeReconstruction(clusterId, cluster, cleanResumePlan);
    }

    if (failureInfo) {
      this._requireFailedAgent(clusterId, cluster, failureInfo);
    }

    await this._ensureIsolationForResume(clusterId, cluster);
    this._ensureWorktreeForResume(clusterId, cluster);
    this._startSnapshotter(cluster);
    this._clearTransientAgentState(cluster);
    await this._restartClusterAgents(cluster);

    if (failureInfo) {
      return this._resumeFailedCluster(clusterId, cluster, failureInfo, recentMessages, prompt);
    }

    return this._resumeCleanCluster(clusterId, cluster, recentMessages, prompt, cleanResumePlan);
  }

  _validateGuidanceAgentArgs(clusterId, agentId, text) {
    if (!clusterId) {
      throw new Error('sendGuidanceToAgent: clusterId is required');
    }
    if (!agentId) {
      throw new Error('sendGuidanceToAgent: agentId is required');
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('sendGuidanceToAgent: text must be a non-empty string');
    }
  }

  _validateGuidanceClusterArgs(clusterId, text) {
    if (!clusterId) {
      throw new Error('sendGuidanceToCluster: clusterId is required');
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('sendGuidanceToCluster: text must be a non-empty string');
    }
  }

  _getClusterOrThrow(clusterId, caller = 'sendGuidanceToAgent') {
    const cluster = this.clusters.get(clusterId);
    if (!cluster) {
      throw new Error(`${caller}: cluster not found: ${clusterId}`);
    }
    return cluster;
  }

  _getAgentOrThrow(cluster, agentId) {
    const agent = cluster.agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      throw new Error(`sendGuidanceToAgent: agent not found: ${agentId}`);
    }
    return agent;
  }

  _buildDefaultDelivery(agent) {
    return {
      status: 'unsupported',
      reason: 'unknown',
      method: null,
      taskId: agent.currentTaskId || null,
    };
  }

  async _attemptGuidanceInjection(agent, text, timeoutMs) {
    try {
      const result = await agent.injectInput(text, { timeoutMs });
      return {
        status: result.status === 'injected' ? 'injected' : 'unsupported',
        reason: result.status === 'injected' ? null : result.reason || 'unsupported',
        method: result.status === 'injected' ? result.method || 'pty' : result.method || null,
        taskId: result.taskId || agent.currentTaskId || null,
      };
    } catch (error) {
      return {
        status: 'unsupported',
        reason: error.message,
        method: null,
        taskId: agent.currentTaskId || null,
      };
    }
  }

  _buildGuidanceMetadata(options, delivery) {
    return {
      ...(options.metadata || {}),
      delivery: {
        status: delivery.status,
        reason: delivery.reason,
        method: delivery.method,
        taskId: delivery.taskId,
        timestamp: Date.now(),
      },
    };
  }

  _summarizeGuidanceDeliveries(deliveries) {
    const agentIds = Object.keys(deliveries);
    const summary = {
      injected: 0,
      queued: 0,
      total: agentIds.length,
    };

    for (const agentId of agentIds) {
      const delivery = deliveries[agentId];
      if (delivery?.status === 'injected') {
        summary.injected += 1;
      } else {
        summary.queued += 1;
      }
    }

    return summary;
  }

  _buildClusterGuidanceMetadata(options, deliveries) {
    return {
      ...(options.metadata || {}),
      delivery: {
        summary: this._summarizeGuidanceDeliveries(deliveries),
        agents: deliveries,
        timestamp: Date.now(),
      },
    };
  }

  _publishGuidance(cluster, clusterId, agentId, text, metadata, sender) {
    cluster.messageBus.publish({
      cluster_id: clusterId,
      topic: USER_GUIDANCE_AGENT,
      sender,
      target_agent_id: agentId,
      content: { text },
      metadata,
    });
  }

  _publishClusterGuidance(cluster, clusterId, text, metadata, sender) {
    cluster.messageBus.publish({
      cluster_id: clusterId,
      topic: USER_GUIDANCE_CLUSTER,
      sender,
      content: { text },
      metadata,
    });
  }

  /**
   * Send guidance to a specific agent with optional live injection.
   * Always persists USER_GUIDANCE_AGENT in the ledger with delivery metadata.
   * @param {string} clusterId
   * @param {string} agentId
   * @param {string} text
   * @param {object} [options]
   * @param {string} [options.sender='user']
   * @param {object} [options.metadata]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{status: string, reason: string|null, method: string|null, taskId: string|null}>}
   */
  async sendGuidanceToAgent(clusterId, agentId, text, options = {}) {
    this._validateGuidanceAgentArgs(clusterId, agentId, text);

    const cluster = this._getClusterOrThrow(clusterId, 'sendGuidanceToAgent');
    const agent = this._getAgentOrThrow(cluster, agentId);
    const defaultDelivery = this._buildDefaultDelivery(agent);
    const delivery =
      (await this._attemptGuidanceInjection(agent, text, options.timeoutMs)) || defaultDelivery;
    const metadata = this._buildGuidanceMetadata(options, delivery);

    this._publishGuidance(cluster, clusterId, agentId, text, metadata, options.sender || 'user');

    return delivery;
  }

  /**
   * Send guidance to every agent in a cluster with optional live injection.
   * Always persists a single USER_GUIDANCE_CLUSTER in the ledger with delivery metadata.
   * @param {string} clusterId
   * @param {string} text
   * @param {object} [options]
   * @param {string} [options.sender='user']
   * @param {object} [options.metadata]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{summary: {injected: number, queued: number, total: number}, agents: Record<string, {status: string, reason: string|null, method: string|null, taskId: string|null}>, timestamp: number}>}
   */
  async sendGuidanceToCluster(clusterId, text, options = {}) {
    this._validateGuidanceClusterArgs(clusterId, text);

    const cluster = this._getClusterOrThrow(clusterId, 'sendGuidanceToCluster');
    const agents = Array.isArray(cluster.agents) ? cluster.agents : [];
    const deliveries = {};

    await Promise.all(
      agents.map(async (agent) => {
        const defaultDelivery = this._buildDefaultDelivery(agent);
        const delivery =
          (await this._attemptGuidanceInjection(agent, text, options.timeoutMs)) || defaultDelivery;
        deliveries[agent.id] = delivery;
      })
    );

    const metadata = this._buildClusterGuidanceMetadata(options, deliveries);

    this._publishClusterGuidance(cluster, clusterId, text, metadata, options.sender || 'user');

    return metadata.delivery;
  }

  _resolveFailureInfo(cluster, clusterId) {
    const persistedFailure = cluster.failureInfo?.agentId ? cluster.failureInfo : null;
    if (persistedFailure) {
      if (!this._hasDurableProgressAfterFailure(cluster, clusterId, persistedFailure)) {
        return persistedFailure;
      }
      this._log(
        `[Orchestrator] Ignoring recovered registry failure from ${persistedFailure.agentId}; durable task progress followed it`
      );
    }

    const errors = cluster.messageBus.query({
      cluster_id: clusterId,
      topic: 'AGENT_ERROR',
      order: 'desc',
    });

    for (const error of errors) {
      const failureInfo = {
        agentId: error.sender,
        taskId: error.content?.data?.taskId || null,
        iteration: error.content?.data?.iteration || 0,
        error: error.content?.data?.error || error.content?.text,
        timestamp: error.timestamp,
      };
      if (this._hasDurableProgressAfterFailure(cluster, clusterId, failureInfo)) {
        this._log(
          `[Orchestrator] Ignoring recovered ledger failure from ${error.sender}; durable task progress followed it`
        );
        continue;
      }

      this._log(`[Orchestrator] Found failure from ledger: ${failureInfo.agentId}`);
      return failureInfo;
    }

    return null;
  }

  _hasDurableProgressAfterFailure(cluster, clusterId, failureInfo) {
    const failureIteration = failureInfo.iteration;
    const failureTimestamp = failureInfo.timestamp;
    return cluster.messageBus
      .query({
        cluster_id: clusterId,
        topic: 'AGENT_LIFECYCLE',
        sender: failureInfo.agentId,
        since: failureTimestamp,
      })
      .some((message) => {
        const event = message.content?.data?.event;
        if (!['TASK_STARTED', 'TASK_COMPLETED'].includes(event)) {
          return false;
        }

        const iteration = message.content?.data?.iteration;
        return (
          (Number.isFinite(failureTimestamp) && message.timestamp > failureTimestamp) ||
          (Number.isInteger(failureIteration) &&
            Number.isInteger(iteration) &&
            iteration > failureIteration)
        );
      });
  }

  _requireFailedAgent(clusterId, cluster, failureInfo) {
    const failedAgent = cluster.agents.find((agent) => agent.id === failureInfo.agentId);
    if (!failedAgent) {
      throw new Error(
        `Cannot resume cluster ${clusterId}: Failed agent '${failureInfo.agentId}' is not present in the restored configuration.`
      );
    }
  }

  _checkContainerExists(containerId) {
    const { spawn } = require('child_process');
    const checkContainer = spawn('docker', ['inspect', containerId], { stdio: 'ignore' });
    return new Promise((resolve) => {
      checkContainer.on('close', (code) => resolve(code === 0));
    });
  }

  async _ensureIsolationForResume(clusterId, cluster) {
    if (!cluster.isolation?.enabled) {
      return;
    }

    const oldContainerId = cluster.isolation.containerId;
    const containerExists = await this._checkContainerExists(oldContainerId);
    if (containerExists) {
      this._log(`[Orchestrator] Container ${oldContainerId} still exists, reusing`);
      return;
    }

    this._log(`[Orchestrator] Container ${oldContainerId} not found, recreating...`);

    const workDir = cluster.isolation.workDir;
    if (!workDir) {
      throw new Error(`Cannot resume cluster ${clusterId}: workDir not saved in isolation state`);
    }

    const isolatedPath = path.join(os.tmpdir(), 'zeroshot-isolated', clusterId);
    if (!fs.existsSync(isolatedPath)) {
      throw new Error(
        `Cannot resume cluster ${clusterId}: isolated workspace deleted. ` +
          `Was the cluster killed (not stopped)? Use 'zeroshot run' to start fresh.`
      );
    }

    const providerName = this._resolveClusterProvider(cluster.config);
    const newContainerId = await cluster.isolation.manager.createContainer(clusterId, {
      workDir,
      image: cluster.isolation.image,
      reuseExistingWorkspace: true,
      provider: providerName,
    });

    this._log(`[Orchestrator] New container created: ${newContainerId}`);
    cluster.isolation.containerId = newContainerId;

    for (const agent of cluster.agents) {
      if (agent.isolation?.enabled) {
        agent.isolation.containerId = newContainerId;
        agent.isolation.manager = cluster.isolation.manager;
      }
    }

    this._log(`[Orchestrator] All agents updated with new container ID`);
  }

  _ensureWorktreeForResume(clusterId, cluster) {
    if (!cluster.worktree?.enabled) {
      return;
    }

    const worktreePath = cluster.worktree.path;
    if (!fs.existsSync(worktreePath)) {
      throw new Error(
        `Cannot resume cluster ${clusterId}: worktree at ${worktreePath} no longer exists. ` +
          `Was the worktree manually removed? Use 'zeroshot run' to start fresh.`
      );
    }

    this._log(`[Orchestrator] Worktree at ${worktreePath} exists, reusing`);
    this._log(`[Orchestrator] Branch: ${cluster.worktree.branch}`);
  }

  async _restartClusterAgents(cluster) {
    cluster.state = 'running';
    cluster.pid = process.pid;
    for (const agent of cluster.agents) {
      if (!agent.running) {
        await agent.start();
      }
    }
  }

  _loadRecentMessages(cluster, clusterId, limit) {
    return cluster.messageBus
      .query({
        cluster_id: clusterId,
        limit,
        order: 'desc',
      })
      .reverse();
  }

  _findLastDurableWorkflowTrigger(cluster, clusterId) {
    let latest = null;

    for (const topic of WORKFLOW_TRIGGERS) {
      const candidate = cluster.messageBus.findLast({
        cluster_id: clusterId,
        topic,
      });
      if (candidate && (!latest || candidate.timestamp > latest.timestamp)) {
        latest = candidate;
      }
    }

    return latest;
  }

  _buildResumeContext(recentMessages, prompt, options) {
    const resumePrompt = prompt || 'Continue from where you left off. Complete the task.';
    let context = `${options.header}\n\n`;

    if (options.error) {
      context += `Previous error: ${options.error}\n\n`;
    }

    if (options.durableMessages?.length > 0) {
      context += `## Durable Workflow Context\n\n`;
      for (const msg of options.durableMessages) {
        context += `[${msg.topic}] [${msg.sender}]\n${msg.content?.text || ''}\n\n`;
      }
    }

    context += `## Recent Context\n\n`;
    for (const msg of recentMessages.slice(-10)) {
      if (options.topics.includes(msg.topic)) {
        context += `[${msg.sender}] ${msg.content?.text?.slice(0, 200) || ''}\n`;
      }
    }

    context += `\n## Resume Instructions\n\n${resumePrompt}\n`;
    return context;
  }

  _triggerMatchesTopic(triggerTopic, topic) {
    if (triggerTopic === topic) return true;
    if (triggerTopic === '*') return true;
    if (triggerTopic.endsWith('*')) {
      const prefix = triggerTopic.slice(0, -1);
      return topic.startsWith(prefix);
    }
    return false;
  }

  _selectAgentsToResume(cluster, lastTrigger) {
    const matching = [];
    const eligible = [];

    for (const agent of cluster.agents) {
      if (!agent.config.triggers) continue;

      const matchingTrigger = agent.config.triggers.find((trigger) =>
        this._triggerMatchesTopic(trigger.topic, lastTrigger.topic)
      );
      if (!matchingTrigger) continue;

      const candidate = { agent, message: lastTrigger, trigger: matchingTrigger };
      matching.push(candidate);

      if (matchingTrigger.logic?.script) {
        const shouldTrigger = agent._evaluateTrigger(matchingTrigger, lastTrigger);
        if (!shouldTrigger) continue;
      }

      eligible.push(candidate);
    }

    return { matching, eligible };
  }

  _findDurableTriggerBefore(cluster, clusterId, topic, timestamp) {
    if (!topic || topic === 'AGENT_RESUME') {
      return null;
    }

    return cluster.messageBus.findLast({
      cluster_id: clusterId,
      topic,
      until: timestamp - 1,
    });
  }

  _collectDurableResumeContext(cluster, clusterId, messages = []) {
    const durableMessages = [
      cluster.messageBus.findLast({ cluster_id: clusterId, topic: 'ISSUE_OPENED' }),
      cluster.messageBus.findLast({ cluster_id: clusterId, topic: 'PLAN_READY' }),
      cluster.messageBus.findLast({ cluster_id: clusterId, topic: 'IMPLEMENTATION_READY' }),
      ...messages,
    ].filter(Boolean);
    const uniqueById = new Map(durableMessages.map((message) => [message.id, message]));
    return [...uniqueById.values()].sort((left, right) => left.timestamp - right.timestamp);
  }

  _findInterruptedResumeTargets(clusterId, cluster) {
    const targets = [];
    const invalid = [];
    const issueMessage = cluster.messageBus.findLast({
      cluster_id: clusterId,
      topic: 'ISSUE_OPENED',
    });

    for (const agent of cluster.agents) {
      if (agent.state !== 'executing_task') {
        continue;
      }

      const lifecycle = cluster.messageBus.query({
        cluster_id: clusterId,
        topic: 'AGENT_LIFECYCLE',
        sender: agent.id,
      });
      const startedIndex = lifecycle.findLastIndex(
        (message) => message.content?.data?.event === 'TASK_STARTED'
      );
      const lastStarted = startedIndex >= 0 ? lifecycle[startedIndex] : null;
      const lifecycleAfterStart = startedIndex >= 0 ? lifecycle.slice(startedIndex + 1) : [];
      const completedAfterStart = lifecycleAfterStart.some(
        (message) => message.content?.data?.event === 'TASK_COMPLETED'
      );
      const lastTaskIdAssigned = [...lifecycleAfterStart]
        .reverse()
        .find((message) => message.content?.data?.event === 'TASK_ID_ASSIGNED');
      const assignedTaskId = lastTaskIdAssigned?.content?.data?.taskId || null;
      const startedIteration = lastStarted?.content?.data?.iteration;
      const triggeredBy = lastStarted?.content?.data?.triggeredBy;
      const triggeringMessage = lastStarted
        ? this._findDurableTriggerBefore(cluster, clusterId, triggeredBy, lastStarted.timestamp)
        : null;

      if (
        !agent.currentTaskId ||
        !lastStarted ||
        completedAfterStart ||
        startedIteration !== agent.iteration ||
        !assignedTaskId ||
        assignedTaskId !== agent.currentTaskId ||
        !issueMessage
      ) {
        invalid.push({
          agentId: agent.id,
          reason: !issueMessage ? 'missing_durable_context' : 'ambiguous_task_identity',
          state: agent.state,
          iteration: agent.iteration,
          currentTaskId: agent.currentTaskId || null,
          assignedTaskId,
          lastStartedIteration: startedIteration ?? null,
          completedAfterStart: Boolean(completedAfterStart),
        });
        continue;
      }

      targets.push({
        agent,
        message: triggeringMessage || issueMessage,
        lifecycleMessage: lastStarted,
        issueMessage,
        trigger: null,
        reason: 'interrupted_task',
      });
    }

    const interruptedRoles = new Set(targets.map(({ agent }) => agent.role));
    if (interruptedRoles.size > 1) {
      invalid.push({
        reason: 'multiple_interrupted_phases',
        agents: targets.map(({ agent }) => agent.id),
      });
    }

    return { targets, invalid };
  }

  _findPartialValidationTargets(clusterId, cluster, lastTrigger) {
    if (
      !lastTrigger ||
      !['IMPLEMENTATION_READY', 'VALIDATION_RESULT'].includes(lastTrigger.topic)
    ) {
      return null;
    }

    const implementationReady = cluster.messageBus.findLast({
      cluster_id: clusterId,
      topic: 'IMPLEMENTATION_READY',
      until: lastTrigger.timestamp,
    });
    if (!implementationReady) {
      return null;
    }

    const validators = cluster.agents.filter((agent) => agent.role === 'validator');
    if (validators.length === 0) {
      return null;
    }

    const validatorIds = new Set(validators.map((agent) => agent.id));
    const validationResults = cluster.messageBus
      .query({
        cluster_id: clusterId,
        topic: 'VALIDATION_RESULT',
        since: implementationReady.timestamp,
      })
      .filter(
        (message) =>
          message.timestamp > implementationReady.timestamp && validatorIds.has(message.sender)
      );
    const responded = new Set(validationResults.map((message) => message.sender));
    const missing = validators.filter((agent) => !responded.has(agent.id));
    if (missing.length === 0) {
      return { kind: 'complete', validationResults, implementationReady };
    }

    const missingIds = new Set(missing.map((agent) => agent.id));
    const selection = this._selectAgentsToResume(cluster, implementationReady);
    const matching = selection.matching.filter(({ agent }) => missingIds.has(agent.id));
    const eligible = selection.eligible.filter(({ agent }) => missingIds.has(agent.id));

    if (eligible.length !== missing.length) {
      return {
        kind: 'failure',
        missingAgentIds: missing.map((agent) => agent.id),
        matchingAgentIds: matching.map(({ agent }) => agent.id),
        implementationReady,
        validationResults,
      };
    }

    return {
      kind: 'agents',
      agentsToResume: eligible.map((target) => ({
        ...target,
        reason: 'missing_validation_result',
      })),
      implementationReady,
      validationResults,
    };
  }

  _buildCleanResumePlan(clusterId, cluster) {
    const interrupted = this._findInterruptedResumeTargets(clusterId, cluster);
    if (interrupted.invalid.length > 0) {
      const missingContext = interrupted.invalid.some(
        (entry) => entry.reason === 'missing_durable_context'
      );
      return {
        kind: 'failure',
        error: missingContext
          ? `Cannot resume cluster ${clusterId}: interrupted work has no durable workflow context. ` +
            `No agents were started and the preserved cluster remains stopped. ` +
            `Inspect it with 'zeroshot export ${clusterId}' before repairing its persisted state; do not launch a duplicate run.`
          : `Cannot resume cluster ${clusterId}: persisted interrupted-task state is ambiguous. ` +
            `No agents were started; inspect failureInfo for reconstruction details.`,
        details: {
          reason: missingContext ? 'missing_workflow_history' : 'ambiguous_interrupted_task',
          interrupted: interrupted.invalid,
        },
      };
    }

    const lastTrigger = this._findLastDurableWorkflowTrigger(cluster, clusterId);
    const partialValidation = this._findPartialValidationTargets(clusterId, cluster, lastTrigger);
    if (partialValidation?.kind === 'failure') {
      return {
        kind: 'failure',
        error:
          `Cannot resume cluster ${clusterId}: validators ${partialValidation.missingAgentIds.join(
            ', '
          )} are missing results, but not every missing validator has an eligible IMPLEMENTATION_READY handler. ` +
          `No agents were started.`,
        details: {
          reason: 'partial_validation_handlers_ineligible',
          missingAgentIds: partialValidation.missingAgentIds,
          matchingAgentIds: partialValidation.matchingAgentIds,
        },
      };
    }

    if (interrupted.targets.length > 0) {
      const interruptedValidators = interrupted.targets.filter(
        ({ agent }) => agent.role === 'validator'
      );
      if (interruptedValidators.length > 0 && partialValidation?.kind !== 'agents') {
        return {
          kind: 'failure',
          error:
            `Cannot resume cluster ${clusterId}: interrupted validator state does not match an active validation cycle. ` +
            `No agents were started.`,
          details: {
            reason: 'ambiguous_validation_cycle',
            interruptedAgentIds: interruptedValidators.map(({ agent }) => agent.id),
          },
        };
      }

      const targets =
        interruptedValidators.length > 0 ? partialValidation.agentsToResume : interrupted.targets;
      return {
        kind: 'agents',
        reason: interruptedValidators.length > 0 ? 'partial_validation' : 'interrupted_tasks',
        agentsToResume: targets,
        lastTrigger,
        durableMessages: this._collectDurableResumeContext(
          cluster,
          clusterId,
          targets.map(({ message }) => message)
        ),
      };
    }

    if (partialValidation?.kind === 'agents') {
      return {
        kind: 'agents',
        reason: 'partial_validation',
        agentsToResume: partialValidation.agentsToResume,
        lastTrigger,
        durableMessages: this._collectDurableResumeContext(
          cluster,
          clusterId,
          partialValidation.validationResults
        ),
      };
    }

    if (!lastTrigger) {
      const issueMessage = cluster.messageBus.findLast({
        cluster_id: clusterId,
        topic: 'ISSUE_OPENED',
      });
      if (issueMessage) {
        return {
          kind: 'bootstrap',
          reason: 'missing_workflow_trigger',
          issueMessage,
          agentsToResume: [],
          lastTrigger: null,
          durableMessages: [issueMessage],
        };
      }

      return {
        kind: 'failure',
        error:
          `Cannot resume cluster ${clusterId}: no workflow trigger or ISSUE_OPENED message exists. ` +
          `No agents were started and the preserved cluster remains stopped. ` +
          `Inspect it with 'zeroshot export ${clusterId}' before repairing its persisted state; do not launch a duplicate run.`,
        details: { reason: 'missing_workflow_history' },
      };
    }

    const selection = this._selectAgentsToResume(cluster, lastTrigger);
    if (selection.eligible.length > 0) {
      return {
        kind: 'agents',
        reason: 'eligible_handlers',
        agentsToResume: selection.eligible,
        lastTrigger,
        durableMessages: this._collectDurableResumeContext(
          cluster,
          clusterId,
          selection.eligible.map(({ message }) => message)
        ),
      };
    }

    const matchingAgentIds = selection.matching.map(({ agent }) => agent.id);
    if (matchingAgentIds.length > 0) {
      return {
        kind: 'failure',
        error:
          `Cannot resume cluster ${clusterId}: trigger ${lastTrigger.topic} is registered by ` +
          `${matchingAgentIds.join(', ')}, but no handler is currently eligible and no interrupted task can be reconstructed. ` +
          `No agents were started.`,
        details: {
          reason: 'registered_handlers_ineligible',
          trigger: lastTrigger.topic,
          matchingAgentIds,
        },
      };
    }

    return {
      kind: 'failure',
      error:
        `Cannot resume cluster ${clusterId}: no restored agent registers trigger ${lastTrigger.topic}. ` +
        `No agents were started; check the persisted agent configuration.`,
      details: {
        reason: 'unhandled_trigger',
        trigger: lastTrigger.topic,
      },
    };
  }

  async _failResumeReconstruction(clusterId, cluster, plan) {
    cluster.state = 'stopped';
    cluster.pid = null;
    cluster.failureInfo = {
      type: 'resume_reconstruction',
      error: plan.error,
      ...plan.details,
      timestamp: Date.now(),
    };
    await this._saveClusters();

    const error = new Error(plan.error);
    error.code = 'RESUME_RECONSTRUCTION_FAILED';
    throw error;
  }

  _clearTransientAgentState(cluster) {
    for (const agent of cluster.agents) {
      agent.currentTask = null;
      agent.currentTaskId = null;
      agent.processPid = null;
      agent._currentExecution = null;
      agent.state = 'idle';
    }
  }

  _resumeAgents(agentsToResume, context) {
    for (const { agent, message } of agentsToResume) {
      this._log(`[Orchestrator] - Resuming agent ${agent.id} (triggered by ${message.topic})`);
      agent.resume(context).catch((err) => {
        console.error(`[Orchestrator] Resume failed for agent ${agent.id}:`, err.message);
      });
    }
  }

  _republishIssue(cluster, clusterId, recentMessages) {
    const issueMessage = recentMessages.find((m) => m.topic === 'ISSUE_OPENED');
    if (!issueMessage) {
      return false;
    }

    cluster.messageBus.publish({
      cluster_id: clusterId,
      topic: 'ISSUE_OPENED',
      sender: 'system',
      receiver: 'broadcast',
      content: issueMessage.content,
      metadata: { _resumed: true, _originalId: issueMessage.id },
    });

    return true;
  }

  async _resumeFailedCluster(clusterId, cluster, failureInfo, recentMessages, prompt) {
    const { agentId, iteration, error } = failureInfo;
    this._log(
      `[Orchestrator] Resuming failed cluster ${clusterId} from agent ${agentId} iteration ${iteration}`
    );
    this._log(`[Orchestrator] Previous error: ${error}`);

    const failedAgent = cluster.agents.find((agent) => agent.id === agentId);
    if (!failedAgent) {
      throw new Error(`Failed agent '${agentId}' not found in cluster`);
    }

    const context = this._buildResumeContext(recentMessages, prompt, {
      header: 'You are resuming from a previous failed attempt.',
      error,
      topics: ['AGENT_OUTPUT', 'VALIDATION_RESULT'],
    });

    cluster.failureInfo = null;
    await this._saveClusters();

    failedAgent.resume(context).catch((err) => {
      console.error(`[Orchestrator] Resume failed for agent ${agentId}:`, err.message);
    });

    this._log(`[Orchestrator] Cluster ${clusterId} resumed from failure`);

    return {
      id: clusterId,
      state: cluster.state,
      resumeType: 'failure',
      resumedAgent: agentId,
      previousError: error,
    };
  }

  async _resumeCleanCluster(clusterId, cluster, recentMessages, prompt, plan) {
    this._log(`[Orchestrator] Resuming stopped cluster ${clusterId} (no failure)`);

    const context = this._buildResumeContext(recentMessages, prompt, {
      header: 'Resuming cluster from previous session.',
      topics: ['AGENT_OUTPUT', 'VALIDATION_RESULT', 'ISSUE_OPENED'],
      durableMessages: plan.durableMessages,
    });

    const lastTrigger = plan.lastTrigger;
    if (lastTrigger) {
      this._log(
        `[Orchestrator] Last workflow trigger: ${lastTrigger.topic} (${new Date(lastTrigger.timestamp).toISOString()})`
      );
    } else {
      this._log(`[Orchestrator] No workflow triggers found in ledger`);
    }

    const agentsToResume = plan.agentsToResume;
    if (plan.kind === 'bootstrap') {
      this._log(`[Orchestrator] Publishing ISSUE_OPENED to bootstrap workflow...`);
      this._republishIssue(cluster, clusterId, [plan.issueMessage]);
    } else {
      this._log(`[Orchestrator] Resuming ${agentsToResume.length} agent(s) based on ledger state`);
      this._resumeAgents(agentsToResume, context);
    }

    cluster.failureInfo = null;
    await this._saveClusters();
    this._log(`[Orchestrator] Cluster ${clusterId} resumed`);

    return {
      id: clusterId,
      state: cluster.state,
      resumeType: 'clean',
      resumedAgents: agentsToResume.map((a) => a.agent.id),
    };
  }

  /**
   * Force restart a stale agent with imperative prompt injection
   * @param {string} clusterId - Cluster ID
   * @param {string} agentId - Agent to restart
   * @param {number} staleDuration - How long agent was stale (ms)
   * @private
   */
  async _forceRestartAgent(clusterId, agentId, staleDuration) {
    const cluster = this.clusters.get(clusterId);
    if (!cluster) {
      throw new Error(`Cluster ${clusterId} not found`);
    }

    const agent = cluster.agents.find((a) => a.id === agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found in cluster ${clusterId}`);
    }

    // Kill current task
    try {
      agent._killTask();
    } catch (err) {
      this._log(`⚠️  Failed to kill agent ${agentId} task:`, err.message);
    }

    // Build imperative restart context
    const staleMinutes = Math.round(staleDuration / 60000);
    const imperativePrompt = `
🔴 CRITICAL: Your previous session STOPPED PRODUCING OUTPUT for ${staleMinutes} minutes and was detected as STUCK.

## What Happened
- Last output timestamp: ${new Date(Date.now() - staleDuration).toISOString()}
- Detected as stale after ${staleMinutes} minutes of silence
- Process was forcefully restarted

## Your Instructions
You MUST complete your current task. DO NOT STOP until you either:
1. Successfully complete the task and publish your completion message, OR
2. Explicitly state WHY you cannot complete the task (missing files, impossible requirements, etc.)

If you discovered that files you need to modify don't exist:
- CREATE them from scratch with the expected implementation
- DO NOT silently give up
- DO NOT stop working without explicit explanation

If you are stuck in an impossible situation:
- EXPLAIN the problem clearly
- PROPOSE alternative solutions
- WAIT for guidance - do not exit

## Resume Your Work
Continue from where you left off. Review your previous output to understand what you were working on.
`.trim();

    // Get recent context from ledger
    const recentMessages = cluster.messageBus
      .query({
        cluster_id: cluster.id,
        limit: 10,
        order: 'desc',
      })
      .reverse();

    const contextText = recentMessages
      .map((m) => `[${m.sender}] ${m.content?.text || JSON.stringify(m.content)}`)
      .join('\n\n');

    const fullContext = `${imperativePrompt}\n\n## Recent Context\n${contextText}`;

    // Resume agent with imperative prompt
    this._log(
      `🔄 Restarting agent ${agentId} with imperative prompt (${imperativePrompt.length} chars)`
    );

    try {
      await agent.resume(fullContext);
      this._log(`✅ Agent ${agentId} successfully restarted`);
    } catch (err) {
      this._log(`❌ Failed to resume agent ${agentId}:`, err.message);
      throw err;
    }
  }

  /**
   * Handle operation chain from CLUSTER_OPERATIONS message
   * Executes operations sequentially: add_agents, remove_agents, update_agent, publish
   *
   * Validation strategy:
   * 1. Pre-validate all agent configs before executing any operations
   * 2. Build a mock cluster config with proposed changes
   * 3. Run config-validator on the mock to catch structural issues
   * 4. Only execute operations if validation passes
   *
   * @param {string} clusterId - Cluster ID
   * @param {Array} operations - Array of operation objects
   * @param {string} sender - Who sent the operations (for attribution)
   * @param {Object} context - Isolation context { isolationManager, containerId }
   * @private
   */
  async _handleOperations(clusterId, operations, sender, context = {}) {
    const cluster = this.clusters.get(clusterId);
    if (!cluster) {
      throw new Error(`Cluster ${clusterId} not found`);
    }

    this._log(`[Orchestrator] Validating ${operations.length} operation(s) from ${sender}`);

    // Phase 1: Pre-validate operation structure
    const validationErrors = this._validateOperationChain(operations);

    if (validationErrors.length > 0) {
      const errorMsg = `Operation chain validation failed:\n  - ${validationErrors.join('\n  - ')}`;
      this._log(`[Orchestrator] ❌ ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // Phase 2: Build mock cluster config with proposed agents
    // Collect all agents that would exist after operations complete
    const existingAgentConfigs = cluster.config.agents || [];
    const proposedAgentConfigs = this._buildProposedAgentConfigs(existingAgentConfigs, operations);

    // Phase 3: Validate proposed cluster config
    const validation = this._validateProposedConfig(
      clusterId,
      cluster,
      proposedAgentConfigs,
      operations
    );

    // Log warnings but proceed
    if (validation.warnings.length > 0) {
      this._log(`[Orchestrator] ⚠️ Warnings (proceeding anyway):`);
      for (const warning of validation.warnings) {
        this._log(`    - ${warning}`);
      }
    }

    // Phase 4: Execute validated operations
    this._log(`[Orchestrator] ✓ Validation passed, executing ${operations.length} operation(s)`);

    await this._executeOperations(cluster, operations, sender, context);

    this._log(`[Orchestrator] All ${operations.length} operation(s) executed successfully`);

    // Publish success notification
    cluster.messageBus.publish({
      cluster_id: clusterId,
      topic: 'CLUSTER_OPERATIONS_SUCCESS',
      sender: 'orchestrator',
      content: {
        text: `Executed ${operations.length} operation(s)`,
        data: {
          operationCount: operations.length,
          agentCount: cluster.agents.length,
        },
      },
    });

    // Save updated cluster state to disk
    await this._saveClusters();
  }

  _validateOperationChain(operations) {
    const validationErrors = [];

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (!op.action) {
        validationErrors.push(`Operation ${i}: missing 'action' field`);
        continue;
      }
      if (!VALID_OPERATIONS.includes(op.action)) {
        validationErrors.push(
          `Operation ${i}: unknown action '${op.action}'. Valid: ${VALID_OPERATIONS.join(', ')}`
        );
      }
    }

    return validationErrors;
  }

  _buildProposedAgentConfigs(existingAgentConfigs, operations) {
    const proposedAgentConfigs = [...existingAgentConfigs];

    for (const op of operations) {
      if (op.action === 'add_agents' && op.agents) {
        for (const agentConfig of op.agents) {
          const existingIdx = proposedAgentConfigs.findIndex((a) => a.id === agentConfig.id);
          if (existingIdx === -1) {
            proposedAgentConfigs.push(agentConfig);
          }
        }
      } else if (op.action === 'load_config' && op.config) {
        const loadedAgentConfigs = this._resolveLoadConfigAgents(op.config);
        for (const agentConfig of loadedAgentConfigs) {
          const existingIdx = proposedAgentConfigs.findIndex((a) => a.id === agentConfig.id);
          if (existingIdx === -1) {
            proposedAgentConfigs.push(agentConfig);
          }
        }
      } else if (op.action === 'remove_agents' && op.agentIds) {
        for (const agentId of op.agentIds) {
          const idx = proposedAgentConfigs.findIndex((a) => a.id === agentId);
          if (idx !== -1) {
            proposedAgentConfigs.splice(idx, 1);
          }
        }
      } else if (op.action === 'update_agent' && op.agentId && op.updates) {
        const agentConfig = proposedAgentConfigs.find((a) => a.id === op.agentId);
        if (agentConfig) {
          Object.assign(agentConfig, op.updates);
        }
      }
    }

    return proposedAgentConfigs;
  }

  _resolveLoadConfigAgents(config) {
    if (!config) {
      throw new Error('load_config operation missing config');
    }

    const templatesDir = path.join(__dirname, '..', 'cluster-templates');
    let loadedConfig;

    // Parameterized template - resolve with TemplateResolver
    if (typeof config === 'object' && config.base) {
      const { base, params } = config;
      const resolver = new TemplateResolver(templatesDir);
      loadedConfig = resolver.resolve(base, params || {});
    } else if (typeof config === 'string') {
      // Static config - load directly from file
      const configPath = path.join(templatesDir, `${config}.json`);
      if (!fs.existsSync(configPath)) {
        throw new Error(`Config not found: ${config} (looked in ${configPath})`);
      }
      const configContent = fs.readFileSync(configPath, 'utf8');
      loadedConfig = JSON.parse(configContent);
    } else {
      throw new Error(
        `Invalid config format: expected string or {base, params}, got ${typeof config}`
      );
    }

    if (!loadedConfig.agents || !Array.isArray(loadedConfig.agents)) {
      throw new Error(`Config has no agents array`);
    }

    return loadedConfig.agents;
  }

  _hasCompletionHandler(agentConfigs) {
    return (agentConfigs || []).some(
      (agent) =>
        agent.id === 'completion-detector' ||
        agent.id === 'git-pusher' ||
        agent.hooks?.onComplete?.config?.topic === 'CLUSTER_COMPLETE' ||
        agent.triggers?.some((trigger) => trigger.action === 'stop_cluster')
    );
  }

  _clusterHasAgent(cluster, agentId) {
    return Boolean(
      cluster?.agents?.some((agent) => agent.id === agentId || agent.config?.id === agentId) ||
      cluster?.config?.agents?.some((agent) => agent.id === agentId)
    );
  }

  _normalizeCompletionHandlersForPrMode(cluster, agentConfigs) {
    if (!Array.isArray(agentConfigs) || agentConfigs.length === 0) {
      return [];
    }

    const isPrMode = cluster?.autoPr ?? process.env.ZEROSHOT_PR === '1';
    const hasGitPusher =
      this._clusterHasAgent(cluster, 'git-pusher') ||
      agentConfigs.some((agent) => agent?.id === 'git-pusher');

    if (!isPrMode || !hasGitPusher) {
      return agentConfigs;
    }

    return agentConfigs.filter((agent) => agent?.id !== 'completion-detector');
  }

  _injectCriticalValidationResultProducer(agentConfigs) {
    const hasMetaCoordinator = agentConfigs.some((agent) => agent.id === 'meta-coordinator');
    const hasRuntimeValidator = agentConfigs.some((agent) => agent.role === 'validator');
    const hasSimulator = agentConfigs.some((agent) => agent.id === '__validation-result-simulator');

    // CRITICAL flow loads quick/heavy validators dynamically; simulate stage-1 producer
    // for static validation so we don't reject legitimate staged topologies.
    if (hasMetaCoordinator && !hasRuntimeValidator && !hasSimulator) {
      agentConfigs.push({
        id: '__validation-result-simulator',
        role: 'validator',
        triggers: [{ topic: 'IMPLEMENTATION_READY', action: 'execute_task' }],
        hooks: {
          onComplete: {
            action: 'publish_message',
            config: {
              topic: 'VALIDATION_RESULT',
              content: {
                data: {
                  approved: true,
                  errors: [],
                  criteriaResults: [],
                },
              },
            },
          },
        },
      });
    }
  }

  _prepareValidationAgentConfigs(cluster, proposedAgentConfigs) {
    const validationAgents = this._normalizeCompletionHandlersForPrMode(
      cluster,
      JSON.parse(JSON.stringify(proposedAgentConfigs || []))
    );

    this._injectCriticalValidationResultProducer(validationAgents);

    // Operation-chain validation runs before _injectCompletionAgent executes.
    // Add a synthetic completion handler so transient missing completion detectors
    // don't invalidate otherwise-correct topology changes.
    if (!this._hasCompletionHandler(validationAgents)) {
      validationAgents.push({
        id: '__completion-validator',
        role: 'orchestrator',
        triggers: [{ topic: 'VALIDATION_RESULT', action: 'stop_cluster' }],
      });
    }

    return validationAgents;
  }

  _validateProposedConfig(clusterId, cluster, proposedAgentConfigs, operations) {
    const validationAgents = this._prepareValidationAgentConfigs(cluster, proposedAgentConfigs);
    const mockConfig = { agents: validationAgents };
    const validation = configValidator.validateConfig(mockConfig);

    if (!validation.valid) {
      const errorMsg = `Proposed cluster configuration is invalid:\n  - ${validation.errors.join('\n  - ')}`;
      this._log(`[Orchestrator] ❌ ${errorMsg}`);

      // Publish validation failure for conductor to see and retry
      cluster.messageBus.publish({
        cluster_id: clusterId,
        topic: 'CLUSTER_OPERATIONS_VALIDATION_FAILED',
        sender: 'orchestrator',
        content: {
          text: 'Operation chain would create invalid cluster configuration',
          data: {
            errors: validation.errors,
            warnings: validation.warnings,
            operations: operations,
          },
        },
      });

      throw new Error(errorMsg);
    }

    return validation;
  }

  async _executeOperations(cluster, operations, sender, context) {
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      this._log(`  [${i + 1}/${operations.length}] ${op.action}`);
      await this._executeOperation(cluster, op, sender, context);
    }
  }

  async _executeOperation(cluster, op, sender, context) {
    switch (op.action) {
      case 'add_agents':
        await this._opAddAgents(cluster, op, context);
        break;
      case 'remove_agents':
        await this._opRemoveAgents(cluster, op);
        break;
      case 'update_agent':
        this._opUpdateAgent(cluster, op);
        break;
      case 'publish':
        this._opPublish(cluster, op, sender);
        break;
      case 'load_config':
        await this._opLoadConfig(cluster, op, context);
        break;
    }
  }

  /**
   * Operation: add_agents - Spawn new agents dynamically
   * @private
   */
  async _opAddAgents(cluster, op, context) {
    const agents = this._normalizeCompletionHandlersForPrMode(cluster, op.agents);
    if (!agents || !Array.isArray(agents)) {
      throw new Error('add_agents operation missing agents array');
    }
    if (agents.length === 0) {
      this._log(`    Skipping add_agents: PR-mode completion detector replaced by git-pusher`);
      return;
    }

    // CRITICAL: Inject cluster's worktree cwd into dynamically added agents
    // Without this, template agents (planning, implementation, validator) run in
    // original directory instead of worktree, causing --ship mode to pollute main
    const agentCwd = cluster.worktree?.path || cluster.isolation?.workDir || process.cwd();

    for (const agentConfig of agents) {
      // Inject cwd if not already set (same as startCluster does for initial agents)
      if (!agentConfig.cwd) {
        agentConfig.cwd = agentCwd;
        this._log(`    [cwd] Injected worktree cwd for ${agentConfig.id}: ${agentCwd}`);
      }

      // Apply model override if set (for consistency with initial agents)
      if (cluster.modelOverride) {
        applyModelOverride(agentConfig, cluster.modelOverride);
        this._log(`    [model] Overridden model for ${agentConfig.id}: ${cluster.modelOverride}`);
      }

      applyRequiredQualityGatesToAgent(agentConfig, cluster.requiredQualityGates);
      applyCommandProofsToAgent(agentConfig, cluster.commandProofs);
      if (cluster.autoPr) {
        applyPushBlockedRepairTrigger(agentConfig);
      }

      // Validate agent config has required fields
      if (!agentConfig.id) {
        throw new Error('Agent config missing required field: id');
      }

      // Check for duplicate agent ID - REPLACE agent entirely
      // Previous behavior merged triggers but kept old hooks, causing bugs when
      // loading templates with same agent IDs but different hooks (e.g., quick-validation
      // and heavy-validation both have consensus-coordinator with different onComplete hooks)
      const existingAgentIndex = cluster.agents.findIndex((a) => a.id === agentConfig.id);
      if (existingAgentIndex !== -1) {
        const existingAgent = cluster.agents[existingAgentIndex];
        this._log(
          `    🔄 Replacing agent ${agentConfig.id} (old role: ${existingAgent.config.role})`
        );

        // Stop the existing agent and wait for shutdown before replacement.
        // This prevents the old instance from draining buffered messages or
        // finishing in-flight work after the new agent has already started.
        if (existingAgent.stop) {
          await existingAgent.stop();
        }

        // Remove from cluster.agents array
        cluster.agents.splice(existingAgentIndex, 1);

        // Remove from cluster.config.agents if present
        if (cluster.config.agents) {
          const configIndex = cluster.config.agents.findIndex((a) => a.id === agentConfig.id);
          if (configIndex !== -1) {
            cluster.config.agents.splice(configIndex, 1);
          }
        }
        // Continue to add the new agent below
      }

      // Add to config agents array (for persistence)
      if (!cluster.config.agents) {
        cluster.config.agents = [];
      }
      cluster.config.agents.push(agentConfig);

      // Build agent options
      const agentOptions = {
        testMode: !!this.taskRunner, // Enable testMode if taskRunner provided
        quiet: this.quiet,
        modelOverride: cluster.modelOverride || null,
      };

      // TaskRunner DI - propagate to dynamically spawned agents
      if (this.taskRunner) {
        agentOptions.taskRunner = this.taskRunner;
      }

      // Pass isolation context if cluster is running in isolation mode
      if (cluster.isolation?.enabled && context.isolationManager) {
        agentOptions.isolation = {
          enabled: true,
          manager: context.isolationManager,
          clusterId: cluster.id,
        };
      }

      // Create and start agent
      const agent = new AgentWrapper(agentConfig, cluster.messageBus, cluster, agentOptions);
      cluster.agents.push(agent);
      await agent.start();

      this._log(
        `    ✓ Added agent: ${agentConfig.id} (role: ${agentConfig.role || 'unspecified'})`
      );
    }
  }

  /**
   * Operation: remove_agents - Stop and remove agents by ID
   * @private
   */
  async _opRemoveAgents(cluster, op) {
    const agentIds = op.agentIds;
    if (!agentIds || !Array.isArray(agentIds)) {
      throw new Error('remove_agents operation missing agentIds array');
    }

    for (const agentId of agentIds) {
      const agentIndex = cluster.agents.findIndex((a) => a.id === agentId);
      if (agentIndex === -1) {
        this._log(`    ⚠️ Agent ${agentId} not found, skipping removal`);
        continue;
      }

      const agent = cluster.agents[agentIndex];
      await agent.stop();

      // Remove from cluster.agents
      cluster.agents.splice(agentIndex, 1);

      // Remove from config.agents
      if (cluster.config.agents) {
        const configIndex = cluster.config.agents.findIndex((a) => a.id === agentId);
        if (configIndex !== -1) {
          cluster.config.agents.splice(configIndex, 1);
        }
      }

      this._log(`    ✓ Removed agent: ${agentId}`);
    }
  }

  /**
   * Operation: update_agent - Modify existing agent config at runtime
   * Note: Some updates may require agent restart to take effect
   * @private
   */
  _opUpdateAgent(cluster, op) {
    const { agentId, updates } = op;
    if (!agentId) {
      throw new Error('update_agent operation missing agentId');
    }
    if (!updates || typeof updates !== 'object') {
      throw new Error('update_agent operation missing updates object');
    }

    const agent = cluster.agents.find((a) => a.id === agentId);
    if (!agent) {
      throw new Error(`update_agent: Agent ${agentId} not found`);
    }

    // Apply updates to agent config
    Object.assign(agent.config, updates);

    // Also update in cluster.config.agents for persistence
    if (cluster.config.agents) {
      const configAgent = cluster.config.agents.find((a) => a.id === agentId);
      if (configAgent) {
        Object.assign(configAgent, updates);
      }
    }

    this._log(`    ✓ Updated agent: ${agentId} (fields: ${Object.keys(updates).join(', ')})`);
  }

  /**
   * Operation: publish - Publish a message to the bus
   * @private
   */
  _opPublish(cluster, op, sender) {
    const { topic, content, metadata } = op;
    if (!topic) {
      throw new Error('publish operation missing topic');
    }

    cluster.messageBus.publish({
      cluster_id: cluster.id,
      topic,
      sender: op.sender || sender,
      receiver: op.receiver || 'broadcast',
      content: content || {},
      metadata: metadata || null,
    });

    this._log(`    ✓ Published to topic: ${topic}`);
  }

  /**
   * Operation: load_config - Load agents from a cluster config
   *
   * Supports two formats:
   * 1. Static config: { config: 'config-name' } - loads from cluster-templates/config-name.json
   * 2. Parameterized: { config: { base: 'template-name', params: {...} } } - resolves base template with params
   *
   * @private
   */
  async _opLoadConfig(cluster, op, context) {
    const { config } = op;
    if (!config) {
      throw new Error('load_config operation missing config');
    }

    const templatesDir = path.join(__dirname, '..', 'cluster-templates');
    let loadedConfig;

    // Check if config is parameterized ({ base, params }) or static (string)
    if (typeof config === 'object' && config.base) {
      // Parameterized template - resolve with TemplateResolver
      const { base, params } = config;
      this._log(`    Loading parameterized template: ${base}`);
      this._log(`    Params: ${JSON.stringify(params)}`);

      const resolver = new TemplateResolver(templatesDir);
      loadedConfig = resolver.resolve(base, params);

      this._log(`    ✓ Resolved template: ${base} → ${loadedConfig.agents?.length || 0} agent(s)`);
    } else if (typeof config === 'string') {
      // Static config - load directly from file
      const configPath = path.join(templatesDir, `${config}.json`);

      if (!fs.existsSync(configPath)) {
        throw new Error(`Config not found: ${config} (looked in ${configPath})`);
      }

      this._log(`    Loading static config: ${config}`);

      const configContent = fs.readFileSync(configPath, 'utf8');
      loadedConfig = JSON.parse(configContent);
    } else {
      throw new Error(
        `Invalid config format: expected string or {base, params}, got ${typeof config}`
      );
    }

    if (!loadedConfig.agents || !Array.isArray(loadedConfig.agents)) {
      throw new Error(`Config has no agents array`);
    }

    this._log(`    Found ${loadedConfig.agents.length} agent(s)`);

    // Add agents from loaded config (reuse existing add_agents logic)
    await this._opAddAgents(cluster, { agents: loadedConfig.agents }, context);

    this._log(`    ✓ Config loaded (${loadedConfig.agents.length} agents)`);

    // Inject completion agent (templates don't include one - orchestrator controls termination)
    await this._injectCompletionAgent(cluster, context);
  }

  /**
   * Inject appropriate completion agent based on mode
   * Templates define work, orchestrator controls termination strategy
   * @private
   */
  async _injectCompletionAgent(cluster, context) {
    // Skip if completion agent already exists
    const hasCompletionAgent = cluster.agents.some(
      (a) => a.config?.id === 'completion-detector' || a.config?.id === 'git-pusher'
    );
    if (hasCompletionAgent) {
      return;
    }

    const isPrMode = cluster.autoPr ?? process.env.ZEROSHOT_PR === '1';

    if (isPrMode) {
      // Detect platform from stored cluster metadata OR git context
      let platform = cluster.gitPlatform; // Use stored git platform (not issueProvider!)

      // Fallback to git context detection if cluster metadata missing
      if (!platform) {
        const { getPlatformForPR } = require('./issue-providers');
        try {
          platform = getPlatformForPR(cluster.cwd || process.cwd());
        } catch (error) {
          throw new Error(`Cannot determine platform for PR creation on resume: ${error.message}`);
        }
      }

      const {
        generateGitPusherAgent,
        isPlatformSupported,
      } = require('./agents/git-pusher-template');

      if (!isPlatformSupported(platform)) {
        throw new Error(
          `Platform '${platform}' does not support --pr mode. Supported: github, gitlab, azure-devops`
        );
      }

      // Get issue context from ledger
      const issueMsg = cluster.messageBus.ledger.findLast({ topic: 'ISSUE_OPENED' });
      const issueNumber = issueMsg?.content?.data?.number || 'unknown';
      const issueTitle = issueMsg?.content?.data?.title || 'Implementation';

      // Generate the final prompt in one typed assembly pass. Issue values are
      // resolved before the shell-quoted remote is inserted, so placeholder-like
      // remote names cannot be rewritten by issue context.
      const gitPusherConfig = generateGitPusherAgent(platform, {
        ...(cluster.prOptions || {}),
        issueNumber,
        issueTitle,
      });

      await this._opAddAgents(cluster, { agents: [gitPusherConfig] }, context);
      this._log(`    [--pr mode] Injected ${platform}-git-pusher agent`);
    } else {
      // Default completion-detector
      const { SHARED_TRIGGER_SCRIPT } = require('./agents/git-pusher-template');
      const completionDetector = {
        id: 'completion-detector',
        role: 'orchestrator',
        modelLevel: this._resolveCompletionDetectorLevel(cluster.config),
        timeout: 0,
        triggers: [
          {
            topic: 'VALIDATION_RESULT',
            logic: {
              engine: 'javascript',
              script: SHARED_TRIGGER_SCRIPT,
            },
            action: 'stop_cluster',
          },
        ],
      };

      await this._opAddAgents(cluster, { agents: [completionDetector] }, context);
      this._log(`    Injected completion-detector agent`);
    }
  }

  /**
   * Check if a process with given PID is running
   * @param {Number} pid - Process ID
   * @returns {Boolean} True if process exists
   * @private
   */
  _isProcessRunning(pid) {
    return isProcessRunning(pid);
  }

  /**
   * Read messageCount for a cluster without fabricating a value on failure.
   * A confirmed zero (ledger read succeeded, cluster has no messages) and a
   * failed read (ledger unavailable) must stay distinguishable - returning 0
   * for both is what produced the phantom "failed/msgs=0" state in list/status.
   * @private
   */
  _readMessageCount(cluster, clusterId) {
    try {
      return cluster.messageBus.readSnapshot(clusterId).messageCount;
    } catch (error) {
      console.error(
        `[Orchestrator] Failed to read message count for cluster ${clusterId}: ${error.message || String(error)}`
      );
      return null;
    }
  }

  /**
   * Get cluster status
   * @param {String} clusterId - Cluster ID
   * @returns {Object} Cluster status
   */
  getStatus(clusterId) {
    const cluster = this.clusters.get(clusterId);
    if (!cluster) {
      throw new Error(`Cluster ${clusterId} not found`);
    }

    // Detect zombie clusters: state=running but no backing process
    let state = cluster.state;
    let isZombie = false;
    if (state === 'running') {
      if (cluster.pid) {
        // PID recorded - check if process is running
        if (!this._isProcessRunning(cluster.pid)) {
          state = 'zombie';
          isZombie = true;
          this._log(
            `[Orchestrator] Detected zombie cluster ${clusterId} (PID ${cluster.pid} not running)`
          );
        }
      } else {
        // No PID recorded (legacy cluster or bug) - definitely a zombie
        // New code always records PID for running clusters
        state = 'zombie';
        isZombie = true;
        this._log(
          `[Orchestrator] Detected zombie cluster ${clusterId} (no PID recorded - legacy or killed cluster)`
        );
      }
    }

    return {
      id: clusterId,
      state: state,
      isZombie: isZombie,
      pid: cluster.pid || null,
      createdAt: cluster.createdAt,
      agents: cluster.agents.map((a) => a.getState()),
      messageCount: this._readMessageCount(cluster, clusterId),
      setupLogPath: cluster.setupLogPath || null,
      setupStage: cluster.setupStage || null,
      failureInfo: cluster.failureInfo || null,
      runMode: cluster.runMode || null,
    };
  }

  /**
   * List all clusters
   * @returns {Array} List of cluster summaries
   */
  listClusters() {
    return Array.from(this.clusters.values()).map((cluster) => {
      // Detect zombie clusters (state=running but no backing process)
      let state = cluster.state;
      if (state === 'running') {
        if (cluster.pid) {
          if (!this._isProcessRunning(cluster.pid)) {
            state = 'zombie';
          }
        } else {
          // No PID recorded - definitely a zombie
          state = 'zombie';
        }
      }

      return {
        id: cluster.id,
        state: state,
        createdAt: cluster.createdAt,
        issue: cluster.issue || null,
        agentCount: cluster.agents.length,
        messageCount: this._readMessageCount(cluster, cluster.id),
        pid: cluster.pid || null,
        setupLogPath: cluster.setupLogPath || null,
        setupStage: cluster.setupStage || null,
        failureInfo: cluster.failureInfo || null,
        runMode: cluster.runMode || null,
      };
    });
  }

  /**
   * Get cluster object (for internal use)
   * @param {String} clusterId - Cluster ID
   * @returns {Object} Full cluster object
   */
  getCluster(clusterId) {
    return this.clusters.get(clusterId);
  }

  /**
   * Export cluster conversation
   * @param {String} clusterId - Cluster ID
   * @param {String} format - Export format ('json' or 'markdown')
   * @returns {String} Exported data
   */
  export(clusterId, format = 'json') {
    const cluster = this.clusters.get(clusterId);
    if (!cluster) {
      throw new Error(`Cluster ${clusterId} not found`);
    }

    const messages = cluster.messageBus.getAll(clusterId);

    if (format === 'json') {
      return JSON.stringify(
        {
          cluster_id: clusterId,
          state: cluster.state,
          created_at: cluster.createdAt,
          agents: cluster.agents.map((a) => a.getState()),
          messages,
        },
        null,
        2
      );
    } else if (format === 'markdown') {
      return this._exportMarkdown(cluster, clusterId, messages);
    } else {
      throw new Error(`Unknown export format: ${format}`);
    }
  }

  /**
   * Export cluster as nicely formatted markdown
   * @private
   */
  _exportMarkdown(cluster, clusterId, messages) {
    const { parseProviderChunk } = require('./providers');

    // Find task info
    const issueOpened = messages.find((m) => m.topic === 'ISSUE_OPENED');
    const taskText = issueOpened?.content?.text || 'Unknown task';

    // Calculate duration
    const firstMsg = messages[0];
    const lastMsg = messages[messages.length - 1];
    const durationMs = lastMsg ? lastMsg.timestamp - firstMsg.timestamp : 0;
    const durationMin = Math.round(durationMs / 60000);

    // Header
    let md = `# Cluster: ${clusterId}\n\n`;
    md += `| Property | Value |\n|----------|-------|\n`;
    md += `| State | ${cluster.state} |\n`;
    md += `| Created | ${new Date(cluster.createdAt).toLocaleString()} |\n`;
    md += `| Duration | ${durationMin} minutes |\n`;
    md += `| Agents | ${cluster.agents.map((a) => a.id).join(', ')} |\n\n`;

    // Task
    md += `## Task\n\n${taskText}\n\n`;

    // Group messages by agent for cleaner output
    const agentOutputs = this._collectAgentOutputs(messages);

    for (const [agentId, agentMsgs] of agentOutputs) {
      md += this._renderAgentMarkdown(agentId, agentMsgs, parseProviderChunk);
    }

    md += this._renderValidationMarkdown(messages);

    // Final status
    const clusterComplete = messages.find((m) => m.topic === 'CLUSTER_COMPLETE');
    if (clusterComplete) {
      md += `## Result\n\n✅ **Cluster completed successfully**\n`;
    }

    return md;
  }

  _collectAgentOutputs(messages) {
    const agentOutputs = new Map();

    for (const msg of messages) {
      if (msg.topic !== 'AGENT_OUTPUT') continue;
      if (!agentOutputs.has(msg.sender)) {
        agentOutputs.set(msg.sender, []);
      }
      agentOutputs.get(msg.sender).push(msg);
    }

    return agentOutputs;
  }

  _extractAgentOutput(agentMsgs, parseProviderChunk) {
    let text = '';
    const tools = [];

    for (const msg of agentMsgs) {
      const content = msg.content?.data?.line || msg.content?.data?.chunk || msg.content?.text;
      if (!content) continue;

      const provider = normalizeProviderName(
        msg.content?.data?.provider || msg.sender_provider || 'claude'
      );
      const events = parseProviderChunk(provider, content);
      for (const event of events) {
        switch (event.type) {
          case 'text':
            text += event.text;
            break;
          case 'tool_call':
            tools.push({ name: event.toolName, input: event.input });
            break;
          case 'tool_result':
            if (tools.length > 0) {
              const lastTool = tools[tools.length - 1];
              lastTool.result = event.content;
              lastTool.isError = event.isError;
            }
            break;
        }
      }
    }

    return { text, tools };
  }

  _renderToolMarkdown(tools) {
    let md = `### Tools Used\n\n`;

    for (const tool of tools) {
      const status = tool.isError ? '❌' : '✓';
      md += `- **${tool.name}** ${status}\n`;
      if (tool.input) {
        const inputStr = typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input);
        if (inputStr.length < 100) {
          md += `  - Input: \`${inputStr}\`\n`;
        }
      }
    }

    return `${md}\n`;
  }

  _renderAgentMarkdown(agentId, agentMsgs, parseProviderChunk) {
    let md = `## Agent: ${agentId}\n\n`;
    const { text, tools } = this._extractAgentOutput(agentMsgs, parseProviderChunk);

    if (text.trim()) {
      md += `### Output\n\n${text.trim()}\n\n`;
    }

    if (tools.length > 0) {
      md += this._renderToolMarkdown(tools);
    }

    return md;
  }

  _renderCriteriaMarkdown(criteriaResults) {
    if (!Array.isArray(criteriaResults)) {
      return '';
    }

    let md = '';
    const cannotValidateYet = criteriaResults.filter((c) => c.status === 'CANNOT_VALIDATE_YET');
    if (cannotValidateYet.length > 0) {
      md += `**❌ Cannot Validate Yet (${cannotValidateYet.length} criteria - work incomplete):**\n`;
      for (const cv of cannotValidateYet) {
        md += `- ${cv.id}: ${cv.reason || 'No reason provided'}\n`;
      }
      md += '\n';
    }

    const cannotValidate = criteriaResults.filter((c) => c.status === 'CANNOT_VALIDATE');
    if (cannotValidate.length > 0) {
      md += `**⚠️ Could Not Validate (${cannotValidate.length} criteria - permanent):**\n`;
      for (const cv of cannotValidate) {
        md += `- ${cv.id}: ${cv.reason || 'No reason provided'}\n`;
      }
      md += '\n';
    }

    return md;
  }

  _renderValidationEntryMarkdown(validation) {
    const data = validation.content?.data || {};
    const approved = data.approved === true || data.approved === 'true';
    const icon = approved ? '✅' : '❌';
    let md = `### ${validation.sender} ${icon}\n\n`;

    if (data.summary) {
      md += `${data.summary}\n\n`;
    }

    if (!approved && data.issues) {
      const issues = typeof data.issues === 'string' ? JSON.parse(data.issues) : data.issues;
      if (Array.isArray(issues) && issues.length > 0) {
        md += `**Issues:**\n`;
        for (const issue of issues) {
          md += `- ${issue}\n`;
        }
        md += '\n';
      }
    }

    md += this._renderCriteriaMarkdown(data.criteriaResults);
    return md;
  }

  _renderValidationMarkdown(messages) {
    const validations = messages.filter((m) => m.topic === 'VALIDATION_RESULT');
    if (validations.length === 0) {
      return '';
    }

    let md = `## Validation Results\n\n`;
    for (const validation of validations) {
      md += this._renderValidationEntryMarkdown(validation);
    }

    return md;
  }

  /**
   * Validate cluster configuration (delegates to config-validator module)
   * @param {Object} config - Cluster configuration
   * @param {Object} options - Validation options
   * @param {boolean} options.strict - Treat warnings as errors (default: false)
   * @returns {Object} { valid: Boolean, errors: Array, warnings: Array }
   */
  validateConfig(config, options = {}) {
    const result = configValidator.validateConfig(config);

    // In strict mode, warnings become errors
    if (options.strict && result.warnings.length > 0) {
      result.errors.push(...result.warnings.map((w) => `[strict] ${w}`));
      result.valid = false;
    }

    return result;
  }

  /**
   * Load cluster configuration from file
   * @param {String} configPath - Path to config JSON file
   * @param {Object} options - Load options
   * @param {boolean} options.strict - Treat warnings as errors
   * @returns {Object} Parsed configuration
   */
  loadConfig(configPath, options = {}) {
    const fullPath = path.resolve(configPath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const config = JSON.parse(content);

    const validation = this.validateConfig(config, options);

    // Show warnings (but don't fail unless strict mode)
    if (validation.warnings && validation.warnings.length > 0 && !this.quiet) {
      console.warn('\n⚠️  Configuration warnings:');
      for (const warning of validation.warnings) {
        console.warn(`   ${warning}`);
      }
      console.warn('');
    }

    if (!validation.valid) {
      const errorMsg = validation.errors.join('\n  ');
      throw new Error(`Invalid config:\n  ${errorMsg}`);
    }

    return config;
  }

  /**
   * Garbage-collect orphaned worktree directories and database files.
   *
   * Delegates to the standalone gc module, passing in-memory cluster IDs
   * as additional known IDs (clusters.json may not reflect recently spawned clusters).
   *
   * @param {object} [options]
   * @param {boolean} [options.dryRun=false] - If true, report but don't delete
   * @returns {{ orphanedWorktrees: string[], orphanedDbs: string[], errors: string[] }}
   */
  gcWorktrees(options = {}) {
    const { gcOrphanedWorktrees } = require('./lib/gc');
    return gcOrphanedWorktrees({
      storageDir: this.storageDir,
      extraKnownIds: new Set(this.clusters.keys()),
      dryRun: options.dryRun || false,
    });
  }

  /**
   * Explicitly detect clusters corrupted by SIGINT during initialization
   * (state='running' but the ledger never received its first message).
   *
   * This replaces the old unconditional 0-message check that used to run inside
   * _loadClusters() on every list/status call: that check mutated cluster.state
   * as a side effect of a plain read, and a single racy count() (e.g. against a
   * writer's just-opened connection) was enough to misclassify a healthy running
   * cluster as corrupted. This method is only ever invoked explicitly (from the
   * `gc` CLI flow), never from getStatus()/listClusters(), and requires:
   *   - the cluster has been running longer than `graceMs` (default 60s), so a
   *     brand-new cluster whose first message hasn't landed yet isn't flagged, and
   *   - two independent reads 250ms apart both observe 0 messages, so a single
   *     transient/racy read can't trigger a false positive.
   *
   * @param {object} [options]
   * @param {number} [options.graceMs=60000]
   * @returns {Promise<string[]>} IDs newly marked corrupted
   */
  async detectCorruptedClusters(options = {}) {
    const graceMs = typeof options.graceMs === 'number' ? options.graceMs : 60000;
    const now = Date.now();
    const corrupted = [];

    for (const cluster of this.clusters.values()) {
      if (this._isSetupCluster(cluster)) continue;
      if (cluster.state !== 'running') continue;
      if (!cluster.createdAt || now - cluster.createdAt < graceMs) continue;
      if (!cluster.messageBus) continue;

      let firstCount;
      try {
        firstCount = cluster.messageBus.count({ cluster_id: cluster.id });
      } catch (error) {
        console.warn(
          `[Orchestrator] Skipping corruption check for ${cluster.id}: ${error.message || String(error)}`
        );
        continue;
      }
      if (firstCount !== 0) continue;

      await new Promise((resolve) => setTimeout(resolve, 250));

      let secondCount;
      try {
        secondCount = cluster.messageBus.count({ cluster_id: cluster.id });
      } catch (error) {
        console.warn(
          `[Orchestrator] Skipping corruption check for ${cluster.id}: ${error.message || String(error)}`
        );
        continue;
      }
      if (secondCount !== 0) continue;

      console.warn(`[Orchestrator] ⚠️  Cluster ${cluster.id} has 0 messages (corrupted)`);
      console.warn(`[Orchestrator]    This likely occurred from SIGINT during initialization.`);
      console.warn(
        `[Orchestrator]    Marking as 'corrupted' - use 'zeroshot kill ${cluster.id}' to remove.`
      );
      cluster.state = 'corrupted';
      cluster.corruptedReason = 'SIGINT during initialization (0 messages in ledger)';
      corrupted.push(cluster.id);
    }

    if (corrupted.length > 0) {
      await this._saveClusters();
    }

    return corrupted;
  }
}

// Exported for testing (PR options persistence, e.g. autoMerge for --pr vs --ship).
Orchestrator.buildPrOptions = buildPrOptions;
Orchestrator.resolveRunPlan = resolveRunPlan;

module.exports = Orchestrator;
module.exports.DuplicateClusterError = DuplicateClusterError;
