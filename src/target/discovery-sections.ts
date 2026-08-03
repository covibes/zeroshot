import { TargetDiscoveryError } from './discovery-errors.ts';
import {
  closedRecord,
  exact,
  parseCredentialInstall,
  sameOriginUrl,
  type CredentialInstallDescriptor,
} from './discovery-validation.ts';
import { routeTemplate } from './route-template.ts';

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
  if (cache.discovery !== undefined && cache.discovery !== null &&
      typeof cache.discovery !== 'string') {
    throw new TargetDiscoveryError('cache_policy.discovery must be a string or null');
  }
}

export function parseSizes(discovery: Record<string, unknown>): {
  readonly catalog: readonly ('tiny' | 'small' | 'standard' | 'large')[];
  readonly default: 'tiny' | 'small' | 'standard' | 'large';
} {
  const sizes = closedRecord(discovery.sizes, 'sizes', ['catalog', 'default']);
  if (!Array.isArray(sizes.catalog) || sizes.catalog.length === 0 ||
      new Set(sizes.catalog).size !== sizes.catalog.length ||
      sizes.catalog.some((size) => !['tiny', 'small', 'standard', 'large'].includes(String(size)))) {
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
  origin: string,
): CredentialInstallDescriptor | null {
  if (discovery.extensions === undefined || discovery.extensions === null) return null;
  const extensions = closedRecord(discovery.extensions, 'extensions', [
    'connections', 'credential_install',
  ]);
  if (extensions.connections === undefined) {
    throw new TargetDiscoveryError('extensions.connections is required');
  }
  const connections = closedRecord(extensions.connections, 'extensions.connections', [
    'kind', 'base_url', 'route_templates',
  ]);
  exact(connections.kind, 'zerocloud.connections/v1', 'extensions.connections.kind');
  sameOriginUrl(connections.base_url, 'extensions.connections.base_url', origin);
  const routes = closedRecord(connections.route_templates, 'extensions.connections.route_templates', [
    'list', 'create', 'update',
  ]);
  routeTemplate(routes.list, 'extensions.connections.route_templates.list', []);
  routeTemplate(routes.create, 'extensions.connections.route_templates.create', []);
  routeTemplate(routes.update, 'extensions.connections.route_templates.update', ['connection_id']);
  return parseCredentialInstall(extensions.credential_install);
}

export function validateOAuthMetadata(
  metadata: Record<string, unknown>,
  origin: string,
  expected: readonly [string, string, string],
): void {
  const device = sameOriginUrl(
    metadata.device_authorization_endpoint,
    'OAuth metadata device_authorization_endpoint',
    origin,
  );
  const token = sameOriginUrl(metadata.token_endpoint, 'OAuth metadata token_endpoint', origin);
  const revoke = sameOriginUrl(
    metadata.revocation_endpoint,
    'OAuth metadata revocation_endpoint',
    origin,
  );
  if (device !== expected[0] || token !== expected[1] || revoke !== expected[2]) {
    throw new TargetDiscoveryError('OAuth metadata does not match hosted-target discovery');
  }
}
