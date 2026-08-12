import simulationAgentRuntime = require('./simulation-agent-runtime');

interface SimulationMessageBus {
  publish(message: unknown): unknown;
}

type PublishMessage = Record<string, unknown> & { receiver?: unknown };

export interface SimulationAgentConfig {
  id: string;
  role?: string;
}

export interface SimulationCluster {
  id: string;
  agents: Array<{ id: string; role: string | undefined }>;
}

interface SimulationAgent {
  id: string;
  role: string | undefined;
  iteration: number;
  cluster: SimulationCluster;
  messageBus: SimulationMessageBus;
  config: SimulationAgentConfig;
  currentTaskId: string;
  workingDirectory: string;
  _log(...arguments_: unknown[]): void;
  _resolveProvider(): 'claude';
  _parseResultOutput(output: string): Promise<unknown>;
  _publish(message: PublishMessage): unknown;
}

interface CreateSimulationAgentOptions {
  agentConfig: SimulationAgentConfig;
  cluster: SimulationCluster;
  messageBus: SimulationMessageBus;
  iteration?: number;
  currentTaskId?: string;
}

export function createSimulationAgent({
  agentConfig,
  cluster,
  messageBus,
  iteration = 1,
  currentTaskId = 'sim-task',
}: CreateSimulationAgentOptions): SimulationAgent {
  const simulationAgent: SimulationAgent = {
    id: agentConfig.id,
    role: agentConfig.role,
    iteration,
    cluster,
    messageBus,
    config: agentConfig,
    currentTaskId,
    workingDirectory: process.cwd(),
    _log: () => {},
    _resolveProvider: () => 'claude',
    _parseResultOutput: (output) =>
      simulationAgentRuntime.parseResultOutput(simulationAgent, output),
    _publish: (message) => {
      const receiver = message.receiver || 'broadcast';
      return messageBus.publish({
        ...message,
        receiver,
        cluster_id: cluster.id,
        sender: simulationAgent.id,
      });
    },
  };
  return simulationAgent;
}
