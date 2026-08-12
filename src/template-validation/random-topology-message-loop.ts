import type {
  RandomDispatchContext,
  ScenarioOutcome,
  SimulationMessage,
} from './random-topology-contracts';
import { dispatchScenarioMessage } from './random-topology-dispatch';
import { handleClusterOperationsMessage } from './random-topology-operations';

export interface MessageLoopContext extends RandomDispatchContext {
  queue: unknown[];
  templatesDir: string;
  startedAt: number;
  maxSteps: number;
  maxScenarioMs: number;
}

function isSimulationMessage(value: unknown): value is SimulationMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'topic' in value &&
    typeof value.topic === 'string'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processMessage(
  context: MessageLoopContext,
  message: SimulationMessage
): Promise<ScenarioOutcome | null> {
  if (message.topic === 'CLUSTER_COMPLETE') return Promise.resolve({ ok: true });
  if (message.topic === 'CLUSTER_FAILED') {
    return Promise.resolve({ ok: false, reason: 'scenario reached CLUSTER_FAILED' });
  }
  if (message.topic === 'CLUSTER_OPERATIONS') {
    try {
      handleClusterOperationsMessage(
        context.state,
        context.messageBus,
        message,
        context.templatesDir
      );
      return Promise.resolve(null);
    } catch (error) {
      return Promise.resolve({
        ok: false,
        reason: `invalid CLUSTER_OPERATIONS: ${errorMessage(error)}`,
      });
    }
  }
  return dispatchScenarioMessage(context, message);
}

export async function runMessageLoop(context: MessageLoopContext): Promise<ScenarioOutcome> {
  let stepCount = 0;
  while (context.queue.length > 0) {
    if (Date.now() - context.startedAt > context.maxScenarioMs) {
      return { ok: false, reason: `scenario timed out after ${context.maxScenarioMs}ms` };
    }
    if (stepCount >= context.maxSteps) {
      return { ok: false, reason: `scenario exceeded step budget (${context.maxSteps})` };
    }
    stepCount += 1;
    const messageValue = context.queue.shift();
    if (!isSimulationMessage(messageValue)) continue;
    const outcome = await processMessage(context, messageValue);
    if (outcome) return outcome;
  }
  return { ok: false, reason: 'message flow quiesced without CLUSTER_COMPLETE' };
}
