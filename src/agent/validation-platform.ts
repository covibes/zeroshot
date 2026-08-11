const PLATFORM_MISMATCH_REGEX =
  /EBADPLATFORM|Unsupported platform|darwin-arm64|linux-x64|@esbuild\/linux-x64/i;

interface ValidationCriterion {
  readonly status?: unknown;
  readonly reason?: unknown;
}

interface ValidationResult {
  readonly criteriaResults?: unknown;
  readonly errors?: unknown;
}

function isValidationCriterion(value: unknown): value is ValidationCriterion {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function isPlatformMismatchReason(reason: unknown): boolean {
  if (!reason) return false;
  return PLATFORM_MISMATCH_REGEX.test(String(reason));
}

function findPlatformMismatchReason(result: ValidationResult = {}): string | null {
  const criteriaResults = result.criteriaResults;
  if (Array.isArray(criteriaResults)) {
    for (const criteria of criteriaResults) {
      if (!isValidationCriterion(criteria) || criteria.status !== 'CANNOT_VALIDATE') continue;
      if (isPlatformMismatchReason(criteria.reason)) {
        return String(criteria.reason);
      }
    }
  }

  const errors = result.errors;
  if (Array.isArray(errors)) {
    for (const error of errors) {
      if (isPlatformMismatchReason(error)) {
        return String(error);
      }
    }
  }

  return null;
}

export = {
  isPlatformMismatchReason,
  findPlatformMismatchReason,
};
