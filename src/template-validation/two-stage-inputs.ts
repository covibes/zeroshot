import type { ValidationCluster, ValidationStageSpec } from './two-stage-contracts';

interface SimulationMessageBus {
  publish(message: unknown): unknown;
}

export function publishScenarioInputs(
  spec: ValidationStageSpec,
  cluster: ValidationCluster,
  messageBus: SimulationMessageBus
): void {
  const now = Date.now();
  messageBus.publish({
    cluster_id: cluster.id,
    topic: spec.stageStartTopic,
    sender: spec.stageStartSender,
    timestamp: now,
  });

  spec.validators.forEach((validator, index) => {
    messageBus.publish({
      cluster_id: cluster.id,
      topic: spec.triggerTopic,
      sender: validator.sender,
      timestamp: now + (index + 1) * 10,
      content: { data: { approved: true, errors: [validator.error] } },
    });
  });
}
