type UnknownRecord = Record<string, unknown>;

const LIMITS = {
  errors: 5,
  criteriaResults: 10,
  acceptanceCriteria: 10,
  filesAffected: 20,
  blockers: 5,
  nextSteps: 10,
  rootCauses: 5,
};

const TEXT_LIMITS = {
  task: 2000,
  plan: 2500, // Slightly increased for actionable plans with embedded patterns (was 2000)
  fixPlan: 1200,
  summary: 300,
  listItem: 200,
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function asRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

function isPresentString(value: string | undefined): value is string {
  return Boolean(value);
}

function toTimestamp(message: unknown): number {
  const timestamp = asRecord(message)?.timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return timestamp;
  }
  return Date.now();
}

function normalizeText(value: unknown, maxLength: number, singleLine = false): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text = String(value);
  if (singleLine) {
    text = text.replace(/\s+/g, ' ').trim();
  } else {
    text = text.trim();
  }
  if (!text) return undefined;
  if (maxLength && text.length > maxLength) {
    return `${text.slice(0, maxLength - 3)}...`;
  }
  return text;
}

function normalizeStringList(list: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const normalized = list
    .map((item: unknown) => normalizeText(item, TEXT_LIMITS.listItem, true))
    .filter(isPresentString);
  if (normalized.length === 0) return undefined;
  if (maxItems && normalized.length > maxItems) {
    return normalized.slice(-maxItems);
  }
  return normalized;
}

function normalizeAcceptanceCriteria(criteria: unknown): string[] | undefined {
  if (!Array.isArray(criteria)) return undefined;
  const normalized = criteria
    .map((item: unknown) => {
      if (typeof item === 'string') {
        return normalizeText(item, TEXT_LIMITS.listItem, true);
      }
      const itemRecord = asRecord(item);
      if (!itemRecord) return undefined;
      const id = itemRecord.id ? String(itemRecord.id) : '';
      const priority = itemRecord.priority ? ` (${String(itemRecord.priority)})` : '';
      const criterion = itemRecord.criterion || itemRecord.text || itemRecord.summary || '';
      const label = id ? `${id}${priority}: ` : '';
      const merged = `${label}${String(criterion)}`.trim();
      if (!merged) return undefined;
      return normalizeText(merged, TEXT_LIMITS.listItem, true);
    })
    .filter(isPresentString);
  if (normalized.length === 0) return undefined;
  if (normalized.length > LIMITS.acceptanceCriteria) {
    return normalized.slice(-LIMITS.acceptanceCriteria);
  }
  return normalized;
}

function normalizeCriteriaEvidence(evidence: unknown): UnknownRecord | undefined {
  const evidenceRecord = asRecord(evidence);
  if (!evidenceRecord) return undefined;
  const normalized: UnknownRecord = {};
  if (evidenceRecord.command) {
    const command = normalizeText(evidenceRecord.command, TEXT_LIMITS.listItem, true);
    if (command) normalized.command = command;
  }
  if (typeof evidenceRecord.exitCode === 'number' && Number.isFinite(evidenceRecord.exitCode)) {
    normalized.exitCode = evidenceRecord.exitCode;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeCriteriaResult(item: unknown): UnknownRecord | undefined {
  const itemRecord = asRecord(item);
  if (!itemRecord) return undefined;
  const entry: UnknownRecord = {};
  if (itemRecord.id) entry.id = String(itemRecord.id);
  if (itemRecord.status) entry.status = String(itemRecord.status);
  if (itemRecord.reason) {
    const reason = normalizeText(itemRecord.reason, TEXT_LIMITS.listItem, true);
    if (reason) entry.reason = reason;
  }
  const evidence = normalizeCriteriaEvidence(itemRecord.evidence);
  if (evidence) entry.evidence = evidence;
  return Object.keys(entry).length > 0 ? entry : undefined;
}

function isPresentRecord(value: UnknownRecord | undefined): value is UnknownRecord {
  return value !== undefined;
}

function normalizeCriteriaResults(results: unknown): UnknownRecord[] | undefined {
  if (!Array.isArray(results)) return undefined;
  const normalized = results.map(normalizeCriteriaResult).filter(isPresentRecord);
  if (normalized.length === 0) return undefined;
  if (normalized.length > LIMITS.criteriaResults) {
    return normalized.slice(-LIMITS.criteriaResults);
  }
  return normalized;
}

function normalizeErrors(data: unknown): string[] | undefined {
  const dataRecord = asRecord(data);
  if (!dataRecord) return undefined;
  if (Array.isArray(dataRecord.errors)) {
    return normalizeStringList(dataRecord.errors, LIMITS.errors);
  }
  if (Array.isArray(dataRecord.issues)) {
    const mapped = dataRecord.issues.map((issue: unknown) => {
      if (typeof issue === 'string') return issue;
      const issueRecord = asRecord(issue);
      if (!issueRecord) return undefined;
      return (
        issueRecord.bug ||
        issueRecord.message ||
        issueRecord.error ||
        issueRecord.summary ||
        undefined
      );
    });
    return normalizeStringList(mapped, LIMITS.errors);
  }
  return undefined;
}

function normalizeRootCauses(rootCauses: unknown): string[] | undefined {
  if (!Array.isArray(rootCauses)) return undefined;
  const normalized = rootCauses
    .map((cause: unknown) => {
      if (typeof cause === 'string') {
        return normalizeText(cause, TEXT_LIMITS.listItem, true);
      }
      const causeRecord = asRecord(cause);
      if (!causeRecord) return undefined;
      return normalizeText(
        causeRecord.cause || causeRecord.summary || causeRecord.description,
        TEXT_LIMITS.listItem,
        true
      );
    })
    .filter(isPresentString);
  if (normalized.length === 0) return undefined;
  if (normalized.length > LIMITS.rootCauses) {
    return normalized.slice(-LIMITS.rootCauses);
  }
  return normalized;
}

function normalizeFilesAffected(filesAffected: unknown): string[] | undefined {
  return normalizeStringList(filesAffected, LIMITS.filesAffected);
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function normalizeProgressStatus(data: unknown): UnknownRecord | undefined {
  const dataRecord = asRecord(data);
  if (!dataRecord) return undefined;
  const completionStatus = asRecord(dataRecord.completionStatus);
  if (completionStatus) {
    return completionStatus;
  }
  const hasProgressFields =
    Object.prototype.hasOwnProperty.call(dataRecord, 'canValidate') ||
    Object.prototype.hasOwnProperty.call(dataRecord, 'percentComplete');
  return hasProgressFields ? dataRecord : undefined;
}

export = {
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
};
