import assert = require('node:assert');
import simulationRuntime = require('./simulation-runtime');
import simulationAgentRuntime = require('./simulation-agent-runtime');
import { createSimulationAgent } from './simulation-agent';
import { publishScenarioInputs } from './two-stage-inputs';
import { evaluateScenarioMessages } from './two-stage-results';
import type {
  ScenarioOutcome,
  ValidationAgentConfig,
  ValidationCluster,
  ValidationStageSpec,
  ValidationTemplateConfig,
} from './two-stage-contracts';

interface CoordinatorContext {
  coordinator: ValidationAgentConfig;
  script: string;
  hook: unknown;
}

function resolveCoordinator(
  spec: ValidationStageSpec,
  config: ValidationTemplateConfig
): CoordinatorContext {
  const coordinator = config.agents.find((agent) => agent.id === 'consensus-coordinator');
  assert.ok(coordinator, `${spec.templateId}: consensus-coordinator missing`);

  const trigger = coordinator.triggers?.find((candidate) => candidate.topic === spec.triggerTopic);
  const script = trigger?.logic?.script;
  assert.ok(script, `${spec.templateId}: coordinator trigger logic missing`);

  const hook = coordinator.hooks?.onComplete;
  assert.ok(hook, `${spec.templateId}: coordinator onComplete missing`);
  return { coordinator, script, hook };
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

async function runScenario(
  spec: ValidationStageSpec,
  cluster: ValidationCluster,
  context: CoordinatorContext,
  allApproved: boolean
): Promise<ScenarioOutcome> {
  const { ledger, messageBus, logicEngine } = simulationRuntime.createSimulationRuntime(cluster);
  publishScenarioInputs(spec, cluster, messageBus);

  const gateOpen = logicEngine.evaluate(
    context.script,
    { id: 'consensus-coordinator', cluster_id: cluster.id },
    { topic: spec.triggerTopic }
  );
  if (!gateOpen) {
    ledger.close();
    return { ok: false, error: spec.gateFailure };
  }

  const simulationAgent = createSimulationAgent({
    agentConfig: context.coordinator,
    cluster,
    messageBus,
  });
  const triggeringMessage = messageBus.findLast({
    cluster_id: cluster.id,
    topic: spec.triggerTopic,
  });

  try {
    await simulationAgentRuntime.executeHook({
      hook: context.hook,
      agent: simulationAgent,
      message: triggeringMessage,
      result: {
        output: JSON.stringify({ allApproved, summary: allApproved ? 'ok' : 'nope' }),
        success: true,
        taskId: 'sim-task',
      },
      messageBus,
      cluster,
    });
  } catch (error) {
    ledger.close();
    return {
      ok: false,
      error: `${spec.templateId}: onComplete failed: ${errorMessage(error)}`,
    };
  }

  const messages = {
    passed: spec.passTopic
      ? messageBus.findLast({ cluster_id: cluster.id, topic: spec.passTopic })
      : null,
    validationResult: messageBus.findLast({
      cluster_id: cluster.id,
      topic: 'VALIDATION_RESULT',
    }),
  };
  ledger.close();
  return evaluateScenarioMessages(spec, allApproved, messages);
}

export async function simulateValidationStage(
  spec: ValidationStageSpec,
  config: ValidationTemplateConfig
): Promise<string[]> {
  const cluster: ValidationCluster = {
    id: spec.clusterId,
    agents: config.agents.map((agent) => ({ id: agent.id, role: agent.role })),
  };
  const context = resolveCoordinator(spec, config);
  const failures: string[] = [];

  for (const allApproved of [true, false]) {
    const result = await runScenario(spec, cluster, context, allApproved);
    if (result.ok === false) failures.push(result.error);
  }
  return failures;
}
