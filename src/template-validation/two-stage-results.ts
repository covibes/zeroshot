import type { ScenarioOutcome, ValidationStageSpec } from './two-stage-contracts';

interface ScenarioMessages {
  passed: unknown;
  validationResult: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getValidationErrors(message: unknown): string[] {
  if (!isRecord(message)) return [];
  const content = message.content;
  if (!isRecord(content)) return [];
  const data = content.data;
  if (!isRecord(data) || !Array.isArray(data.errors)) return [];
  return data.errors.filter((error): error is string => typeof error === 'string');
}

export function evaluateScenarioMessages(
  spec: ValidationStageSpec,
  allApproved: boolean,
  messages: ScenarioMessages
): ScenarioOutcome {
  if (allApproved && spec.passTopic) {
    return messages.passed ? { ok: true } : { ok: false, error: spec.missingPassFailure };
  }

  if (!messages.validationResult) {
    return { ok: false, error: spec.missingResultFailure };
  }

  const errors = getValidationErrors(messages.validationResult);
  if (!spec.validators.every((validator) => errors.includes(validator.error))) {
    return { ok: false, error: spec.aggregateFailure };
  }

  return { ok: true };
}
