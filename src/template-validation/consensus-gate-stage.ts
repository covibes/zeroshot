import type { StageStartTopic, TopicProducers } from './consensus-gate-contracts';

const STAGE_START_TOPICS = [
  'IMPLEMENTATION_READY',
  'QUICK_VALIDATION_PASSED',
] as const satisfies readonly StageStartTopic[];

const EXTERNAL_STAGE_SENDERS: Readonly<Record<StageStartTopic, string>> = {
  IMPLEMENTATION_READY: 'worker',
  QUICK_VALIDATION_PASSED: 'consensus-coordinator',
};

interface SimulationMessageBus {
  publish(message: unknown): unknown;
}

interface PublishStageStartOptions {
  messageBus: SimulationMessageBus;
  clusterId: string;
  producersByTopic: TopicProducers;
  requiredStageTopics: StageStartTopic[];
  allowExternalTopics: string[];
}

function scriptReferencesTopic(logicScript: string, topic: string): boolean {
  return logicScript.includes(`topic: '${topic}'`) || logicScript.includes(`topic: "${topic}"`);
}

export function getRequiredStageTopics(logicScript: string): StageStartTopic[] {
  return STAGE_START_TOPICS.filter((topic) => scriptReferencesTopic(logicScript, topic));
}

export function publishStageStartMessages({
  messageBus,
  clusterId,
  producersByTopic,
  requiredStageTopics,
  allowExternalTopics,
}: PublishStageStartOptions): void {
  let timestamp = Date.now();

  for (const topic of requiredStageTopics) {
    const producers = Array.from(producersByTopic.get(topic) || []);
    const sender =
      producers.at(0) ??
      (allowExternalTopics.includes(topic) ? EXTERNAL_STAGE_SENDERS[topic] : null);
    if (!sender) continue;

    messageBus.publish({
      cluster_id: clusterId,
      topic,
      sender,
      timestamp: timestamp++,
    });
  }
}
