import simulationRuntime = require('./simulation-runtime');
import { publishStageStartMessages } from './consensus-gate-stage';
import type {
  ConsensusProducers,
  RequiredQualityGate,
  ScenarioContext,
} from './consensus-gate-contracts';

interface SimulationMessageBus {
  publish(message: unknown): unknown;
}

interface EvaluateScenarioOptions extends ScenarioContext {
  publishMessages(
    messageBus: SimulationMessageBus,
    producers: ConsensusProducers,
    clusterId: string
  ): void;
}

interface PassingQualityGate {
  id: string;
  status: 'PASS';
  scope: string;
  completedAt: number;
  evidence: {
    command: string;
    exitCode: 0;
    output: string;
  };
}

interface ApprovedResultData {
  approved: true;
  qualityGates?: PassingQualityGate[];
}

function evaluateScenario({
  agentId,
  cluster,
  topic,
  script,
  requiredQualityGates,
  producers,
  producersByTopic,
  requiredStageTopics,
  allowExternalTopics,
  publishMessages,
}: EvaluateScenarioOptions): boolean {
  const { ledger, messageBus, logicEngine } = simulationRuntime.createSimulationRuntime(cluster);

  publishStageStartMessages({
    messageBus,
    clusterId: cluster.id,
    producersByTopic,
    requiredStageTopics,
    allowExternalTopics,
  });
  publishMessages(messageBus, producers, cluster.id);

  const result = logicEngine.evaluate(
    script,
    { id: agentId, cluster_id: cluster.id, requiredQualityGates },
    { topic }
  );
  ledger.close();
  return result;
}

function getPassingQualityGate(requiredGate: RequiredQualityGate): PassingQualityGate {
  const scope = requiredGate.scope || 'template-sim';
  return {
    id: requiredGate.id,
    status: 'PASS',
    scope,
    completedAt: Date.now(),
    evidence: {
      command: `quality-check --scope ${scope}`,
      exitCode: 0,
      output: 'template simulation quality pass',
    },
  };
}

function getApprovedResultData(context: ScenarioContext): ApprovedResultData {
  const data: ApprovedResultData = { approved: true };
  const requiredQualityGates = Array.isArray(context.requiredQualityGates)
    ? context.requiredQualityGates
    : [];
  if (
    context.agentId === 'git-pusher' &&
    context.topic === 'VALIDATION_RESULT' &&
    requiredQualityGates.length > 0
  ) {
    data.qualityGates = requiredQualityGates.map(getPassingQualityGate);
  }
  return data;
}

export function checkDuplicateProducerScenario(context: ScenarioContext): boolean {
  return evaluateScenario({
    ...context,
    publishMessages(messageBus, producers, clusterId) {
      const message = {
        cluster_id: clusterId,
        topic: context.topic,
        sender: producers[0],
        content: { data: getApprovedResultData(context) },
      };
      messageBus.publish(message);
      messageBus.publish(message);
    },
  });
}

export function checkDistinctProducerScenario(context: ScenarioContext): boolean {
  return evaluateScenario({
    ...context,
    publishMessages(messageBus, producers, clusterId) {
      for (const producer of producers) {
        messageBus.publish({
          cluster_id: clusterId,
          topic: context.topic,
          sender: producer,
          content: { data: getApprovedResultData(context) },
        });
      }
    },
  });
}
