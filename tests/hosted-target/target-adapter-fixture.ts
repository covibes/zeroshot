import { createTargetAdapter } from '../helpers/hosted-target-runtime.mjs';
import { FakeHttpTransport, FakeTokenProvider, NO_RETRY, fakeDiscovery } from './harness.mjs';

export function bodyOf(request: { readonly init: RequestInit }): unknown {
  return JSON.parse(String(request.init.body));
}

export function createAdapter(http: FakeHttpTransport) {
  return createTargetAdapter({
    descriptor: fakeDiscovery(),
    organization: { id: 'org/opaque value' },
    tokenProvider: new FakeTokenProvider(),
    transport: http,
    retryPolicy: NO_RETRY,
  });
}
