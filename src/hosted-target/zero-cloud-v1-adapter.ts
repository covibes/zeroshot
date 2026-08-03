import { MAX_ERROR_BODY_BYTES, MAX_RESPONSE_BYTES, MAX_RETRY_ELAPSED_MS, IDEMPOTENCY_KEY_PATTERN } from './bounds.ts';
import {
  TargetAuthError,
  TargetConflictError,
  TargetNotFoundError,
  TargetProtocolError,
  TargetRateLimitError,
  TargetTransportError,
} from './errors.ts';
import { TargetAdapterError } from './errors.ts';
import { DefaultRetryPolicy, parseRetryAfter } from './retry.ts';
import {
  assertCapsule,
  assertCapsuleAccess,
  assertCapsuleLimits,
  assertCapsuleListPage,
} from './response-validation.ts';
import type { TargetAdapter } from './target-adapter.ts';
import type {
  AllocateRequest,
  Capsule,
  CapsuleAccess,
  CapsuleLimits,
  CapsuleListPage,
  Clock,
  HttpTransport,
  RetryPolicy,
  TargetAccessTokenProvider,
  TargetDiscovery,
} from './types.ts';

interface ZeroCloudV1Options {
  readonly discovery: TargetDiscovery;
  readonly organization: string;
  readonly tokenProvider: TargetAccessTokenProvider;
  readonly transport?: HttpTransport;
  readonly clock?: Clock;
  readonly retryPolicy?: RetryPolicy;
}

const DEFAULT_TRANSPORT: HttpTransport = {
  fetch(url: string, init: RequestInit & { redirect: 'error' }): Promise<Response> {
    return globalThis.fetch(url, init);
  },
};

const DEFAULT_CLOCK: Clock = { now: () => Date.now() };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason === undefined
      ? new DOMException('The operation was aborted', 'AbortError')
      : signal.reason;
  }
}

async function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (delayMs <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        signal!.reason === undefined
          ? new DOMException('The operation was aborted', 'AbortError')
          : signal!.reason,
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    throw new TargetProtocolError(`Invalid URL: ${url}`);
  }
}

export class ZeroCloudV1TargetAdapter implements TargetAdapter {
  private readonly discovery: TargetDiscovery;
  private readonly organization: string;
  private readonly tokenProvider: TargetAccessTokenProvider;
  private readonly transport: HttpTransport;
  private readonly clock: Clock;
  private readonly retryPolicy: RetryPolicy;
  private readonly expectedOrigin: string;

  constructor(opts: ZeroCloudV1Options) {
    this.discovery = opts.discovery;
    this.organization = opts.organization;
    this.tokenProvider = opts.tokenProvider;
    this.transport = opts.transport ?? DEFAULT_TRANSPORT;
    this.clock = opts.clock ?? DEFAULT_CLOCK;
    this.retryPolicy = opts.retryPolicy ?? new DefaultRetryPolicy();
    this.expectedOrigin = originOf(opts.discovery.capsuleV1);
  }

  async allocate(req: AllocateRequest, signal?: AbortSignal): Promise<Capsule> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(req.idempotencyKey)) {
      throw new TargetProtocolError(
        `Invalid idempotency key: must match ${IDEMPOTENCY_KEY_PATTERN}`,
      );
    }

    const body = JSON.stringify({ profile: req.profile, organization: this.organization });

    return this._withRetry(async () => {
      const resp = await this._request('POST', '/capsules', {
        signal,
        body,
        headers: { 'Idempotency-Key': req.idempotencyKey },
      });
      const json = await this._readJson(resp);
      return assertCapsule(json);
    }, signal);
  }

  async list(cursor?: string, signal?: AbortSignal): Promise<CapsuleListPage> {
    return this._withRetry(async () => {
      const params = new URLSearchParams({ organization: this.organization });
      if (cursor) params.set('cursor', cursor);
      const resp = await this._request('GET', `/capsules?${params.toString()}`, { signal });
      const json = await this._readJson(resp);
      const page = assertCapsuleListPage(json);
      if (page.cursor !== undefined && page.cursor === cursor) {
        throw new TargetProtocolError(
          `Pagination loop detected: server returned the same cursor "${cursor}"`,
        );
      }
      return page;
    }, signal);
  }

  async inspect(capsuleId: string, signal?: AbortSignal): Promise<Capsule> {
    return this._withRetry(async () => {
      const resp = await this._request('GET', `/capsules/${encodeURIComponent(capsuleId)}`, {
        signal,
      });
      const json = await this._readJson(resp);
      return assertCapsule(json);
    }, signal);
  }

  async terminate(capsuleId: string, signal?: AbortSignal): Promise<void> {
    await this._withRetry(async () => {
      const resp = await this._request(
        'DELETE',
        `/capsules/${encodeURIComponent(capsuleId)}`,
        { signal },
      );
      if (resp.status !== 204) {
        const json = await this._readJson(resp);
        throw new TargetProtocolError(`Unexpected terminate response: ${JSON.stringify(json)}`);
      }
    }, signal);
  }

  async limits(signal?: AbortSignal): Promise<CapsuleLimits> {
    return this._withRetry(async () => {
      const params = new URLSearchParams({ organization: this.organization });
      const resp = await this._request('GET', `/limits?${params.toString()}`, { signal });
      const json = await this._readJson(resp);
      return assertCapsuleLimits(json);
    }, signal);
  }

  async access(capsuleId: string, signal?: AbortSignal): Promise<CapsuleAccess> {
    return this._withRetry(async () => {
      const resp = await this._request(
        'POST',
        `/capsules/${encodeURIComponent(capsuleId)}/access`,
        { signal },
      );
      const json = await this._readJson(resp);
      return assertCapsuleAccess(json);
    }, signal);
  }

  private async _request(
    method: string,
    path: string,
    opts: { signal?: AbortSignal | undefined; body?: string | undefined; headers?: Record<string, string> | undefined },
  ): Promise<Response> {
    const url = `${this.discovery.capsuleV1}${path}`;

    const responseOrigin = originOf(url);
    if (responseOrigin !== this.expectedOrigin) {
      throw new TargetProtocolError(
        `Origin mismatch: expected ${this.expectedOrigin}, got ${responseOrigin}`,
      );
    }

    let token: string;
    try {
      token = await this.tokenProvider.getAccessToken(opts.signal);
    } catch (err) {
      throw new TargetTransportError('Failed to acquire access token', err);
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...opts.headers,
    };

    let response: Response;
    const fetchInit: RequestInit & { redirect: 'error' } = {
      method,
      headers,
      redirect: 'error',
    };
    if (opts.body !== undefined) fetchInit.body = opts.body;
    if (opts.signal !== undefined) fetchInit.signal = opts.signal;

    try {
      response = await this.transport.fetch(url, fetchInit);
    } catch (err) {
      if (err instanceof TargetAdapterError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('redirect')) {
        throw new TargetProtocolError(`Redirect rejected for ${method} ${path}`, err);
      }
      throw new TargetTransportError(`Network error during ${method} ${path}`, err);
    }

    if (response.status < 200 || response.status >= 300) {
      await this._mapStatusError(response, method, path, opts.headers);
    }

    return response;
  }

  private async _mapStatusError(
    response: Response,
    method: string,
    path: string,
    headers?: Record<string, string>,
  ): Promise<never> {
    const status = response.status;
    const errorBody = await this._readErrorBody(response);
    const context = `${status} ${method} ${path}: ${errorBody}`;

    if (status === 401 || status === 403) throw new TargetAuthError(context);
    if (status === 404) throw new TargetNotFoundError(context);
    if (status === 409) {
      const idempotencyKey = headers?.['Idempotency-Key'] ?? 'unknown';
      throw new TargetConflictError(idempotencyKey, context);
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'), this.clock);
      throw new TargetRateLimitError(context, retryAfterMs ?? undefined);
    }
    if (status >= 500) throw new TargetTransportError(context);
    throw new TargetProtocolError(`Unexpected status ${context}`);
  }

  private async _readJson(response: Response): Promise<unknown> {
    const contentLength = response.headers.get('Content-Length');
    if (contentLength !== null) {
      const len = parseInt(contentLength, 10);
      if (Number.isFinite(len) && len > MAX_RESPONSE_BYTES) {
        throw new TargetProtocolError(
          `Response too large: ${len} bytes exceeds limit of ${MAX_RESPONSE_BYTES}`,
        );
      }
    }

    let text: string;
    try {
      const reader = response.body?.getReader();
      if (!reader) {
        text = await response.text();
      } else {
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            reader.cancel();
            throw new TargetProtocolError(
              `Response body exceeds limit of ${MAX_RESPONSE_BYTES} bytes`,
            );
          }
          chunks.push(value);
        }
        const combined = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        text = new TextDecoder().decode(combined);
      }
    } catch (err) {
      if (err instanceof TargetProtocolError) throw err;
      throw new TargetProtocolError('Failed to read response body', err);
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      throw new TargetProtocolError('Invalid JSON in response body', err);
    }
  }

  private async _readErrorBody(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (totalBytes < MAX_ERROR_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;

        const remaining = MAX_ERROR_BODY_BYTES - totalBytes;
        const retained = value.byteLength > remaining ? value.slice(0, remaining) : value;
        chunks.push(retained);
        totalBytes += retained.byteLength;
        if (retained.byteLength !== value.byteLength || totalBytes === MAX_ERROR_BODY_BYTES) {
          void reader.cancel().catch(() => undefined);
          break;
        }
      }
    } catch {
      void reader.cancel().catch(() => undefined);
      return '<unreadable>';
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  }

  private async _withRetry<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const startTime = this.clock.now();
    let attempt = 0;

    while (true) {
      throwIfAborted(signal);
      try {
        return await fn();
      } catch (err) {
        throwIfAborted(signal);
        if (!(err instanceof TargetAdapterError)) throw err;
        if (err instanceof TargetAuthError) throw err;

        attempt++;
        const elapsed = this.clock.now() - startTime;
        const decision = this.retryPolicy.shouldRetry(attempt, elapsed, err);
        const remaining = MAX_RETRY_ELAPSED_MS - elapsed;

        if (
          !decision.retry ||
          !Number.isFinite(decision.delayMs) ||
          decision.delayMs < 0 ||
          decision.delayMs >= remaining
        ) {
          throw err;
        }

        await waitForRetryDelay(decision.delayMs, signal);
        if (this.clock.now() - startTime >= MAX_RETRY_ELAPSED_MS) throw err;
      }
    }
  }
}
