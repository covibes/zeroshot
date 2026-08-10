import {
  FakeCredentialStore,
  type BrowserOpener,
  type Clock,
  type HttpTransport,
  type RouteTemplate,
  type SettingsPort,
  type TargetDiscoveryDescriptor,
  type TargetRecord,
  type TargetSessionDeps,
  type TargetSessionEndpoints,
} from '../helpers/target-runtime.mjs';

export { FakeCredentialStore };

interface CannedResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  readonly init: RequestInit & { redirect: 'error' | 'manual' };
}

export class FakeHttpTransport implements HttpTransport {
  readonly requests: RecordedRequest[] = [];
  readonly responses: Array<CannedResponse | Response> = [];

  enqueue(response: CannedResponse | Response): void;
  enqueue(status: number, body: unknown, headers?: Record<string, string>): void;
  enqueue(
    responseOrStatus: CannedResponse | Response | number,
    body?: unknown,
    headers?: Record<string, string>
  ): void {
    this.responses.push(
      typeof responseOrStatus === 'number'
        ? respond(responseOrStatus, body, headers)
        : responseOrStatus
    );
  }

  async fetch(
    url: string,
    init: RequestInit & { redirect: 'error' | 'manual' }
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v;
        });
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
      init,
    });

    const canned = this.responses.shift();
    if (!canned) {
      throw new Error(`FakeHttpTransport: no response queued for ${init.method} ${url}`);
    }
    if (canned instanceof Response) return canned;

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
  headers?: Record<string, string>
): CannedResponse {
  return {
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...(headers === undefined ? {} : { headers }),
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
        const query = names.split(',').flatMap((name) => {
          const value = values[name];
          return value === undefined
            ? []
            : [`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`];
        });
        return query.length === 0 ? '' : `?${query.join('&')}`;
      });
      result = result.replace(/\{([^}]+)\}/g, (_match, name: string) => {
        const value = String(values[name]);
        if (value === '.' || value === '..') throw new Error('structural dot segment');
        return encodeURIComponent(value);
      });
      return result;
    },
  };
}

export function makeDiscovery(
  baseUrl: string = 'https://api.test.example'
): TargetDiscoveryDescriptor {
  return {
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
    capabilityFlags: [
      'capsule_allocate',
      'capsule_read',
      'capsule_terminate',
      'capsule_access',
      'connections_onboarding',
    ],
    runIntent: null,
    additional: {},
  };
}

export function makeDiscoveryEndpoints(
  baseUrl: string = 'https://api.test.example'
): TargetSessionEndpoints {
  const descriptor = makeDiscovery(baseUrl);
  return {
    deviceAuthorizationEndpoint: descriptor.oauth.deviceAuthorizationEndpoint,
    tokenEndpoint: descriptor.oauth.tokenEndpoint,
    revocationEndpoint: descriptor.oauth.revocationEndpoint,
    clientId: descriptor.oauth.clientId,
    capsuleApiBaseUrl: descriptor.capsule.baseUrl,
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
