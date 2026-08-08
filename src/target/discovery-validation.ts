import { TargetDiscoveryError } from './discovery-errors.js';
import { routeTemplate, type RouteTemplate } from './route-template.js';

export interface CredentialInstallDescriptor {
  readonly kind: 'openengine.capsule-credential-install/v1';
  readonly install: { readonly routeTemplate: RouteTemplate; readonly method: 'PUT' };
  readonly maxBodyBytes: number;
}

export function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TargetDiscoveryError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function closedRecord(
  value: unknown,
  field: string,
  fields: readonly string[],
): Record<string, unknown> {
  const result = record(value, field);
  const unknown = Object.keys(result).find((key) => !fields.includes(key));
  if (unknown !== undefined) throw new TargetDiscoveryError(`${field}.${unknown} is not supported`);
  return result;
}

export function stringField(
  source: Record<string, unknown>,
  field: string,
  parent = '',
): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TargetDiscoveryError(`${parent}${field} must be a non-empty string`);
  }
  return value;
}

export function exact(value: unknown, expected: unknown, field: string): void {
  if (value !== expected) throw new TargetDiscoveryError(`${field} is not supported`);
}

export function integer(
  value: unknown,
  field: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TargetDiscoveryError(`${field} is outside the supported bounds`);
  }
  return value as number;
}

export function exactStringSet(
  value: unknown,
  field: string,
  expected: readonly string[],
): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TargetDiscoveryError(`${field} must be an array of strings`);
  }
  if (value.length !== expected.length || new Set(value).size !== value.length ||
      expected.some((item) => !value.includes(item))) {
    throw new TargetDiscoveryError(`${field} does not match the supported contract`);
  }
  return Object.freeze([...value]) as readonly string[];
}

function hasForbiddenUrlComponent(
  url: URL,
  value: string,
  protocols: readonly string[],
): boolean {
  return !protocols.includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.href !== value;
}

export function sameOriginUrl(
  value: unknown,
  field: string,
  origin: string,
  protocols: readonly string[] = ['https:', 'http:'],
): string {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]|\s/u.test(value)) {
    throw new TargetDiscoveryError(`${field} must be a canonical absolute URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TargetDiscoveryError(`${field} must be an absolute URL`);
  }
  if (hasForbiddenUrlComponent(url, value, protocols)) {
    throw new TargetDiscoveryError(`${field} contains forbidden URL components`);
  }
  if (url.origin !== origin) {
    throw new TargetDiscoveryError(`${field} must remain on the target origin`);
  }
  return url.href;
}

export function parseCredentialInstall(value: unknown): CredentialInstallDescriptor | null {
  if (value === undefined || value === null) return null;
  const extension = closedRecord(value, 'extensions.credential_install', [
    'kind',
    'install',
    'max_body_bytes',
  ]);
  exact(
    extension.kind,
    'openengine.capsule-credential-install/v1',
    'extensions.credential_install.kind'
  );
  const install = closedRecord(extension.install, 'extensions.credential_install.install', [
    'route_template',
    'method',
  ]);
  exact(install.method, 'PUT', 'extensions.credential_install.install.method');
  return Object.freeze({
    kind: 'openengine.capsule-credential-install/v1' as const,
    install: Object.freeze({
      routeTemplate: routeTemplate(
        install.route_template,
        'extensions.credential_install.install.route_template',
        ['capsule_id']
      ),
      method: 'PUT' as const,
    }),
    maxBodyBytes: integer(
      extension.max_body_bytes,
      'extensions.credential_install.max_body_bytes',
      1,
      4 * 1024 * 1024
    ),
  });
}
