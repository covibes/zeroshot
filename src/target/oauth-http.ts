import { readBoundedResponseJson } from './bounded-response.ts';

const MAX_SESSION_RESPONSE_BYTES = 64 * 1024;

export function oauthFormRequest(
  body: URLSearchParams,
  signal?: AbortSignal,
): RequestInit & { redirect: 'error' } {
  const init: RequestInit & { redirect: 'error' } = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'error',
  };
  if (signal !== undefined) init.signal = signal;
  return init;
}

export async function readTargetSessionJson(response: Response): Promise<unknown> {
  return readBoundedResponseJson(response, MAX_SESSION_RESPONSE_BYTES, (kind) =>
    new Error(
      kind === 'size'
        ? 'Target session response exceeds the size limit'
        : 'Target session response is malformed',
    ),
  );
}

export async function readOAuthError(response: Response): Promise<string | null> {
  try {
    const value = await readTargetSessionJson(response);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 1 && typeof record.error === 'string'
      ? record.error
      : null;
  } catch {
    return null;
  }
}
