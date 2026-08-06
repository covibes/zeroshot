import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LoginRequiredError } from '../helpers/target-runtime.mjs';
import { FakeCredentialStore, FakeHttpTransport, respond } from './harness.mjs';
import { enqueueToken } from './response-fixtures.mjs';
import { getRefreshToken, makeSessionManager } from './session-harness.mjs';

  it('binds login only through the authenticated target-session projection', async () => {
    const http = new FakeHttpTransport();
    http.enqueue(
      respond(200, {
        device_code: 'device-code',
        user_code: 'USER-CODE',
        verification_uri: 'https://api.test.example/activate',
        expires_in: 900,
        interval: 0,
      })
    );
    enqueueToken(http, { access_token: 'capsule-access-canary', refresh_token: 'refresh-family-canary' });
    http.enqueue(
      respond(200, {
        kind: 'openengine.target-session/v1',
        organization_id: 'org-from-server',
      })
    );
    const fixture = makeSessionManager(http);

    const result = await fixture.value.login();

    assert.deepEqual(result, { organization: { id: 'org-from-server' } });
    assert.deepEqual(fixture.settings.load()._targets?.primary?.organization, {
      id: 'org-from-server',
    });
    assert.equal(
      await getRefreshToken(fixture),
      'refresh-family-canary'
    );
    assert.equal(http.requests[0]?.body, 'client_id=cli');
    const exchange = new URLSearchParams(http.requests[1]?.body ?? '');
    assert.deepEqual(Object.fromEntries(exchange), {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'device-code',
      client_id: 'cli',
      device_token: 'device-token-001',
      device_label: 'zeroshot-cli',
      audience: 'capsule',
    });
    assert.equal(exchange.has('scope'), false);
    assert.equal(http.requests[2]?.headers.Authorization, 'Bearer capsule-access-canary');
  });

  it('holds the target lock across initial exchange, verification, and publication', async () => {
    let locked = false;
    const http = new (class extends FakeHttpTransport {
      override async fetch(
        url: string,
        init: RequestInit & { redirect: 'error' | 'manual' }
      ): Promise<Response> {
        if (url.endsWith('/oauth/token') || url.endsWith('/target-session'))
          assert.equal(locked, true);
        return super.fetch(url, init);
      }
    })();
    http.enqueue(
      respond(200, {
        device_code: 'device-code',
        user_code: 'USER-CODE',
        verification_uri: 'https://api.test.example/activate',
        expires_in: 900,
        interval: 0,
      })
    );
    enqueueToken(http, { access_token: 'access', refresh_token: 'refresh' });
    http.enqueue(
      respond(200, {
        kind: 'openengine.target-session/v1',
        organization_id: 'org',
      })
    );
    const acquireLock = async () => {
      assert.equal(locked, false);
      locked = true;
      return async () => {
        locked = false;
      };
    };
    const fixture = makeSessionManager(http, new FakeCredentialStore(), acquireLock);

    await fixture.value.login();

    assert.equal(locked, false);
  });

  it('rejects JWT-derived or additive organization claims and invalidates the family', async () => {
    const http = new FakeHttpTransport();
    http.enqueue(
      respond(200, {
        device_code: 'device-code',
        user_code: 'USER-CODE',
        verification_uri: 'https://api.test.example/activate',
        expires_in: 900,
        interval: 0,
      })
    );
    enqueueToken(http, { access_token: 'access', refresh_token: 'replacement' });
    http.enqueue(
      respond(200, {
        kind: 'openengine.target-session/v1',
        organization_id: 'org',
        jwt_sub: 'must-not-bind',
      })
    );
    http.enqueue(respond(200, {}));
    const fixture = makeSessionManager(http);

    await assert.rejects(fixture.value.login(), LoginRequiredError);
    assert.equal(
      await getRefreshToken(fixture),
      null
    );
  });
