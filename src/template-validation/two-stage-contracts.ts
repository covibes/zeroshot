export interface ValidationTrigger {
  topic?: string;
  logic?: { script?: string };
}

export interface ValidationAgentConfig {
  id: string;
  role?: string;
  triggers?: ValidationTrigger[];
  hooks?: { onComplete?: unknown };
}

export interface ValidationTemplateConfig {
  agents: ValidationAgentConfig[];
}

export interface ValidationCluster {
  id: string;
  agents: Array<{ id: string; role: string | undefined }>;
}

export interface ValidatorFixture {
  sender: string;
  error: string;
}

export interface ValidationStageSpec {
  templateId: 'quick-validation' | 'heavy-validation';
  clusterId: string;
  triggerTopic: string;
  stageStartTopic: string;
  stageStartSender: string;
  validators: readonly ValidatorFixture[];
  passTopic?: string;
  gateFailure: string;
  missingPassFailure: string;
  missingResultFailure: string;
  aggregateFailure: string;
}

export type ScenarioOutcome = { ok: true } | { ok: false; error: string };
