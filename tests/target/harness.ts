import { FakeCredentialStore } from '../../src/target/credential-store.ts';
import type { HttpTransport, Clock } from '../../src/target/device-flow.ts';
import type { BrowserOpener, TargetSessionDeps } from '../../src/target/target-session.ts';
import type { SettingsPort, TargetRecord } from '../../src/target/target-registry.ts';

export { FakeCredentialStore };

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

  enqueue(response: CannedResponse): void {
    this.responses.push(response);
  }

  async fetch(
    url: string,
    init: RequestInit & { redirect: 'error' },
  ): Promise<Response> {
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

    const canned = this.responses.shift();
    if (!canned) {
      throw new Error(`FakeHttpTransport: no response queued for ${init.method} ${url}`);
    }

    const responseHeaders = new Headers(canned.headers);
    if (!responseHeaders.has('Content-Type')) {
      responseHeaders.set('Content-Type', 'application/json');
    }

    return new Response(canned.body, {
      status: canned.status,
      headers: responseHeaders,
    });
  }
}

export class FakeClock implements Clock {
  private _now: number;

  constructor(startMs: number = 1_000_000) {
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

export class FakeBrowserOpener implements BrowserOpener {
  readonly openedUrls: string[] = [];

  async open(url: string): Promise<void> {
    this.openedUrls.push(url);
  }
}

export class FakeStderr {
  readonly output: string[] = [];
  write(s: string): void {
    this.output.push(s);
  }
}

export function respond(
  status: number,
  body: unknown,
): { status: number; body: string } {
  return {
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

export function makeSettingsPort(initial: Record<string, unknown> = {}): SettingsPort {
  const data = { ...initial };
  return {
    load() {
      return { ...data } as Record<string, unknown> & { _targets?: Record<string, TargetRecord> };
    },
    mutate(fn) {
      fn(data as Record<string, unknown> & { _targets?: Record<string, TargetRecord> });
    },
  };
}

export function makeDiscoveryEndpoints(baseUrl: string = 'https://api.test.example') {
  return {
    deviceAuthorizationEndpoint: `${baseUrl}/oauth/device`,
    tokenEndpoint: `${baseUrl}/oauth/token`,
    revocationEndpoint: `${baseUrl}/oauth/revoke`,
    clientId: 'cli',
  };
}

export function makeSessionDeps(overrides: Partial<TargetSessionDeps> = {}): TargetSessionDeps {
  return {
    http: overrides.http ?? new FakeHttpTransport(),
    clock: overrides.clock ?? new FakeClock(),
    browserOpener: overrides.browserOpener ?? new FakeBrowserOpener(),
    stderr: overrides.stderr ?? new FakeStderr(),
    discoveryEndpoints: overrides.discoveryEndpoints ?? makeDiscoveryEndpoints(),
  };
}

export function makeTarget(overrides: Partial<TargetRecord> = {}): TargetRecord {
  return {
    id: 'target-uuid-001',
    url: 'https://api.test.example',
    adapterVersion: 'v1',
    deviceToken: 'device-token-001',
    createdAt: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

export function fakeLock(): () => Promise<() => Promise<void>> {
  return async () => {
    return async () => {};
  };
}
