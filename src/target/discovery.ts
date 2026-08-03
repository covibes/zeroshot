import type { HttpTransport } from './device-flow.ts';

const DISCOVERY_PATH = '/.well-known/openengine-hosted-target';
const MAX_DISCOVERY_BYTES = 64 * 1024;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CAPSULE_AUDIENCE = 'capsule';
const CLUSTER_PROTOCOL = 'openengine.cluster/v1';
const CAPSULE_PROTOCOL = 'openengine.capsules/v1';

const ROOT_FIELDS = new Set([
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
]);

export interface RouteTemplate {
  readonly template: string;
  readonly variables: readonly string[];
  expand(values: Readonly<Record<string, string | number | undefined>>): string;
}

export interface CredentialInstallDescriptor {
  readonly kind: 'openengine.capsule-credential-install/v1';
  readonly grant: { readonly routeTemplate: RouteTemplate; readonly method: 'POST' };
  readonly install: { readonly routeTemplate: RouteTemplate; readonly method: 'PUT' };
  readonly uploadUrlOrigin: 'same_origin';
  readonly sealedEnvelopeAlgorithms: readonly ['RSA-OAEP-3072-SHA256'];
  readonly bounds: {
    readonly maxEnvelopeBytes: number;
    readonly maxBodyBytes: number;
    readonly grantTtlSeconds: number;
    readonly maxClockSkewSeconds: number;
  };
}

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
  readonly deviceGrantType: typeof DEVICE_GRANT;
  readonly audience: typeof CAPSULE_AUDIENCE;
  readonly sessionEndpoint: string;
  readonly descriptor: TargetDiscoveryDescriptor;
}

export class TargetDiscoveryError extends Error {
  constructor(message: string) {
    super(`Invalid hosted target discovery: ${message}`);
    this.name = 'TargetDiscoveryError';
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TargetDiscoveryError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function closedRecord(value: unknown, field: string, fields: readonly string[]): Record<string, unknown> {
  const result = record(value, field);
  const allowed = new Set(fields);
  const unknown = Object.keys(result).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new TargetDiscoveryError(`${field}.${unknown} is not supported`);
  return result;
}

function stringField(source: Record<string, unknown>, field: string, parent = ''): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TargetDiscoveryError(`${parent}${field} must be a non-empty string`);
  }
  return value;
}

function exact(value: unknown, expected: unknown, field: string): void {
  if (value !== expected) throw new TargetDiscoveryError(`${field} is not supported`);
}

function integer(value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TargetDiscoveryError(`${field} is outside the supported bounds`);
  }
  return value as number;
}

function exactStringSet(value: unknown, field: string, expected: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TargetDiscoveryError(`${field} must be an array of strings`);
  }
  if (value.length !== expected.length || new Set(value).size !== value.length || expected.some((x) => !value.includes(x))) {
    throw new TargetDiscoveryError(`${field} does not match the supported contract`);
  }
  return Object.freeze([...value]) as readonly string[];
}

function sameOriginUrl(value: unknown, field: string, origin: string, protocols: readonly string[] = ['https:', 'http:']): string {
  if (typeof value !== 'string') throw new TargetDiscoveryError(`${field} must be an absolute URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TargetDiscoveryError(`${field} must be an absolute URL`);
  }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TargetDiscoveryError(`${field} contains forbidden URL components`);
  }
  if (url.origin !== origin) throw new TargetDiscoveryError(`${field} must remain on the target origin`);
  return url.href;
}

function expandCompiled(
  template: string,
  variables: readonly string[],
  values: Readonly<Record<string, string | number | undefined>>,
): string {
  const supplied = Object.keys(values).filter((key) => values[key] !== undefined);
  if (supplied.some((key) => !variables.includes(key))) {
    throw new TargetDiscoveryError('route expansion supplied an undeclared variable');
  }
  let expanded = template.replace(/\{\?([^}]+)\}/g, (_match, names: string) => {
    const params = names.split(',').flatMap((name) =>
      values[name] === undefined ? [] : [[name, String(values[name])]] as Array<[string, string]>,
    );
    return params.length === 0 ? '' : `?${new URLSearchParams(params).toString()}`;
  });
  expanded = expanded.replace(/\{([^}?][^}]*)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new TargetDiscoveryError(`route expansion is missing ${name}`);
    return encodeURIComponent(String(value));
  });
  if (/[{}]/.test(expanded)) throw new TargetDiscoveryError('route expansion left an unexpanded variable');
  return expanded;
}

function routeTemplate(value: unknown, field: string, variables: readonly string[]): RouteTemplate {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('#') ||
    value.replace(/\{\?[^}]+\}/g, '').includes('?')
  ) {
    throw new TargetDiscoveryError(`${field} must be a safe relative route template`);
  }
  const expressions = [...value.matchAll(/\{([^{}]+)\}/g)];
  const stripped = value.replace(/\{[^{}]+\}/g, '');
  if (stripped.includes('{') || stripped.includes('}') || /(^|\/)\.\.?(\/|$)/.test(stripped)) {
    throw new TargetDiscoveryError(`${field} contains an unsafe template expression`);
  }
  const found: string[] = [];
  for (const expression of expressions) {
    const body = expression[1];
    if (body === undefined) throw new TargetDiscoveryError(`${field} contains an invalid expression`);
    const query = body.startsWith('?');
    const names = body.replace(/^\?/, '').split(',');
    if (query && field !== 'capsule_protocol.route_templates.list') {
      throw new TargetDiscoveryError(`${field} contains an unsupported query expansion`);
    }
    found.push(...names);
  }
  if (found.length !== variables.length || new Set(found).size !== found.length || variables.some((x) => !found.includes(x))) {
    throw new TargetDiscoveryError(`${field} declares unsupported variables`);
  }
  const compiledVariables = Object.freeze([...variables]);
  return Object.freeze({
    template: value,
    variables: compiledVariables,
    expand: (values: Readonly<Record<string, string | number | undefined>>) =>
      expandCompiled(value, compiledVariables, values),
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_DISCOVERY_BYTES)) {
    throw new TargetDiscoveryError('response exceeds the size limit');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DISCOVERY_BYTES) throw new TargetDiscoveryError('response exceeds the size limit');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new TargetDiscoveryError('response is not valid UTF-8 JSON');
  }
}

async function fetchDocument(http: HttpTransport, url: string, origin: string): Promise<Record<string, unknown>> {
  const response = await http.fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
  });
  if (response.url && new URL(response.url).origin !== origin) {
    throw new TargetDiscoveryError('request changed target authority');
  }
  if (!response.ok) throw new TargetDiscoveryError(`request failed with status ${response.status}`);
  return record(await readBoundedJson(response), 'response');
}

function parseCredentialInstall(value: unknown): CredentialInstallDescriptor | null {
  if (value === undefined || value === null) return null;
  const extension = closedRecord(value, 'extensions.credential_install', [
    'kind', 'grant', 'install', 'upload_url_origin', 'sealed_envelope_algorithms', 'bounds',
  ]);
  exact(extension.kind, 'openengine.capsule-credential-install/v1', 'extensions.credential_install.kind');
  const grant = closedRecord(extension.grant, 'extensions.credential_install.grant', ['route_template', 'method']);
  const install = closedRecord(extension.install, 'extensions.credential_install.install', ['route_template', 'method']);
  exact(grant.method, 'POST', 'extensions.credential_install.grant.method');
  exact(install.method, 'PUT', 'extensions.credential_install.install.method');
  exact(extension.upload_url_origin, 'same_origin', 'extensions.credential_install.upload_url_origin');
  exactStringSet(extension.sealed_envelope_algorithms, 'extensions.credential_install.sealed_envelope_algorithms', ['RSA-OAEP-3072-SHA256']);
  const bounds = closedRecord(extension.bounds, 'extensions.credential_install.bounds', [
    'max_envelope_bytes', 'max_body_bytes', 'grant_ttl_seconds', 'max_clock_skew_seconds',
  ]);
  return Object.freeze({
    kind: 'openengine.capsule-credential-install/v1' as const,
    grant: Object.freeze({ routeTemplate: routeTemplate(grant.route_template, 'extensions.credential_install.grant.route_template', ['capsule_id']), method: 'POST' as const }),
    install: Object.freeze({ routeTemplate: routeTemplate(install.route_template, 'extensions.credential_install.install.route_template', ['capsule_id']), method: 'PUT' as const }),
    uploadUrlOrigin: 'same_origin' as const,
    sealedEnvelopeAlgorithms: Object.freeze(['RSA-OAEP-3072-SHA256'] as const),
    bounds: Object.freeze({
      maxEnvelopeBytes: integer(bounds.max_envelope_bytes, 'extensions.credential_install.bounds.max_envelope_bytes', 1, 1_048_576),
      maxBodyBytes: integer(bounds.max_body_bytes, 'extensions.credential_install.bounds.max_body_bytes', 1, 1_048_576),
      grantTtlSeconds: integer(bounds.grant_ttl_seconds, 'extensions.credential_install.bounds.grant_ttl_seconds', 1, 3_600),
      maxClockSkewSeconds: integer(bounds.max_clock_skew_seconds, 'extensions.credential_install.bounds.max_clock_skew_seconds', 0, 300),
    }),
  });
}

export async function discoverTarget(targetUrl: string, http: HttpTransport): Promise<TargetDiscoveryDescriptor> {
  const target = new URL(targetUrl);
  const origin = target.origin;
  const discovery = await fetchDocument(http, new URL(DISCOVERY_PATH, target).href, origin);
  exact(discovery.kind, 'openengine.hosted-target/v1', 'kind');

  const adapter = closedRecord(discovery.adapter, 'adapter', ['name', 'major_version']);
  if (!['fargate', 'docker', 'local'].includes(String(adapter.name))) throw new TargetDiscoveryError('adapter.name is not supported');
  exact(adapter.major_version, 1, 'adapter.major_version');
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

  const cache = closedRecord(discovery.cache_policy, 'cache_policy', ['control', 'discovery']);
  exact(cache.control, 'no-store', 'cache_policy.control');
  if (cache.discovery !== undefined && cache.discovery !== null && typeof cache.discovery !== 'string') {
    throw new TargetDiscoveryError('cache_policy.discovery must be a string or null');
  }

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
  const sizes = closedRecord(discovery.sizes, 'sizes', ['catalog', 'default']);
  if (!Array.isArray(sizes.catalog) || sizes.catalog.length === 0 || new Set(sizes.catalog).size !== sizes.catalog.length || sizes.catalog.some((size) => !['tiny', 'small', 'standard', 'large'].includes(String(size)))) {
    throw new TargetDiscoveryError('sizes.catalog contains an unsupported size');
  }
  if (!sizes.catalog.includes(sizes.default)) throw new TargetDiscoveryError('sizes.default is not in sizes.catalog');

  const session = closedRecord(discovery.session, 'session', ['route_template', 'method', 'cache_policy']);
  exact(session.method, 'GET', 'session.method');
  exact(session.cache_policy, 'no-store', 'session.cache_policy');
  const sessionRoute = routeTemplate(session.route_template, 'session.route_template', []);

  const transport = closedRecord(discovery.transport, 'transport', ['websocket_route_template', 'unauthorized_status', 'close_codes']);
  exact(transport.unauthorized_status, 401, 'transport.unauthorized_status');
  const closeCodes = closedRecord(transport.close_codes, 'transport.close_codes', ['expired', 'revoked']);
  exact(closeCodes.expired, 4401, 'transport.close_codes.expired');
  exact(closeCodes.revoked, 4403, 'transport.close_codes.revoked');

  let credentialInstall: CredentialInstallDescriptor | null = null;
  if (discovery.extensions !== undefined && discovery.extensions !== null) {
    const extensions = closedRecord(discovery.extensions, 'extensions', ['connections', 'credential_install']);
    if (extensions.connections === undefined) throw new TargetDiscoveryError('extensions.connections is required');
    const connections = closedRecord(extensions.connections, 'extensions.connections', ['kind', 'base_url', 'route_templates']);
    exact(connections.kind, 'zerocloud.connections/v1', 'extensions.connections.kind');
    sameOriginUrl(connections.base_url, 'extensions.connections.base_url', origin);
    const connectionRoutes = closedRecord(connections.route_templates, 'extensions.connections.route_templates', ['list', 'create', 'update']);
    routeTemplate(connectionRoutes.list, 'extensions.connections.route_templates.list', []);
    routeTemplate(connectionRoutes.create, 'extensions.connections.route_templates.create', []);
    routeTemplate(connectionRoutes.update, 'extensions.connections.route_templates.update', ['connection_id']);
    credentialInstall = parseCredentialInstall(extensions.credential_install);
  }

  const metadata = await fetchDocument(http, metadataUrl, origin);
  const metadataDevice = sameOriginUrl(metadata.device_authorization_endpoint, 'OAuth metadata device_authorization_endpoint', origin);
  const metadataToken = sameOriginUrl(metadata.token_endpoint, 'OAuth metadata token_endpoint', origin);
  const metadataRevoke = sameOriginUrl(metadata.revocation_endpoint, 'OAuth metadata revocation_endpoint', origin);
  if (metadataDevice !== deviceAuthorizationEndpoint || metadataToken !== tokenEndpoint || metadataRevoke !== revocationEndpoint) {
    throw new TargetDiscoveryError('OAuth metadata does not match hosted-target discovery');
  }

  const additional = Object.freeze(Object.fromEntries(Object.entries(discovery).filter(([key]) => !ROOT_FIELDS.has(key))));
  return Object.freeze({
    origin,
    adapter: Object.freeze({ name: adapter.name as 'fargate' | 'docker' | 'local', majorVersion: 1 as const }),
    endpoint: endpointUrl,
    endpointCapabilities,
    pagination: Object.freeze({ defaultPageSize, maxPageSize }),
    sizes: Object.freeze({ catalog: Object.freeze([...(sizes.catalog as Array<'tiny' | 'small' | 'standard' | 'large'>)]), default: sizes.default as 'tiny' | 'small' | 'standard' | 'large' }),
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
    deviceGrantType: descriptor.oauth.deviceGrantType,
    audience: descriptor.oauth.audience,
    sessionEndpoint: new URL(descriptor.session.routeTemplate.template, descriptor.origin).href,
    descriptor,
  });
}

export function expandRoute(template: RouteTemplate, values: Readonly<Record<string, string | number | undefined>>): string {
  return template.expand(values);
}
