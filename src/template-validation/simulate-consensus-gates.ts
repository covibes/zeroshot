import {
  checkDistinctProducerScenario,
  checkDuplicateProducerScenario,
} from './consensus-gate-scenarios';
import { getRequiredStageTopics } from './consensus-gate-stage';
import type {
  ConsensusScenario,
  ConsensusSimulationOptions,
  SimulationContext,
  StageStartTopic,
  TemplateAgent,
  TemplateConfig,
  TemplateTrigger,
  TopicProducers,
} from './consensus-gate-contracts';

function collectTopicProducers(config: TemplateConfig): TopicProducers {
  const producersByTopic: TopicProducers = new Map();

  for (const agent of config.agents || []) {
    const topic = getPublishedTopic(agent);
    if (!topic) continue;
    const producers = producersByTopic.get(topic) || new Set<string>();
    producers.add(agent.id);
    producersByTopic.set(topic, producers);
  }

  return producersByTopic;
}

function getPublishedTopic(agent: TemplateAgent): string | null {
  const onComplete = agent.hooks?.onComplete;
  if (!onComplete) return null;
  if (onComplete.action !== 'publish_message') return null;
  if (!onComplete.config?.topic) return null;
  return String(onComplete.config.topic);
}

function isConsensusLikeAgent(agent: TemplateAgent): boolean {
  const agentId = String(agent.id || '');
  const explicitIds = ['git-pusher', 'completion-detector'];
  const hasConsensusLikeId = agentId.includes('consensus') || agentId.includes('coordinator');
  const hasStopClusterTrigger =
    agent.triggers?.some((trigger) => trigger.action === 'stop_cluster') === true;

  return (
    agent.role === 'coordinator' ||
    explicitIds.includes(agentId) ||
    hasConsensusLikeId ||
    hasStopClusterTrigger
  );
}

function getMissingStageTopics(
  requiredStageTopics: StageStartTopic[],
  producersByTopic: TopicProducers,
  allowExternalTopics: string[]
): StageStartTopic[] {
  return requiredStageTopics.filter((stageTopic) => {
    const producers = producersByTopic.get(stageTopic);
    return (!producers || producers.size === 0) && !allowExternalTopics.includes(stageTopic);
  });
}

function createSimulationContext(
  config: TemplateConfig,
  options: ConsensusSimulationOptions = {}
): SimulationContext {
  const agents = Array.isArray(config.agents) ? config.agents : [];

  return {
    agents,
    producersByTopic: collectTopicProducers(config),
    allowExternalTopics: Array.isArray(options.allowExternalTopics)
      ? options.allowExternalTopics
      : [],
    cluster: {
      id: 'template-sim',
      agents: agents.map((agent) => ({
        id: agent.id,
        role: agent.role,
        requiredQualityGates: agent.requiredQualityGates || [],
      })),
    },
  };
}

function getMissingStageFailure(
  agentId: string,
  topic: string,
  missingStageTopics: StageStartTopic[]
): string | null {
  if (missingStageTopics.length === 0) return null;

  return (
    `Agent "${agentId}" trigger on "${topic}" depends on missing stage topic(s): ${missingStageTopics.join(', ')}. ` +
    'Preflight must validate real producers, not synthesize stage-start messages.'
  );
}

function hasAtLeastTwoProducers(producers: string[]): producers is [string, string, ...string[]] {
  return producers.length >= 2;
}

function getConsensusScenarioContext(
  agent: TemplateAgent,
  trigger: TemplateTrigger,
  simulation: SimulationContext
): ConsensusScenario | null {
  const topic = trigger.topic;
  const script = trigger.logic?.script;
  if (!topic || !script) return null;

  const requiredStageTopics = getRequiredStageTopics(script);
  const missingStageFailure = getMissingStageFailure(
    agent.id,
    topic,
    getMissingStageTopics(
      requiredStageTopics,
      simulation.producersByTopic,
      simulation.allowExternalTopics
    )
  );
  if (missingStageFailure) return { failure: missingStageFailure };

  const producers = Array.from(simulation.producersByTopic.get(topic) || []);
  if (!hasAtLeastTwoProducers(producers)) return { failure: null };

  return {
    context: {
      agentId: agent.id,
      cluster: simulation.cluster,
      topic,
      script,
      requiredQualityGates: agent.requiredQualityGates || [],
      producers,
      producersByTopic: simulation.producersByTopic,
      requiredStageTopics,
      allowExternalTopics: simulation.allowExternalTopics,
    },
    failure: null,
  };
}

function validateConsensusTrigger(
  agent: TemplateAgent,
  trigger: TemplateTrigger,
  simulation: SimulationContext
): string[] {
  const scenario = getConsensusScenarioContext(agent, trigger, simulation);
  if (!scenario) return [];
  if (scenario.failure) return [scenario.failure];
  if (!('context' in scenario)) return [];

  const { context } = scenario;
  const { producers, topic } = context;
  const failures: string[] = [];

  if (checkDuplicateProducerScenario(context)) {
    failures.push(
      `Agent "${agent.id}" trigger on "${topic}" fires early on duplicate sender (${producers[0]}). ` +
        `Gate must require distinct producers: ${producers.join(', ')}`
    );
  }
  if (!checkDistinctProducerScenario(context)) {
    failures.push(
      `Agent "${agent.id}" trigger on "${topic}" did not fire after all producers published. ` +
        `Expected producers: ${producers.join(', ')}`
    );
  }

  return failures;
}

/** Validate consensus-like trigger gates against duplicate and distinct producer scenarios. */
function simulateConsensusGates(
  config: TemplateConfig,
  options: ConsensusSimulationOptions = {}
): string[] {
  const simulation = createSimulationContext(config, options);
  const failures: string[] = [];

  for (const agent of simulation.agents) {
    if (!isConsensusLikeAgent(agent)) continue;
    for (const trigger of agent.triggers || []) {
      failures.push(...validateConsensusTrigger(agent, trigger, simulation));
    }
  }

  return failures;
}

export = {
  collectTopicProducers,
  simulateConsensusGates,
};
