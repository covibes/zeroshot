import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createTargetAdapter, MAX_RESPONSE_BYTES } from '../helpers/hosted-target-runtime.mjs';
import { FakeHttpTransport, FakeTokenProvider, NO_RETRY, fakeDiscovery } from './harness.mjs';
import { bodyOf, createAdapter, createRuntimeAdapter } from './target-adapter-fixture.ts';

let http: FakeHttpTransport;

beforeEach(() => {
  http = new FakeHttpTransport();
});

describe('descriptor-driven TargetAdapter bounds and transport', () => {
  it('installs one opaque runtime bundle with the capsule access bearer', async () => {
    http.responses.push(new Response(null, { status: 204 }));
    const target = createRuntimeAdapter(http);
    const runtime = {
      arbitrary: {
        environment: { BEDROCK_REGION: 'eu-west-1' },
        settings: { endpoint: 'https://models.example' },
      },
    };
    await target.installRuntime('cap/raw', runtime, 'capsule-access-canary');
    assert.equal(
      http.requests[0]?.url,
      'https://hosted.openengine.example/api/v1/capsules/cap%2Fraw/credentials'
    );
    assert.equal(http.requests[0]?.init.method, 'PUT');
    assert.equal(
      new Headers(http.requests[0]?.init.headers).get('Authorization'),
      'Bearer capsule-access-canary'
    );
    assert.deepEqual(bodyOf(http.requests[0]!), runtime);
  });

  it('cancels a chunked capsule response at the cumulative byte bound', async () => {
    let cancelled = false;
    http.responses.push(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 }
      )
    );
    await assert.rejects(createAdapter(http).inspect('cap-1'), /size limit/);
    assert.equal(cancelled, true);
  });

  it('accepts the discovered literal-loopback WS transport exception', async () => {
    const descriptor = fakeDiscovery();
    const loopbackDescriptor = {
      ...descriptor,
      origin: 'http://127.0.0.1:8080',
      capsule: {
        ...descriptor.capsule,
        baseUrl: 'http://127.0.0.1:8080/api/v1',
      },
    };
    http.enqueue(200, {
      protocol: 'openengine.cluster/v1',
      websocket_url: 'ws://127.0.0.1:8080/v1/capsules/cap-1/oecp',
      access_token: 'capsule-grant-canary',
      token_type: 'Bearer',
      expires_at: '2026-08-03T01:00:00Z',
    });
    const target = createTargetAdapter({
      descriptor: loopbackDescriptor,
      organization: { id: 'org' },
      tokenProvider: new FakeTokenProvider(),
      transport: http,
      retryPolicy: NO_RETRY,
    });
    const access = await target.access('cap-1');
    assert.equal(access.websocketUrl, 'ws://127.0.0.1:8080/v1/capsules/cap-1/oecp');
    assert.equal(http.requests[0]?.url, 'http://127.0.0.1:8080/api/v1/capsules/cap-1/access');
  });

  it('exposes absence of credential install as capability metadata without guessing a route', () => {
    assert.deepEqual(createAdapter(http).credentialInstall, { supported: false });
    assert.equal(http.requests.length, 0);
  });
});
