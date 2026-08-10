import type { HttpTransport } from './device-flow.js';
import { readBoundedResponseJson } from './bounded-response.js';
import { TargetDiscoveryError } from './discovery-errors.js';
import type { RouteTemplate } from './route-template.js';
import { exact, exactStringSet, record } from './discovery-validation.js';
import type { RunIntentDescriptor } from './run-intent-discovery.js';
import {
  parseAdapter,
  parseCapsule,
  parseEndpoint,
  parseExtensions,
  parseOAuth,
  parseSession,
  parseSizes,
  parseTransport,
  validateOAuthMetadata,
} from './discovery-sections.js';
export type { RunIntentDescriptor } from './run-intent-discovery.js';
export { TargetDiscoveryError } from './discovery-errors.js';
export { expandRoute, type RouteTemplate } from './route-template.js';

const DISCOVERY_PATH = '/.well-known/openengine-hosted-target';
const MAX_DISCOVERY_BYTES = 64 * 1024;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CAPSULE_AUDIENCE = 'capsule';

const ROOT_FIELDS = [
  'kind',
  'adapter',
  'protocol',
  'binding',
  'endpoint',
  'pagination',
  'cache_policy',
  'schema_links',
  'capsule_protocol',
  'oauth',
  'organization_binding',
  'capability_flags',
  'sizes',
  'session',
  'transport',
  'extensions',
] as const;
export interface TargetDiscoveryDescriptor {
  readonly origin: string;
  readonly adapter: { readonly name: 'fargate' | 'docker' | 'local'; readonly majorVersion: 1 };
  readonly endpoint: string;
  readonly endpointCapabilities: readonly ['exec', 'log_stream'];
  readonly pagination: { readonly defaultPageSize: number; readonly maxPageSize: number };
  readonly sizes: {
    readonly catalog: readonly ('tiny' | 'small' | 'standard' | 'large')[];
    readonly default: 'tiny' | 'small' | 'standard' | 'large';
  };
  readonly oauth: {
    readonly metadataUrl: string;
    readonly deviceAuthorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly revocationEndpoint: string;
    readonly clientId: string;
    readonly deviceGrantType: typeof DEVICE_GRANT;
    readonly audience: typeof CAPSULE_AUDIENCE;
  };
  readonly session: { readonly routeTemplate: RouteTemplate; readonly method: 'GET' };
  readonly capsule: {
    readonly baseUrl: string;
    readonly routes: {
      readonly allocate: RouteTemplate;
      readonly list: RouteTemplate;
      readonly inspect: RouteTemplate;
      readonly terminate: RouteTemplate;
      readonly limits: RouteTemplate;
      readonly access: RouteTemplate;
    };
  };
  readonly transport: {
    readonly websocketRouteTemplate: RouteTemplate;
    readonly unauthorizedStatus: 401;
    readonly closeCodes: { readonly expired: 4401; readonly revoked: 4403 };
  };
  readonly capabilityFlags: readonly string[];
  readonly runIntent: RunIntentDescriptor | null;
  readonly additional: Readonly<Record<string, unknown>>;
}

/** Compatibility projection. New callers should retain the complete descriptor. */
export interface TargetSessionEndpoints {
  readonly deviceAuthorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string;
  readonly clientId: string;
  readonly capsuleApiBaseUrl: string;
  readonly deviceGrantType: typeof DEVICE_GRANT;
  readonly audience: typeof CAPSULE_AUDIENCE;
  readonly sessionEndpoint: string;
  readonly descriptor: TargetDiscoveryDescriptor;
}

const FLAGS = [
  'capsule_allocate',
  'capsule_read',
  'capsule_terminate',
  'capsule_access',
  'connections_onboarding',
] as const;
const SIZE_ERROR = 'response exceeds the size limit';
const JSON_ERROR = 'response is not valid UTF-8 JSON';

function parseDiscoveryDocument(
  discovery: Record<string, unknown>,
  origin: string
): TargetDiscoveryDescriptor {
  exact(discovery.kind, 'openengine.hosted-target/v1', 'kind');
  const adapter = parseAdapter(discovery);
  const endpoint = parseEndpoint(discovery, origin);
  const capsule = parseCapsule(discovery, origin);
  const oauth = parseOAuth(discovery, origin);
  exact(discovery.organization_binding, 'device_approval', 'organization_binding');
  const capabilityFlags = exactStringSet(discovery.capability_flags, 'capability_flags', FLAGS);
  const sizes = parseSizes(discovery);
  const session = parseSession(discovery);
  const transport = parseTransport(discovery);
  const extensions = parseExtensions(discovery, origin);
  const additional = Object.freeze(
    Object.fromEntries(
      Object.entries(discovery).filter(
        ([key]) => !ROOT_FIELDS.includes(key as (typeof ROOT_FIELDS)[number])
      )
    )
  );
  return Object.freeze({
    origin,
    adapter,
    endpoint: endpoint.url,
    endpointCapabilities: endpoint.capabilities,
    pagination: endpoint.pagination,
    sizes,
    oauth,
    session,
    capsule,
    transport,
    capabilityFlags,
    runIntent: extensions.runIntent,
    additional,
  });
}

export async function discoverTarget(
  targetUrl: string,
  http: HttpTransport
): Promise<TargetDiscoveryDescriptor> {
  const target = new URL(targetUrl);
  const origin = target.origin;
  const discovery = await fetchDocument(http, new URL(DISCOVERY_PATH, target).href);
  const descriptor = parseDiscoveryDocument(discovery, origin);
  const metadata = await fetchDocument(http, descriptor.oauth.metadataUrl);
  validateOAuthMetadata(metadata, origin, [
    descriptor.oauth.deviceAuthorizationEndpoint,
    descriptor.oauth.tokenEndpoint,
    descriptor.oauth.revocationEndpoint,
  ]);
  return descriptor;
}

export async function discoverTargetSessionEndpoints(
  targetUrl: string,
  http: HttpTransport
): Promise<TargetSessionEndpoints> {
  const descriptor = await discoverTarget(targetUrl, http);
  return Object.freeze({
    deviceAuthorizationEndpoint: descriptor.oauth.deviceAuthorizationEndpoint,
    tokenEndpoint: descriptor.oauth.tokenEndpoint,
    revocationEndpoint: descriptor.oauth.revocationEndpoint,
    clientId: descriptor.oauth.clientId,
    capsuleApiBaseUrl: descriptor.capsule.baseUrl.replace(/\/$/, ''),
    deviceGrantType: descriptor.oauth.deviceGrantType,
    audience: descriptor.oauth.audience,
    sessionEndpoint: new URL(descriptor.session.routeTemplate.template, descriptor.origin).href,
    descriptor,
  });
}

function boundedResponseError(kind: 'size' | 'json'): Error {
  return new TargetDiscoveryError(kind === 'size' ? SIZE_ERROR : JSON_ERROR);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  return readBoundedResponseJson(response, MAX_DISCOVERY_BYTES, boundedResponseError);
}

async function fetchDocument(http: HttpTransport, url: string): Promise<Record<string, unknown>> {
  const response = await http.fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
  });
  if (response.url && new URL(response.url).href !== url) {
    await response.body?.cancel().catch(() => undefined);
    throw new TargetDiscoveryError('request changed target route or authority');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new TargetDiscoveryError(`request failed with status ${response.status}`);
  }
  return record(await readBoundedJson(response), 'response');
}
