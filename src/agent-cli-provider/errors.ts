import { getNumber, getRecord, getString, isRecord, unknownToMessage } from './json';
import type { ErrorClassification } from './types';

export class UnsupportedProviderCapabilityError extends Error {
  readonly code = 'unsupported-capability';
  readonly permanent = true;
  readonly provider: string;
  readonly capability: string;

  constructor(provider: string, capability: string, message: string) {
    super(message);
    this.name = 'UnsupportedProviderCapabilityError';
    this.provider = provider;
    this.capability = capability;
  }
}

const BASE_RETRYABLE_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /\b429\b/i,
  /too many requests/i,
  /overloaded/i,
  /temporar(?:y|ily)/i,
  /unavailable/i,
  /try again/i,
  /timeout/i,
  /timed out/i,
  /deadline exceeded/i,
  /connection (?:reset|refused)/i,
  /\b(econnreset|econnrefused|etimedout|eai_again)\b/i,
  /network/i,
];

const BASE_PERMANENT_PATTERNS: readonly RegExp[] = [
  /invalid[_ -]?api[_ -]?key/i,
  /api[_ -]?key.*invalid/i,
  /unauthorized/i,
  /forbidden/i,
  /authentication/i,
  /permission denied/i,
  /invalid argument/i,
  /unknown option/i,
  /\busage:\b/i,
  /command not found/i,
  /not recognized as an internal or external command/i,
  /model not found/i,
  /context length exceeded/i,
  /insufficient quota/i,
];

function statusFromMessage(message: string): number | null {
  const match = /\b(?:status(?: code)?|http)\s+(?<status>\d{3})\b/i.exec(message);
  if (!match?.groups?.status) return null;
  const status = Number.parseInt(match.groups.status, 10);
  return Number.isInteger(status) ? status : null;
}

export function extractErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const directStatus = getNumber(error, 'status') ?? getNumber(error, 'statusCode');
  if (directStatus !== null) return directStatus;

  const response = getRecord(error, 'response');
  const responseStatus =
    response === null ? null : getNumber(response, 'status') ?? getNumber(response, 'statusCode');
  if (responseStatus !== null) return responseStatus;

  return statusFromMessage(unknownToMessage(error));
}

function getCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  return getString(error, 'code');
}

function firstMatchedPattern(patterns: readonly RegExp[], message: string): RegExp | null {
  for (const pattern of patterns) {
    if (pattern.test(message)) return pattern;
  }
  return null;
}

export function baseRetryableErrorPatterns(): readonly RegExp[] {
  return BASE_RETRYABLE_PATTERNS;
}

export function basePermanentErrorPatterns(): readonly RegExp[] {
  return BASE_PERMANENT_PATTERNS;
}

export function classifyErrorWithPatterns(
  error: unknown,
  retryablePatterns: readonly RegExp[],
  permanentPatterns: readonly RegExp[]
): ErrorClassification {
  const statusClassification = classifyStatus(extractErrorStatus(error));
  if (statusClassification !== null) return statusClassification;

  const codeClassification = classifyCode(getCode(error));
  if (codeClassification !== null) return codeClassification;

  const message = unknownToMessage(error).trim();
  if (!message) return { retryable: true, kind: 'unknown-retryable' };
  return classifyMessage(message, retryablePatterns, permanentPatterns);
}

function classifyStatus(status: number | null): ErrorClassification | null {
  if (typeof status !== 'number') return null;
  if (status === 429 || status >= 500) return { retryable: true, kind: 'status-retryable' };
  if (status >= 400 && status < 500) return { retryable: false, kind: 'status-permanent' };
  return null;
}

function classifyCode(code: string | null): ErrorClassification | null {
  if (typeof code !== 'string') return null;
  if (/\b(econnreset|econnrefused|etimedout|eai_again)\b/i.test(code)) {
    return { retryable: true, kind: 'code-retryable', matchedPattern: 'network-code' };
  }
  return null;
}

function classifyMessage(
  message: string,
  retryablePatterns: readonly RegExp[],
  permanentPatterns: readonly RegExp[]
): ErrorClassification {
  const permanent = firstMatchedPattern(permanentPatterns, message);
  if (permanent !== null) {
    return {
      retryable: false,
      kind: 'permanent-pattern',
      matchedPattern: permanent.source,
    };
  }

  const retryable = firstMatchedPattern(retryablePatterns, message);
  if (retryable !== null) {
    return {
      retryable: true,
      kind: 'retryable-pattern',
      matchedPattern: retryable.source,
    };
  }

  return { retryable: true, kind: 'unknown-retryable' };
}
