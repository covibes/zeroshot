import type { HttpTransport } from './device-flow.ts';
import { readBoundedResponseJson } from './bounded-response.ts';
import { TargetDiscoveryError } from './discovery-errors.ts';
import { routeTemplate, type RouteTemplate } from './route-template.ts';
import {
  closedRecord,
  exact,
  exactStringSet,
  integer,
  record,
  stringField,
  sameOriginUrl,
  type CredentialInstallDescriptor,
} from './discovery-validation.ts';
import {
  parseAdapter,
  parseExtensions,
  parseSizes,
  validateCachePolicy,
  validateOAuthMetadata,
} from './discovery-sections.ts';
export type { CredentialInstallDescriptor } from './discovery-validation.ts';
export { TargetDiscoveryError } from './discovery-errors.ts';
export { expandRoute, type RouteTemplate } from './route-template.ts';

const DISCOVERY_PATH = '/.well-known/openengine-hosted-target';
const MAX_DISCOVERY_BYTES = 64 * 1024;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CAPSULE_AUDIENCE = 'capsule';
const CLUSTER_PROTOCOL = 'openengine.cluster/v1';
const CAPSULE_PROTOCOL = 'openengine.capsules/v1';

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
  readonly credentialInstall: CredentialInstallDescriptor | null;
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



async function readBoundedJson(response: Response): Promise<unknown> {
  return readBoundedResponseJson(response, MAX_DISCOVERY_BYTES, (kind) =>
    new TargetDiscoveryError(
      kind === 'size' ? 'response exceeds the size limit' : 'response is not valid UTF-8 JSON',
    ),
  );
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


export async function discoverTarget(targetUrl: string, http: HttpTransport): Promise<TargetDiscoveryDescriptor> {
  const target = new URL(targetUrl);
  const origin = target.origin;
  const discovery = await fetchDocument(http, new URL(DISCOVERY_PATH, target).href);
  exact(discovery.kind, 'openengine.hosted-target/v1', 'kind');

  const adapter = parseAdapter(discovery);
  const protocol = closedRecord(discovery.protocol, 'protocol', ['name', 'major_version']);
  exact(protocol.name, CLUSTER_PROTOCOL, 'protocol.name');
  exact(protocol.major_version, 1, 'protocol.major_version');
  const binding = closedRecord(discovery.binding, 'binding', ['scope', 'auth_location']);
  exact(binding.scope, 'organization', 'binding.scope');
  exact(binding.auth_location, 'authorization_header', 'binding.auth_location');

  const endpoint = closedRecord(discovery.endpoint, 'endpoint', ['url', 'capabilities']);
  const endpointUrl = sameOriginUrl(endpoint.url, 'endpoint.url', origin);
  const endpointCapabilities = exactStringSet(endpoint.capabilities, 'endpoint.capabilities', ['exec', 'log_stream']) as readonly ['exec', 'log_stream'];

  const pagination = closedRecord(discovery.pagination, 'pagination', ['default_page_size', 'max_page_size']);
  const defaultPageSize = integer(pagination.default_page_size, 'pagination.default_page_size', 1);
  const maxPageSize = integer(pagination.max_page_size, 'pagination.max_page_size', 1);
  if (defaultPageSize > maxPageSize) throw new TargetDiscoveryError('pagination.default_page_size exceeds maximum');

  validateCachePolicy(discovery);

  const schemaLinks = closedRecord(discovery.schema_links, 'schema_links', ['self', 'problem', 'errors']);
  sameOriginUrl(schemaLinks.self, 'schema_links.self', origin);
  sameOriginUrl(schemaLinks.problem, 'schema_links.problem', origin);
  sameOriginUrl(schemaLinks.errors, 'schema_links.errors', origin);

  const capsule = closedRecord(discovery.capsule_protocol, 'capsule_protocol', ['name', 'major_version', 'base_url', 'route_templates']);
  exact(capsule.name, CAPSULE_PROTOCOL, 'capsule_protocol.name');
  exact(capsule.major_version, 1, 'capsule_protocol.major_version');
  const capsuleBaseUrl = sameOriginUrl(capsule.base_url, 'capsule_protocol.base_url', origin);
  const routes = closedRecord(capsule.route_templates, 'capsule_protocol.route_templates', ['allocate', 'list', 'inspect', 'terminate', 'limits', 'access']);

  const oauth = closedRecord(discovery.oauth, 'oauth', [
    'metadata_url', 'device_authorization_endpoint', 'token_endpoint', 'revocation_endpoint', 'client_id',
    'device_grant_type', 'device_exchange_fields', 'audience',
  ]);
  const metadataUrl = sameOriginUrl(oauth.metadata_url, 'oauth.metadata_url', origin);
  const deviceAuthorizationEndpoint = sameOriginUrl(oauth.device_authorization_endpoint, 'oauth.device_authorization_endpoint', origin);
  const tokenEndpoint = sameOriginUrl(oauth.token_endpoint, 'oauth.token_endpoint', origin);
  const revocationEndpoint = sameOriginUrl(oauth.revocation_endpoint, 'oauth.revocation_endpoint', origin);
  const clientId = stringField(oauth, 'client_id', 'oauth.');
  exact(oauth.device_grant_type, DEVICE_GRANT, 'oauth.device_grant_type');
  exactStringSet(oauth.device_exchange_fields, 'oauth.device_exchange_fields', ['device_token', 'device_label']);
  exact(oauth.audience, CAPSULE_AUDIENCE, 'oauth.audience');

  exact(discovery.organization_binding, 'device_approval', 'organization_binding');
  const capabilityFlags = exactStringSet(discovery.capability_flags, 'capability_flags', [
    'capsule_allocate', 'capsule_read', 'capsule_terminate', 'capsule_access', 'connections_onboarding',
  ]);
  const sizes = parseSizes(discovery);

  const session = closedRecord(discovery.session, 'session', ['route_template', 'method', 'cache_policy']);
  exact(session.method, 'GET', 'session.method');
  exact(session.cache_policy, 'no-store', 'session.cache_policy');
  const sessionRoute = routeTemplate(session.route_template, 'session.route_template', []);

  const transport = closedRecord(discovery.transport, 'transport', ['websocket_route_template', 'unauthorized_status', 'close_codes']);
  exact(transport.unauthorized_status, 401, 'transport.unauthorized_status');
  const closeCodes = closedRecord(transport.close_codes, 'transport.close_codes', ['expired', 'revoked']);
  exact(closeCodes.expired, 4401, 'transport.close_codes.expired');
  exact(closeCodes.revoked, 4403, 'transport.close_codes.revoked');

  const credentialInstall = parseExtensions(discovery, origin);

  const metadata = await fetchDocument(http, metadataUrl);
  validateOAuthMetadata(metadata, origin, [
    deviceAuthorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint,
  ]);

  const additional = Object.freeze(
    Object.fromEntries(Object.entries(discovery).filter(([key]) =>
      !ROOT_FIELDS.includes(key as (typeof ROOT_FIELDS)[number]),
    )),
  );
  return Object.freeze({
    origin,
    adapter,
    endpoint: endpointUrl,
    endpointCapabilities,
    pagination: Object.freeze({ defaultPageSize, maxPageSize }),
    sizes,
    oauth: Object.freeze({ metadataUrl, deviceAuthorizationEndpoint, tokenEndpoint, revocationEndpoint, clientId, deviceGrantType: DEVICE_GRANT, audience: CAPSULE_AUDIENCE }),
    session: Object.freeze({ routeTemplate: sessionRoute, method: 'GET' as const }),
    capsule: Object.freeze({
      baseUrl: capsuleBaseUrl,
      routes: Object.freeze({
        allocate: routeTemplate(routes.allocate, 'capsule_protocol.route_templates.allocate', ['org_id']),
        list: routeTemplate(routes.list, 'capsule_protocol.route_templates.list', ['org_id', 'cursor', 'limit']),
        inspect: routeTemplate(routes.inspect, 'capsule_protocol.route_templates.inspect', ['org_id', 'capsule_id']),
        terminate: routeTemplate(routes.terminate, 'capsule_protocol.route_templates.terminate', ['org_id', 'capsule_id']),
        limits: routeTemplate(routes.limits, 'capsule_protocol.route_templates.limits', ['org_id']),
        access: routeTemplate(routes.access, 'capsule_protocol.route_templates.access', ['capsule_id']),
      }),
    }),
    transport: Object.freeze({
      websocketRouteTemplate: routeTemplate(transport.websocket_route_template, 'transport.websocket_route_template', ['capsule_id']),
      unauthorizedStatus: 401 as const,
      closeCodes: Object.freeze({ expired: 4401 as const, revoked: 4403 as const }),
    }),
    capabilityFlags,
    credentialInstall,
    additional,
  });
}

export async function discoverTargetSessionEndpoints(targetUrl: string, http: HttpTransport): Promise<TargetSessionEndpoints> {
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
