import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestDeviceCode,
  pollForToken,
  DeviceFlowDeniedError,
  DeviceFlowExpiredError,
  type PollForTokenRequest,
} from '../../src/target/device-flow.ts';
import { FakeHttpTransport, FakeClock, respond } from './harness.ts';

describe('requestDeviceCode', () => {
  it('sends POST with client_id and returns device code response', async () => {
    const http = new FakeHttpTransport();
    http.enqueue(
      respond(200, {
        device_code: 'dev-code-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://auth.example.com/device',
        verification_uri_complete: 'https://auth.example.com/device?code=ABCD-1234',
        expires_in: 900,
        interval: 5,
      })
    );

    const result = await requestDeviceCode('https://auth.example.com/oauth/device', 'cli', http);

    assert.equal(result.device_code, 'dev-code-123');
    assert.equal(result.user_code, 'ABCD-1234');
    assert.equal(result.verification_uri, 'https://auth.example.com/device');
    assert.equal(result.expires_in, 900);
    assert.equal(result.interval, 5);
    assert.equal(http.requests.length, 1);
    assert.equal(http.requests[0]!.method, 'POST');
    assert.equal(http.requests[0]!.body, 'client_id=cli');
  });

  it('throws on non-ok response', async () => {
    const http = new FakeHttpTransport();
    http.enqueue(respond(400, { error: 'bad_request' }));

    await assert.rejects(
      requestDeviceCode('https://auth.example.com/oauth/device', 'cli', http),
      /Device code request failed \(400\)/
    );
  });

  it('rejects additive and unsafe device responses before returning them', async () => {
    const http = new FakeHttpTransport();
    http.enqueue(
      respond(200, {
        device_code: 'dev-code-123',
        user_code: 'ABCD-1234',
        verification_uri: 'javascript:alert(1)',
        expires_in: 900,
        interval: 5,
        organization: 'jwt-derived',
      })
    );

    await assert.rejects(
      requestDeviceCode('https://auth.example.com/oauth/device', 'cli', http),
      /Device code response is malformed/
    );
  });

  it('rejects a browser completion URL on a different authority', async () => {
    const http = new FakeHttpTransport();
    http.enqueue(respond(200, {
      device_code: 'dev-code-123',
      user_code: 'ABCD-1234',
      verification_uri: 'https://auth.example.com/device',
      verification_uri_complete: 'https://attacker.example/device?code=ABCD-1234',
      expires_in: 900,
      interval: 5,
    }));
    await assert.rejects(
      requestDeviceCode('https://auth.example.com/oauth/device', 'cli', http),
      /Device code response is malformed/,
    );
  });

  it('cancels a chunked device response at the OAuth byte bound', async () => {
    let cancelled = false;
    const http = {
      async fetch() {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(64 * 1024));
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }), { status: 200 });
      },
    };
    await assert.rejects(
      requestDeviceCode('https://auth.example.com/oauth/device', 'cli', http),
      /size limit/,
    );
    assert.equal(cancelled, true);
  });
});

function poll(
  http: FakeHttpTransport,
  overrides: Partial<Omit<PollForTokenRequest, 'http'>> = {},
) {
  return pollForToken({
    tokenEndpoint: 'https://auth.example.com/oauth/token',
    clientId: 'cli',
    deviceCode: 'dev-code-123',
    interval: 0,
    expiresIn: 900,
    http,
    ...overrides,
  });
}

describe('pollForToken', () => {
  it('returns token on immediate success', async () => {
    const http = new FakeHttpTransport();
    const clock = new FakeClock(0);

    http.enqueue(
      respond(200, {
        access_token: 'access-123',
        refresh_token: 'refresh-456',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_expires_in: 5_184_000,
        scope: 'session capsule',
      })
    );

    const result = await poll(http, { clock });

    assert.equal(result.access_token, 'access-123');
    assert.equal(result.refresh_token, 'refresh-456');
    assert.equal(result.token_type, 'Bearer');
    assert.equal('refresh_expires_in' in result, false);
    assert.equal('scope' in result, false);
  });

  it('requires the authority refresh lifetime and scope fields', async () => {
    const http = new FakeHttpTransport();
    http.enqueue(respond(200, {
      access_token: 'access-123',
      refresh_token: 'refresh-456',
      token_type: 'Bearer',
      expires_in: 3600,
    }));
    await assert.rejects(
      poll(http, { deviceCode: 'device' }),
      /Token response is malformed/,
    );
  });
});

describe('pollForToken retry state', () => {

  it('continues polling on authorization_pending', async () => {
    const http = new FakeHttpTransport();
    const clock = new FakeClock(0);

    http.enqueue(respond(400, { error: 'authorization_pending' }));
    http.enqueue(respond(400, { error: 'authorization_pending' }));
    http.enqueue(
      respond(200, {
        access_token: 'access-123',
        refresh_token: 'refresh-456',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_expires_in: 5_184_000,
        scope: 'session capsule',
      })
    );

    const result = await poll(http, { clock });

    assert.equal(result.access_token, 'access-123');
    assert.equal(http.requests.length, 3);
  });

  it('increases interval on slow_down', async () => {
    const http = new FakeHttpTransport();
    const clock = new FakeClock(0);

    http.enqueue(respond(400, { error: 'slow_down' }));
    http.enqueue(
      respond(200, {
        access_token: 'access-123',
        refresh_token: 'refresh-456',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_expires_in: 5_184_000,
        scope: 'session capsule',
      })
    );

    // interval starts at 0 for speed, after slow_down becomes 5
    const result = await poll(http, { clock });

    assert.equal(result.access_token, 'access-123');
  });
});

describe('pollForToken failures', () => {

  it('throws DeviceFlowDeniedError on access_denied', async () => {
    const http = new FakeHttpTransport();
    const clock = new FakeClock(0);

    http.enqueue(respond(400, { error: 'access_denied' }));

    await assert.rejects(
      poll(http, { clock }),
      DeviceFlowDeniedError
    );
  });

  it('throws DeviceFlowExpiredError on expired_token', async () => {
    const http = new FakeHttpTransport();
    const clock = new FakeClock(0);

    http.enqueue(respond(400, { error: 'expired_token' }));

    await assert.rejects(
      poll(http, { clock }),
      DeviceFlowExpiredError
    );
  });

  it('reports unknown OAuth failures without copying token canaries', async () => {
    const http = new FakeHttpTransport();
    const clock = new FakeClock(0);
    http.enqueue(respond(400, { error: 'CANARY_REFRESH_920' }));

    await assert.rejects(
      poll(http, { clock }),
      (error: Error) => {
        assert.equal(error.message, 'Token endpoint returned an unsupported OAuth error');
        assert.equal(error.message.includes('CANARY_REFRESH_920'), false);
        return true;
      }
    );
  });

  it('throws DeviceFlowExpiredError when deadline exceeded', async () => {
    const http = new FakeHttpTransport();
    const clock = new FakeClock(1_000_000);

    await assert.rejects(
      poll(http, { expiresIn: 0, clock }),
      DeviceFlowExpiredError
    );
  });

  it('throws on abort signal', async () => {
    const http = new FakeHttpTransport();
    const clock = new FakeClock(0);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      poll(http, { interval: 1, clock, signal: controller.signal }),
      /Aborted|abort/i
    );
  });
});
