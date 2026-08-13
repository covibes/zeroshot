/**
 * Config Validator - Static analysis for zeroshot cluster configurations
 *
 * Catches logical failures that would cause clusters to:
 * - Never start (no bootstrap trigger)
 * - Never complete (no path to completion)
 * - Loop infinitely (circular dependencies)
 * - Deadlock (impossible consensus)
 * - Waste compute (orchestrator executing tasks)
 *
 * Run at config load time to fail fast before spawning agents.
 */

const { loadSettings } = require('../lib/settings');
const {
  VALID_PROVIDERS,
  normalizeProviderName,
  providerSupportsCapability,
} = require('../lib/provider-names');
const { getProvider } = require('./providers');
const { CAPABILITIES } = require('./providers/capabilities');
const { GUIDANCE_TOPICS } = require('./guidance-topics');

const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const REASONING_EFFORT_LABEL = REASONING_EFFORTS.join('|');

const HOOK_ACTION_TOPIC_CONTRACTS = Object.freeze({
  verify_pull_request: Object.freeze([
    { topic: 'CLUSTER_COMPLETE', keys: null },
    { topic: 'PUSH_BLOCKED', keys: null },
  ]),
});

/**
 * Check if config is a conductor-bootstrap style config
 * Conductor configs dynamically spawn agents via CLUSTER_OPERATIONS
 * @param {Object} config - Cluster configuration
 * @returns {boolean}
 */
function isConductorConfig(config) {
  const agents = Array.isArray(config?.agents) ? config.agents : [];
  const hasConductorOps = agents.some(
    (a) =>
      a.role === 'conductor' &&
      // Old style: static topic in config
      (a.hooks?.onComplete?.config?.topic === 'CLUSTER_OPERATIONS' ||
        // New style: topic set in transform script (check for CLUSTER_OPERATIONS in script)
        a.hooks?.onComplete?.transform?.script?.includes('CLUSTER_OPERATIONS'))
  );

  if (!hasConductorOps) {
    return false;
  }

  // Once runtime agents are present (after load_config/add_agents), we should NOT
  // skip message-flow validation. Skipping here caused proposed runtime topologies
  // to bypass dead-topic checks.
  const runtimeRoles = new Set([
    'implementation',
    'worker',
    'planner',
    'validator',
    'tester',
    'coordinator',
  ]);
  const hasRuntimeAgents = agents.some((a) => runtimeRoles.has(a.role));

  return !hasRuntimeAgents;
}

/**
 * Validate a cluster configuration for structural correctness
 * @param {Object} config - Cluster configuration
 * @param {Number} depth - Current nesting depth (for subcluster validation)
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateConfig(config, depth = 0) {
  const errors = [];
  const warnings = [];
  const settings = loadSettings();

  // Max nesting depth check
  const MAX_DEPTH = 5;
  if (depth > MAX_DEPTH) {
    errors.push(`Cluster nesting exceeds max depth (${MAX_DEPTH})`);
    return { valid: false, errors, warnings };
  }

  // === PHASE 1: Basic structure validation ===
  const basicResult = validateBasicStructure(config, depth);
  errors.push(...basicResult.errors);
  warnings.push(...basicResult.warnings);

  // Note: We continue to other phases even if Phase 1 has errors,
  // to collect ALL validation issues (especially semantic checks in Phase 6-9)

  // Conductor configs dynamically spawn agents - skip message flow analysis
  // The orchestrator validates the spawned config at CLUSTER_OPERATIONS execution time
  const conductorMode = isConductorConfig(config);

  // === PHASE 2: Message flow analysis (skip for conductor configs) ===
  if (!conductorMode) {
    const flowResult = analyzeMessageFlow(config);
    errors.push(...flowResult.errors);
    warnings.push(...flowResult.warnings);
  }

  // === PHASE 3: Agent-specific validation ===
  const agentResult = validateAgents(config);
  errors.push(...agentResult.errors);
  warnings.push(...agentResult.warnings);

  // === PHASE 4: Logic script validation ===
  const logicResult = validateLogicScripts(config);
  errors.push(...logicResult.errors);
  warnings.push(...logicResult.warnings);

  // === PHASE 5: Template variable validation ===
  const templateResult = validateTemplateVariables(config, depth);
  errors.push(...templateResult.errors);
  warnings.push(...templateResult.warnings);

  // === PHASE 6: Hook semantic validation ===
  const hookResult = validateHookSemantics(config);
  errors.push(...hookResult.errors);
  warnings.push(...hookResult.warnings);

  // === PHASE 7: Rule coverage validation ===
  const ruleResult = validateRuleCoverage(config);
  errors.push(...ruleResult.errors);
  warnings.push(...ruleResult.warnings);

  // === PHASE 8: N-agent cycle detection ===
  const cycleResult = detectNAgentCycles(config);
  errors.push(...cycleResult.errors);
  warnings.push(...cycleResult.warnings);

  // === PHASE 9: Configuration semantic validation ===
  const configResult = validateConfigSemantics(config);
  errors.push(...configResult.errors);
  warnings.push(...configResult.warnings);

  // === PHASE 10: Provider feature validation ===
  const providerResult = validateProviderFeatures(config, settings);
  errors.push(...providerResult.errors);
  warnings.push(...providerResult.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function validateAgentIdentity(agent, prefix, seenIds, errors) {
  if (!agent.id) {
    errors.push(`${prefix}.id is required`);
  } else if (typeof agent.id !== 'string') {
    errors.push(`${prefix}.id must be a string`);
  } else if (seenIds.has(agent.id)) {
    errors.push(`Duplicate agent id: "${agent.id}"`);
  } else {
    seenIds.add(agent.id);
  }

  if (!agent.role) {
    errors.push(`${prefix}.role is required`);
  }
}

function validateSubclusterAgent(agent, depth, errors, warnings) {
  const subClusterSchema = require('./schemas/sub-cluster');
  const subResult = subClusterSchema.validateSubCluster(agent, depth);
  errors.push(...subResult.errors);
  warnings.push(...subResult.warnings);
}

function validateTrigger(trigger, triggerPrefix, errors) {
  if (!trigger.topic) {
    errors.push(`${triggerPrefix}.topic is required`);
  }

  if (trigger.action && !['execute_task', 'stop_cluster'].includes(trigger.action)) {
    errors.push(
      `${triggerPrefix}.action must be 'execute_task' or 'stop_cluster', got '${trigger.action}'`
    );
  }

  if (trigger.logic) {
    if (!trigger.logic.script) {
      errors.push(`${triggerPrefix}.logic.script is required when logic is specified`);
    }
    if (trigger.logic.engine && trigger.logic.engine !== 'javascript') {
      errors.push(
        `${triggerPrefix}.logic.engine must be 'javascript', got '${trigger.logic.engine}'`
      );
    }
  }
}

function validateAgentTriggers(agent, prefix, errors) {
  if (!agent.triggers || !Array.isArray(agent.triggers)) {
    errors.push(`${prefix}.triggers array is required`);
    return;
  }

  if (agent.triggers.length === 0) {
    errors.push(`${prefix}.triggers cannot be empty (agent would never activate)`);
  }

  for (let j = 0; j < agent.triggers.length; j++) {
    const trigger = agent.triggers[j];
    const triggerPrefix = `${prefix}.triggers[${j}]`;
    validateTrigger(trigger, triggerPrefix, errors);
  }
}

function validateModelRule(rule, rulePrefix, errors) {
  if (!rule.iterations) {
    errors.push(`${rulePrefix}.iterations is required`);
  } else if (!isValidIterationPattern(rule.iterations)) {
    errors.push(
      `${rulePrefix}.iterations '${rule.iterations}' is invalid. Valid: "1", "1-3", "5+", "all"`
    );
  }

  if (!rule.model && !rule.modelLevel) {
    errors.push(`${rulePrefix}.model or modelLevel is required`);
  }
}

function validateAgentModelRules(agent, prefix, errors) {
  if (!agent.modelRules) {
    return;
  }

  if (!Array.isArray(agent.modelRules)) {
    errors.push(`${prefix}.modelRules must be an array`);
    return;
  }

  for (let j = 0; j < agent.modelRules.length; j++) {
    const rule = agent.modelRules[j];
    const rulePrefix = `${prefix}.modelRules[${j}]`;
    validateModelRule(rule, rulePrefix, errors);
  }
}

/**
 * Phase 1: Validate basic structure (fields, types, duplicates)
 */
function validateBasicStructure(config, depth = 0) {
  const errors = [];
  const warnings = [];

  if (!config.agents || !Array.isArray(config.agents)) {
    errors.push('agents array is required');
    return { errors, warnings };
  }

  if (config.agents.length === 0) {
    errors.push('agents array cannot be empty');
    return { errors, warnings };
  }

  const seenIds = new Set();

  for (let i = 0; i < config.agents.length; i++) {
    const agent = config.agents[i];
    const prefix = `agents[${i}]`;

    // Check if this is a subcluster
    const isSubCluster = agent.type === 'subcluster';

    validateAgentIdentity(agent, prefix, seenIds, errors);

    // Validate subclusters
    if (isSubCluster) {
      validateSubclusterAgent(agent, depth, errors, warnings);
      continue; // Skip regular agent validation
    }

    // Regular agent validation
    validateAgentTriggers(agent, prefix, errors);

    // Validate model rules if present
    validateAgentModelRules(agent, prefix, errors);

    // Note: Detailed coverage gap checking (iteration ranges) is done in Phase 7
  }

  return { errors, warnings };
}

/**
 * Phase 2: Analyze message flow for structural problems
 */
function ensureTopicList(map, topic) {
  if (!map.has(topic)) {
    map.set(topic, []);
  }
  return map.get(topic);
}

function getHookActionTopicContracts(hook) {
  if (!hook?.action) {
    return [];
  }
  return HOOK_ACTION_TOPIC_CONTRACTS[hook.action] || [];
}

function recordOutputTopic(agent, topic, topicProducers, agentOutputTopics, producerId = agent.id) {
  const producers = ensureTopicList(topicProducers, topic);
  if (!producers.includes(producerId)) {
    producers.push(producerId);
  }

  const outputs = agentOutputTopics.get(agent.id);
  if (!outputs.includes(topic)) {
    outputs.push(topic);
  }
}

function recordAgentTriggers(agent, topicConsumers, agentInputTopics) {
  for (const trigger of agent.triggers || []) {
    const topic = trigger.topic;
    ensureTopicList(topicConsumers, topic).push(agent.id);
    agentInputTopics.get(agent.id).push(topic);
  }
}

function extractDynamicTopicsFromScript(script, ctx) {
  if (!script || typeof script !== 'string') {
    return;
  }

  const topicMatches = script.match(/topic:\s*['"]([A-Z_]+)['"]/g) || [];
  for (const match of topicMatches) {
    const dynamicTopic = match.match(/['"]([A-Z_]+)['"]/)?.[1];
    if (!dynamicTopic || dynamicTopic === ctx.outputTopic) {
      continue;
    }

    const producers = ensureTopicList(ctx.topicProducers, dynamicTopic);
    if (!producers.includes(ctx.agentId)) {
      producers.push(`${ctx.agentId}*`);
    }

    const outputs = ctx.agentOutputTopics.get(ctx.agentId);
    if (!outputs.includes(dynamicTopic)) {
      outputs.push(dynamicTopic);
    }
  }
}

function recordAgentOutputs(agent, topicProducers, agentOutputTopics) {
  const hook = agent.hooks?.onComplete;
  const outputTopic = agent.hooks?.onComplete?.config?.topic;
  if (outputTopic) {
    recordOutputTopic(agent, outputTopic, topicProducers, agentOutputTopics);
  }

  const ctx = { outputTopic, agentId: agent.id, topicProducers, agentOutputTopics };
  extractDynamicTopicsFromScript(hook?.logic?.script, ctx);
  extractDynamicTopicsFromScript(hook?.transform?.script, ctx);

  for (const contract of getHookActionTopicContracts(hook)) {
    recordOutputTopic(agent, contract.topic, topicProducers, agentOutputTopics);
  }
}

function buildMessageFlowGraph(config) {
  const topicProducers = new Map();
  const topicConsumers = new Map();
  const agentOutputTopics = new Map();
  const agentInputTopics = new Map();

  topicProducers.set('ISSUE_OPENED', ['system']);

  for (const agent of config.agents) {
    agentInputTopics.set(agent.id, []);
    agentOutputTopics.set(agent.id, []);

    recordAgentTriggers(agent, topicConsumers, agentInputTopics);
    recordAgentOutputs(agent, topicProducers, agentOutputTopics);
  }

  return {
    topicProducers,
    topicConsumers,
    agentOutputTopics,
    agentInputTopics,
  };
}

function reportMissingBootstrap(topicConsumers, errors, config) {
  const issueOpenedConsumers = topicConsumers.get('ISSUE_OPENED') || [];
  const isSubTemplate = config.params && Object.keys(config.params).length > 0;

  if (issueOpenedConsumers.length === 0 && !isSubTemplate) {
    errors.push(
      'No agent triggers on ISSUE_OPENED. Cluster will never start. ' +
        'Add a trigger: { "topic": "ISSUE_OPENED", "action": "execute_task" }'
    );
  }
}

function reportCompletionHandlers(config, errors, warnings) {
  const completionHandlers = config.agents.filter(
    (a) =>
      a.triggers?.some((t) => t.action === 'stop_cluster') ||
      a.id === 'completion-detector' ||
      a.id === 'git-pusher' ||
      a.hooks?.onComplete?.config?.topic === 'CLUSTER_COMPLETE'
  );
  const isTemplateConfig = config.params && Object.keys(config.params).length > 0;
  // Conductor-driven configs (merged conductor + template agents) rely on idle timeout
  const hasConductorAgents = config.agents.some((a) => a.role === 'conductor');

  if (completionHandlers.length === 0) {
    const message =
      'No completion handler found. Cluster will run until idle timeout (2 min). ' +
      'Add an agent with trigger action: "stop_cluster"';
    if (isTemplateConfig || hasConductorAgents) {
      warnings.push(
        `${message} (${isTemplateConfig ? 'template will rely on orchestrator injection' : 'conductor-driven cluster relies on idle timeout'})`
      );
    } else {
      errors.push(message);
    }
  } else if (completionHandlers.length > 1) {
    errors.push(
      `Multiple completion handlers: [${completionHandlers.map((a) => a.id).join(', ')}]. ` +
        'This causes race conditions. Keep only one.'
    );
  }
}

function reportOrphanTopics(topicProducers, topicConsumers, warnings) {
  for (const [topic, producers] of topicProducers) {
    if (topic === 'CLUSTER_COMPLETE') {
      continue;
    }

    const consumers = topicConsumers.get(topic) || [];
    if (consumers.length === 0) {
      warnings.push(
        `Topic '${topic}' is produced by [${producers.join(', ')}] but never consumed. Dead end.`
      );
    }
  }
}

function reportUnproducedTopics(topicConsumers, topicProducers, errors, config) {
  const EXTERNAL_TOPICS = [
    'ISSUE_OPENED',
    'CLUSTER_RESUMED',
    'QUICK_VALIDATION_PASSED',
    'IMPLEMENTATION_READY',
    'CLUSTER_OPERATIONS_VALIDATION_FAILED', // Produced by orchestrator at runtime
    ...GUIDANCE_TOPICS,
  ];
  const isSubTemplate = config.params && Object.keys(config.params).length > 0;

  for (const [topic, consumers] of topicConsumers) {
    if (EXTERNAL_TOPICS.includes(topic)) {
      continue;
    }
    if (topic.endsWith('*')) {
      continue;
    }

    const producers = topicProducers.get(topic) || [];
    if (producers.length === 0) {
      if (isSubTemplate) {
        continue;
      }
      errors.push(
        `Topic '${topic}' consumed by [${consumers.join(', ')}] but never produced. ` +
          'These agents will never trigger.'
      );
    }
  }
}

function reportSelfTriggeringAgents(config, agentInputTopics, agentOutputTopics, errors) {
  for (const agent of config.agents) {
    const inputs = agentInputTopics.get(agent.id) || [];
    const outputs = agentOutputTopics.get(agent.id) || [];
    const selfTrigger = inputs.find((t) => outputs.includes(t));
    if (!selfTrigger) {
      continue;
    }

    const triggerHasLogic = agent.triggers?.some((t) => t.topic === selfTrigger && t.logic?.script);
    const hookHasLogic = agent.hooks?.onComplete?.logic?.script;

    if (!triggerHasLogic && !hookHasLogic) {
      errors.push(
        `Agent '${agent.id}' triggers on '${selfTrigger}' and produces '${selfTrigger}'. ` +
          'Instant infinite loop.'
      );
    }
  }
}

function reportTwoAgentCycles(config, agentInputTopics, agentOutputTopics, warnings) {
  for (const agentA of config.agents) {
    const outputsA = agentOutputTopics.get(agentA.id) || [];
    for (const agentB of config.agents) {
      if (agentA.id === agentB.id) {
        continue;
      }

      const inputsB = agentInputTopics.get(agentB.id) || [];
      const outputsB = agentOutputTopics.get(agentB.id) || [];
      const inputsA = agentInputTopics.get(agentA.id) || [];

      const aToB = outputsA.some((t) => inputsB.includes(t));
      const bToA = outputsB.some((t) => inputsA.includes(t));

      if (aToB && bToA) {
        const hasEscapeLogic =
          agentA.triggers?.some((t) => t.logic) || agentB.triggers?.some((t) => t.logic);
        if (!hasEscapeLogic) {
          warnings.push(
            `Circular dependency: '${agentA.id}' ↔ '${agentB.id}'. ` +
              'Add logic conditions to prevent infinite loop, or ensure maxIterations is set.'
          );
        }
      }
    }
  }
}

function reportMissingValidationTriggers(config, errors) {
  const validators = config.agents.filter((a) => a.role === 'validator');
  const workers = config.agents.filter((a) => a.role === 'implementation');

  if (validators.length === 0 || workers.length === 0) {
    return;
  }

  for (const worker of workers) {
    const triggersOnValidation = worker.triggers?.some(
      (t) => t.topic === 'VALIDATION_RESULT' || t.topic.includes('VALIDATION')
    );
    if (!triggersOnValidation) {
      errors.push(
        `Worker '${worker.id}' has validators but doesn't trigger on VALIDATION_RESULT. ` +
          'Rejections will be ignored. Add trigger: { "topic": "VALIDATION_RESULT", "logic": {...} }'
      );
    }
  }
}

function reportMissingContextTopics(config, warnings) {
  for (const agent of config.agents) {
    if (!agent.contextStrategy?.sources) {
      continue;
    }

    const triggerTopics = (agent.triggers || []).map((t) => t.topic);
    const contextTopics = agent.contextStrategy.sources.map((s) => s.topic);

    for (const triggerTopic of triggerTopics) {
      if (triggerTopic === 'ISSUE_OPENED' || triggerTopic === 'CLUSTER_RESUMED') {
        continue;
      }
      if (triggerTopic.endsWith('*')) {
        continue;
      }

      if (!contextTopics.includes(triggerTopic)) {
        warnings.push(
          `Agent '${agent.id}' triggers on '${triggerTopic}' but doesn't include it in contextStrategy. ` +
            'Agent may not see what triggered it.'
        );
      }
    }
  }
}

function hasDynamicLoadConfigPath(config) {
  for (const agent of config.agents || []) {
    const onComplete = agent?.hooks?.onComplete;
    if (!onComplete) continue;

    const configOps = onComplete.config?.content?.data?.operations;
    if (Array.isArray(configOps) && configOps.some((op) => op?.action === 'load_config')) {
      return true;
    }

    const script = onComplete.transform?.script;
    if (typeof script === 'string' && script.includes('load_config')) {
      return true;
    }
  }
  return false;
}

function hasReachableCompletionPath(config, topicConsumers, agentOutputTopics) {
  const agentsById = new Map((config.agents || []).map((agent) => [agent.id, agent]));
  const queue = ['ISSUE_OPENED'];
  const visitedTopics = new Set(queue);

  while (queue.length > 0) {
    const topic = queue.shift();
    if (topic === 'CLUSTER_COMPLETE') {
      return true;
    }

    const consumers = topicConsumers.get(topic) || [];
    for (const agentId of consumers) {
      const agent = agentsById.get(agentId);
      if (!agent) continue;

      const stopTrigger = (agent.triggers || []).some(
        (trigger) => trigger.topic === topic && trigger.action === 'stop_cluster'
      );
      if (stopTrigger) {
        return true;
      }

      const outputs = agentOutputTopics.get(agentId) || [];
      for (const nextTopic of outputs) {
        if (!visitedTopics.has(nextTopic)) {
          visitedTopics.add(nextTopic);
          queue.push(nextTopic);
        }
      }
    }
  }

  return false;
}

function reportMissingCompletionPath(config, topicConsumers, agentOutputTopics, errors, warnings) {
  const hasPath = hasReachableCompletionPath(config, topicConsumers, agentOutputTopics);
  if (hasPath) {
    return;
  }

  const message =
    'No reachable path from ISSUE_OPENED to terminal signal (stop_cluster or CLUSTER_COMPLETE). ' +
    'Cluster may run until timeout even when validation appears to pass.';
  const isDynamic = hasDynamicLoadConfigPath(config);
  if (isDynamic) {
    warnings.push(
      `${message} Dynamic load_config path detected; add explicit resolved-topology simulation.`
    );
    return;
  }

  const isSubTemplate = config.params && Object.keys(config.params).length > 0;
  if (isSubTemplate) {
    warnings.push(`${message} Template mode may rely on orchestrator completion injection.`);
    return;
  }

  errors.push(message);
}

function extractPublishedDataKeys(hook) {
  if (hook?.action !== 'publish_message') {
    return null;
  }
  if (hook?.config?.topic && hook?.config?.content) {
    const data = hook.config.content.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return new Set(Object.keys(data));
    }
    return new Set();
  }
  return null;
}

function extractHookTopics(hook) {
  const topics = new Set();
  if (hook?.config?.topic) {
    topics.add(String(hook.config.topic));
  }

  const script = hook?.transform?.script;
  if (typeof script === 'string') {
    const matches = script.match(/topic:\s*['"]([A-Za-z0-9_-]+)['"]/g) || [];
    for (const match of matches) {
      const topic = match.match(/['"]([A-Za-z0-9_-]+)['"]/)?.[1];
      if (topic) topics.add(topic);
    }
  }

  return topics;
}

function collectTopicContracts(config) {
  const contracts = new Map(); // topic -> [{ agentId, keys: Set<string>|null }]

  const addContract = (topic, contract) => {
    if (!contracts.has(topic)) {
      contracts.set(topic, []);
    }
    contracts.get(topic).push(contract);
  };

  for (const agent of config.agents || []) {
    const hook = agent?.hooks?.onComplete;
    if (!hook) continue;

    const topics = extractHookTopics(hook);
    const staticKeys = extractPublishedDataKeys(hook);

    for (const topic of topics) {
      const isStaticTopic = hook?.config?.topic === topic;
      if (isStaticTopic) {
        addContract(topic, { agentId: agent.id, keys: staticKeys ?? new Set() });
      } else {
        // Topic inferred from transform script. Treat as dynamic payload shape.
        addContract(topic, { agentId: agent.id, keys: null });
      }
    }

    for (const contract of getHookActionTopicContracts(hook)) {
      addContract(contract.topic, {
        agentId: agent.id,
        keys: contract.keys instanceof Set ? new Set(contract.keys) : contract.keys,
      });
    }
  }

  return contracts;
}

function extractRequiredDataKeys(script) {
  if (typeof script !== 'string') return new Set();
  const required = new Set();
  // Only treat direct `content.data.key` access as required contract keys.
  // Optional-chained access (`content?.data?.key`) is intentionally excluded.
  const regex = /\.content\.data\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let match;
  while ((match = regex.exec(script)) !== null) {
    required.add(match[1]);
  }
  return required;
}

function reportSchemaContractMismatches(config, errors, warnings) {
  const contracts = collectTopicContracts(config);
  const seen = new Set();

  for (const agent of config.agents || []) {
    for (const trigger of agent.triggers || []) {
      if (!trigger?.topic || !trigger?.logic?.script) continue;

      const requiredKeys = extractRequiredDataKeys(trigger.logic.script);
      if (requiredKeys.size === 0) continue;

      const producers = contracts.get(trigger.topic) || [];
      if (producers.length === 0) continue;

      const staticProducers = producers.filter((producer) => producer.keys instanceof Set);
      const hasDynamicProducers = producers.some((producer) => producer.keys === null);
      if (staticProducers.length === 0) continue;

      for (const key of requiredKeys) {
        const token = `${agent.id}:${trigger.topic}:${key}`;
        if (seen.has(token)) continue;
        seen.add(token);

        const hasStaticKey = staticProducers.some((producer) => producer.keys.has(key));
        if (hasStaticKey) continue;

        if (hasDynamicProducers) {
          warnings.push(
            `Agent '${agent.id}' trigger on '${trigger.topic}' expects content.data.${key}, ` +
              `but static producers for '${trigger.topic}' do not publish it (dynamic producers present).`
          );
        } else {
          errors.push(
            `Agent '${agent.id}' trigger on '${trigger.topic}' expects content.data.${key}, ` +
              `but no producer for '${trigger.topic}' publishes that data key.`
          );
        }
      }
    }
  }
}

function analyzeMessageFlow(config) {
  const errors = [];
  const warnings = [];

  const { topicProducers, topicConsumers, agentOutputTopics, agentInputTopics } =
    buildMessageFlowGraph(config);

  reportMissingBootstrap(topicConsumers, errors, config);
  reportCompletionHandlers(config, errors, warnings);
  reportOrphanTopics(topicProducers, topicConsumers, warnings);
  reportUnproducedTopics(topicConsumers, topicProducers, errors, config);
  reportSelfTriggeringAgents(config, agentInputTopics, agentOutputTopics, errors);
  reportTwoAgentCycles(config, agentInputTopics, agentOutputTopics, warnings);
  reportMissingValidationTriggers(config, errors);
  reportMissingContextTopics(config, warnings);
  reportMissingCompletionPath(config, topicConsumers, agentOutputTopics, errors, warnings);
  reportSchemaContractMismatches(config, errors, warnings);

  return { errors, warnings };
}

/**
 * Phase 3: Validate agent-specific configurations
 */
function recordAgentRole(roles, agent) {
  if (!roles.has(agent.role)) {
    roles.set(agent.role, []);
  }
  roles.get(agent.role).push(agent.id);
}

function agentExecutesTask(agent) {
  return agent.triggers?.some((t) => t.action === 'execute_task' || (!t.action && !t.logic));
}

function validateOrchestratorTriggers(agent, warnings) {
  if (agent.role !== 'orchestrator') {
    return;
  }

  if (agentExecutesTask(agent)) {
    warnings.push(
      `Orchestrator '${agent.id}' has execute_task triggers. ` +
        'Orchestrators typically use action: "stop_cluster". This may waste API calls.'
    );
  }
}

const VALIDATOR_GIT_COMMANDS = ['git diff', 'git status', 'git log', 'git show'];
const GIT_PROHIBITION_BOUNDARY = /[\n.!?;—]/;
const GIT_PROHIBITION_CONTRAST = /\b(?:but|however|yet)\b/gi;
const GIT_NEGATIVE_DIRECTIVES = [
  /\b(?:do|does|did)\s+not\b/gi,
  /\bdon['’]t\b/gi,
  /\bnever\b/gi,
  /\b(?:must|should|may)\s+not\b/gi,
  /\b(?:cannot|can['’]t)\b/gi,
  /\b(?:avoid|without)\b/gi,
  /\bforbid(?:s|den)?\b/gi,
  /\bprohibit(?:s|ed)?\b/gi,
  /\bdisallow(?:s|ed)?\b/gi,
  /\b(?:instead\s+of|rather\s+than)\b/gi,
];
const GIT_USAGE_VERB =
  /\b(?:use|using|run|running|invoke|invoking|execute|executing|call|calling|inspect|inspecting|check|checking|read|reading|mention|mentioning|rely|relying|shell)\b/i;

function clauseSlice(prompt, index, commandLength) {
  let start = index;
  while (start > 0 && !GIT_PROHIBITION_BOUNDARY.test(prompt[start - 1])) start--;

  let end = index + commandLength;
  while (end < prompt.length && !GIT_PROHIBITION_BOUNDARY.test(prompt[end])) end++;

  return {
    before: prompt.slice(start, index),
    after: prompt.slice(index + commandLength, end),
    clause: prompt.slice(start, end).trim(),
  };
}

function lastRegexMatch(input, regex) {
  regex.lastIndex = 0;
  let last = null;
  let match;
  while ((match = regex.exec(input)) !== null) last = match;
  return last;
}

function lastRegexMatchAny(input, regexes) {
  let last = null;
  for (const regex of regexes) {
    const match = lastRegexMatch(input, regex);
    if (match && (!last || match.index > last.index)) last = match;
  }
  return last;
}

function isPostCommandProhibition(after) {
  const normalized = after.trimStart().toLowerCase();
  const prefixes = ['is ', 'are ', 'must be ', 'should be '];
  const prefix = prefixes.find((candidate) => normalized.startsWith(candidate));
  if (!prefix) return false;

  let description = normalized.slice(prefix.length);
  if (description.startsWith('strictly ')) description = description.slice('strictly '.length);

  const prohibited = ['forbidden', 'prohibited', 'disallowed', 'not allowed'];
  if (prohibited.some((word) => description.startsWith(word))) return true;

  return /^unreliable\s+and\s+(?:must|should)\s+not\s+be\s+used\b/i.test(description);
}

function isExplicitGitProhibition(prompt, index, commandLength) {
  const { before, after } = clauseSlice(prompt, index, commandLength);
  const contrast = lastRegexMatch(before, GIT_PROHIBITION_CONTRAST);
  const scopedBefore = contrast ? before.slice(contrast.index + contrast[0].length) : before;
  const directive = lastRegexMatchAny(scopedBefore, GIT_NEGATIVE_DIRECTIVES);

  if (directive) {
    const scope = scopedBefore.slice(directive.index + directive[0].length);
    const reversesNegation = /^\s*(?:forget|fail|neglect|omit)\s+to\b/i.test(scope);
    if (!reversesNegation && (scope.trim() === '' || GIT_USAGE_VERB.test(scope))) return true;
  }

  return isPostCommandProhibition(after);
}

function validateValidatorGitUsage(agent, errors) {
  if (agent.role !== 'validator') {
    return;
  }

  const prompt = typeof agent.prompt === 'string' ? agent.prompt : agent.prompt?.system;
  if (typeof prompt !== 'string') return;

  const lowerPrompt = prompt.toLowerCase();
  for (const command of VALIDATOR_GIT_COMMANDS) {
    let index = lowerPrompt.indexOf(command);
    while (index !== -1) {
      if (!isExplicitGitProhibition(prompt, index, command.length)) {
        const { clause } = clauseSlice(prompt, index, command.length);
        const excerpt = clause.length > 120 ? `${clause.slice(0, 117)}...` : clause;
        errors.push(
          `Validator '${agent.id}' instructs use of '${command}' (${JSON.stringify(excerpt)}). ` +
            `Remove the git command instruction and read files directly; explicit prohibitions ` +
            `like "do not use ${command}" are allowed.`
        );
      }
      index = lowerPrompt.indexOf(command, index + command.length);
    }
  }
}

function validateJsonOutputSchema(agent, warnings) {
  if (agent.outputFormat === 'json' && !agent.jsonSchema) {
    warnings.push(
      `Agent '${agent.id}' has outputFormat: 'json' but no jsonSchema. ` +
        'Output parsing may be unreliable.'
    );
  }
}

function validateMaxIterations(agent, warnings) {
  if (agent.maxIterations && agent.maxIterations > 50) {
    warnings.push(
      `Agent '${agent.id}' has maxIterations: ${agent.maxIterations}. ` +
        'This may consume significant API credits if stuck in a loop.'
    );
  }
}

function validateImplementationIterations(agent, warnings) {
  if (agent.role === 'implementation' && !agent.maxIterations) {
    warnings.push(
      `Implementation agent '${agent.id}' has no maxIterations. ` +
        'Defaults to 30, but consider setting explicitly.'
    );
  }
}

function validateModelSpec(agent, errors) {
  if (agent.model) {
    errors.push(
      `Agent '${agent.id}' uses 'model: "${agent.model}"'. ` +
        `Use 'modelLevel: "level1|level2|level3"' instead for provider-agnostic model selection.`
    );
  }
}

function findRoleReferences(script) {
  const matches = script.match(/getAgentsByRole\(['"](\w+)['"]\)/g);
  if (!matches) {
    return [];
  }

  return matches.map((match) => match.match(/['"](\w+)['"]/)[1]);
}

function warnMissingRoleReferences(agents, roles, warnings) {
  for (const agent of agents) {
    for (const trigger of agent.triggers || []) {
      if (!trigger.logic?.script) {
        continue;
      }

      const script = trigger.logic.script;
      const rolesReferenced = findRoleReferences(script);
      if (rolesReferenced.length === 0) {
        continue;
      }

      for (const role of rolesReferenced) {
        if (!roles.has(role)) {
          warnings.push(
            `Agent '${agent.id}' logic references role '${role}' but no agent has that role. ` +
              `Trigger may be a no-op. Available roles: [${Array.from(roles.keys()).join(', ')}]`
          );
        }
      }
    }
  }
}

function validateAgents(config) {
  const errors = [];
  const warnings = [];

  const roles = new Map(); // role -> [agentIds]

  for (const agent of config.agents) {
    recordAgentRole(roles, agent);
    validateOrchestratorTriggers(agent, warnings);
    validateValidatorGitUsage(agent, errors);
    validateJsonOutputSchema(agent, warnings);
    validateMaxIterations(agent, warnings);
    validateImplementationIterations(agent, warnings);
    validateModelSpec(agent, errors);
  }

  // Check for role references in logic scripts
  // IMPORTANT: Changed from error to warning because some triggers are designed to be
  // no-ops when the referenced role doesn't exist (e.g., worker's VALIDATION_RESULT
  // trigger returns false when validators.length === 0)
  warnMissingRoleReferences(config.agents, roles, warnings);

  return { errors, warnings };
}

/**
 * Phase 4: Validate logic scripts (syntax only, not semantics)
 */
function validateLogicScripts(config) {
  const errors = [];
  const warnings = [];

  const vm = require('vm');

  for (const agent of config.agents) {
    for (const trigger of agent.triggers || []) {
      if (!trigger.logic?.script) continue;

      const script = trigger.logic.script;

      // Syntax check
      try {
        // codeql[js/bad-code-sanitization] Validator compiles repo-authored config scripts only to report syntax errors before runtime sandbox execution.
        const wrappedScript = `(function() { ${script} })()`;
        new vm.Script(wrappedScript);
      } catch (syntaxError) {
        errors.push(`Agent '${agent.id}' has invalid logic script: ${syntaxError.message}`);
        continue;
      }

      // Check for common mistakes - only flag if script is JUST "return false" or "return true"
      // Complex scripts with conditionals should not trigger this
      const trimmedScript = script.trim().replace(/\s+/g, ' ');
      const isSimpleReturnFalse = /^return\s+false;?$/.test(trimmedScript);
      const isSimpleReturnTrue = /^return\s+true;?$/.test(trimmedScript);

      if (isSimpleReturnFalse) {
        warnings.push(
          `Agent '${agent.id}' logic is just 'return false'. Agent will never trigger.`
        );
      }

      if (isSimpleReturnTrue) {
        warnings.push(
          `Agent '${agent.id}' logic is just 'return true'. Consider adding conditions or removing the logic block.`
        );
      }

      // Check for undefined variable access (common typos)
      const knownVars = [
        'ledger',
        'cluster',
        'message',
        'agent',
        'helpers',
        'Set',
        'Map',
        'Array',
        'Object',
        'JSON',
        'Date',
        'Math',
      ];
      const varPattern = /\b([a-zA-Z_]\w*)\s*\./g;
      let match;
      while ((match = varPattern.exec(script)) !== null) {
        const varName = match[1];
        if (
          !knownVars.includes(varName) &&
          !script.includes(`const ${varName}`) &&
          !script.includes(`let ${varName}`)
        ) {
          warnings.push(
            `Agent '${agent.id}' logic uses '${varName}' which may be undefined. ` +
              `Available: [${knownVars.join(', ')}]`
          );
          break; // Only warn once per agent
        }
      }
    }
  }

  return { errors, warnings };
}

/**
 * Phase 5: Validate template variables against jsonSchema
 * Ensures {{result.*}} references in hooks match defined schema properties
 *
 * Issue #14 - Gap 3:
 * - Gap 3: Template variables don't exist (line 582-656)
 *
 */
function validateTemplateVariables(config, depth = 0) {
  const errors = [];
  const warnings = [];

  if (!config.agents || !Array.isArray(config.agents)) {
    return { errors, warnings };
  }

  const prefix = depth > 0 ? `Sub-cluster (depth ${depth}): ` : '';

  for (const agent of config.agents) {
    // Skip subclusters - they have their own validation
    if (agent.type === 'subcluster') {
      // Recursively validate subcluster config
      if (agent.config?.agents) {
        const subResult = validateTemplateVariables(agent.config, depth + 1);
        // Prefix sub-cluster errors with agent ID
        errors.push(...subResult.errors.map((e) => `Sub-cluster '${agent.id}': ${e}`));
        warnings.push(...subResult.warnings.map((w) => `Sub-cluster '${agent.id}': ${w}`));
      }
      continue;
    }

    const result = validateAgentTemplateVariables(agent, agent.id);
    errors.push(...result.errors.map((e) => `${prefix}${e}`));
    warnings.push(...result.warnings.map((w) => `${prefix}${w}`));
  }

  return { errors, warnings };
}

/**
 * Validate template variables for a single agent
 * @param {Object} agent - Agent configuration
 * @param {String} agentId - Agent ID for error messages
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateAgentTemplateVariables(agent, agentId) {
  const errors = [];
  const warnings = [];

  // Extract schema properties (null if non-JSON output or text output)
  const schemaProps = extractSchemaProperties(agent);

  // If schemaProps is null, this agent doesn't use JSON output - skip validation
  if (schemaProps === null) {
    return { errors, warnings };
  }

  // Extract template variables from hooks
  const templateVars = extractTemplateVariables(agent);

  // Check for undefined references (ERROR)
  for (const varName of templateVars) {
    if (!schemaProps.has(varName)) {
      const availableProps = Array.from(schemaProps).join(', ');
      errors.push(
        `Agent '${agentId}': Template uses '{{result.${varName}}}' but '${varName}' is not defined in jsonSchema. ` +
          `Available properties: [${availableProps}]`
      );
    }
  }

  // Check for unused schema properties (WARNING)
  for (const prop of schemaProps) {
    if (!templateVars.has(prop)) {
      warnings.push(
        `Agent '${agentId}': Schema property '${prop}' is defined but never referenced in hooks. ` +
          `Consider removing it to save tokens.`
      );
    }
  }

  return { errors, warnings };
}

/**
 * Extract all template variables ({{result.*}}) from agent hooks
 * Searches hooks.onComplete.config (recursive) and hooks.onComplete.transform.script
 * Also searches triggers[].onComplete patterns
 * @param {Object} agent - Agent configuration
 * @returns {Set<string>} Set of variable names referenced
 */
function extractTemplateVariables(agent) {
  const variables = new Set();

  // Regex patterns - reset lastIndex before each use to avoid state pollution
  const mustachePattern = /\{\{result\.([^}]+)\}\}/g;
  const directPattern = /\bresult\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

  /**
   * Recursively traverse an object/array and extract template variables from strings
   */
  function traverseAndExtract(obj) {
    if (obj === null || obj === undefined) {
      return;
    }

    if (typeof obj === 'string') {
      // Extract mustache-style {{result.field}}
      mustachePattern.lastIndex = 0;
      let match;
      while ((match = mustachePattern.exec(obj)) !== null) {
        variables.add(match[1]);
      }
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        traverseAndExtract(item);
      }
      return;
    }

    if (typeof obj === 'object') {
      for (const value of Object.values(obj)) {
        traverseAndExtract(value);
      }
    }
  }

  /**
   * Extract variables from transform script (direct result.field access)
   */
  function extractFromScript(script) {
    if (typeof script !== 'string') {
      return;
    }

    directPattern.lastIndex = 0;
    let match;
    while ((match = directPattern.exec(script)) !== null) {
      variables.add(match[1]);
    }
  }

  // Extract from hooks.onComplete.config
  if (agent.hooks?.onComplete?.config) {
    traverseAndExtract(agent.hooks.onComplete.config);
  }

  // Extract from hooks.onComplete.transform.script
  if (agent.hooks?.onComplete?.transform?.script) {
    extractFromScript(agent.hooks.onComplete.transform.script);
  }

  // Extract from triggers[].onComplete (some agents define hooks per-trigger)
  if (agent.triggers && Array.isArray(agent.triggers)) {
    for (const trigger of agent.triggers) {
      if (trigger.onComplete?.config) {
        traverseAndExtract(trigger.onComplete.config);
      }
      if (trigger.onComplete?.transform?.script) {
        extractFromScript(trigger.onComplete.transform.script);
      }
    }
  }

  return variables;
}

/**
 * Extract schema properties from agent's jsonSchema
 * @param {Object} agent - Agent configuration
 * @returns {Set<string>|null} Set of property names, or null if agent doesn't use JSON output
 */
function extractSchemaProperties(agent) {
  // Non-JSON agents don't need validation
  // Both 'json' and 'stream-json' use jsonSchema and need validation
  if (!['json', 'stream-json'].includes(agent.outputFormat)) {
    return null;
  }

  // If explicit schema is provided, use its properties
  if (agent.jsonSchema?.properties) {
    return new Set(Object.keys(agent.jsonSchema.properties));
  }

  // Default schema when outputFormat is 'json' but no explicit schema
  // See: agent-config.js:62-69
  return new Set(['summary', 'result']);
}

/**
 * Check if iteration pattern is valid
 */
function isValidIterationPattern(pattern) {
  if (pattern === 'all') return true;
  if (/^\d+$/.test(pattern)) return true; // "1"
  if (/^\d+-\d+$/.test(pattern)) return true; // "1-3"
  if (/^\d+\+$/.test(pattern)) return true; // "5+"
  return false;
}

/**
 * Format validation result for CLI output
 */
function formatValidationResult(result) {
  const lines = [];

  if (result.valid) {
    lines.push('✅ Configuration is valid');
  } else {
    lines.push('❌ Configuration has errors');
  }

  if (result.errors.length > 0) {
    lines.push('\nErrors:');
    for (const error of result.errors) {
      lines.push(`  ❌ ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('\nWarnings:');
    for (const warning of result.warnings) {
      lines.push(`  ⚠️  ${warning}`);
    }
  }

  return lines.join('\n');
}

/**
 * Phase 6: Hook semantic validation
 * Catches runtime failures in hook execution (agent-hook-executor.js)
 *
 * Issue #14 - Gaps 1, 2, 7:
 * - Gap 1: Hook action field missing (line 837-842)
 * - Gap 2: Transform script output shape (line 846-866)
 * - Gap 7: Conductor CLUSTER_OPERATIONS payload (line 869-888)
 *
 * @param {Object} config - Cluster configuration
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateHookAction(hook, prefix, errors) {
  if (!hook.action) {
    errors.push(
      `[Gap 1] ${prefix}: Missing 'action' field. ` +
        `Fix: Add "action": "publish_message", "action": "execute_system_command", ` +
        `or "action": "verify_pull_request"`
    );
  }
}

function validateTransformScript(hook, prefix, errors) {
  if (!hook.transform?.script) {
    return;
  }

  const script = hook.transform.script;
  const hasReturnTopic = /return\s*\{[^}]*topic\s*:/i.test(script);
  const hasReturnContent = /return\s*\{[^}]*content\s*:/i.test(script);

  if (!hasReturnTopic) {
    errors.push(
      `[Gap 2] ${prefix}: Transform script must return object with 'topic' property. ` +
        `Fix: return { topic: "TOPIC_NAME", content: {...} }`
    );
  }

  if (!hasReturnContent) {
    errors.push(
      `[Gap 2] ${prefix}: Transform script must return object with 'content' property. ` +
        `Fix: return { topic: "...", content: { data: result } }`
    );
  }
}

function validateConductorOperations(agent, hook, prefix, errors) {
  const targetsClusterOperations =
    hook.config?.topic === 'CLUSTER_OPERATIONS' ||
    hook.transform?.script?.includes('CLUSTER_OPERATIONS');

  if (agent.role !== 'conductor' || !targetsClusterOperations) {
    return;
  }

  if (!hook.transform?.script) {
    return;
  }

  const script = hook.transform.script;
  const hasOperations = /operations\s*:/i.test(script);
  if (!hasOperations) {
    errors.push(
      `[Gap 7] ${prefix}: CLUSTER_OPERATIONS message must include 'operations' field. ` +
        `Fix: return { topic: "CLUSTER_OPERATIONS", content: { data: { operations: JSON.stringify([...]) } } }`
    );
  }
}

function validateHookLogic(hook, prefix, errors) {
  if (!hook.logic) {
    return;
  }

  if (hook.logic.engine && hook.logic.engine !== 'javascript') {
    errors.push(`${prefix}: Hook logic engine must be 'javascript', got: '${hook.logic.engine}'`);
  }

  if (!hook.logic.script) {
    errors.push(`${prefix}: Hook logic must have a 'script' property`);
  } else if (typeof hook.logic.script !== 'string') {
    errors.push(`${prefix}: Hook logic script must be a string`);
  } else {
    try {
      const vm = require('vm');
      // codeql[js/bad-code-sanitization] Validator compiles repo-authored hook logic only to report syntax errors before runtime sandbox execution.
      const wrappedScript = `(function() { 'use strict'; ${hook.logic.script} })()`;
      new vm.Script(wrappedScript);
    } catch (syntaxError) {
      errors.push(`${prefix}: Hook logic script has syntax error: ${syntaxError.message}`);
    }
  }

  if (!hook.config && !hook.transform) {
    errors.push(
      `${prefix}: Hook with logic block must also have 'config' or 'transform'. ` +
        `Logic provides overrides, not the full message.`
    );
  }
}

function validateHookSemantics(config) {
  const errors = [];
  const warnings = [];

  if (!config.agents || !Array.isArray(config.agents)) {
    return { errors, warnings };
  }

  for (const agent of config.agents) {
    // Skip subclusters - they have their own validation
    if (agent.type === 'subcluster') {
      continue;
    }

    const hooks = agent.hooks || {};
    const hookTypes = ['onComplete', 'onFailure', 'onTimeout'];

    for (const hookType of hookTypes) {
      const hook = hooks[hookType];
      if (!hook) continue;

      const prefix = `Agent '${agent.id}' hooks.${hookType}`;

      // === GAP 1: Hook action field missing ===
      // Causes runtime crash at agent-hook-executor.js:66
      validateHookAction(hook, prefix, errors);

      // === GAP 2: Transform script output shape validation ===
      // Causes runtime crash at agent-hook-executor.js:148
      validateTransformScript(hook, prefix, errors);

      // === GAP 7: CLUSTER_OPERATIONS payload validation ===
      // Causes runtime crash at orchestrator.js:722
      validateConductorOperations(agent, hook, prefix, errors);

      // === Logic block validation ===
      // Logic blocks allow conditional config overrides (like trigger logic)
      validateHookLogic(hook, prefix, errors);
    }
  }

  return { errors, warnings };
}

/**
 * Phase 7: Rule coverage validation
 * Catches gaps in model rules and prompt rules that cause runtime failures
 *
 * Issue #14 - Gaps 4, 5:
 * - Gap 4: Model rule iteration gaps (line 916-963)
 * - Gap 5: Prompt rule iteration gaps (line 965-1014)
 *
 * @param {Object} config - Cluster configuration
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateRuleCoverage(config) {
  const errors = [];
  const warnings = [];

  if (!config.agents || !Array.isArray(config.agents)) {
    return { errors, warnings };
  }

  const applyIterationPattern = (coveredIterations, pattern, maxIterations) => {
    if (!pattern) return;

    if (pattern === 'all') {
      for (let i = 1; i <= maxIterations; i++) {
        coveredIterations.add(i);
      }
      return;
    }

    if (/^\d+$/.test(pattern)) {
      coveredIterations.add(parseInt(pattern, 10));
      return;
    }

    if (/^\d+-\d+$/.test(pattern)) {
      const [start, end] = pattern.split('-').map((n) => parseInt(n, 10));
      for (let i = start; i <= end; i++) {
        coveredIterations.add(i);
      }
      return;
    }

    if (/^\d+\+$/.test(pattern)) {
      const start = parseInt(pattern, 10);
      for (let i = start; i <= maxIterations; i++) {
        coveredIterations.add(i);
      }
    }
  };

  const collectCoverage = (rules, maxIterations) => {
    const coveredIterations = new Set();
    for (const rule of rules) {
      applyIterationPattern(coveredIterations, rule.iterations, maxIterations);
    }
    return coveredIterations;
  };

  const findUncoveredIterations = (coveredIterations, maxIterations) => {
    const uncoveredIterations = [];
    for (let i = 1; i <= maxIterations; i++) {
      if (!coveredIterations.has(i)) {
        uncoveredIterations.push(i);
      }
    }
    return uncoveredIterations;
  };

  const reportCoverageGap = (agent, gapNumber, label, fixHint, uncoveredIterations) => {
    if (uncoveredIterations.length === 0) {
      return;
    }
    const ranges = groupConsecutive(uncoveredIterations);
    errors.push(
      `[Gap ${gapNumber}] Agent '${agent.id}': ${label} have gaps at iterations ${ranges.join(', ')}. ` +
        `Fix: ${fixHint}`
    );
  };

  for (const agent of config.agents) {
    if (agent.type === 'subcluster') {
      continue;
    }

    const maxIterations = agent.maxIterations || 30;

    // === GAP 4: Model rule iteration gaps ===
    // Causes runtime crash at agent-wrapper.js:154
    if (agent.modelRules && Array.isArray(agent.modelRules)) {
      const coveredIterations = collectCoverage(agent.modelRules, maxIterations);
      const uncoveredIterations = findUncoveredIterations(coveredIterations, maxIterations);
      reportCoverageGap(
        agent,
        4,
        'Model rules',
        'Add catch-all rule { "iterations": "all", "modelLevel": "level2" } or extend existing ranges.',
        uncoveredIterations
      );
    }

    // === GAP 5: Prompt rule iteration gaps ===
    // Causes runtime crash at agent-wrapper.js:222
    if (
      agent.promptConfig &&
      agent.promptConfig.type === 'rules' &&
      agent.promptConfig.rules &&
      Array.isArray(agent.promptConfig.rules)
    ) {
      const coveredIterations = collectCoverage(agent.promptConfig.rules, maxIterations);
      const uncoveredIterations = findUncoveredIterations(coveredIterations, maxIterations);
      reportCoverageGap(
        agent,
        5,
        'Prompt rules',
        'Add catch-all rule { "iterations": "all", "prompt": "..." } or extend existing ranges.',
        uncoveredIterations
      );
    }
  }

  return { errors, warnings };
}

/**
 * Helper: Group consecutive numbers into ranges for readable output
 * Example: [1, 2, 3, 5, 7, 8, 9] -> ["1-3", "5", "7-9"]
 */
function groupConsecutive(numbers) {
  if (numbers.length === 0) return [];

  const sorted = [...numbers].sort((a, b) => a - b);
  const ranges = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === rangeEnd + 1) {
      rangeEnd = sorted[i];
    } else {
      // End of range
      if (rangeStart === rangeEnd) {
        ranges.push(`${rangeStart}`);
      } else {
        ranges.push(`${rangeStart}-${rangeEnd}`);
      }
      rangeStart = sorted[i];
      rangeEnd = sorted[i];
    }
  }

  // Add final range
  if (rangeStart === rangeEnd) {
    ranges.push(`${rangeStart}`);
  } else {
    ranges.push(`${rangeStart}-${rangeEnd}`);
  }

  return ranges;
}

/**
 * Phase 8: N-agent cycle detection
 * Detects circular dependencies with 3+ agents using DFS
 *
 * Issue #14 - Gap 6:
 * - Gap 6: 3+ agent circular dependencies (line 1060-1165)
 *
 * @param {Object} config - Cluster configuration
 * @returns {{ errors: string[], warnings: string[] }}
 */
function collectAgentDependencies(agent, topicProducers) {
  const dependencies = new Set();

  for (const trigger of agent.triggers || []) {
    const topic = trigger.topic;
    if (topic === 'ISSUE_OPENED' || topic === 'CLUSTER_RESUMED') continue;
    if (topic.endsWith('*')) continue;

    const producers = topicProducers.get(topic) || [];
    for (const producer of producers) {
      if (producer !== agent.id) {
        dependencies.add(producer);
      }
    }
  }

  return Array.from(dependencies);
}

function buildAgentGraph(config) {
  const agentGraph = new Map();
  const topicProducers = new Map();

  for (const agent of config.agents) {
    if (agent.type === 'subcluster') continue;
    agentGraph.set(agent.id, []);

    const outputTopic = agent.hooks?.onComplete?.config?.topic;
    if (!outputTopic) continue;

    if (!topicProducers.has(outputTopic)) {
      topicProducers.set(outputTopic, []);
    }
    topicProducers.get(outputTopic).push(agent.id);
  }

  for (const agent of config.agents) {
    if (agent.type === 'subcluster') continue;
    agentGraph.set(agent.id, collectAgentDependencies(agent, topicProducers));
  }

  return agentGraph;
}

function findFirstCycle(agentGraph) {
  const visited = new Set();
  const recursionStack = new Set();

  const dfs = (agentId, path) => {
    visited.add(agentId);
    recursionStack.add(agentId);

    const dependencies = agentGraph.get(agentId) || [];
    for (const nextAgent of dependencies) {
      if (recursionStack.has(nextAgent)) {
        const cycleStartIndex = path.indexOf(nextAgent);
        return [...path.slice(cycleStartIndex), nextAgent];
      }

      if (!visited.has(nextAgent)) {
        const cycle = dfs(nextAgent, [...path, nextAgent]);
        if (cycle) return cycle;
      }
    }

    recursionStack.delete(agentId);
    return null;
  };

  for (const agentId of agentGraph.keys()) {
    if (!visited.has(agentId)) {
      const cycle = dfs(agentId, [agentId]);
      if (cycle) return cycle;
    }
  }

  return null;
}

function detectNAgentCycles(config) {
  const errors = [];
  const warnings = [];

  if (!config.agents || !Array.isArray(config.agents)) {
    return { errors, warnings };
  }

  const agentGraph = buildAgentGraph(config);
  const cycle = findFirstCycle(agentGraph);

  if (cycle) {
    const agentsById = new Map(
      config.agents.filter((agent) => agent.type !== 'subcluster').map((agent) => [agent.id, agent])
    );
    const hasEscapeLogic = cycle.some((id) => agentsById.get(id)?.triggers?.some((t) => t.logic));
    const cycleStr = cycle.join(' → ');

    if (!hasEscapeLogic) {
      errors.push(
        `[Gap 6] Circular dependency detected: ${cycleStr}. ` +
          `Fix: Add logic conditions to break the loop, or set maxIterations on involved agents.`
      );
    } else {
      warnings.push(
        `Circular dependency detected: ${cycleStr}. ` +
          `Has escape logic in triggers, but verify maxIterations is set to prevent infinite loops.`
      );
    }
  }

  return { errors, warnings };
}

function collectAgentIdConflicts(agents, errors) {
  const allAgentIds = new Map();

  const collectAgentIds = (list, depth = 0) => {
    if (!list) return;

    for (const agent of list) {
      if (!agent.id) continue;

      if (allAgentIds.has(agent.id)) {
        const firstSeenDepth = allAgentIds.get(agent.id);
        errors.push(
          `[Gap 11] Duplicate agent ID '${agent.id}' found across cluster hierarchy ` +
            `(first at depth ${firstSeenDepth}, duplicate at depth ${depth}). ` +
            `Fix: Ensure all agent IDs are unique across the entire cluster.`
        );
      } else {
        allAgentIds.set(agent.id, depth);
      }

      if (agent.type === 'subcluster' && agent.config?.agents) {
        collectAgentIds(agent.config.agents, depth + 1);
      }
    }
  };

  collectAgentIds(agents);
}

function buildTopicProducers(agents) {
  const topicProducers = new Map();

  for (const agent of agents) {
    if (agent.type === 'subcluster') continue;
    const outputTopic = agent.hooks?.onComplete?.config?.topic;
    if (!outputTopic) continue;

    if (!topicProducers.has(outputTopic)) {
      topicProducers.set(outputTopic, []);
    }
    topicProducers.get(outputTopic).push(agent.id);
  }

  return topicProducers;
}

function validateJsonSchema(prefix, agent, errors) {
  if (!agent.jsonSchema) return;

  try {
    JSON.stringify(agent.jsonSchema);

    if (typeof agent.jsonSchema !== 'object') {
      errors.push(
        `[Gap 8] ${prefix}: jsonSchema must be an object, got ${typeof agent.jsonSchema}. ` +
          `Fix: Use valid JSON Schema format with 'type' and 'properties' fields.`
      );
    }
  } catch (error) {
    errors.push(
      `[Gap 8] ${prefix}: jsonSchema is not valid JSON: ${error.message}. ` +
        `Fix: Ensure schema is a valid JSON object.`
    );
  }
}

function validateContextSource(prefix, source, topicProducers, errors, warnings) {
  const topic = source.topic;
  if (topic === 'ISSUE_OPENED' || topic === 'CLUSTER_RESUMED' || topic === 'STATE_SNAPSHOT') {
    return;
  }
  if (topic.endsWith('*')) return;

  const resolvedAmount = source.amount ?? source.limit;
  const resolvedStrategy = source.strategy ?? (resolvedAmount !== undefined ? 'latest' : 'all');

  const producers = topicProducers.get(topic) || [];
  if (producers.length === 0) {
    warnings.push(
      `[Gap 9] ${prefix}: Context source topic '${topic}' is never produced. ` +
        `Agent will get empty context for this source.`
    );
  }

  if (resolvedAmount === undefined && resolvedStrategy !== 'all') {
    warnings.push(
      `[Gap 14] ${prefix}: Context source for topic '${topic}' missing 'amount' field. ` +
        `Defaults may not be what you expect.`
    );
  }

  if (source.strategy && !['latest', 'all', 'oldest'].includes(source.strategy)) {
    errors.push(
      `[Gap 14] ${prefix}: Context source strategy '${source.strategy}' is invalid. ` +
        `Fix: Use 'latest', 'all', or 'oldest'.`
    );
  }

  if (source.priority && !['required', 'high', 'medium', 'low'].includes(source.priority)) {
    errors.push(
      `[Gap 14] ${prefix}: Context source priority '${source.priority}' is invalid. ` +
        `Fix: Use 'required', 'high', 'medium', or 'low'.`
    );
  }

  if (source.compactStrategy && !['latest', 'all', 'oldest'].includes(source.compactStrategy)) {
    errors.push(
      `[Gap 14] ${prefix}: Context source compactStrategy '${source.compactStrategy}' is invalid. ` +
        `Fix: Use 'latest', 'all', or 'oldest'.`
    );
  }

  if (source.compactAmount !== undefined) {
    if (!Number.isFinite(source.compactAmount) || source.compactAmount <= 0) {
      errors.push(
        `[Gap 14] ${prefix}: Context source compactAmount must be a positive number, got ${source.compactAmount}. ` +
          `Fix: Use a positive integer like 1 or 3.`
      );
    }
  }
}

function validateContextSources(prefix, agent, topicProducers, errors, warnings) {
  if (!agent.contextStrategy?.sources) return;

  for (const source of agent.contextStrategy.sources) {
    validateContextSource(prefix, source, topicProducers, errors, warnings);
  }
}

function validateIsolationConfig(prefix, agent, path, errors, warnings) {
  if (!agent.isolation) return;

  if (agent.isolation.type === 'docker') {
    if (!agent.isolation.image) {
      errors.push(
        `[Gap 10] ${prefix}: Docker isolation requires 'image' field. ` +
          `Fix: Add "image": "zeroshot-runner" or custom image name.`
      );
    }

    if (agent.isolation.mounts) {
      for (const mount of agent.isolation.mounts) {
        if (mount.host && !path.isAbsolute(mount.host)) {
          warnings.push(
            `[Gap 10] ${prefix}: Docker mount host path '${mount.host}' is not absolute. ` +
              `May cause runtime errors.`
          );
        }
      }
    }

    return;
  }

  if (agent.isolation.type && agent.isolation.type !== 'worktree') {
    errors.push(
      `[Gap 10] ${prefix}: Unknown isolation type '${agent.isolation.type}'. ` +
        `Fix: Use 'docker' or 'worktree'.`
    );
  }
}

function validateLoadConfig(prefix, agent, fs, errors) {
  if (!agent.loadConfig) return;
  const configPath = agent.loadConfig.path;
  if (configPath && !fs.existsSync(configPath)) {
    errors.push(
      `[Gap 12] ${prefix}: Load config file '${configPath}' does not exist. ` +
        `Fix: Check file path or remove loadConfig.`
    );
  }
}

function validateTaskExecutor(prefix, agent, errors) {
  if (!agent.taskExecutor) return;

  if (agent.taskExecutor.command === undefined) {
    errors.push(
      `[Gap 13] ${prefix}: Task executor missing 'command' field. ` +
        `Fix: Add "command": "claude" or custom command.`
    );
  }

  if (agent.taskExecutor.retries !== undefined) {
    if (typeof agent.taskExecutor.retries !== 'number' || agent.taskExecutor.retries < 0) {
      errors.push(
        `[Gap 13] ${prefix}: Task executor 'retries' must be a non-negative number, got ${agent.taskExecutor.retries}. ` +
          `Fix: Use a positive integer or 0.`
      );
    }
  }

  if (agent.taskExecutor.timeout !== undefined) {
    if (typeof agent.taskExecutor.timeout !== 'number' || agent.taskExecutor.timeout <= 0) {
      errors.push(
        `[Gap 13] ${prefix}: Task executor 'timeout' must be a positive number, got ${agent.taskExecutor.timeout}. ` +
          `Fix: Use a positive number in milliseconds.`
      );
    }
  }
}

function validateRoleReferences(prefix, agent, roles, errors) {
  for (const trigger of agent.triggers || []) {
    if (!trigger.logic?.script) continue;
    const script = trigger.logic.script;
    const roleMatches = script.match(/getAgentsByRole\(['"](\w+)['"]\)/g);

    if (!roleMatches) continue;

    for (const match of roleMatches) {
      const role = match.match(/['"](\w+)['"]/)[1];
      if (roles.has(role)) continue;

      const isCritical =
        /\.length\s*[><=!]/.test(script) ||
        /allResponded/.test(script) ||
        /hasConsensus/.test(script);

      const hasZeroLengthFallback =
        /\.length\s*===?\s*0\s*\)\s*return/.test(script) || /\.length\s*[<]=\s*0/.test(script);

      if (isCritical && !hasZeroLengthFallback) {
        errors.push(
          `[Gap 15] ${prefix}: Logic references role '${role}' which doesn't exist. ` +
            `This will cause logic to fail. Fix: Add agent with role '${role}' or update logic.`
        );
      }
    }
  }
}

/**
 * Phase 9: Configuration semantic validation
 * Validates configuration fields that can cause runtime failures
 *
 * Issue #14 - Gaps 8-15:
 * - Gap 8: JSON schema structurally invalid (line 1219-1237)
 * - Gap 9: Context sources never produced (line 1240-1283)
 * - Gap 10: Isolation config invalid (line 1286-1312)
 * - Gap 11: Agent ID conflicts across subclusters (line 1185-1212)
 * - Gap 12: Load config file paths don't exist (line 1315-1323)
 * - Gap 13: Task executor config invalid (line 1326-1352)
 * - Gap 14: Context source format invalid (line 1270-1282)
 * - Gap 15: Role references in logic (stricter) (line 1354-1383)
 *
 * @param {Object} config - Cluster configuration
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateConfigSemantics(config) {
  const errors = [];
  const warnings = [];

  if (!config.agents || !Array.isArray(config.agents)) {
    return { errors, warnings };
  }

  const fs = require('fs');
  const path = require('path');

  // === GAP 11: Agent ID conflicts across subclusters ===
  collectAgentIdConflicts(config.agents, errors);

  const topicProducers = buildTopicProducers(config.agents);
  const roles = new Set(
    config.agents.filter((agent) => agent.type !== 'subcluster').map((agent) => agent.role)
  );

  for (const agent of config.agents) {
    if (agent.type === 'subcluster') continue;

    const prefix = `Agent '${agent.id}'`;

    // === GAP 8: JSON schema structurally invalid ===
    validateJsonSchema(prefix, agent, errors);

    // === GAP 9: Context sources never produced (enhanced check) ===
    // Already partially covered in Phase 2, but add stricter checks
    validateContextSources(prefix, agent, topicProducers, errors, warnings);

    // === GAP 10: Isolation config invalid ===
    validateIsolationConfig(prefix, agent, path, errors, warnings);

    // === GAP 12: Load config file paths don't exist ===
    validateLoadConfig(prefix, agent, fs, errors);

    // === GAP 13: Task executor config invalid ===
    validateTaskExecutor(prefix, agent, errors);

    // === GAP 15: Stricter role reference validation ===
    // Upgrade from WARNING to ERROR when role is used in critical logic
    validateRoleReferences(prefix, agent, roles, errors);
  }

  return { errors, warnings };
}

function resolveProviderName(agent, config, settings) {
  const resolved =
    config.forceProvider ||
    agent.provider ||
    config.defaultProvider ||
    settings.defaultProvider ||
    'claude';
  return normalizeProviderName(resolved) || 'claude';
}

function validateProviderLevel(provider, requestedLevel, minLevel, maxLevel) {
  const providerModule = getProvider(provider);
  const levels = providerModule.getLevelMapping();
  const rank = (level) => levels[level]?.rank;

  if (!levels[requestedLevel]) {
    throw new Error(`Invalid level "${requestedLevel}" for provider "${provider}"`);
  }

  if (minLevel && !levels[minLevel]) {
    throw new Error(`Invalid minLevel "${minLevel}" for provider "${provider}"`);
  }

  if (maxLevel && !levels[maxLevel]) {
    throw new Error(`Invalid maxLevel "${maxLevel}" for provider "${provider}"`);
  }

  if (minLevel && maxLevel && rank(minLevel) > rank(maxLevel)) {
    throw new Error(
      `minLevel "${minLevel}" exceeds maxLevel "${maxLevel}" for provider "${provider}"`
    );
  }

  if (maxLevel && rank(requestedLevel) > rank(maxLevel)) {
    throw new Error(
      `Level "${requestedLevel}" exceeds maxLevel "${maxLevel}" for provider "${provider}"`
    );
  }

  if (minLevel && rank(requestedLevel) < rank(minLevel)) {
    throw new Error(
      `Level "${requestedLevel}" is below minLevel "${minLevel}" for provider "${provider}"`
    );
  }

  return requestedLevel;
}

function validateProviderSettings(provider, providerSettings) {
  const providerModule = getProvider(provider);
  const levels = providerModule.getLevelMapping();
  const settings = providerSettings || {};
  const providerError = providerModule.validateSettings(settings);
  if (providerError) {
    throw new Error(providerError);
  }

  const minLevel = settings.minLevel || providerModule.getDefaultMinLevel?.();
  const maxLevel = settings.maxLevel || providerModule.getDefaultMaxLevel?.();
  const defaultLevel = settings.defaultLevel || providerModule.getDefaultLevel();

  validateProviderLevel(provider, defaultLevel, minLevel, maxLevel);

  for (const [level, override] of Object.entries(settings.levelOverrides || {})) {
    if (!levels[level]) {
      throw new Error(`Unknown level "${level}" in overrides for provider "${provider}"`);
    }
    if (override?.model && (typeof override.model !== 'string' || !override.model.trim())) {
      throw new Error(
        `Invalid model override (must be non-empty string) for provider "${provider}"`
      );
    }
    if (override?.model || (provider === 'opencode' && override?.model === '')) {
      providerModule.resolveModelSpec(level, { [level]: override });
    }
    if (override?.reasoningEffort && !providerSupportsCapability(provider, 'reasoningEffort')) {
      throw new Error(
        `reasoningEffort overrides are only supported for Claude, Codex, and Opencode`
      );
    }
    if (override?.reasoningEffort && !REASONING_EFFORTS.includes(override.reasoningEffort)) {
      throw new Error(
        `Invalid reasoningEffort "${override.reasoningEffort}" (${REASONING_EFFORT_LABEL})`
      );
    }
  }
}

function resolveAgentProvider(agent, config, settings, errors) {
  const provider = resolveProviderName(agent, config, settings);
  if (!VALID_PROVIDERS.includes(provider)) {
    errors.push(`Agent "${agent.id}" references unknown provider "${provider}"`);
    return null;
  }
  return provider;
}

function buildProviderContext(provider, settings) {
  const providerModule = getProvider(provider);
  const levels = providerModule.getLevelMapping();
  const providerSettings = settings.providerSettings?.[provider] || {};
  const minLevel = providerSettings.minLevel;
  const maxLevel = providerSettings.maxLevel;
  const rank = (level) => levels[level]?.rank;

  return {
    providerModule,
    levels,
    providerSettings,
    minLevel,
    maxLevel,
    rank,
  };
}

function validateJsonSchemaSupport(agent, provider, warnings) {
  if (!agent.jsonSchema) return;
  const cap = CAPABILITIES[provider]?.jsonSchema;
  if (cap === 'experimental') {
    warnings.push(
      `Agent "${agent.id}" uses jsonSchema with ${provider} provider - ` +
        `this feature is experimental and may not work reliably`
    );
  } else if (!cap) {
    warnings.push(
      `Agent "${agent.id}" uses jsonSchema but ${provider} provider doesn't support it`
    );
  }
}

function validateModelLevelSupport(agent, provider, levels, warnings) {
  if (agent.modelLevel && !levels[agent.modelLevel]) {
    warnings.push(
      `Agent "${agent.id}" uses modelLevel "${agent.modelLevel}" which is not valid for ${provider}`
    );
  }
}

function validateModelSelection(agent, context, warnings) {
  const { provider, providerModule, minLevel, maxLevel, rank } = context;

  if (agent.model) {
    try {
      providerModule.validateModelId(agent.model);
    } catch {
      warnings.push(
        `Agent "${agent.id}" uses model "${agent.model}" which is not valid for ${provider}`
      );
    }
    return;
  }

  if (agent.modelLevel && minLevel && maxLevel) {
    if (rank(minLevel) > rank(maxLevel)) {
      warnings.push(
        `Provider "${provider}" has minLevel "${minLevel}" above maxLevel "${maxLevel}"`
      );
    } else if (rank(agent.modelLevel) < rank(minLevel)) {
      warnings.push(
        `Agent "${agent.id}" uses modelLevel "${agent.modelLevel}" below minLevel "${minLevel}" for ${provider}`
      );
    } else if (rank(agent.modelLevel) > rank(maxLevel)) {
      warnings.push(
        `Agent "${agent.id}" uses modelLevel "${agent.modelLevel}" above maxLevel "${maxLevel}" for ${provider}`
      );
    }
  }
}

function validateModelRulesSupport(agent, provider, providerModule, levels, warnings) {
  if (!agent.modelRules || !Array.isArray(agent.modelRules)) return;

  for (const rule of agent.modelRules) {
    if (rule.modelLevel && !levels[rule.modelLevel]) {
      warnings.push(
        `Agent "${agent.id}" uses modelLevel "${rule.modelLevel}" in modelRules which is not valid for ${provider}`
      );
    }
    if (rule.model) {
      try {
        providerModule.validateModelId(rule.model);
      } catch {
        warnings.push(
          `Agent "${agent.id}" uses model "${rule.model}" in modelRules which is not valid for ${provider}`
        );
      }
    }
  }
}

function validateReasoningEffortSupport(agent, provider, warnings) {
  if (agent.reasoningEffort && !providerSupportsCapability(provider, 'reasoningEffort')) {
    warnings.push(`Agent "${agent.id}" sets reasoningEffort but ${provider} does not support it`);
  } else if (agent.reasoningEffort && !REASONING_EFFORTS.includes(agent.reasoningEffort)) {
    warnings.push(
      `Agent "${agent.id}" has invalid reasoningEffort "${agent.reasoningEffort}" (${REASONING_EFFORT_LABEL})`
    );
  }
}

function validateProviderFeatures(config, settings) {
  const errors = [];
  const warnings = [];

  const providersToValidate = VALID_PROVIDERS;

  for (const provider of providersToValidate) {
    try {
      validateProviderSettings(provider, settings.providerSettings?.[provider]);
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (!config.agents || !Array.isArray(config.agents)) {
    return { errors, warnings };
  }

  for (const agent of config.agents) {
    if (agent.type === 'subcluster') {
      continue;
    }

    const provider = resolveAgentProvider(agent, config, settings, errors);
    if (!provider) continue;

    const { providerModule, levels, minLevel, maxLevel, rank } = buildProviderContext(
      provider,
      settings
    );
    const modelSelectionContext = {
      provider,
      providerModule,
      minLevel,
      maxLevel,
      rank,
    };

    validateJsonSchemaSupport(agent, provider, warnings);
    validateModelLevelSupport(agent, provider, levels, warnings);
    validateModelSelection(agent, modelSelectionContext, warnings);
    validateModelRulesSupport(agent, provider, providerModule, levels, warnings);
    validateReasoningEffortSupport(agent, provider, warnings);
  }

  return { errors, warnings };
}

module.exports = {
  validateConfig,
  isConductorConfig,
  validateBasicStructure,
  analyzeMessageFlow,
  validateAgents,
  validateLogicScripts,
  isValidIterationPattern,
  formatValidationResult,
  // Phase 5: Template variable validation
  validateTemplateVariables,
  extractTemplateVariables,
  extractSchemaProperties,
  validateAgentTemplateVariables,
  // Phase 6-9: Semantic validation
  validateHookSemantics,
  validateRuleCoverage,
  detectNAgentCycles,
  validateConfigSemantics,
  validateProviderLevel,
  validateProviderSettings,
  validateProviderFeatures,
  groupConsecutive,
};
