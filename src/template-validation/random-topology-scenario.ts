import type {
  RandomSimulationState,
  RunScenarioOptions,
  ScenarioOutcome,
  SimulationMessage,
} from './random-topology-contracts';
import { runMessageLoop } from './random-topology-message-loop';
import { createSeededRng } from './random-topology-schema';
import { cloneAgentConfigs } from './random-topology-state';
import simulationRuntime = require('./simulation-runtime');

function createIssueOpenedMessage(clusterId: string): SimulationMessage {
  return {
    cluster_id: clusterId,
    topic: 'ISSUE_OPENED',
    sender: 'system',
    receiver: 'broadcast',
    content: { text: 'template validation simulation', data: {} },
  };
}

function createState(options: RunScenarioOptions): RandomSimulationState {
  const agentConfigs = cloneAgentConfigs(options.config.agents || []);
  return {
    agentConfigs,
    cluster: {
      id: `sim-${options.templateId}-${options.seed}`,
      agents: agentConfigs.map((agent) => ({ id: agent.id, role: agent.role })),
    },
  };
}

export async function runScenario(options: RunScenarioOptions): Promise<ScenarioOutcome> {
  const state = createState(options);
  const runtime = simulationRuntime.createSimulationRuntime(state.cluster);
  const queue: unknown[] = [];
  const unsubscribe = runtime.messageBus.subscribe((message) => queue.push(message));
  const startedAt = Date.now();
  try {
    runtime.messageBus.publish(createIssueOpenedMessage(state.cluster.id));
    return await runMessageLoop({
      state,
      messageBus: runtime.messageBus,
      logicEngine: runtime.logicEngine,
      iterations: new Map(),
      rng: createSeededRng(options.seed),
      queue,
      templatesDir: options.templatesDir,
      startedAt,
      maxSteps: options.maxSteps,
      maxScenarioMs: options.maxScenarioMs,
    });
  } finally {
    unsubscribe();
    runtime.ledger.close();
  }
}
