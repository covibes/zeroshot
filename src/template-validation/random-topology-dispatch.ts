import type {
  RandomDispatchContext,
  RandomTrigger,
  ScenarioOutcome,
  SimulationMessage,
} from './random-topology-contracts';
import randomTopologyRuntime = require('./random-topology-runtime');
import { executeAgentTrigger } from './random-topology-trigger';

function isRandomTrigger(value: unknown): value is RandomTrigger {
  return (
    typeof value === 'object' &&
    value !== null &&
    'topic' in value &&
    typeof value.topic === 'string'
  );
}

export async function dispatchScenarioMessage(
  context: RandomDispatchContext,
  message: SimulationMessage
): Promise<ScenarioOutcome | null> {
  for (const agentConfig of context.state.agentConfigs) {
    const triggerValue = randomTopologyRuntime.findMatchingTrigger({
      triggers: agentConfig.triggers || [],
      message,
    });
    if (!isRandomTrigger(triggerValue)) continue;
    const outcome = await executeAgentTrigger(context, agentConfig, triggerValue, message);
    if (outcome) return outcome;
  }
  return null;
}
