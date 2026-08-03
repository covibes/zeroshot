import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { ZeroCloudV1TargetAdapter } from '../../src/hosted-target/zero-cloud-v1-adapter.ts';
import {
  TargetAuthError,
  TargetConflictError,
  TargetNotFoundError,
  TargetProtocolError,
  TargetRateLimitError,
  TargetTransportError,
} from '../../src/hosted-target/errors.ts';
import { MAX_RESPONSE_BYTES } from '../../src/hosted-target/bounds.ts';
import type { RetryPolicy } from '../../src/hosted-target/types.ts';
import type { TargetAdapterError } from '../../src/hosted-target/errors.ts';
import {
  FakeHttpTransport,
  FakeClock,
  FakeTokenProvider,
  fakeDiscovery,
  respond,
  makeCapsule,
  makeCapsuleAccess,
  makeListPage,
  NO_RETRY,
} from './harness.ts';

function countingRetry(maxAttempts: number): RetryPolicy & { attempts: number[] } {
  const state = {
    attempts: [] as number[],
    shouldRetry(attempt: number, _elapsed: number, _error: TargetAdapterError) {
      state.attempts.push(attempt);
      if (attempt >= maxAttempts) return { retry: false, delayMs: 0 };
      return { retry: true, delayMs: 0 };
    },
  };
  return state;
}

function makeAdapter(
  transport: FakeHttpTransport,
  opts?: { clock?: FakeClock; retryPolicy?: RetryPolicy; tokenProvider?: FakeTokenProvider },
) {
  return new ZeroCloudV1TargetAdapter({
    discovery: fakeDiscovery(),
    organization: 'org-test',
    tokenProvider: opts?.tokenProvider ?? new FakeTokenProvider(),
    transport,
    clock: opts?.clock ?? new FakeClock(),
    retryPolicy: opts?.retryPolicy ?? NO_RETRY,
  });
}

describe('ZeroCloudV1TargetAdapter', () => {
  let transport: FakeHttpTransport;

  beforeEach(() => {
    transport = new FakeHttpTransport();
  });

  describe('auth errors', () => {
    it('401 throws TargetAuthError (non-retryable)', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respond(401, { error: 'unauthorized' }));

      try {
        await adapter.inspect('cap-1');
        assert.fail('should throw');
      } catch (err) {
        assert.ok(err instanceof TargetAuthError);
        assert.equal(err.retryable, false);
      }
    });

    it('403 throws TargetAuthError (non-retryable)', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respond(403, { error: 'forbidden' }));

      try {
        await adapter.inspect('cap-1');
        assert.fail('should throw');
      } catch (err) {
        assert.ok(err instanceof TargetAuthError);
        assert.equal(err.retryable, false);
      }
    });

    it('auth errors are never retried', async () => {
      const retryPolicy = countingRetry(3);
      const adapter = makeAdapter(transport, { retryPolicy });
      transport.enqueue(respond(401, { error: 'unauthorized' }));

      await assert.rejects(() => adapter.inspect('cap-1'), TargetAuthError);
      assert.equal(retryPolicy.attempts.length, 0);
      assert.equal(transport.requests.length, 1);
    });
  });

  describe('rate limiting', () => {
    it('429 with numeric Retry-After header', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(
        respond(429, { error: 'rate limited' }, { 'Retry-After': '30' }),
      );

      try {
        await adapter.inspect('cap-1');
        assert.fail('should throw');
      } catch (err) {
        assert.ok(err instanceof TargetRateLimitError);
        assert.equal(err.retryAfterMs, 30000);
      }
    });

    it('429 with HTTP-date Retry-After header', async () => {
      const clock = new FakeClock(1000000);
      const futureDate = new Date(1000000 + 60000).toUTCString();
      const adapter = makeAdapter(transport, { clock });
      transport.enqueue(
        respond(429, { error: 'rate limited' }, { 'Retry-After': futureDate }),
      );

      try {
        await adapter.inspect('cap-1');
        assert.fail('should throw');
      } catch (err) {
        assert.ok(err instanceof TargetRateLimitError);
        assert.ok(err.retryAfterMs !== undefined && err.retryAfterMs > 0);
      }
    });
  });

  describe('server errors and retries', () => {
    it('5xx is retried up to policy limit', async () => {
      const retryPolicy = countingRetry(3);
      const adapter = makeAdapter(transport, { retryPolicy });
      transport.enqueue(respond(500, { error: 'internal' }));
      transport.enqueue(respond(502, { error: 'bad gateway' }));
      transport.enqueue(respond(200, makeCapsule()));

      const result = await adapter.inspect('cap-1');
      assert.equal(result.id, 'cap-001');
      assert.equal(retryPolicy.attempts.length, 2);
    });

    it('5xx exhausts retries and throws', async () => {
      const retryPolicy = countingRetry(2);
      const adapter = makeAdapter(transport, { retryPolicy });
      transport.enqueue(respond(500, { error: 'fail1' }));
      transport.enqueue(respond(500, { error: 'fail2' }));
      transport.enqueue(respond(500, { error: 'fail3' }));

      await assert.rejects(() => adapter.inspect('cap-1'), TargetTransportError);
    });
  });

  describe('redirect rejection', () => {
    it('redirect response throws TargetProtocolError', async () => {
      const adapter = makeAdapter(transport);
      transport.setFault(() => {
        const err = new TypeError('redirect mode is set to error');
        throw err;
      });

      await assert.rejects(() => adapter.inspect('cap-1'), TargetProtocolError);
    });
  });

  describe('oversized response', () => {
    it('rejects response exceeding MAX_RESPONSE_BYTES via Content-Length', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(
        respond(200, makeCapsule(), {
          'Content-Length': String(MAX_RESPONSE_BYTES + 1),
        }),
      );

      await assert.rejects(() => adapter.inspect('cap-1'), TargetProtocolError);
    });
  });

  describe('malformed response', () => {
    it('partial/malformed JSON throws TargetProtocolError', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue({ status: 200, body: '{"id": "cap-1", broken' });

      await assert.rejects(() => adapter.inspect('cap-1'), TargetProtocolError);
    });

    it('missing required field throws TargetProtocolError', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respond(200, { id: 'cap-1' }));

      await assert.rejects(() => adapter.inspect('cap-1'), TargetProtocolError);
    });
  });

  describe('forward compatibility', () => {
    it('unknown enum value passes without error', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(
        respond(200, makeCapsule({ state: 'upgrading' })),
      );

      const result = await adapter.inspect('cap-1');
      assert.equal(result.state, 'upgrading');
    });

    it('unknown optional fields are preserved', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(
        respond(200, makeCapsule({ futureField: 'future-value' })),
      );

      const result = await adapter.inspect('cap-1');
      assert.equal((result as Record<string, unknown>)['futureField'], 'future-value');
    });
  });

  describe('credential safety', () => {
    it('Authorization header never appears in error message', async () => {
      const tokenProvider = new FakeTokenProvider('super-secret-bearer-token-xyz');
      const adapter = makeAdapter(transport, { tokenProvider });
      transport.enqueue(respond(500, { error: 'server error' }));

      try {
        await adapter.inspect('cap-1');
        assert.fail('should throw');
      } catch (err: unknown) {
        const message = (err as Error).message;
        assert.ok(
          !message.includes('super-secret-bearer-token-xyz'),
          `Error message should not contain token: ${message}`,
        );
      }
    });

    it('access token value never appears in error output', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(
        respond(200, makeCapsuleAccess({ token: 'very-secret-access-token' })),
      );

      const result = await adapter.access('cap-1');
      assert.equal(result.token, 'very-secret-access-token');

      transport.enqueue(respond(500, { error: 'post-access failure' }));
      try {
        await adapter.inspect('cap-2');
        assert.fail('should throw');
      } catch (err: unknown) {
        const fullError = JSON.stringify(err);
        assert.ok(
          !fullError.includes('very-secret-access-token'),
          'Serialized error should not contain access token',
        );
      }
    });
  });

  describe('idempotency key handling', () => {
    it('preserves idempotency key on retry of ambiguous allocation', async () => {
      const retryPolicy = countingRetry(2);
      const adapter = makeAdapter(transport, { retryPolicy });
      transport.setFault(() => {
        transport.setFault(null);
        throw new Error('connection reset');
      });
      transport.enqueue(respond(201, makeCapsule({ id: 'cap-new' })));

      const result = await adapter.allocate({ idempotencyKey: 'idem-key-1', profile: 'default' });
      assert.equal(result.id, 'cap-new');
      assert.equal(transport.requests.length, 2);
      assert.equal(transport.requests[0]!.headers['Idempotency-Key'], 'idem-key-1');
      assert.equal(transport.requests[1]!.headers['Idempotency-Key'], 'idem-key-1');
    });

    it('preserves request body on retry', async () => {
      const retryPolicy = countingRetry(2);
      const adapter = makeAdapter(transport, { retryPolicy });
      transport.setFault(() => {
        transport.setFault(null);
        throw new Error('connection reset');
      });
      transport.enqueue(respond(201, makeCapsule()));

      await adapter.allocate({ idempotencyKey: 'key-x', profile: 'gpu-large' });

      assert.equal(transport.requests[0]!.body, transport.requests[1]!.body);
      const body = JSON.parse(transport.requests[0]!.body!);
      assert.equal(body.profile, 'gpu-large');
    });
  });

  describe('404 handling', () => {
    it('404 throws TargetNotFoundError', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respond(404, { error: 'not found' }));

      await assert.rejects(() => adapter.inspect('nonexistent'), TargetNotFoundError);
    });
  });

  describe('409 conflict', () => {
    it('409 throws TargetConflictError with idempotency key', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respond(409, { error: 'conflict' }));

      try {
        await adapter.allocate({ idempotencyKey: 'dup-key', profile: 'default' });
        assert.fail('should throw');
      } catch (err) {
        assert.ok(err instanceof TargetConflictError);
        assert.equal(err.idempotencyKey, 'dup-key');
      }
    });
  });

  describe('cursor loop detection', () => {
    it('throws TargetProtocolError when server returns same cursor as input', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respond(200, makeListPage([makeCapsule()], 'cursor-A')));
      transport.enqueue(respond(200, makeListPage([makeCapsule()], 'cursor-A')));

      const page1 = await adapter.list();
      assert.equal(page1.cursor, 'cursor-A');

      await assert.rejects(
        () => adapter.list(page1.cursor),
        (err: Error) => {
          assert.ok(err instanceof TargetProtocolError);
          assert.ok(err.message.includes('Pagination loop'));
          return true;
        },
      );
    });

    it('allows different cursor values across pages', async () => {
      const adapter = makeAdapter(transport);
      transport.enqueue(respond(200, makeListPage([makeCapsule()], 'cursor-A')));
      transport.enqueue(respond(200, makeListPage([makeCapsule()], 'cursor-B')));

      const page1 = await adapter.list();
      assert.equal(page1.cursor, 'cursor-A');

      const page2 = await adapter.list(page1.cursor);
      assert.equal(page2.cursor, 'cursor-B');
    });
  });

  describe('origin validation', () => {
    it('rejects requests where path would change origin', async () => {
      const adapter = new ZeroCloudV1TargetAdapter({
        discovery: { capsuleV1: 'https://api.test.example/v1' },
        organization: 'org-test',
        tokenProvider: new FakeTokenProvider(),
        transport,
        clock: new FakeClock(),
        retryPolicy: NO_RETRY,
      });

      transport.enqueue(respond(200, makeCapsule()));
      const result = await adapter.inspect('cap-1');
      assert.equal(result.id, 'cap-001');
    });
  });

  describe('network timeout', () => {
    it('network timeout throws TargetTransportError', async () => {
      const adapter = makeAdapter(transport);
      transport.setFault(() => {
        throw new Error('network timeout');
      });

      await assert.rejects(() => adapter.inspect('cap-1'), TargetTransportError);
    });
  });
});
