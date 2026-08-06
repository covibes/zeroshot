import { ClusterConfigError } from '../cluster/index.js';
import type { HostedAccess } from './types.js';

const LOOPBACK_HOSTS: Readonly<Record<string, true>> = Object.freeze({
  '127.0.0.1': true,
  '::1': true,
  '[::1]': true,
});

function parseCanonicalUrl(value: string, message: string, code: string): URL {
  try {
    if (/[\u0000-\u0020\u007f]/.test(value)) throw new TypeError('unsafe URL code point');
    const url = new URL(value);
    if (url.href !== value && url.origin !== value) throw new TypeError('non-canonical URL');
    return url;
  } catch {
    throw new ClusterConfigError(message, code);
  }
}

function hasOriginSuffix(url: URL): boolean {
  return Boolean(
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash,
  );
}

export function normalizedAuthority(value: string): string {
  const message = 'targetAuthority must be an HTTPS or literal-loopback HTTP origin';
  const url = parseCanonicalUrl(value, message, 'INVALID_TARGET_AUTHORITY');
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS[url.hostname] === true;
  if ((url.protocol !== 'https:' && !loopbackHttp) || hasOriginSuffix(url) ||
      value !== url.origin) {
    throw new ClusterConfigError(message, 'INVALID_TARGET_AUTHORITY');
  }
  return url.origin;
}

function accessAuthorityMatches(endpoint: URL, target: URL): boolean {
  const expectedProtocol = target.protocol === 'http:' ? 'ws:' : 'wss:';
  return (
    endpoint.protocol === expectedProtocol &&
    endpoint.host === target.host &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.search &&
    !endpoint.hash
  );
}

export function validateHostedAccess(access: HostedAccess, targetAuthority: string): void {
  const endpoint = parseCanonicalUrl(
    access.websocketUrl,
    'access endpoint must be an absolute target WebSocket URL',
    'INVALID_ACCESS_ENDPOINT',
  );
  if (endpoint.href !== access.websocketUrl ||
      !accessAuthorityMatches(endpoint, new URL(targetAuthority))) {
    throw new ClusterConfigError(
      'access endpoint must remain on the exact target authority',
      'INVALID_ACCESS_ENDPOINT',
    );
  }
  if (
    access.protocol !== 'openengine.cluster/v1' ||
    access.tokenType !== 'Bearer' ||
    access.accessToken.length === 0
  ) {
    throw new ClusterConfigError(
      'access grant does not match the hosted session contract',
      'INVALID_ACCESS_GRANT',
    );
  }
}
