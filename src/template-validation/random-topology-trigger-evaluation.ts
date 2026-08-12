import type {
  RandomAgentConfig,
  RandomDispatchContext,
  RandomTrigger,
  ScenarioOutcome,
  SimulationMessage,
} from './random-topology-contracts';
import randomTopologyRuntime = require('./random-topology-runtime');

export type TriggerEvaluation =
  | { kind: 'match'; matches: boolean }
  | { kind: 'outcome'; outcome: ScenarioOutcome };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function publishTerminal(options: {
  context: RandomDispatchContext;
  agentConfig: RandomAgentConfig;
  topic: 'CLUSTER_COMPLETE' | 'CLUSTER_FAILED';
  text: string;
  data: Record<string, unknown>;
}): void {
  const { context, agentConfig, topic, text, data } = options;
  context.messageBus.publish({
    cluster_id: context.state.cluster.id,
    topic,
    sender: agentConfig.id,
    receiver: 'system',
    content: { text, data },
  });
}

export function evaluateAgentTrigger(
  context: RandomDispatchContext,
  agentConfig: RandomAgentConfig,
  trigger: RandomTrigger,
  message: SimulationMessage
): TriggerEvaluation {
  try {
    return {
      kind: 'match',
      matches: randomTopologyRuntime.evaluateTrigger({
        trigger,
        message,
        agent: {
          id: agentConfig.id,
          role: agentConfig.role,
          iteration: context.iterations.get(agentConfig.id) || 0,
          cluster_id: context.state.cluster.id,
        },
        logicEngine: context.logicEngine,
      }),
    };
  } catch (error) {
    return {
      kind: 'outcome',
      outcome: {
        ok: false,
        reason: `trigger logic error (${agentConfig.id} on ${message.topic}): ${errorMessage(error)}`,
      },
    };
  }
}
