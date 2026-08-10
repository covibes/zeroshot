import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createTargetAdapter, MAX_RESPONSE_BYTES } from '../helpers/hosted-target-runtime.mjs';
import { FakeHttpTransport, FakeTokenProvider, NO_RETRY, fakeDiscovery } from './harness.mjs';
import { createAdapter } from './target-adapter-fixture.ts';

let http: FakeHttpTransport;

beforeEach(() => {
  http = new FakeHttpTransport();
});

describe('descriptor-driven TargetAdapter bounds and transport', () => {
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
});
