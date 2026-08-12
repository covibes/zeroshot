import simulationAgentRuntime = require('./simulation-agent-runtime');
import { createSimulationAgent } from './simulation-agent';
import type {
  RandomAgentConfig,
  RandomDispatchContext,
  RandomTrigger,
  ScenarioOutcome,
  SimulationMessage,
} from './random-topology-contracts';
import { evaluateAgentTrigger, publishTerminal } from './random-topology-trigger-evaluation';
import { sampleResultData } from './random-topology-schema';

type TriggerOutcome = ScenarioOutcome | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function executeAgentTrigger(
  context: RandomDispatchContext,
  agentConfig: RandomAgentConfig,
  trigger: RandomTrigger,
  message: SimulationMessage
): Promise<TriggerOutcome> {
  const evaluation = evaluateAgentTrigger(context, agentConfig, trigger, message);
  if (evaluation.kind === 'outcome') return evaluation.outcome;
  if (!evaluation.matches) return null;

  const action = trigger.action || 'execute_task';
  if (action === 'stop_cluster') {
    publishTerminal({
      context,
      agentConfig,
      topic: 'CLUSTER_COMPLETE',
      text: 'simulated completion',
      data: { topic: message.topic },
    });
    return null;
  }
  if (action !== 'execute_task') return null;

  const nextIteration = (context.iterations.get(agentConfig.id) || 0) + 1;
  context.iterations.set(agentConfig.id, nextIteration);
  const maxIterations = maximumIterations(agentConfig);
  if (nextIteration > maxIterations) {
    publishTerminal({
      context,
      agentConfig,
      topic: 'CLUSTER_FAILED',
      text: `maxIterations exceeded: ${agentConfig.id}`,
      data: { maxIterations, iteration: nextIteration },
    });
    return null;
  }

  const sampledResult = sampleResultData(agentConfig, context.rng);
  const simulationAgent = createSimulationAgent({
    agentConfig,
    cluster: context.state.cluster,
    messageBus: context.messageBus,
    iteration: nextIteration,
    currentTaskId: `sim-${agentConfig.id}-${nextIteration}`,
  });
  try {
    await simulationAgentRuntime.executeHook({
      hook: agentConfig.hooks?.onComplete,
      agent: simulationAgent,
      message,
      result: {
        output: JSON.stringify(sampledResult || {}),
        success: true,
        taskId: `sim-task-${agentConfig.id}-${nextIteration}`,
      },
      messageBus: context.messageBus,
      cluster: context.state.cluster,
    });
    return null;
  } catch (error) {
    return {
      ok: false,
      reason: `hook execution failed (${agentConfig.id}): ${errorMessage(error)}`,
    };
  }
}

function maximumIterations(agentConfig: RandomAgentConfig): number {
  return Number.isInteger(agentConfig.maxIterations) ? Number(agentConfig.maxIterations) : 100;
}
