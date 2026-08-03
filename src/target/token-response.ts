const MAX_TOKEN_BYTES = 16 * 1024;
const TOKEN_RESPONSE_FIELDS = [
  'access_token',
  'refresh_token',
  'token_type',
  'expires_in',
  'refresh_expires_in',
  'scope',
] as const;

export interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maxBytes;
}

function tokenFieldsValid(token: Record<string, unknown>): boolean {
  const fields = Object.keys(token);
  return fields.length === TOKEN_RESPONSE_FIELDS.length &&
    fields.every((key) => TOKEN_RESPONSE_FIELDS.includes(
      key as (typeof TOKEN_RESPONSE_FIELDS)[number],
    ));
}

function tokenLifetimesValid(token: Record<string, unknown>): boolean {
  return Number.isSafeInteger(token.expires_in) &&
    (token.expires_in as number) > 0 &&
    (token.expires_in as number) <= 86_400 &&
    Number.isSafeInteger(token.refresh_expires_in) &&
    (token.refresh_expires_in as number) > 0 &&
    (token.refresh_expires_in as number) <= 31_536_000;
}

function tokenStringsValid(token: Record<string, unknown>): boolean {
  return boundedString(token.access_token, MAX_TOKEN_BYTES) &&
    boundedString(token.refresh_token, MAX_TOKEN_BYTES) &&
    token.token_type === 'Bearer' &&
    boundedString(token.scope, 512) &&
    !/[\u0000-\u001f\u007f]/.test(token.scope);
}

export function parseTokenResponse(value: unknown): TokenResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Token response is malformed');
  }
  const token = value as Record<string, unknown>;
  if (!tokenFieldsValid(token) || !tokenLifetimesValid(token) || !tokenStringsValid(token)) {
    throw new Error('Token response is malformed');
  }
  return Object.freeze({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: 'Bearer',
    expires_in: token.expires_in,
  }) as TokenResponse;
}
