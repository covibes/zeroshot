import normalization = require('./state-snapshot-normalization');

const SNAPSHOT_VERSION = 1;

type UnknownRecord = Record<string, unknown>;

interface SnapshotStateDraft {
  version: number;
  updatedAt: number;
  clusterId: unknown;
  sourceMessageId: unknown;
  task?: unknown;
  plan?: unknown;
  progress?: unknown;
  validation?: unknown;
  debug?: unknown;
}

interface SnapshotState extends UnknownRecord {
  version: number;
  updatedAt: number;
  clusterId: unknown;
  sourceMessageId: unknown;
}

const {
  LIMITS,
  TEXT_LIMITS,
  asRecord,
  isPresentString,
  toTimestamp,
  normalizeText,
  normalizeStringList,
  normalizeAcceptanceCriteria,
  normalizeCriteriaResults,
  normalizeErrors,
  normalizeRootCauses,
  normalizeFilesAffected,
  normalizeBoolean,
  normalizeProgressStatus,
} = normalization;

function buildBaseState(state: unknown, message: unknown): SnapshotStateDraft {
  const stateRecord = asRecord(state);
  const messageRecord = asRecord(message);
  return {
    version: SNAPSHOT_VERSION,
    updatedAt: toTimestamp(message),
    clusterId: messageRecord?.cluster_id || stateRecord?.clusterId || null,
    sourceMessageId: messageRecord?.id || stateRecord?.sourceMessageId || null,
    task: stateRecord?.task,
    plan: stateRecord?.plan,
    progress: stateRecord?.progress,
    validation: stateRecord?.validation,
    debug: stateRecord?.debug,
  };
}

function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    const next = value.map(pruneEmpty).filter((item: unknown) => item !== undefined);
    return next.length > 0 ? next : undefined;
  }
  const valueRecord = asRecord(value);
  if (valueRecord) {
    const next: UnknownRecord = {};
    for (const [key, entry] of Object.entries(valueRecord)) {
      const pruned = pruneEmpty(entry);
      if (pruned !== undefined) {
        next[key] = pruned;
      }
    }
    return Object.keys(next).length > 0 ? next : undefined;
  }
  if (value === undefined || value === null) return undefined;
  return value;
}

function finalizeState(state: SnapshotStateDraft): SnapshotState {
  const result: SnapshotState = {
    version: state.version ?? SNAPSHOT_VERSION,
    updatedAt: state.updatedAt ?? Date.now(),
    clusterId: state.clusterId ?? null,
    sourceMessageId: state.sourceMessageId ?? null,
  };
  const sections = asRecord(
    pruneEmpty({
      task: state.task,
      plan: state.plan,
      progress: state.progress,
      validation: state.validation,
      debug: state.debug,
    })
  );
  if (sections) {
    Object.assign(result, sections);
  }
  return result;
}

function messageContent(message: unknown): UnknownRecord {
  return asRecord(asRecord(message)?.content) ?? {};
}

function contentData(content: UnknownRecord): UnknownRecord {
  return asRecord(content.data) ?? {};
}

function initStateFromIssue(issueMessage: unknown): SnapshotState {
  const messageRecord = asRecord(issueMessage);
  const content = messageContent(issueMessage);
  const data = contentData(content);
  const task = {
    raw: normalizeText(content.text, TEXT_LIMITS.task),
    title: normalizeText(data.title, TEXT_LIMITS.summary, true),
    issueNumber: data.issue_number ?? data.issueNumber,
    source: asRecord(messageRecord?.metadata)?.source,
  };
  const base = buildBaseState(null, issueMessage);
  base.task = pruneEmpty(task);
  return finalizeState(base);
}

function applyIssueOpened(state: unknown, message: unknown): SnapshotState {
  const messageRecord = asRecord(message);
  const base = buildBaseState(state, message);
  const content = messageContent(message);
  const data = contentData(content);
  const task = {
    raw: normalizeText(content.text, TEXT_LIMITS.task),
    title: normalizeText(data.title, TEXT_LIMITS.summary, true),
    issueNumber: data.issue_number ?? data.issueNumber,
    source: asRecord(messageRecord?.metadata)?.source,
  };
  base.task = pruneEmpty(task);
  return finalizeState(base);
}

function applyPlanReady(state: unknown, message: unknown): SnapshotState {
  const base = buildBaseState(state, message);
  const content = messageContent(message);
  const data = contentData(content);
  const plan = {
    text: normalizeText(content.text, TEXT_LIMITS.plan),
    summary: normalizeText(data.summary, TEXT_LIMITS.summary, true),
    acceptanceCriteria: normalizeAcceptanceCriteria(data.acceptanceCriteria),
    filesAffected: normalizeFilesAffected(data.filesAffected),
    updatedAt: toTimestamp(message),
  };
  base.plan = pruneEmpty(plan);
  return finalizeState(base);
}

function applyWorkerProgress(state: unknown, message: unknown): SnapshotState {
  const base = buildBaseState(state, message);
  const content = messageContent(message);
  const status = normalizeProgressStatus(content.data || {});
  if (!status) {
    return finalizeState(base);
  }
  const progress = {
    canValidate: normalizeBoolean(status.canValidate),
    percentComplete:
      typeof status.percentComplete === 'number' && Number.isFinite(status.percentComplete)
        ? status.percentComplete
        : undefined,
    blockers: normalizeStringList(status.blockers, LIMITS.blockers),
    nextSteps: normalizeStringList(status.nextSteps, LIMITS.nextSteps),
    lastSummary: normalizeText(content.text || status.summary, TEXT_LIMITS.summary, true),
    updatedAt: toTimestamp(message),
  };
  base.progress = pruneEmpty(progress);
  return finalizeState(base);
}

function applyImplementationReady(state: unknown, message: unknown): SnapshotState {
  return applyWorkerProgress(state, message);
}

function applyValidationResult(state: unknown, message: unknown): SnapshotState {
  const base = buildBaseState(state, message);
  const content = messageContent(message);
  const data = contentData(content);
  const validation = {
    approved: normalizeBoolean(data.approved),
    errors: normalizeErrors(data),
    criteriaResults: normalizeCriteriaResults(data.criteriaResults),
    updatedAt: toTimestamp(message),
  };
  base.validation = pruneEmpty(validation);
  return finalizeState(base);
}

function applyInvestigationComplete(state: unknown, message: unknown): SnapshotState {
  const base = buildBaseState(state, message);
  const content = messageContent(message);
  const data = contentData(content);
  const debug = {
    fixPlan: normalizeText(content.text, TEXT_LIMITS.fixPlan),
    successCriteria: normalizeText(data.successCriteria, TEXT_LIMITS.summary, true),
    rootCauses: normalizeRootCauses(data.rootCauses),
    updatedAt: toTimestamp(message),
  };
  base.debug = pruneEmpty(debug);
  return finalizeState(base);
}

function sectionFor(state: unknown, key: string): UnknownRecord | null {
  return asRecord(asRecord(state)?.[key]);
}

function buildTaskSummary(state: unknown): string | undefined {
  const task = sectionFor(state, 'task');
  const taskTitle = normalizeText(task?.title || task?.raw, TEXT_LIMITS.summary, true);
  return taskTitle ? `Task: ${taskTitle}` : undefined;
}

function buildPlanSummary(state: unknown): string | undefined {
  const plan = sectionFor(state, 'plan');
  const planSummary = normalizeText(plan?.summary || plan?.text, TEXT_LIMITS.summary, true);
  return planSummary ? `Plan: ${planSummary}` : undefined;
}

function buildProgressSummary(state: unknown): string | undefined {
  const progress = sectionFor(state, 'progress');
  if (!progress) return undefined;
  const parts: string[] = [];
  if (typeof progress.percentComplete === 'number' && Number.isFinite(progress.percentComplete)) {
    parts.push(`${progress.percentComplete}%`);
  }
  if (typeof progress.canValidate === 'boolean') {
    parts.push(`canValidate=${progress.canValidate}`);
  }
  const firstNextStep: unknown = Array.isArray(progress.nextSteps)
    ? progress.nextSteps[0]
    : undefined;
  const nextStepText = normalizeText(firstNextStep, TEXT_LIMITS.listItem, true);
  if (nextStepText) {
    parts.push(`next: ${nextStepText}`);
  }
  return parts.length > 0 ? `Progress: ${parts.join(' | ')}` : undefined;
}

function resolveValidationStatus(approved: unknown): string {
  if (approved === true) return 'approved';
  if (approved === false) return 'rejected';
  return 'pending';
}

function buildValidationSummary(state: unknown): string | undefined {
  const validation = sectionFor(state, 'validation');
  if (!validation) return undefined;
  const status = resolveValidationStatus(validation.approved);
  const errorCount = Array.isArray(validation.errors) ? validation.errors.length : 0;
  return `Validation: ${status}${errorCount ? ` (${errorCount} errors)` : ''}`;
}

function buildDebugSummary(state: unknown): string | undefined {
  const debug = sectionFor(state, 'debug');
  const debugSummary = normalizeText(
    debug?.fixPlan || debug?.successCriteria,
    TEXT_LIMITS.summary,
    true
  );
  return debugSummary ? `Debug: ${debugSummary}` : undefined;
}

function renderStateSummary(state: unknown): string {
  if (!asRecord(state)) return '';
  const lines = [
    buildTaskSummary(state),
    buildPlanSummary(state),
    buildProgressSummary(state),
    buildValidationSummary(state),
    buildDebugSummary(state),
  ].filter(isPresentString);

  return lines.join('\n');
}

export = {
  SNAPSHOT_VERSION,
  initStateFromIssue,
  applyIssueOpened,
  applyPlanReady,
  applyWorkerProgress,
  applyImplementationReady,
  applyValidationResult,
  applyInvestigationComplete,
  renderStateSummary,
};
