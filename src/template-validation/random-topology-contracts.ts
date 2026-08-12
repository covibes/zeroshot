import type { SimulationAgentConfig, SimulationCluster } from './simulation-agent';

export type RandomNumberGenerator = () => number;

export interface RandomTrigger {
  topic: string;
  logic?: { script?: string };
  action?: string;
}

export interface RandomAgentConfig extends SimulationAgentConfig {
  triggers?: RandomTrigger[];
  hooks?: { onComplete?: unknown };
  jsonSchema?: unknown;
  structuredOutput?: unknown;
  maxIterations?: number;
}

export interface RandomTemplateConfig {
  agents?: RandomAgentConfig[];
}

export interface SimulationMessage {
  topic: string;
  [key: string]: unknown;
}

export interface RandomSimulationState {
  agentConfigs: RandomAgentConfig[];
  cluster: SimulationCluster;
}

export interface SimulationMessageBus {
  publish(message: unknown): unknown;
}

export interface RandomDispatchContext {
  state: RandomSimulationState;
  messageBus: SimulationMessageBus;
  logicEngine: unknown;
  iterations: Map<string, number>;
  rng: RandomNumberGenerator;
}

export type ScenarioOutcome = { ok: true } | { ok: false; reason: string };

export interface RunScenarioOptions {
  config: RandomTemplateConfig;
  templateId: string;
  seed: number;
  maxSteps: number;
  maxScenarioMs: number;
  templatesDir: string;
}
