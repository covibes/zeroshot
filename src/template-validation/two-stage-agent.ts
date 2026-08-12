import twoStageRuntime = require('./two-stage-runtime');
import type { ValidationAgentConfig, ValidationCluster } from './two-stage-contracts';

interface SimulationMessageBus {
  publish(message: unknown): unknown;
}

type PublishMessage = Record<string, unknown> & { receiver?: unknown };

interface SimulationAgent {
  id: string;
  role: string | undefined;
  iteration: number;
  cluster: ValidationCluster;
  messageBus: SimulationMessageBus;
  config: ValidationAgentConfig;
  currentTaskId: string;
  workingDirectory: string;
  _log(...arguments_: unknown[]): void;
  _resolveProvider(): 'claude';
  _parseResultOutput(output: string): Promise<unknown>;
  _publish(message: PublishMessage): unknown;
}

interface CreateSimulationAgentOptions {
  agentConfig: ValidationAgentConfig;
  cluster: ValidationCluster;
  messageBus: SimulationMessageBus;
}

export function createSimulationAgent({
  agentConfig,
  cluster,
  messageBus,
}: CreateSimulationAgentOptions): SimulationAgent {
  const simulationAgent: SimulationAgent = {
    id: agentConfig.id,
    role: agentConfig.role,
    iteration: 1,
    cluster,
    messageBus,
    config: agentConfig,
    currentTaskId: 'sim-task',
    workingDirectory: process.cwd(),
    _log: () => {},
    _resolveProvider: () => 'claude',
    _parseResultOutput: (output) => twoStageRuntime.parseResultOutput(simulationAgent, output),
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
