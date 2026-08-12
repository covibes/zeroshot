import { createHash } from 'node:crypto';
import type { CliErrorDetail } from './output-extraction-types';

const MAX_CLI_ERROR_BYTES = 4096;
const CLI_ERROR_TRUNCATION_SUFFIX = '… [truncated]';

function truncateUtf8(text: string, maxBytes = MAX_CLI_ERROR_BYTES): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;

  const suffixBytes = Buffer.byteLength(CLI_ERROR_TRUNCATION_SUFFIX);
  const contentBudget = Math.max(0, maxBytes - suffixBytes);
  let bytes = 0;
  let truncated = '';
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > contentBudget) break;
    truncated += character;
    bytes += characterBytes;
  }
  return `${truncated}${CLI_ERROR_TRUNCATION_SUFFIX}`;
}

function primitiveErrorText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

function cliErrorDetail(value: unknown, fallback: string): CliErrorDetail {
  const candidate = Array.isArray(value)
    ? value
        .map(primitiveErrorText)
        .filter((message) => message.trim())
        .join('; ')
    : primitiveErrorText(value);
  const raw = candidate.trim() ? candidate : fallback;
  return {
    error: truncateUtf8(raw.trim()),
    diagnostic: {
      byteLength: Buffer.byteLength(raw),
      sha256: createHash('sha256').update(raw).digest('hex'),
    },
  };
}

export = {
  MAX_CLI_ERROR_BYTES,
  cliErrorDetail,
};
