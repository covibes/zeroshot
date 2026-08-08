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

export function createRuntimeAdapter(http: FakeHttpTransport) {
  const descriptor = fakeDiscovery();
  return createTargetAdapter({
    descriptor: {
      ...descriptor,
      credentialInstall: {
        kind: 'openengine.capsule-credential-install/v1',
        install: {
          routeTemplate: {
            template: '/capsules/{capsule_id}/credentials',
            variables: ['capsule_id'],
            expand: ({ capsule_id }: Readonly<Record<string, string | number | undefined>>) =>
              `/capsules/${encodeURIComponent(String(capsule_id))}/credentials`,
          },
          method: 'PUT',
        },
        maxBodyBytes: 4096,
      },
    },
    organization: { id: 'org/opaque value' },
    tokenProvider: new FakeTokenProvider(),
    transport: http,
    retryPolicy: NO_RETRY,
  });
}
