import { FakeCredentialStore } from '../../src/target/credential-store.ts';
import type { HttpTransport, Clock } from '../../src/target/device-flow.ts';
import type { BrowserOpener, TargetSessionDeps } from '../../src/target/target-session.ts';
import type { SettingsPort, TargetRecord } from '../../src/target/target-registry.ts';
import type { RouteTemplate, TargetDiscoveryDescriptor, TargetSessionEndpoints } from '../../src/target/discovery.ts';

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

function route(template: string, variables: readonly string[]): RouteTemplate {
  return {
    template,
    variables,
    expand(values) {
      let result = template.replace(/\{\?([^}]+)\}/g, (_match, names: string) => {
        const query = new URLSearchParams();
        for (const name of names.split(',')) {
          const value = values[name];
          if (value !== undefined) query.set(name, String(value));
        }
        const serialized = query.toString();
        return serialized ? `?${serialized}` : '';
      });
      result = result.replace(/\{([^}]+)\}/g, (_match, name: string) =>
        encodeURIComponent(String(values[name])),
      );
      return result;
    },
  };
}

export function makeDiscoveryEndpoints(baseUrl: string = 'https://api.test.example'): TargetSessionEndpoints {
  const descriptor: TargetDiscoveryDescriptor = {
    origin: baseUrl,
    adapter: { name: 'fargate', majorVersion: 1 },
    endpoint: `${baseUrl}/targets/primary`,
    endpointCapabilities: ['exec', 'log_stream'],
    pagination: { defaultPageSize: 20, maxPageSize: 100 },
    sizes: { catalog: ['tiny', 'small', 'standard', 'large'], default: 'standard' },
    oauth: {
      metadataUrl: `${baseUrl}/.well-known/oauth`,
      deviceAuthorizationEndpoint: `${baseUrl}/oauth/device`,
      tokenEndpoint: `${baseUrl}/oauth/token`,
      revocationEndpoint: `${baseUrl}/oauth/revoke`,
      clientId: 'cli',
      deviceGrantType: 'urn:ietf:params:oauth:grant-type:device_code',
      audience: 'capsule',
    },
    session: { routeTemplate: route('/target-session', []), method: 'GET' },
    capsule: {
      baseUrl: `${baseUrl}/api/v1`,
      routes: {
        allocate: route('/orgs/{org_id}/capsules', ['org_id']),
        list: route('/orgs/{org_id}/capsules{?cursor,limit}', ['org_id', 'cursor', 'limit']),
        inspect: route('/orgs/{org_id}/capsules/{capsule_id}', ['org_id', 'capsule_id']),
        terminate: route('/orgs/{org_id}/capsules/{capsule_id}', ['org_id', 'capsule_id']),
        limits: route('/orgs/{org_id}/limits', ['org_id']),
        access: route('/capsules/{capsule_id}/access', ['capsule_id']),
      },
    },
    transport: {
      websocketRouteTemplate: route('/v1/capsules/{capsule_id}/oecp', ['capsule_id']),
      unauthorizedStatus: 401,
      closeCodes: { expired: 4401, revoked: 4403 },
    },
    capabilityFlags: ['capsule_allocate', 'capsule_read', 'capsule_terminate', 'capsule_access', 'connections_onboarding'],
    credentialInstall: null,
    additional: {},
  };
  return {
    deviceAuthorizationEndpoint: descriptor.oauth.deviceAuthorizationEndpoint,
    tokenEndpoint: descriptor.oauth.tokenEndpoint,
    revocationEndpoint: descriptor.oauth.revocationEndpoint,
    clientId: descriptor.oauth.clientId,
    deviceGrantType: descriptor.oauth.deviceGrantType,
    audience: descriptor.oauth.audience,
    sessionEndpoint: `${baseUrl}/target-session`,
    descriptor,
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
