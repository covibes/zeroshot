import { simulateValidationStage } from './two-stage-scenario';
import type { ValidationStageSpec, ValidationTemplateConfig } from './two-stage-contracts';

const QUICK_VALIDATION_SPEC: ValidationStageSpec = {
  templateId: 'quick-validation',
  clusterId: 'quick-sim',
  triggerTopic: 'QUICK_VALIDATION_RESULT',
  stageStartTopic: 'IMPLEMENTATION_READY',
  stageStartSender: 'worker',
  validators: [
    { sender: 'validator-requirements', error: 'req-error' },
    { sender: 'validator-code', error: 'code-error' },
  ],
  passTopic: 'QUICK_VALIDATION_PASSED',
  gateFailure: 'quick-validation: gate did not open after both validators',
  missingPassFailure: 'quick-validation: expected QUICK_VALIDATION_PASSED',
  missingResultFailure: 'quick-validation: expected VALIDATION_RESULT on rejection',
  aggregateFailure: 'quick-validation: rejection did not aggregate validator errors',
};

const HEAVY_VALIDATION_SPEC: ValidationStageSpec = {
  templateId: 'heavy-validation',
  clusterId: 'heavy-sim',
  triggerTopic: 'HEAVY_VALIDATION_RESULT',
  stageStartTopic: 'QUICK_VALIDATION_PASSED',
  stageStartSender: 'consensus-coordinator',
  validators: [
    { sender: 'validator-security', error: 'sec-error' },
    { sender: 'validator-tester', error: 'test-error' },
  ],
  gateFailure: 'heavy-validation: gate did not open after both validators',
  missingPassFailure: 'heavy-validation: expected QUICK_VALIDATION_PASSED',
  missingResultFailure: 'heavy-validation: expected VALIDATION_RESULT',
  aggregateFailure: 'heavy-validation: did not aggregate validator errors',
};

interface SimulationInput {
  templateId: string;
  config: ValidationTemplateConfig;
}

/** Run deterministic two-stage validation scenarios for base templates. */
function simulateTwoStageValidation({ templateId, config }: SimulationInput): Promise<string[]> {
  if (templateId === 'quick-validation') {
    return simulateValidationStage(QUICK_VALIDATION_SPEC, config);
  }
  if (templateId === 'heavy-validation') {
    return simulateValidationStage(HEAVY_VALIDATION_SPEC, config);
  }
  return Promise.resolve([]);
}

export = {
  simulateTwoStageValidation,
};
