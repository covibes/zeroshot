import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  createTargetAdapter,
  MAX_RESPONSE_BYTES,
  TargetProtocolError,
  TargetServerError,
} from '../helpers/hosted-target-runtime.mjs';
import {
  FakeHttpTransport,
  FakeTokenProvider,
  NO_RETRY,
  capsule,
  fakeDiscovery,
} from './harness.mjs';

function bodyOf(request: { readonly init: RequestInit }): unknown {
  return JSON.parse(String(request.init.body));
}

let http: FakeHttpTransport;

beforeEach(() => {
  http = new FakeHttpTransport();
});

function adapter() {
  return createTargetAdapter({
    descriptor: fakeDiscovery(),
    organization: { id: 'org/opaque value' },
    tokenProvider: new FakeTokenProvider(),
    transport: http,
    retryPolicy: NO_RETRY,
  });
}

function runtimeAdapter() {
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

describe('descriptor-driven TargetAdapter', () => {
  it('captures every discovered method, route, query, header, and body exactly', async () => {
    http.enqueue(201, capsule('cap/opaque'));
    http.enqueue(200, { capsules: [capsule('cap/opaque')], next_cursor: 'cursor/next ?' });
    http.enqueue(200, capsule('cap/opaque'));
    http.enqueue(200, { active_capsules: 1, max_active_capsules: null });
    http.enqueue(200, {
      protocol: 'openengine.cluster/v1',
      websocket_url: 'wss://hosted.openengine.example/v1/capsules/cap%2Fopaque/oecp',
      access_token: 'capsule-grant-canary',
      token_type: 'Bearer',
      expires_at: '2026-08-03T01:00:00Z',
    });
    http.enqueue(202, capsule('cap/opaque', 'terminating'));
    const target = adapter();

    await target.allocate({ idempotencyKey: 'idem-1', label: 'worker', size: 'small' });
    const page = await target.list({ cursor: 'cursor/raw ?', limit: 37 });
    await target.inspect('cap/opaque');
    const limits = await target.limits();
    const access = await target.access('cap/opaque');
    const terminating = await target.terminate('cap/opaque');

    assert.equal(
      http.requests[0]?.url,
      'https://hosted.openengine.example/api/v1/orgs/org%2Fopaque%20value/capsules'
    );
    assert.equal(http.requests[0]?.init.method, 'POST');
    assert.deepEqual(bodyOf(http.requests[0]!), { label: 'worker', size: 'small' });
    assert.equal(new Headers(http.requests[0]?.init.headers).get('Idempotency-Key'), 'idem-1');
    assert.equal(
      new Headers(http.requests[0]?.init.headers).get('Authorization'),
      'Bearer admin-access-canary'
    );
    assert.equal(
      http.requests[1]?.url,
      'https://hosted.openengine.example/api/v1/orgs/org%2Fopaque%20value/capsules?cursor=cursor%2Fraw%20%3F&limit=37'
    );
    assert.equal(http.requests[1]?.init.redirect, 'manual');
    assert.equal(
      http.requests[2]?.url,
      'https://hosted.openengine.example/api/v1/orgs/org%2Fopaque%20value/capsules/cap%2Fopaque'
    );
    assert.equal(
      http.requests[3]?.url,
      'https://hosted.openengine.example/api/v1/orgs/org%2Fopaque%20value/limits'
    );
    assert.equal(
      http.requests[4]?.url,
      'https://hosted.openengine.example/api/v1/capsules/cap%2Fopaque/access'
    );
    assert.deepEqual(bodyOf(http.requests[4]!), { protocol: 'openengine.cluster/v1' });
    assert.equal(http.requests[5]?.init.method, 'DELETE');
    assert.equal(page.nextCursor, 'cursor/next ?');
    assert.equal(limits.maxActiveCapsules, null);
    assert.equal(access.accessToken, 'capsule-grant-canary');
    assert.equal(terminating.state, 'terminating');
  });
});

describe('descriptor-driven TargetAdapter validation', () => {
  it('rejects body and pagination bounds before transport side effects', async () => {
    const target = adapter();
    await assert.rejects(
      target.allocate({ idempotencyKey: 'idem', label: 'x'.repeat(101) }),
      TargetProtocolError
    );
    await assert.rejects(target.list({ limit: 101 }), TargetProtocolError);
    assert.equal(http.requests.length, 0);
  });

  it('preserves the closed 409 code and valid Retry-After instead of collapsing conflicts', async () => {
    http.enqueue(
      409,
      {
        code: 'run_conflict',
        message: 'server message and token canary must not escape',
        capsule_id: 'cap-1',
        retryable: true,
      },
      { 'Retry-After': '1' }
    );
    const target = adapter();

    await assert.rejects(target.inspect('cap-1'), (error: unknown) => {
      assert.ok(error instanceof TargetServerError);
      assert.equal(error.serverCode, 'run_conflict');
      assert.equal(error.retryAfterMs, 1000);
      assert.equal(error.message, 'Capsule request failed (run_conflict)');
      assert.equal(error.message.includes('token canary'), false);
      return true;
    });
  });

  it('rejects unknown fields, lifecycle values, and permanent Retry-After', async () => {
    http.enqueue(200, { ...capsule(), provider_id: 'leak' });
    await assert.rejects(adapter().inspect('cap-1'), TargetProtocolError);

    http.enqueue(
      409,
      {
        code: 'idempotency_conflict',
        message: 'conflict',
        capsule_id: null,
        retryable: false,
      },
      { 'Retry-After': '1' }
    );
    await assert.rejects(adapter().inspect('cap-1'), TargetProtocolError);
  });

  it('requires the exact Bearer challenge on closed unauthorized responses', async () => {
    const unauthorized = {
      code: 'unauthorized',
      message: 'CANARY_REFRESH_920',
      capsule_id: null,
      retryable: false,
    };
    http.enqueue(401, unauthorized);
    await assert.rejects(adapter().inspect('cap-1'), TargetProtocolError);

    http.enqueue(401, unauthorized, {
      'WWW-Authenticate': 'Bearer error="invalid_token"',
    });
    await assert.rejects(adapter().inspect('cap-1'), (error: unknown) => {
      assert.ok(error instanceof TargetServerError);
      assert.equal(error.serverCode, 'unauthorized');
      assert.equal(error.message.includes('CANARY_REFRESH_920'), false);
      return true;
    });
  });
});

describe('descriptor-driven TargetAdapter wire errors', () => {
  it('accepts the production 402 forbidden contract pair', async () => {
    http.enqueue(402, {
      code: 'forbidden',
      message: 'quota exhausted',
      capsule_id: null,
      retryable: false,
    });
    await assert.rejects(adapter().allocate({ idempotencyKey: 'idem-402' }), (error: unknown) => {
      assert.ok(error instanceof TargetServerError);
      assert.equal(error.status, 402);
      assert.equal(error.serverCode, 'forbidden');
      return true;
    });
  });

  it('rejects retryable errors without Retry-After', async () => {
    http.enqueue(503, {
      code: 'temporarily_unavailable',
      message: 'try later',
      capsule_id: null,
      retryable: true,
    });
    await assert.rejects(adapter().limits(), /omitted Retry-After/);
    http.enqueue(
      503,
      {
        code: 'temporarily_unavailable',
        message: 'try later',
        capsule_id: null,
        retryable: true,
      },
      { 'Retry-After': '1.5' }
    );
    await assert.rejects(adapter().limits(), /Retry-After header is malformed/);
  });

  it('rejects impossible calendar dates', async () => {
    http.enqueue(200, {
      ...capsule(),
      created_at: '2026-02-31T00:00:00Z',
    });
    await assert.rejects(adapter().inspect('cap-1'), TargetProtocolError);
  });

  it('classifies redirects as one non-retryable protocol failure', async () => {
    http.responses.push(
      new Response('{}', {
        status: 302,
        headers: { Location: 'https://attacker.example/capsules' },
      })
    );
    await assert.rejects(adapter().inspect('cap-1'), /redirects are forbidden/);
    assert.equal(http.requests.length, 1);
  });

  it('rejects structural dot segments before token acquisition or transport', async () => {
    const tokenProvider = new FakeTokenProvider();
    const target = createTargetAdapter({
      descriptor: fakeDiscovery(),
      organization: { id: 'org' },
      tokenProvider,
      transport: http,
      retryPolicy: NO_RETRY,
    });
    await assert.rejects(target.terminate('..'), TargetProtocolError);
    assert.equal(tokenProvider.calls.length, 0);
    assert.equal(http.requests.length, 0);
  });
});

describe('descriptor-driven TargetAdapter bounds and transport', () => {
  it('installs one opaque runtime bundle with the capsule access bearer', async () => {
    http.responses.push(new Response(null, { status: 204 }));
    const target = runtimeAdapter();
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
    await assert.rejects(adapter().inspect('cap-1'), /size limit/);
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
    assert.deepEqual(adapter().credentialInstall, { supported: false });
    assert.equal(http.requests.length, 0);
  });
});
