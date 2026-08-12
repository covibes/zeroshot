import validationPlatform = require('./validation-platform');

import type {
  ContextCluster,
  ContextMessage,
  ContextMessageBus,
  IsolationContext,
  ValidationCriterion,
} from './agent-context-types';

interface CannotValidateCriterion {
  id: string;
  reason: string;
}

interface CannotValidateOptions {
  ignoreReason?: ((reason: string | undefined) => boolean) | null;
}

interface ValidatorSkipParams {
  role: string;
  messageBus: ContextMessageBus;
  cluster: ContextCluster;
  isolation?: IsolationContext | null | undefined;
}

const { isPlatformMismatchReason } = validationPlatform;

function shouldKeepCannotValidate(
  criteria: ValidationCriterion,
  ignoreReason: CannotValidateOptions['ignoreReason'],
  seenIds: ReadonlySet<string>
): criteria is ValidationCriterion & { id: string } {
  if (criteria.status !== 'CANNOT_VALIDATE' || !criteria.id) {
    return false;
  }

  if (ignoreReason && ignoreReason(criteria.reason)) {
    return false;
  }

  if (seenIds.has(criteria.id)) {
    return false;
  }

  return true;
}

function isValidationCriteria(
  value: readonly ValidationCriterion[] | null | undefined
): value is readonly ValidationCriterion[] {
  return Array.isArray(value);
}

function collectCannotValidateCriteria(
  prevValidations: readonly ContextMessage[],
  options: CannotValidateOptions = {}
): CannotValidateCriterion[] {
  const cannotValidateCriteria: CannotValidateCriterion[] = [];
  const seenIds = new Set<string>();
  const ignoreReason = options.ignoreReason;

  for (const msg of prevValidations) {
    const criteriaResults = msg.content?.data?.criteriaResults;
    if (!isValidationCriteria(criteriaResults)) {
      continue;
    }

    for (const criteria of criteriaResults) {
      if (!shouldKeepCannotValidate(criteria, ignoreReason, seenIds)) {
        continue;
      }

      seenIds.add(criteria.id);
      cannotValidateCriteria.push({
        id: criteria.id,
        reason: criteria.reason || 'No reason provided',
      });
    }
  }

  return cannotValidateCriteria;
}

function buildCannotValidateSection(
  cannotValidateCriteria: readonly CannotValidateCriterion[]
): string {
  if (cannotValidateCriteria.length === 0) {
    return '';
  }

  return [
    '',
    '## ⚠️ Permanently Unverifiable Criteria (SKIP THESE)',
    '',
    'The following criteria have PERMANENT environmental limitations (missing tools, no access).',
    'These limitations have not changed. Do NOT re-attempt verification.',
    'Mark these as CANNOT_VALIDATE again with the same reason.',
    '',
    ...cannotValidateCriteria.map((criteria) => `- **${criteria.id}**: ${criteria.reason}`),
    '',
  ].join('\n');
}

function buildValidatorSkipSection({
  role,
  messageBus,
  cluster,
  isolation,
}: ValidatorSkipParams): string {
  if (role !== 'validator') {
    return '';
  }

  const prevValidations = messageBus.query({
    cluster_id: cluster.id,
    topic: 'VALIDATION_RESULT',
    since: cluster.createdAt,
    limit: 50,
  });
  const ignoreReason = isolation?.enabled ? isPlatformMismatchReason : null;
  const cannotValidateCriteria = collectCannotValidateCriteria(prevValidations, { ignoreReason });

  return buildCannotValidateSection(cannotValidateCriteria);
}

export = {
  buildValidatorSkipSection,
};
