import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { ZeroCloudV1TargetAdapter } from '../../src/hosted-target/zero-cloud-v1-adapter.ts';
import {
  FakeHttpTransport,
  FakeClock,
  FakeTokenProvider,
  fakeDiscovery,
  respond,
  respondEmpty,
  makeCapsule,
  makeCapsuleAccess,
  makeLimits,
  makeListPage,
  NO_RETRY,
} from './harness.ts';
import { TargetProtocolError } from '../../src/hosted-target/errors.ts';
import type { RetryPolicy } from '../../src/hosted-target/types.ts';

function makeAdapter(transport: FakeHttpTransport, opts?: { clock?: FakeClock; retryPolicy?: RetryPolicy }) {
  return new ZeroCloudV1TargetAdapter({
    discovery: fakeDiscovery(),
    organization: 'org-test',
    tokenProvider: new FakeTokenProvider(),
    transport,
    clock: opts?.clock ?? new FakeClock(),
    retryPolicy: opts?.retryPolicy ?? NO_RETRY,
  });
}

describe('TargetAdapter contract tests', () => {
  let transport: FakeHttpTransport;

  beforeEach(() => {
    transport = new FakeHttpTransport();
  });

  describe('allocate', () => {
    it('returns a Capsule on success', async () => {
      const adapter = makeAdapter(transport);
      const capsuleData = makeCapsule({ id: 'cap-new', state: 'provisioning' });
      transport.enqueue(respond(201, capsuleData));

      const result = await adapter.allocate(
        { idempotencyKey: 'key-1', profile: 'default' },
      );

      assert.equal(result.id, 'cap-new');
      assert.equal(result.state, 'provisioning');
      assert.equal(transport.requests.length, 1);
      assert.equal(transport.requests[0]!.method, 'POST');
      assert.ok(transport.requests[0]!.url.includes('/capsules'));
      assert.equal(transport.requests[0]!.headers['Idempotency-Key'], 'key-1');
    });

    it('sends idempotency key and organization in request', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respond(201, makeCapsule()));

      await adapter.allocate({ idempotencyKey: 'idem-abc', profile: 'gpu-large' });

      const req = transport.requests[0]!;
      assert.equal(req.headers['Idempotency-Key'], 'idem-abc');
      const body = JSON.parse(req.body!);
      assert.equal(body.profile, 'gpu-large');
      assert.equal(body.organization, 'org-test');
    });

    it('rejects invalid idempotency key format', async () => {
      const adapter = makeAdapter(transport);
      await assert.rejects(
        () => adapter.allocate({ idempotencyKey: '', profile: 'default' }),
        TargetProtocolError,
      );
    });

    it('rejects idempotency key with invalid characters', async () => {
      const adapter = makeAdapter(transport);
      await assert.rejects(
        () => adapter.allocate({ idempotencyKey: 'has spaces!', profile: 'default' }),
        TargetProtocolError,
      );
    });
  });

  describe('list', () => {
    it('returns a page with items and cursor', async () => {
      const adapter = makeAdapter(transport);
      const items = [makeCapsule({ id: 'cap-1' }), makeCapsule({ id: 'cap-2' })];
      transport.enqueue(respond(200, makeListPage(items, 'next-page-token')));

      const result = await adapter.list();

      assert.equal(result.items.length, 2);
      assert.equal(result.items[0]!.id, 'cap-1');
      assert.equal(result.items[1]!.id, 'cap-2');
      assert.equal(result.cursor, 'next-page-token');
    });

    it('passes cursor parameter when provided', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respond(200, makeListPage([makeCapsule()])));

      await adapter.list('abc-cursor');

      const url = transport.requests[0]!.url;
      assert.ok(url.includes('cursor=abc-cursor'));
    });

    it('returns page without cursor when none in response', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respond(200, makeListPage([makeCapsule()])));

      const result = await adapter.list();
      assert.equal(result.cursor, undefined);
    });
  });

  describe('inspect', () => {
    it('returns a capsule by ID', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respond(200, makeCapsule({ id: 'cap-42', state: 'running' })));

      const result = await adapter.inspect('cap-42');

      assert.equal(result.id, 'cap-42');
      assert.equal(result.state, 'running');
      assert.ok(transport.requests[0]!.url.includes('/capsules/cap-42'));
    });
  });

  describe('terminate', () => {
    it('succeeds on 204 response', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respondEmpty(204));

      await adapter.terminate('cap-42');

      assert.equal(transport.requests[0]!.method, 'DELETE');
      assert.ok(transport.requests[0]!.url.includes('/capsules/cap-42'));
    });
  });

  describe('limits', () => {
    it('returns capacity limits', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respond(200, makeLimits({ maxConcurrent: 10, maxPerHour: 50 })));

      const result = await adapter.limits();

      assert.equal(result.maxConcurrent, 10);
      assert.equal(result.maxPerHour, 50);
    });
  });

  describe('access', () => {
    it('returns CapsuleAccess with endpoint and token', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respond(200, makeCapsuleAccess()));

      const result = await adapter.access('cap-42');

      assert.equal(result.endpoint, 'wss://capsule.test.example/oecp');
      assert.equal(result.token, 'access-token-secret');
      assert.ok(result.expiresAt);
      assert.equal(transport.requests[0]!.method, 'POST');
      assert.ok(transport.requests[0]!.url.includes('/capsules/cap-42/access'));
    });
  });

  describe('pagination cursor handling', () => {
    it('preserves opaque cursor bytes exactly', async () => {
      const adapter = makeAdapter(transport);
      const opaqueToken = 'eyJhbGciOiJub25lIn0=.dGVzdA==';
      transport.enqueue(respond(200, makeListPage([makeCapsule()])));

      await adapter.list(opaqueToken);

      const url = transport.requests[0]!.url;
      assert.ok(url.includes(`cursor=${encodeURIComponent(opaqueToken)}`));
    });
  });

  describe('authorization', () => {
    it('sets Bearer token header on every request', async () => {
      const tokenProvider = new FakeTokenProvider('my-secret-token');
      const adapter = new ZeroCloudV1TargetAdapter({
        discovery: fakeDiscovery(),
        organization: 'org-test',
        tokenProvider,
        transport,
        clock: new FakeClock(),
        retryPolicy: NO_RETRY,
      });
      transport.enqueue(respond(200, makeCapsule()));

      await adapter.inspect('cap-1');

      assert.equal(transport.requests[0]!.headers['Authorization'], 'Bearer my-secret-token');
      assert.equal(tokenProvider.callCount, 1);
    });
  });
});
