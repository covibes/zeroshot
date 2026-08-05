import { TargetDiscoveryError } from './discovery-errors.js';
import {
  closedRecord,
  exact,
  exactStringSet,
  integer,
  parseCredentialInstall,
  sameOriginUrl,
  stringField,
  type CredentialInstallDescriptor,
} from './discovery-validation.js';
import {
  parseRunIntent,
  type RunIntentDescriptor,
} from './run-intent-discovery.js';
import { routeTemplate } from './route-template.js';

export function parseAdapter(discovery: Record<string, unknown>): {
  readonly name: 'fargate' | 'docker' | 'local';
  readonly majorVersion: 1;
} {
  const adapter = closedRecord(discovery.adapter, 'adapter', ['name', 'major_version']);
  if (!['fargate', 'docker', 'local'].includes(String(adapter.name))) {
    throw new TargetDiscoveryError('adapter.name is not supported');
  }
  exact(adapter.major_version, 1, 'adapter.major_version');
  return Object.freeze({
    name: adapter.name as 'fargate' | 'docker' | 'local',
    majorVersion: 1 as const,
  });
}

export function validateCachePolicy(discovery: Record<string, unknown>): void {
  const cache = closedRecord(discovery.cache_policy, 'cache_policy', ['control', 'discovery']);
  exact(cache.control, 'no-store', 'cache_policy.control');
  if (
    cache.discovery !== undefined &&
    cache.discovery !== null &&
    typeof cache.discovery !== 'string'
  ) {
    throw new TargetDiscoveryError('cache_policy.discovery must be a string or null');
  }
}

export function parseSizes(discovery: Record<string, unknown>): {
  readonly catalog: readonly ('tiny' | 'small' | 'standard' | 'large')[];
  readonly default: 'tiny' | 'small' | 'standard' | 'large';
} {
  const sizes = closedRecord(discovery.sizes, 'sizes', ['catalog', 'default']);
  if (
    !Array.isArray(sizes.catalog) ||
    sizes.catalog.length === 0 ||
    new Set(sizes.catalog).size !== sizes.catalog.length ||
    sizes.catalog.some((size) => !['tiny', 'small', 'standard', 'large'].includes(String(size)))
  ) {
    throw new TargetDiscoveryError('sizes.catalog contains an unsupported size');
  }
  if (!sizes.catalog.includes(sizes.default)) {
    throw new TargetDiscoveryError('sizes.default is not in sizes.catalog');
  }
  return Object.freeze({
    catalog: Object.freeze([...(sizes.catalog as Array<'tiny' | 'small' | 'standard' | 'large'>)]),
    default: sizes.default as 'tiny' | 'small' | 'standard' | 'large',
  });
}

export function parseExtensions(
  discovery: Record<string, unknown>,
  origin: string
): {
  readonly credentialInstall: CredentialInstallDescriptor | null;
  readonly runIntent: RunIntentDescriptor | null;
} {
  if (discovery.extensions === undefined || discovery.extensions === null) {
    return Object.freeze({ credentialInstall: null, runIntent: null });
  }
  const extensions = closedRecord(discovery.extensions, 'extensions', [
    'connections',
    'credential_install',
    'run_intent',
  ]);
  if (extensions.connections === undefined) {
    throw new TargetDiscoveryError('extensions.connections is required');
  }
  const connections = closedRecord(extensions.connections, 'extensions.connections', [
    'kind',
    'base_url',
    'route_templates',
  ]);
  exact(connections.kind, 'zerocloud.connections/v1', 'extensions.connections.kind');
  sameOriginUrl(connections.base_url, 'extensions.connections.base_url', origin);
  const routes = closedRecord(
    connections.route_templates,
    'extensions.connections.route_templates',
    ['list', 'create', 'update']
  );
  routeTemplate(routes.list, 'extensions.connections.route_templates.list', []);
  routeTemplate(routes.create, 'extensions.connections.route_templates.create', []);
  routeTemplate(routes.update, 'extensions.connections.route_templates.update', ['connection_id']);
  return Object.freeze({
    credentialInstall: parseCredentialInstall(extensions.credential_install),
    runIntent: parseRunIntent(extensions.run_intent, origin),
  });
}

export function validateOAuthMetadata(
  metadata: Record<string, unknown>,
  origin: string,
  expected: readonly [string, string, string]
): void {
  const device = sameOriginUrl(
    metadata.device_authorization_endpoint,
    'OAuth metadata device_authorization_endpoint',
    origin
  );
  const token = sameOriginUrl(metadata.token_endpoint, 'OAuth metadata token_endpoint', origin);
  const revoke = sameOriginUrl(
    metadata.revocation_endpoint,
    'OAuth metadata revocation_endpoint',
    origin
  );
  if (device !== expected[0] || token !== expected[1] || revoke !== expected[2]) {
    throw new TargetDiscoveryError('OAuth metadata does not match hosted-target discovery');
  }
}

export function parseEndpoint(discovery: Record<string, unknown>, origin: string) {
  const protocol = closedRecord(discovery.protocol, 'protocol', ['name', 'major_version']);
  exact(protocol.name, 'openengine.cluster/v1', 'protocol.name');
  exact(protocol.major_version, 1, 'protocol.major_version');
  const binding = closedRecord(discovery.binding, 'binding', ['scope', 'auth_location']);
  exact(binding.scope, 'organization', 'binding.scope');
  exact(binding.auth_location, 'authorization_header', 'binding.auth_location');
  const endpoint = closedRecord(discovery.endpoint, 'endpoint', ['url', 'capabilities']);
  const capabilities = exactStringSet(endpoint.capabilities, 'endpoint.capabilities', [
    'exec',
    'log_stream',
  ]) as readonly ['exec', 'log_stream'];
  const pagination = closedRecord(discovery.pagination, 'pagination', [
    'default_page_size',
    'max_page_size',
  ]);
  const defaultPageSize = integer(pagination.default_page_size, 'pagination.default_page_size', 1);
  const maxPageSize = integer(pagination.max_page_size, 'pagination.max_page_size', 1);
  if (defaultPageSize > maxPageSize) {
    throw new TargetDiscoveryError('pagination.default_page_size exceeds maximum');
  }
  validateCachePolicy(discovery);
  const schemaLinks = closedRecord(discovery.schema_links, 'schema_links', [
    'self',
    'problem',
    'errors',
  ]);
  sameOriginUrl(schemaLinks.self, 'schema_links.self', origin);
  sameOriginUrl(schemaLinks.problem, 'schema_links.problem', origin);
  sameOriginUrl(schemaLinks.errors, 'schema_links.errors', origin);
  return Object.freeze({
    url: sameOriginUrl(endpoint.url, 'endpoint.url', origin),
    capabilities,
    pagination: Object.freeze({ defaultPageSize, maxPageSize }),
  });
}

export function parseCapsule(discovery: Record<string, unknown>, origin: string) {
  const capsule = closedRecord(discovery.capsule_protocol, 'capsule_protocol', [
    'name',
    'major_version',
    'base_url',
    'route_templates',
  ]);
  exact(capsule.name, 'openengine.capsules/v1', 'capsule_protocol.name');
  exact(capsule.major_version, 1, 'capsule_protocol.major_version');
  const routes = closedRecord(capsule.route_templates, 'capsule_protocol.route_templates', [
    'allocate',
    'list',
    'inspect',
    'terminate',
    'limits',
    'access',
  ]);
  const route = (name: string, variables: readonly string[]) =>
    routeTemplate(routes[name], `capsule_protocol.route_templates.${name}`, variables);
  return Object.freeze({
    baseUrl: sameOriginUrl(capsule.base_url, 'capsule_protocol.base_url', origin),
    routes: Object.freeze({
      allocate: route('allocate', ['org_id']),
      list: route('list', ['org_id', 'cursor', 'limit']),
      inspect: route('inspect', ['org_id', 'capsule_id']),
      terminate: route('terminate', ['org_id', 'capsule_id']),
      limits: route('limits', ['org_id']),
      access: route('access', ['capsule_id']),
    }),
  });
}

export function parseOAuth(discovery: Record<string, unknown>, origin: string) {
  const oauth = closedRecord(discovery.oauth, 'oauth', [
    'metadata_url',
    'device_authorization_endpoint',
    'token_endpoint',
    'revocation_endpoint',
    'client_id',
    'device_grant_type',
    'device_exchange_fields',
    'audience',
  ]);
  exact(
    oauth.device_grant_type,
    'urn:ietf:params:oauth:grant-type:device_code',
    'oauth.device_grant_type'
  );
  exactStringSet(oauth.device_exchange_fields, 'oauth.device_exchange_fields', [
    'device_token',
    'device_label',
  ]);
  exact(oauth.audience, 'capsule', 'oauth.audience');
  return Object.freeze({
    metadataUrl: sameOriginUrl(oauth.metadata_url, 'oauth.metadata_url', origin),
    deviceAuthorizationEndpoint: sameOriginUrl(
      oauth.device_authorization_endpoint,
      'oauth.device_authorization_endpoint',
      origin
    ),
    tokenEndpoint: sameOriginUrl(oauth.token_endpoint, 'oauth.token_endpoint', origin),
    revocationEndpoint: sameOriginUrl(
      oauth.revocation_endpoint,
      'oauth.revocation_endpoint',
      origin
    ),
    clientId: stringField(oauth, 'client_id', 'oauth.'),
    deviceGrantType: 'urn:ietf:params:oauth:grant-type:device_code' as const,
    audience: 'capsule' as const,
  });
}

export function parseSession(discovery: Record<string, unknown>) {
  const session = closedRecord(discovery.session, 'session', [
    'route_template',
    'method',
    'cache_policy',
  ]);
  exact(session.method, 'GET', 'session.method');
  exact(session.cache_policy, 'no-store', 'session.cache_policy');
  return Object.freeze({
    routeTemplate: routeTemplate(session.route_template, 'session.route_template', []),
    method: 'GET' as const,
  });
}

export function parseTransport(discovery: Record<string, unknown>) {
  const transport = closedRecord(discovery.transport, 'transport', [
    'websocket_route_template',
    'unauthorized_status',
    'close_codes',
  ]);
  exact(transport.unauthorized_status, 401, 'transport.unauthorized_status');
  const closeCodes = closedRecord(transport.close_codes, 'transport.close_codes', [
    'expired',
    'revoked',
  ]);
  exact(closeCodes.expired, 4401, 'transport.close_codes.expired');
  exact(closeCodes.revoked, 4403, 'transport.close_codes.revoked');
  return Object.freeze({
    websocketRouteTemplate: routeTemplate(
      transport.websocket_route_template,
      'transport.websocket_route_template',
      ['capsule_id']
    ),
    unauthorizedStatus: 401 as const,
    closeCodes: Object.freeze({ expired: 4401 as const, revoked: 4403 as const }),
  });
}
