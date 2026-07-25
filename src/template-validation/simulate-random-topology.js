const Ledger = require('../ledger');
const MessageBus = require('../message-bus');
const LogicEngine = require('../logic-engine');
const TemplateResolver = require('../template-resolver');
const { executeHook } = require('../agent/agent-hook-executor');
const { parseResultOutput } = require('../agent/agent-task-executor');
const { findMatchingTrigger, evaluateTrigger } = require('../agent/agent-trigger-evaluator');

const DEFAULT_SAMPLES = 6;
const DEFAULT_MAX_STEPS = 120;
const DEFAULT_MAX_SCENARIO_MS = 120;
const MAX_ERRORS = 3;

function createSeededRng(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state >>>= 0;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

function randomInt(rng, min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return 0;
  }
  if (max <= min) {
    return Math.round(min);
  }
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randomPick(rng, values, fallback = null) {
  if (!Array.isArray(values) || values.length === 0) {
    return fallback;
  }
  return values[randomInt(rng, 0, values.length - 1)];
}

function normalizeType(schema) {
  if (!schema || !schema.type) return null;
  if (Array.isArray(schema.type)) {
    return schema.type[0] || null;
  }
  return schema.type;
}

function sampleString(schema, rng) {
  const candidates = [];
  if (typeof schema.default === 'string') candidates.push(schema.default);
  if (typeof schema.description === 'string') candidates.push(schema.description);
  candidates.push('sample', 'ok', 'done', 'pass', 'fail');
  let value = randomPick(rng, candidates, 'sample');

  const minLength = Number.isInteger(schema.minLength) ? schema.minLength : 0;
  const maxLength = Number.isInteger(schema.maxLength) ? schema.maxLength : value.length;

  while (value.length < minLength) {
    value += 'x';
  }
  if (maxLength >= 0 && value.length > maxLength) {
    value = value.slice(0, maxLength);
  }
  if (!value && minLength > 0) {
    value = 'x'.repeat(minLength);
  }
  return value;
}

function sampleNumber(schema, rng, asInteger) {
  const minimum = Number.isFinite(schema.minimum) ? schema.minimum : asInteger ? 0 : 0;
  const maximum = Number.isFinite(schema.maximum) ? schema.maximum : asInteger ? 10 : 10;
  if (maximum < minimum) {
    return asInteger ? Math.round(minimum) : minimum;
  }

  if (asInteger) {
    return randomInt(rng, Math.ceil(minimum), Math.floor(maximum));
  }
  const fraction = rng();
  return minimum + (maximum - minimum) * fraction;
}

function sampleFromSchema(schema, rng, depth = 0) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  if (depth > 4) {
    return null;
  }

  if (schema.const !== undefined) {
    return schema.const;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return randomPick(rng, schema.enum);
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return sampleFromSchema(randomPick(rng, schema.oneOf), rng, depth + 1);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return sampleFromSchema(randomPick(rng, schema.anyOf), rng, depth + 1);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return sampleFromSchema(schema.allOf[0], rng, depth + 1);
  }

  const type = normalizeType(schema);

  if (type === 'boolean') {
    return rng() >= 0.5;
  }

  if (type === 'integer') {
    return sampleNumber(schema, rng, true);
  }

  if (type === 'number') {
    return sampleNumber(schema, rng, false);
  }

  if (type === 'array') {
    const minItems = Number.isInteger(schema.minItems) ? schema.minItems : 0;
    const maxItemsRaw = Number.isInteger(schema.maxItems) ? schema.maxItems : minItems + 2;
    const maxItems = Math.max(minItems, Math.min(maxItemsRaw, 3));
    const length = randomInt(rng, minItems, maxItems);

    const itemsSchema = Array.isArray(schema.items)
      ? randomPick(rng, schema.items, {})
      : schema.items || {};
    const values = [];
    for (let i = 0; i < length; i += 1) {
      values.push(sampleFromSchema(itemsSchema, rng, depth + 1));
    }
    return values;
  }

  if (type === 'object' || schema.properties) {
    const properties = schema.properties || {};
    const value = {};

    for (const [key, propSchema] of Object.entries(properties)) {
      value[key] = sampleFromSchema(propSchema, rng, depth + 1);
    }

    if (Object.keys(value).length === 0 && Object.keys(properties).length > 0) {
      const key = Object.keys(properties)[0];
      value[key] = sampleFromSchema(properties[key], rng, depth + 1);
    }

    return value;
  }

  return sampleString(schema, rng);
}

function sampleResultData(agentConfig, rng) {
  const schema = agentConfig?.jsonSchema || agentConfig?.structuredOutput || null;
  if (schema) {
    return sampleFromSchema(schema, rng);
  }
  return {
    summary: 'sample',
    result: 'sample',
  };
}

function createSimAgent({ agentConfig, cluster, messageBus, iteration }) {
  const simAgent = {
    id: agentConfig.id,
    role: agentConfig.role,
    iteration,
    cluster,
    messageBus,
    config: agentConfig,
    currentTaskId: `sim-${agentConfig.id}-${iteration}`,
    workingDirectory: process.cwd(),
    _log: () => {},
    _resolveProvider: () => 'claude',
    _parseResultOutput: (output) => parseResultOutput(simAgent, output),
    _publish: (message) => {
      const receiver = message.receiver || 'broadcast';
      return messageBus.publish({
        ...message,
        receiver,
        cluster_id: cluster.id,
        sender: simAgent.id,
      });
    },
  };
  return simAgent;
}

function addAgentsToState(state, agents) {
  for (const agent of agents || []) {
    if (!agent?.id) {
      continue;
    }

    if (state.agentConfigs.some((existing) => existing.id === agent.id)) {
      continue;
    }

    state.agentConfigs.push(agent);
    state.cluster.agents.push({ id: agent.id, role: agent.role });
  }
}

function parseOperations(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    return JSON.parse(raw);
  }
  return null;
}

function resolveConfigOperation({ configOp, templatesDir }) {
  const resolver = new TemplateResolver(templatesDir);
  return resolver.resolveConfigReference(configOp).loadedConfig;
}

function applyClusterOperation({ state, messageBus, operation, sourceMessage, templatesDir }) {
  if (!operation?.action) {
    return;
  }

  if (operation.action === 'load_config') {
    const loadedConfig = resolveConfigOperation({
      configOp: operation.config,
      templatesDir,
    });
    addAgentsToState(state, loadedConfig.agents || []);
    return;
  }

  if (operation.action === 'add_agents') {
    addAgentsToState(state, operation.agents || []);
    return;
  }

  if (operation.action === 'remove_agents') {
    const ids = new Set(operation.agentIds || []);
    state.agentConfigs = state.agentConfigs.filter((agent) => !ids.has(agent.id));
    state.cluster.agents = state.cluster.agents.filter((agent) => !ids.has(agent.id));
    return;
  }

  if (operation.action === 'update_agent') {
    const target = state.agentConfigs.find((agent) => agent.id === operation.agentId);
    if (!target || !operation.updates || typeof operation.updates !== 'object') {
      return;
    }
    Object.assign(target, operation.updates);
    return;
  }

  if (operation.action === 'publish') {
    messageBus.publish({
      cluster_id: state.cluster.id,
      topic: operation.topic,
      sender: '__sim_orchestrator__',
      receiver: operation.receiver || 'broadcast',
      content: operation.content || {},
      metadata: operation.metadata || {
        fromTopic: sourceMessage.topic,
      },
    });
  }
}

function handleClusterOperationsMessage({ state, messageBus, message, templatesDir }) {
  const raw = message?.content?.data?.operations;
  const operations = parseOperations(raw);
  if (!Array.isArray(operations)) {
    throw new Error(`CLUSTER_OPERATIONS missing operations array: ${JSON.stringify(raw)}`);
  }

  for (const operation of operations) {
    applyClusterOperation({ state, messageBus, operation, sourceMessage: message, templatesDir });
  }
}

function createIssueOpenedMessage(clusterId) {
  return {
    cluster_id: clusterId,
    topic: 'ISSUE_OPENED',
    sender: 'system',
    receiver: 'broadcast',
    content: {
      text: 'template validation simulation',
      data: {},
    },
  };
}

async function runScenario({ config, templateId, seed, maxSteps, maxScenarioMs, templatesDir }) {
  const initialAgentConfigs = JSON.parse(JSON.stringify(config.agents || []));
  const state = {
    agentConfigs: initialAgentConfigs,
    cluster: {
      id: `sim-${templateId}-${seed}`,
      agents: initialAgentConfigs.map((agent) => ({ id: agent.id, role: agent.role })),
    },
  };

  const rng = createSeededRng(seed);
  const ledger = new Ledger(':memory:');
  const messageBus = new MessageBus(ledger);
  const logicEngine = new LogicEngine(messageBus, state.cluster);
  const iterations = new Map();
  const queue = [];
  const unsubscribe = messageBus.subscribe((message) => {
    queue.push(message);
  });

  const startedAt = Date.now();

  try {
    messageBus.publish(createIssueOpenedMessage(state.cluster.id));
    let stepCount = 0;

    while (queue.length > 0) {
      if (Date.now() - startedAt > maxScenarioMs) {
        return {
          ok: false,
          reason: `scenario timed out after ${maxScenarioMs}ms`,
        };
      }
      if (stepCount >= maxSteps) {
        return {
          ok: false,
          reason: `scenario exceeded step budget (${maxSteps})`,
        };
      }
      stepCount += 1;

      const message = queue.shift();
      if (!message) continue;

      if (message.topic === 'CLUSTER_COMPLETE') {
        return { ok: true };
      }
      if (message.topic === 'CLUSTER_FAILED') {
        return {
          ok: false,
          reason: `scenario reached CLUSTER_FAILED`,
        };
      }
      if (message.topic === 'CLUSTER_OPERATIONS') {
        try {
          handleClusterOperationsMessage({
            state,
            messageBus,
            message,
            templatesDir,
          });
        } catch (error) {
          return {
            ok: false,
            reason: `invalid CLUSTER_OPERATIONS: ${error.message}`,
          };
        }
        continue;
      }

      for (const agentConfig of state.agentConfigs) {
        const trigger = findMatchingTrigger({
          triggers: agentConfig.triggers || [],
          message,
        });
        if (!trigger) {
          continue;
        }

        let shouldExecute = true;
        try {
          shouldExecute = evaluateTrigger({
            trigger,
            message,
            agent: {
              id: agentConfig.id,
              role: agentConfig.role,
              iteration: iterations.get(agentConfig.id) || 0,
              cluster_id: state.cluster.id,
            },
            logicEngine,
          });
        } catch (error) {
          return {
            ok: false,
            reason: `trigger logic error (${agentConfig.id} on ${message.topic}): ${error.message}`,
          };
        }

        if (!shouldExecute) {
          continue;
        }

        const action = trigger.action || 'execute_task';
        if (action === 'stop_cluster') {
          messageBus.publish({
            cluster_id: state.cluster.id,
            topic: 'CLUSTER_COMPLETE',
            sender: agentConfig.id,
            receiver: 'system',
            content: {
              text: 'simulated completion',
              data: { topic: message.topic },
            },
          });
          continue;
        }

        if (action !== 'execute_task') {
          continue;
        }

        const nextIteration = (iterations.get(agentConfig.id) || 0) + 1;
        iterations.set(agentConfig.id, nextIteration);
        const maxIterations = Number.isInteger(agentConfig.maxIterations)
          ? agentConfig.maxIterations
          : 100;
        if (nextIteration > maxIterations) {
          messageBus.publish({
            cluster_id: state.cluster.id,
            topic: 'CLUSTER_FAILED',
            sender: agentConfig.id,
            receiver: 'system',
            content: {
              text: `maxIterations exceeded: ${agentConfig.id}`,
              data: { maxIterations, iteration: nextIteration },
            },
          });
          continue;
        }

        const sampledResult = sampleResultData(agentConfig, rng);
        const simAgent = createSimAgent({
          agentConfig,
          cluster: state.cluster,
          messageBus,
          iteration: nextIteration,
        });

        try {
          await executeHook({
            hook: agentConfig.hooks?.onComplete,
            agent: simAgent,
            message,
            result: {
              output: JSON.stringify(sampledResult || {}),
              success: true,
              taskId: `sim-task-${agentConfig.id}-${nextIteration}`,
            },
            messageBus,
            cluster: state.cluster,
          });
        } catch (error) {
          return {
            ok: false,
            reason: `hook execution failed (${agentConfig.id}): ${error.message}`,
          };
        }
      }
    }

    return {
      ok: false,
      reason: 'message flow quiesced without CLUSTER_COMPLETE',
    };
  } finally {
    unsubscribe();
    ledger.close();
  }
}

async function simulateRandomTopology({
  config,
  templateId,
  templatesDir,
  samples = DEFAULT_SAMPLES,
  maxSteps = DEFAULT_MAX_STEPS,
  maxScenarioMs = DEFAULT_MAX_SCENARIO_MS,
}) {
  const errors = [];
  if (!config?.agents || config.agents.length === 0) {
    return errors;
  }

  const baseSeed = 1337;
  const scenarioCount = Math.max(1, Number(samples) || DEFAULT_SAMPLES);

  for (let i = 0; i < scenarioCount; i += 1) {
    const seed = baseSeed + i * 9973;
    const outcome = await runScenario({
      config,
      templateId,
      seed,
      maxSteps,
      maxScenarioMs,
      templatesDir,
    });
    if (outcome.ok) {
      continue;
    }
    errors.push(
      `[RandomSim] ${templateId} seed=${seed}: ${outcome.reason}. ` +
        `Topology may be unsound under sampled schema-conformant outputs.`
    );
    if (errors.length >= MAX_ERRORS) {
      break;
    }
  }

  return errors;
}

module.exports = {
  simulateRandomTopology,
  sampleFromSchema,
};
