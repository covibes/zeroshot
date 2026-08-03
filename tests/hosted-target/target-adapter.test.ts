import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createTargetAdapter } from '../../src/hosted-target/target-adapter.ts';
import { TargetProtocolError, TargetServerError } from '../../src/hosted-target/errors.ts';
import {
  FakeHttpTransport,
  FakeTokenProvider,
  NO_RETRY,
  capsule,
  fakeDiscovery,
} from './harness.ts';

function bodyOf(request: { readonly init: RequestInit }): unknown {
  return JSON.parse(String(request.init.body));
}

describe('descriptor-driven TargetAdapter', () => {
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
      'https://hosted.openengine.example/orgs/org%2Fopaque%20value/capsules'
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
      'https://hosted.openengine.example/orgs/org%2Fopaque%20value/capsules?cursor=cursor%2Fraw+%3F&limit=37'
    );
    assert.equal(
      http.requests[2]?.url,
      'https://hosted.openengine.example/orgs/org%2Fopaque%20value/capsules/cap%2Fopaque'
    );
    assert.equal(
      http.requests[3]?.url,
      'https://hosted.openengine.example/orgs/org%2Fopaque%20value/limits'
    );
    assert.equal(
      http.requests[4]?.url,
      'https://hosted.openengine.example/capsules/cap%2Fopaque/access'
    );
    assert.deepEqual(bodyOf(http.requests[4]!), { protocol: 'openengine.cluster/v1' });
    assert.equal(http.requests[5]?.init.method, 'DELETE');
    assert.equal(page.nextCursor, 'cursor/next ?');
    assert.equal(limits.maxActiveCapsules, null);
    assert.equal(access.accessToken, 'capsule-grant-canary');
    assert.equal(terminating.state, 'terminating');
  });

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

  it('exposes absence of credential install as capability metadata without guessing a route', () => {
    assert.deepEqual(adapter().credentialInstall, { supported: false });
    assert.equal(http.requests.length, 0);
  });
});
