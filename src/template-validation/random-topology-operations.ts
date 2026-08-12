import randomTopologyRuntime = require('./random-topology-runtime');
import type {
  RandomSimulationState,
  SimulationMessage,
  SimulationMessageBus,
} from './random-topology-contracts';
import { addAgentsToState } from './random-topology-state';

type UnknownRecord = Record<string, unknown>;

function parseOperations(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw.map((operation: unknown) => operation);
  if (typeof raw === 'string') {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((operation: unknown) => operation) : null;
  }
  return null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveConfigOperation(configOperation: unknown, templatesDir: string): UnknownRecord {
  const resolver = new randomTopologyRuntime.TemplateResolver(templatesDir);
  const resolved = resolver.resolveConfigReference(configOperation);
  if (!isRecord(resolved) || !isRecord(resolved.loadedConfig)) {
    throw new TypeError('TemplateResolver returned an invalid loadedConfig');
  }
  return resolved.loadedConfig;
}

interface ApplyOperationOptions {
  state: RandomSimulationState;
  messageBus: SimulationMessageBus;
  operation: unknown;
  sourceMessage: SimulationMessage;
  templatesDir: string;
}

function publishOperation(
  state: RandomSimulationState,
  messageBus: SimulationMessageBus,
  operation: UnknownRecord,
  sourceMessage: SimulationMessage
): void {
  messageBus.publish({
    cluster_id: state.cluster.id,
    topic: operation.topic,
    sender: '__sim_orchestrator__',
    receiver: operation.receiver || 'broadcast',
    content: operation.content || {},
    metadata: operation.metadata || { fromTopic: sourceMessage.topic },
  });
}

function applyClusterOperation(options: ApplyOperationOptions): void {
  const { state, messageBus, operation: operationValue, sourceMessage, templatesDir } = options;
  if (!isRecord(operationValue) || !operationValue.action) return;
  const operation = operationValue;
  if (operation.action === 'load_config') {
    addAgentsToState(state, resolveConfigOperation(operation.config, templatesDir).agents);
  } else if (operation.action === 'add_agents') {
    addAgentsToState(state, operation.agents);
  } else if (operation.action === 'remove_agents') {
    const ids = new Set(operationAgentIds(operation.agentIds));
    state.agentConfigs = state.agentConfigs.filter((agent) => !ids.has(agent.id));
    state.cluster.agents = state.cluster.agents.filter((agent) => !ids.has(agent.id));
  } else if (operation.action === 'update_agent') {
    const target = state.agentConfigs.find((agent) => agent.id === operation.agentId);
    if (target && isRecord(operation.updates)) Object.assign(target, operation.updates);
  } else if (operation.action === 'publish') {
    publishOperation(state, messageBus, operation, sourceMessage);
  }
}

function operationAgentIds(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function operationsValue(message: SimulationMessage): unknown {
  const content = message.content;
  if (!isRecord(content) || !isRecord(content.data)) return undefined;
  return content.data.operations;
}

export function handleClusterOperationsMessage(
  state: RandomSimulationState,
  messageBus: SimulationMessageBus,
  message: SimulationMessage,
  templatesDir: string
): void {
  const raw = operationsValue(message);
  const operations = parseOperations(raw);
  if (!operations) {
    throw new Error(`CLUSTER_OPERATIONS missing operations array: ${JSON.stringify(raw)}`);
  }
  for (const operation of operations) {
    applyClusterOperation({ state, messageBus, operation, sourceMessage: message, templatesDir });
  }
}
