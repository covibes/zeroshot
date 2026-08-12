export type StageStartTopic = 'IMPLEMENTATION_READY' | 'QUICK_VALIDATION_PASSED';
export type TopicProducers = Map<string, Set<string>>;
export type ConsensusProducers = [string, string, ...string[]];

export interface RequiredQualityGate {
  id: string;
  scope?: string;
}

interface CompletionHook {
  action?: string;
  config?: { topic?: unknown };
}

export interface TemplateTrigger {
  topic?: string;
  action?: string;
  logic?: { script?: string };
}

export interface TemplateAgent {
  id: string;
  role?: string;
  requiredQualityGates?: RequiredQualityGate[];
  triggers?: TemplateTrigger[];
  hooks?: { onComplete?: CompletionHook };
}

export interface TemplateConfig {
  agents?: TemplateAgent[];
}

export interface ConsensusSimulationOptions {
  allowExternalTopics?: string[];
}

interface SimulationClusterAgent {
  id: string;
  role: string | undefined;
  requiredQualityGates: RequiredQualityGate[];
}

export interface SimulationCluster {
  id: string;
  agents: SimulationClusterAgent[];
}

export interface SimulationContext {
  agents: TemplateAgent[];
  producersByTopic: TopicProducers;
  allowExternalTopics: string[];
  cluster: SimulationCluster;
}

export interface ScenarioContext {
  agentId: string;
  cluster: SimulationCluster;
  topic: string;
  script: string;
  requiredQualityGates: RequiredQualityGate[];
  producers: ConsensusProducers;
  producersByTopic: TopicProducers;
  requiredStageTopics: StageStartTopic[];
  allowExternalTopics: string[];
}

export type ConsensusScenario =
  | { failure: string }
  | { failure: null }
  | { failure: null; context: ScenarioContext };
