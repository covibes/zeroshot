import type { RouteTemplate, TargetDiscoveryDescriptor } from '../../src/target/discovery.ts';
import type { Clock, HttpTransport, RetryPolicy, TargetAccessTokenProvider } from '../../src/hosted-target/types.ts';

export interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit & { redirect: 'manual' };
}

export class FakeHttpTransport implements HttpTransport {
  readonly requests: CapturedRequest[] = [];
  readonly responses: Response[] = [];
  enqueue(status: number, body: unknown, headers: Record<string, string> = {}): void {
    this.responses.push(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));
  }
  async fetch(url: string, init: RequestInit & { redirect: 'manual' }): Promise<Response> {
    this.requests.push({ url, init });
    const response = this.responses.shift();
    if (!response) throw new Error('No response queued');
    return response;
  }
}

export class FakeClock implements Clock {
  private value: number;
  constructor(value = Date.parse('2026-08-03T00:00:00.000Z')) {
    this.value = value;
  }
  now(): number { return this.value; }
  advance(ms: number): void { this.value += ms; }
}

export class FakeTokenProvider implements TargetAccessTokenProvider {
  readonly calls: Array<AbortSignal | undefined> = [];
  readonly token: string;
  constructor(token = 'admin-access-canary') {
    this.token = token;
  }
  async getAccessToken(signal?: AbortSignal): Promise<string> {
    this.calls.push(signal);
    return this.token;
  }
}

function route(template: string, variables: readonly string[]): RouteTemplate {
  return {
    template,
    variables,
    expand(values) {
      let expanded = template.replace(/\{\?([^}]+)\}/g, (_match, names: string) => {
        const query = names.split(',').flatMap((name) => {
          const value = values[name];
          return value === undefined ? [] : [`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`];
        });
        return query.length === 0 ? '' : `?${query.join('&')}`;
      });
      expanded = expanded.replace(/\{([^}]+)\}/g, (_match, name: string) => {
        const value = String(values[name]);
        if (value === '.' || value === '..') throw new Error('structural dot segment');
        return encodeURIComponent(value);
      });
      return expanded;
    },
  };
}

export function fakeDiscovery(): TargetDiscoveryDescriptor {
  const origin = 'https://hosted.openengine.example';
  return {
    origin,
    adapter: { name: 'fargate', majorVersion: 1 },
    endpoint: `${origin}/targets/primary`,
    endpointCapabilities: ['exec', 'log_stream'],
    pagination: { defaultPageSize: 20, maxPageSize: 100 },
    sizes: { catalog: ['tiny', 'small', 'standard', 'large'], default: 'standard' },
    oauth: {
      metadataUrl: `${origin}/.well-known/oauth`,
      deviceAuthorizationEndpoint: `${origin}/auth/device`,
      tokenEndpoint: `${origin}/auth/token`,
      revocationEndpoint: `${origin}/auth/revoke`,
      clientId: 'cli',
      deviceGrantType: 'urn:ietf:params:oauth:grant-type:device_code',
      audience: 'capsule',
    },
    session: { routeTemplate: route('/target-session', []), method: 'GET' },
    capsule: {
      baseUrl: `${origin}/api/v1`,
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
}

export function capsule(id = 'cap-1', state = 'ready') {
  return { capsule_id: id, state, label: null, created_at: '2026-08-03T00:00:00Z' };
}

export const NO_RETRY: RetryPolicy = {
  shouldRetry: () => ({ retry: false, delayMs: 0 }),
};
