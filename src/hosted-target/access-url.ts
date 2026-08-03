import type { TargetDiscoveryDescriptor } from '../target/discovery.js';
import { TargetProtocolError } from './errors.js';

function hasForbiddenCodePoint(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function parseAccessUrl(value: string): URL {
  try {
    if (hasForbiddenCodePoint(value)) throw new TypeError('unsafe URL code point');
    const url = new globalThis.URL(value);
    if (url.href !== value) throw new TypeError('non-canonical URL');
    return url;
  } catch {
    throw new TargetProtocolError('Capsule access WebSocket URL is invalid');
  }
}

function matchesAccessRoute(url: URL, target: URL, expectedPath: string): boolean {
  const expectedProtocol = target.protocol === 'http:' ? 'ws:' : 'wss:';
  return url.protocol === expectedProtocol &&
    url.host === target.host &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === expectedPath;
}

export function validateAccessUrl(
  value: string,
  capsuleId: string,
  descriptor: TargetDiscoveryDescriptor,
): void {
  const url = parseAccessUrl(value);
  const expectedPath = descriptor.transport.websocketRouteTemplate.expand({
    capsule_id: capsuleId,
  });
  if (!matchesAccessRoute(url, new globalThis.URL(descriptor.origin), expectedPath)) {
    throw new TargetProtocolError('Capsule access WebSocket URL does not match discovery');
  }
}
