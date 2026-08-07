import type { RouteTemplate, TargetDiscoveryDescriptor } from '../target/discovery.js';
import {
  TargetAdapterError,
  TargetAuthError,
  TargetProtocolError,
  TargetTransportError,
} from './errors.js';
import type { TargetOperation } from './retry-executor.js';
import type { HttpTransport, TargetAccessTokenProvider } from './types.js';

const DEFAULT_TRANSPORT: HttpTransport = {
  fetch(url, init) {
    return globalThis.fetch(url, init);
  },
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason ?? new globalThis.DOMException('The operation was aborted', 'AbortError');
}

async function resolveAccessToken(
  tokenProvider: TargetAccessTokenProvider,
  accessToken: string | undefined,
  signal: AbortSignal | undefined
): Promise<string> {
  if (accessToken !== undefined) return accessToken;
  try {
    return await tokenProvider.getAccessToken(signal);
  } catch {
    throw new TargetAuthError('Target access authorization failed');
  }
}

export type AdapterRequest = {
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type AdapterRequester = (input: {
  readonly method: string;
  readonly path: string;
  readonly signal: AbortSignal | undefined;
  readonly request: AdapterRequest;
  readonly accessToken: string | undefined;
}) => Promise<Response>;

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

export function createAdapterRequester(
  descriptor: TargetDiscoveryDescriptor,
  tokenProvider: TargetAccessTokenProvider,
  transport: HttpTransport = DEFAULT_TRANSPORT
): AdapterRequester {
  return async ({ method, path, signal, request, accessToken }) => {
    throwIfAborted(signal);
    const url = requestUrl(path, descriptor);
    const token = await resolveAccessToken(tokenProvider, accessToken, signal);
    const init: RequestInit & { redirect: 'manual' } = {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...request.headers,
      },
      redirect: 'manual',
    };
    if (request.body !== undefined) init.body = request.body;
    if (signal !== undefined) init.signal = signal;
    try {
      const response = await transport.fetch(url.href, init);
      if (response.url && new globalThis.URL(response.url).href !== url.href) {
        await response.body?.cancel().catch(() => undefined);
        throw new TargetProtocolError('Capsule response changed target route');
      }
      return response;
    } catch (error) {
      if (error instanceof TargetAdapterError) throw error;
      throwIfAborted(signal);
      throw new TargetTransportError('Capsule transport failed');
    }
  };
}
