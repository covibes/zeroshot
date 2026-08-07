import type { RouteTemplate, TargetDiscoveryDescriptor } from '../target/discovery.js';
import { TargetProtocolError } from './errors.js';
import type { TargetOperation } from './retry-executor.js';

export type AdapterRequest = {
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type ExecuteArguments<T> = [
  operation: TargetOperation,
  method: string,
  template: RouteTemplate,
  values: Readonly<Record<string, string | number | undefined>>,
  expectedStatus: number,
  validate: (body: unknown) => T,
  signal?: AbortSignal,
  request?: AdapterRequest,
];

export function requestUrl(path: string, descriptor: TargetDiscoveryDescriptor): URL {
  const baseUrl = new globalThis.URL(descriptor.capsule.baseUrl);
  const requestPath = `${baseUrl.pathname.replace(/\/$/, '')}${path}`;
  const url = new globalThis.URL(requestPath, baseUrl.origin);
  if (
    url.origin !== descriptor.origin ||
    url.hash ||
    `${url.pathname}${url.search}` !== requestPath
  ) {
    throw new TargetProtocolError('Capsule route changed during URL canonicalization');
  }
  return url;
}
