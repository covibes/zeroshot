import type { HttpTransport } from './device-flow.ts';
import { readBoundedJson } from './bounded-json.ts';

const DISCOVERY_PATH = '/.well-known/openengine-hosted-target';
const MAX_DISCOVERY_BYTES = 64 * 1024;

export interface TargetSessionEndpoints {
  readonly deviceAuthorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly clientId: string;
  readonly capsuleApiBaseUrl: string;
}

export class TargetDiscoveryError extends Error {
  constructor(message: string) {
    super(`Target discovery failed: ${message}`);
    this.name = 'TargetDiscoveryError';
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TargetDiscoveryError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TargetDiscoveryError(`${field} must be a non-empty string`);
  }
  return value;
}

function safeEndpoint(value: unknown, field: string, serviceOrigin: string): string {
  if (typeof value !== 'string') {
    throw new TargetDiscoveryError(`${field} must be an absolute URL`);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TargetDiscoveryError(`${field} must be an absolute URL`);
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TargetDiscoveryError(`${field} contains forbidden URL components`);
  }
  if (endpoint.origin !== serviceOrigin) {
    throw new TargetDiscoveryError(`${field} must remain on the target origin`);
  }
  return endpoint.href;
}

async function fetchDocument(http: HttpTransport, url: string): Promise<Record<string, unknown>> {
  const response = await http.fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
  });
  if (!response.ok) {
    throw new TargetDiscoveryError(`request failed with status ${response.status}`);
  }
  const body = await readBoundedJson(response, MAX_DISCOVERY_BYTES, {
    tooLarge: () => new TargetDiscoveryError('response exceeds the size limit'),
    invalid: () => new TargetDiscoveryError('response is not valid JSON'),
  });
  return record(body, 'response');
}

export async function discoverTargetSessionEndpoints(
  targetUrl: string,
  http: HttpTransport
): Promise<TargetSessionEndpoints> {
  const target = new URL(targetUrl);
  const discovery = await fetchDocument(http, new URL(DISCOVERY_PATH, target).href);
  if (discovery.kind !== 'openengine.hosted-target/v1') {
    throw new TargetDiscoveryError('unsupported hosted-target version');
  }
  if (discovery.organization_binding !== 'device_approval') {
    throw new TargetDiscoveryError('unsupported organization binding');
  }

  const oauth = record(discovery.oauth, 'oauth');
  const capsuleProtocol = record(discovery.capsule_protocol, 'capsule_protocol');
  if (capsuleProtocol.name !== 'openengine.capsules/v1' || capsuleProtocol.major_version !== 1) {
    throw new TargetDiscoveryError('unsupported capsule protocol');
  }
  const capsuleApiBaseUrl = safeEndpoint(
    capsuleProtocol.base_url,
    'capsule_protocol.base_url',
    target.origin
  ).replace(/\/$/, '');
  const metadataUrl = safeEndpoint(oauth.metadata_url, 'oauth.metadata_url', target.origin);
  const deviceEndpoint = safeEndpoint(
    oauth.device_authorization_endpoint,
    'oauth.device_authorization_endpoint',
    target.origin
  );
  const tokenEndpoint = safeEndpoint(oauth.token_endpoint, 'oauth.token_endpoint', target.origin);
  const clientId = stringField(oauth, 'client_id');

  const metadata = await fetchDocument(http, metadataUrl);
  const metadataDeviceEndpoint = safeEndpoint(
    metadata.device_authorization_endpoint,
    'device_authorization_endpoint',
    target.origin
  );
  const metadataTokenEndpoint = safeEndpoint(
    metadata.token_endpoint,
    'token_endpoint',
    target.origin
  );
  if (metadataDeviceEndpoint !== deviceEndpoint || metadataTokenEndpoint !== tokenEndpoint) {
    throw new TargetDiscoveryError('OAuth metadata does not match hosted-target discovery');
  }

  const revocationEndpoint =
    metadata.revocation_endpoint === undefined
      ? undefined
      : safeEndpoint(metadata.revocation_endpoint, 'revocation_endpoint', target.origin);

  return {
    deviceAuthorizationEndpoint: deviceEndpoint,
    tokenEndpoint,
    ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
    clientId,
    capsuleApiBaseUrl,
  };
}
