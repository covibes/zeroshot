/**
 * SubClusterWrapper - Manages nested cluster lifecycle
 *
 * Implements same interface as AgentWrapper but spawns a child Orchestrator
 * instead of a Claude task. Enables recursive cluster composition.
 *
 * Lifecycle:
 * - On trigger match: spawns nested Orchestrator with child cluster config
 * - Passes parent context to child via ISSUE_OPENED equivalent
 * - Listens for child CLUSTER_COMPLETE → executes onComplete hook
 * - Listens for child CLUSTER_FAILED → executes onError hook
 * - Supports maxIterations at subcluster level (restart child on failure)
 */

const LogicEngine = require('./logic-engine');
const MessageBusBridge = require('./message-bus-bridge');
const { DEFAULT_MAX_ITERATIONS } = require('./agent/agent-config');
const { findMatchingTrigger } = require('./agent/agent-trigger-evaluator');
const { bufferMessage, scheduleDrain, drainBufferedMessages } = require('./message-buffer');

function normalizeParentTopicConfig(entry) {
  if (typeof entry === 'string') {
    return { topic: entry, amount: 10, strategy: 'latest' };
  }
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const amount = entry.amount ?? entry.limit;
  const strategy = entry.strategy ?? (amount !== undefined ? 'latest' : 'all');
  return { ...entry, amount, strategy };
}

function selectParentTopicMessages(messageBus, clusterId, topicConfig) {
  const { topic, sender, since, until, amount, strategy } = topicConfig;
  const order = strategy === 'latest' ? 'desc' : 'asc';
  const messages = messageBus.query({
    cluster_id: clusterId,
    topic,
    sender,
    since,
    until,
    limit: amount,
    order,
  });

  if (strategy === 'latest' && messages.length > 1) {
    return messages.slice().reverse();
  }

  return messages;
}

class SubClusterWrapper {
  constructor(config, messageBus, parentCluster, options = {}) {
    this.id = config.id;
    this.role = config.role || 'orchestrator';
    this.config = config;
    this.messageBus = messageBus; // Parent message bus
    this.parentCluster = parentCluster;
    this.logicEngine = new LogicEngine(messageBus, parentCluster);

    this.state = 'idle';
    this.iteration = 0;
    this.maxIterations = config.maxIterations || DEFAULT_MAX_ITERATIONS;
    this.running = false;
    this.unsubscribe = null;

    // Child cluster state
    this.childCluster = null; // { id, orchestrator, messageBus, bridge }
    this.childClusterId = null;

    this.quiet = options.quiet || false;
    this.modelOverride = options.modelOverride || null;
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
   * Publish lifecycle event to parent message bus
   * @private
   */
  _publishLifecycle(event, details = {}) {
    this.messageBus.publish({
      cluster_id: this.parentCluster.id,
      topic: 'AGENT_LIFECYCLE',
      sender: this.id,
      receiver: 'system',
      content: {
        text: `${this.id}: ${event}`,
        data: {
          event,
          agent: this.id,
          role: this.role,
          state: this.state,
          type: 'subcluster',
          ...details,
        },
      },
    });
  }

  /**
   * Start the sub-cluster wrapper (begin listening for triggers)
   */
  start() {
    if (this.running) {
      throw new Error(`SubCluster ${this.id} is already running`);
    }

    this.running = true;
    this.state = 'idle';

    // Subscribe to parent cluster messages
    this.unsubscribe = this.messageBus.subscribe((message) => {
      if (message.cluster_id === this.parentCluster.id) {
        this._handleMessage(message).catch((error) => {
          console.error(`\n${'='.repeat(80)}`);
          console.error(`🔴 FATAL: SubCluster ${this.id} message handler crashed`);
          console.error(`${'='.repeat(80)}`);
          console.error(`Topic: ${message.topic}`);
          console.error(`Error: ${error.message}`);
          console.error(`Stack: ${error.stack}`);
          console.error(`${'='.repeat(80)}\n`);
          throw error;
        });
      }
    });

    this._log(`SubCluster ${this.id} started (role: ${this.role})`);
    this._publishLifecycle('STARTED', {
      triggers: this.config.triggers?.map((t) => t.topic) || [],
    });
  }

  /**
   * Stop the sub-cluster wrapper
   */
  async stop() {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.state = 'stopped';

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    // Stop child cluster if running
    if (this.childCluster) {
      await this._stopChildCluster();
    }

    this._log(`SubCluster ${this.id} stopped`);
  }

  /**
   * Handle incoming message from parent cluster
   * @private
   */
  async _handleMessage(message) {
    if (!this._bufferedMessages) {
      this._bufferedMessages = [];
    }

    // Check if any trigger matches
    const matchingTrigger = this._findMatchingTrigger(message);
    if (!matchingTrigger) {
      return;
    }

    // Check state
    if (!this.running) {
      console.warn(`[${this.id}] ⚠️ DROPPING message (not running): ${message.topic}`);
      return;
    }
    if (this.state !== 'idle') {
      bufferMessage(this, message);
      console.warn(
        `[${this.id}] ⏸️ BUFFERING message (busy, state=${this.state}): ${message.topic}`
      );
      scheduleDrain(
        this,
        () =>
          drainBufferedMessages(this, (next) => this._handleMessage(next), {
            label: 'SubCluster',
          }),
        { label: 'SubCluster' }
      );
      return;
    }

    // Evaluate trigger logic
    this.state = 'evaluating_logic';
    const shouldExecute = this._evaluateTrigger(matchingTrigger, message);

    if (!shouldExecute) {
      this.state = 'idle';
      return;
    }

    // Execute trigger action (spawn child cluster)
    await this._handleTrigger(message);
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
    if (!trigger.logic || !trigger.logic.script) {
      return true;
    }

    const agent = {
      id: this.id,
      role: this.role,
      iteration: this.iteration,
      cluster_id: this.parentCluster.id,
    };

    return this.logicEngine.evaluate(trigger.logic.script, agent, message);
  }

  /**
   * Handle trigger: spawn child cluster
   * @private
   */
  async _handleTrigger(triggeringMessage) {
    // Check max iterations
    if (this.iteration >= this.maxIterations) {
      this._log(`[SubCluster ${this.id}] Hit max iterations (${this.maxIterations}), failing`);
      this._publishLifecycle('MAX_ITERATIONS_REACHED', {
        iteration: this.iteration,
        maxIterations: this.maxIterations,
      });

      this.messageBus.publish({
        cluster_id: this.parentCluster.id,
        topic: 'CLUSTER_FAILED',
        sender: this.id,
        receiver: 'system',
        content: {
          text: `SubCluster ${this.id} hit max iterations limit (${this.maxIterations})`,
          data: {
            reason: 'max_iterations',
            iteration: this.iteration,
            maxIterations: this.maxIterations,
          },
        },
      });

      this.state = 'failed';
      return;
    }

    this.iteration++;
    this.state = 'spawning_child';

    this._publishLifecycle('SPAWNING_CHILD', {
      iteration: this.iteration,
      triggeredBy: triggeringMessage.topic,
    });

    try {
      // Build child cluster context from parent messages
      const context = this._buildChildContext(triggeringMessage);

      // Spawn child cluster
      await this._spawnChildCluster(context);

      this._publishLifecycle('CHILD_SPAWNED', {
        childClusterId: this.childClusterId,
        iteration: this.iteration,
      });

      this.state = 'monitoring_child';
    } catch (error) {
      console.error(`\n${'='.repeat(80)}`);
      console.error(`🔴 CHILD CLUSTER SPAWN FAILED - ${this.id}`);
      console.error(`${'='.repeat(80)}`);
      console.error(`Error: ${error.message}`);
      console.error(`Stack: ${error.stack}`);
      console.error(`${'='.repeat(80)}\n`);

      this.state = 'error';

      // Execute onError hook
      await this._executeHook('onError', { error, triggeringMessage });

      // Return to idle if we haven't hit max iterations
      if (this.iteration < this.maxIterations) {
        this.state = 'idle';
      }
    }
  }

  /**
   * Build context for child cluster from parent messages
   * @private
   */
  _buildChildContext(triggeringMessage) {
    const parentTopics = this.config.contextStrategy?.parentTopics || [];

    const lines = [
      '# Child Cluster Context',
      '',
      `Parent Cluster: ${this.parentCluster.id}`,
      `SubCluster ID: ${this.id}`,
      `Iteration: ${this.iteration}`,
      '',
    ];

    this._appendParentTopicContext(lines, parentTopics);
    this._appendTriggeringMessageContext(lines, triggeringMessage);

    return lines.join('\n');
  }

  _appendParentTopicContext(lines, parentTopics) {
    if (parentTopics.length === 0) {
      return;
    }

    lines.push('## Parent Cluster Messages', '');

    for (const entry of parentTopics) {
      const topicConfig = normalizeParentTopicConfig(entry);
      if (!topicConfig?.topic) {
        continue;
      }
      const topicLines = this._buildTopicContextLines(topicConfig);
      if (topicLines.length === 0) {
        continue;
      }

      lines.push(...topicLines);
    }
  }

  _buildTopicContextLines(topicConfig) {
    const messages = selectParentTopicMessages(this.messageBus, this.parentCluster.id, topicConfig);

    if (messages.length === 0) {
      return [];
    }

    const lines = [`### Topic: ${topicConfig.topic}`, ''];

    for (const message of messages) {
      lines.push(...this._buildMessageContextLines(message));
      lines.push('');
    }

    return lines;
  }

  _buildMessageContextLines(message) {
    const lines = [`[${new Date(message.timestamp).toISOString()}] ${message.sender}:`];
    const text = message.content?.text;
    const data = message.content?.data;

    if (text) {
      lines.push(text);
    }

    if (data) {
      lines.push(`Data: ${JSON.stringify(data, null, 2)}`);
    }

    return lines;
  }

  _appendTriggeringMessageContext(lines, triggeringMessage) {
    lines.push(
      '',
      '## Triggering Message',
      '',
      `Topic: ${triggeringMessage.topic}`,
      `Sender: ${triggeringMessage.sender}`
    );

    const text = triggeringMessage.content?.text;
    if (text) {
      lines.push('', text);
    }
  }

  /**
   * Spawn child cluster with nested Orchestrator
   * @private
   */
  async _spawnChildCluster(context) {
    const Orchestrator = require('./orchestrator');
    const path = require('path');

    // Generate child cluster ID (namespaced under parent)
    const childId = `${this.parentCluster.id}.${this.id}`;
    this.childClusterId = childId;

    // Create child orchestrator with separate database
    const childOrchestrator = await Orchestrator.create({
      quiet: this.quiet,
      skipLoad: true,
      storageDir: path.join(this.parentCluster.ledger.dbPath, '..', 'subclusters', childId),
    });

    const childConfig = JSON.parse(JSON.stringify(this.config.config));
    const parentConfig = this.parentCluster?.config || {};

    if (parentConfig.forceProvider) {
      childConfig.forceProvider = parentConfig.forceProvider;
      childConfig.defaultProvider = parentConfig.forceProvider;
      if (parentConfig.forceLevel) {
        childConfig.forceLevel = parentConfig.forceLevel;
        childConfig.defaultLevel = parentConfig.forceLevel;
      }
    } else if (parentConfig.defaultProvider && !childConfig.defaultProvider) {
      childConfig.defaultProvider = parentConfig.defaultProvider;
    }

    // Start child cluster with text input (context from parent)
    const childCluster = await childOrchestrator.start(
      childConfig, // Child cluster config
      { text: context },
      { testMode: false, modelOverride: this.modelOverride || undefined }
    );

    // Create message bridge
    const bridge = new MessageBusBridge(this.messageBus, childCluster.messageBus, {
      parentClusterId: this.parentCluster.id,
      childClusterId: childId,
      parentTopics: this.config.contextStrategy?.parentTopics || [],
    });

    // Store child cluster state
    this.childCluster = {
      id: childId,
      orchestrator: childOrchestrator,
      messageBus: childCluster.messageBus,
      bridge,
    };

    // Listen for child cluster completion
    childCluster.messageBus.subscribe((message) => {
      if (message.topic === 'CLUSTER_COMPLETE' && message.cluster_id === childId) {
        this._onChildComplete(message).catch((err) => {
          console.error(`Failed to handle child completion: ${err.message}`);

          // CRITICAL: Hook failure = cluster failure
          this._publishLifecycle('HOOK_FAILED', {
            error: err.message,
            hook: 'onComplete',
          });

          this.messageBus.publish({
            cluster_id: this.parentCluster.id,
            topic: 'CLUSTER_FAILED',
            sender: this.id,
            content: {
              text: `Hook failed: ${err.message}`,
              data: {
                reason: 'onComplete hook failed',
                error: err.message,
                stack: err.stack,
              },
            },
          });

          this.state = 'failed';
          throw err;
        });
      }
    });

    // Listen for child cluster failure
    childCluster.messageBus.subscribe((message) => {
      if (message.topic === 'CLUSTER_FAILED' && message.cluster_id === childId) {
        this._onChildFailed(message).catch((err) => {
          console.error(`Failed to handle child failure: ${err.message}`);

          // CRITICAL: Hook failure = cluster failure
          this._publishLifecycle('HOOK_FAILED', {
            error: err.message,
            hook: 'onFailed',
          });

          this.messageBus.publish({
            cluster_id: this.parentCluster.id,
            topic: 'CLUSTER_FAILED',
            sender: this.id,
            content: {
              text: `Hook failed: ${err.message}`,
              data: {
                reason: 'onFailed hook failed',
                error: err.message,
                stack: err.stack,
              },
            },
          });

          this.state = 'failed';
          throw err;
        });
      }
    });
  }

  /**
   * Handle child cluster completion
   * @private
   */
  async _onChildComplete(message) {
    this._log(`[SubCluster ${this.id}] Child cluster completed`);

    this._publishLifecycle('CHILD_COMPLETE', {
      childClusterId: this.childClusterId,
      iteration: this.iteration,
    });

    // Execute onComplete hook - will throw if verification fails
    await this._executeHook('onComplete', {
      result: message,
      triggeringMessage: null,
    });

    // Only clean up and transition to idle if hook succeeded
    await this._stopChildCluster();

    this.state = 'idle';
  }

  /**
   * Handle child cluster failure
   * @private
   */
  async _onChildFailed(message) {
    this._log(`[SubCluster ${this.id}] Child cluster failed`);

    this._publishLifecycle('CHILD_FAILED', {
      childClusterId: this.childClusterId,
      iteration: this.iteration,
      error: message.content?.data?.reason,
    });

    // Execute onError hook
    const error = new Error(message.content?.data?.reason || 'Child cluster failed');
    await this._executeHook('onError', { error, triggeringMessage: null });

    // Clean up child cluster
    await this._stopChildCluster();

    // Retry if within max iterations
    if (this.iteration < this.maxIterations) {
      this.state = 'idle';
    } else {
      this.state = 'failed';
    }
  }

  /**
   * Stop child cluster
   * @private
   */
  async _stopChildCluster() {
    if (!this.childCluster) {
      return;
    }

    // Close message bridge
    if (this.childCluster.bridge) {
      this.childCluster.bridge.close();
    }

    // Stop child orchestrator
    try {
      await this.childCluster.orchestrator.stop(this.childCluster.id);
    } catch (err) {
      console.warn(`Warning: Failed to stop child cluster ${this.childCluster.id}: ${err.message}`);
    }

    this.childCluster = null;
    this.childClusterId = null;
  }

  /**
   * Execute a hook
   * @private
   */
  _executeHook(hookName, context) {
    const hook = this.config.hooks?.[hookName];
    if (!hook) {
      return;
    }

    if (hook.action === 'publish_message') {
      const message = this._substituteTemplate(hook.config, context);
      this.messageBus.publish({
        cluster_id: this.parentCluster.id,
        sender: this.id,
        ...message,
      });
    } else {
      throw new Error(`Unknown hook action: ${hook.action}`);
    }
  }

  /**
   * Substitute template variables in hook config
   * @private
   */
  _substituteTemplate(config, context) {
    if (!config) {
      throw new Error('_substituteTemplate: config is required');
    }

    const json = JSON.stringify(config);

    let substituted = json
      .replace(/\{\{cluster\.id\}\}/g, this.parentCluster.id)
      .replace(/\{\{subcluster\.id\}\}/g, this.id)
      .replace(/\{\{child\.id\}\}/g, this.childClusterId || '')
      .replace(/\{\{iteration\}\}/g, String(this.iteration))
      .replace(/\{\{error\.message\}\}/g, context.error?.message || '');

    // Parse and validate
    let result;
    try {
      result = JSON.parse(substituted);
    } catch (e) {
      console.error('JSON parse failed. Substituted string:');
      console.error(substituted);
      throw new Error(`Template substitution produced invalid JSON: ${e.message}`);
    }

    return result;
  }

  /**
   * Resume sub-cluster task (not implemented for subclusters)
   */
  resume(_resumeContext) {
    throw new Error('Resume not implemented for subclusters');
  }

  /**
   * Get current sub-cluster state
   */
  getState() {
    return {
      id: this.id,
      role: this.role,
      state: this.state,
      iteration: this.iteration,
      maxIterations: this.maxIterations,
      type: 'subcluster',
      childClusterId: this.childClusterId,
      childRunning: this.childCluster !== null,
    };
  }
}

module.exports = SubClusterWrapper;
