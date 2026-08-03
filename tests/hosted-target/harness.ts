import type { HttpTransport, Clock, RetryPolicy, TargetAccessTokenProvider, TargetDiscovery } from '../../src/hosted-target/types.ts';

export const NO_RETRY: RetryPolicy = {
  shouldRetry() {
    return { retry: false, delayMs: 0 };
  },
};

interface CannedResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export class FakeHttpTransport implements HttpTransport {
  readonly requests: RecordedRequest[] = [];
  private readonly responses: CannedResponse[] = [];
  private faultFn: (() => never) | null = null;

  enqueue(response: CannedResponse): void {
    this.responses.push(response);
  }

  setFault(fn: (() => never) | null): void {
    this.faultFn = fn;
  }

  async fetch(
    url: string,
    init: RequestInit & { redirect: 'error' },
  ): Promise<Response> {
    if (init.redirect !== 'error') {
      throw new Error('FakeHttpTransport: redirect must be "error"');
    }

    const headers: Record<string, string> = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v;
      } else {
        Object.assign(headers, init.headers);
      }
    }

    this.requests.push({
      url,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : null,
    });

    if (this.faultFn) {
      this.faultFn();
    }

    const canned = this.responses.shift();
    if (!canned) {
      throw new Error(`FakeHttpTransport: no response queued for ${init.method} ${url}`);
    }

    const responseHeaders = new Headers(canned.headers);
    if (!responseHeaders.has('Content-Type')) {
      responseHeaders.set('Content-Type', 'application/json');
    }

    const nullBodyStatuses = [101, 204, 205, 304];
    const responseBody = nullBodyStatuses.includes(canned.status) ? null : canned.body;
    return new Response(responseBody, {
      status: canned.status,
      headers: responseHeaders,
    });
  }
}

export class FakeClock implements Clock {
  private _now: number;

  constructor(startMs: number = 1000000) {
    this._now = startMs;
  }

  now(): number {
    return this._now;
  }

  advance(ms: number): void {
    this._now += ms;
  }

  set(ms: number): void {
    this._now = ms;
  }
}

export class FakeTokenProvider implements TargetAccessTokenProvider {
  private _token: string;
  callCount = 0;

  constructor(token: string = 'test-token-abc123') {
    this._token = token;
  }

  setToken(token: string): void {
    this._token = token;
  }

  async getAccessToken(_signal?: AbortSignal): Promise<string> {
    this.callCount++;
    return this._token;
  }
}

export function fakeDiscovery(): TargetDiscovery {
  return { capsuleV1: 'https://api.test.example/v1' };
}

export function respond(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): { status: number; body: string; headers?: Record<string, string> } {
  const result: { status: number; body: string; headers?: Record<string, string> } = {
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
  if (headers !== undefined) result.headers = headers;
  return result;
}

export function respondEmpty(
  status: number,
  headers?: Record<string, string>,
): { status: number; body: string; headers?: Record<string, string> } {
  const result: { status: number; body: string; headers?: Record<string, string> } = {
    status,
    body: '',
  };
  if (headers !== undefined) result.headers = headers;
  return result;
}

export function makeCapsule(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'cap-001',
    state: 'running',
    createdAt: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

export function makeCapsuleAccess(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    endpoint: 'wss://capsule.test.example/oecp',
    token: 'access-token-secret',
    expiresAt: '2026-08-01T01:00:00Z',
    ...overrides,
  };
}

export function makeLimits(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    maxConcurrent: 5,
    maxPerHour: 20,
    ...overrides,
  };
}

export function makeListPage(
  items: Record<string, unknown>[],
  cursor?: string,
): Record<string, unknown> {
  const page: Record<string, unknown> = { items };
  if (cursor !== undefined) page['cursor'] = cursor;
  return page;
}
