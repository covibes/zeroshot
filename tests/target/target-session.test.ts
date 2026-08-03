import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TargetSessionManager, LoginRequiredError } from '../../src/target/target-session.ts';
import {
  TARGET_ACCOUNT,
  targetServiceKey,
  type TargetCredentialStore,
} from '../../src/target/credential-store.ts';
import {
  FakeClock,
  FakeCredentialStore,
  FakeHttpTransport,
  fakeLock,
  makeSessionDeps,
  makeSettingsPort,
  makeTarget,
  respond,
} from './harness.ts';

function manager(
  http: FakeHttpTransport,
  store: TargetCredentialStore = new FakeCredentialStore(),
  acquireLock: () => Promise<() => Promise<void>> = fakeLock()
) {
  const target = makeTarget();
  const settings = makeSettingsPort({ _targets: { primary: target } });
  return {
    target,
    settings,
    store,
    value: new TargetSessionManager({
      targetName: 'primary',
      target,
      credentialStore: store,
      acquireLock,
      settings,
      deps: makeSessionDeps({ http, clock: new FakeClock(1_000_000) }),
    }),
  };
}

describe('TargetSessionManager', () => {
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
    http.enqueue(
      respond(200, {
        access_token: 'capsule-access-canary',
        refresh_token: 'refresh-family-canary',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );
    http.enqueue(
      respond(200, {
        kind: 'openengine.target-session/v1',
        organization_id: 'org-from-server',
      })
    );
    const fixture = manager(http);

    const result = await fixture.value.login();

    assert.deepEqual(result, { organization: { id: 'org-from-server' } });
    assert.deepEqual(fixture.settings.load()._targets?.primary?.organization, {
      id: 'org-from-server',
    });
    assert.equal(
      await fixture.store.get(targetServiceKey(fixture.target.id), TARGET_ACCOUNT),
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
        init: RequestInit & { redirect: 'error' }
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
    http.enqueue(
      respond(200, {
        access_token: 'access',
        refresh_token: 'refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );
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
    const fixture = manager(http, new FakeCredentialStore(), acquireLock);

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
    http.enqueue(
      respond(200, {
        access_token: 'access',
        refresh_token: 'replacement',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );
    http.enqueue(
      respond(200, {
        kind: 'openengine.target-session/v1',
        organization_id: 'org',
        jwt_sub: 'must-not-bind',
      })
    );
    http.enqueue(respond(200, {}));
    const fixture = manager(http);

    await assert.rejects(fixture.value.login(), LoginRequiredError);
    assert.equal(
      await fixture.store.get(targetServiceKey(fixture.target.id), TARGET_ACCOUNT),
      null
    );
  });

  it('rotates one refresh family under the requested audience and caches only that audience', async () => {
    const http = new FakeHttpTransport();
    const fixture = manager(http);
    await fixture.store.set(targetServiceKey(fixture.target.id), TARGET_ACCOUNT, 'old-refresh');
    http.enqueue(
      respond(200, {
        access_token: 'admin-access',
        refresh_token: 'new-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );

    assert.equal(await fixture.value.getAccessToken('admin'), 'admin-access');
    assert.equal(await fixture.value.getAccessToken('admin'), 'admin-access');
    assert.equal(http.requests.length, 1);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(http.requests[0]?.body ?? '')), {
      grant_type: 'refresh_token',
      client_id: 'cli',
      refresh_token: 'old-refresh',
      audience: 'admin',
    });
    assert.equal(
      await fixture.store.get(targetServiceKey(fixture.target.id), TARGET_ACCOUNT),
      'new-refresh'
    );
  });

  it('clears durable refresh state after a dispatched malformed exchange', async () => {
    const http = new FakeHttpTransport();
    const fixture = manager(http);
    await fixture.store.set(targetServiceKey(fixture.target.id), TARGET_ACCOUNT, 'old-refresh');
    http.enqueue(
      respond(200, {
        access_token: 'access',
        refresh_token: 'replacement',
        token_type: 'bearer',
        expires_in: 3600,
      })
    );

    await assert.rejects(fixture.value.getAccessToken('capsule'), LoginRequiredError);
    assert.equal(
      await fixture.store.get(targetServiceKey(fixture.target.id), TARGET_ACCOUNT),
      null
    );
  });

  it('deletes the old family after a post-dispatch ambiguous refresh', async () => {
    const http = new (class extends FakeHttpTransport {
      override async fetch(
        url: string,
        init: RequestInit & { redirect: 'error' }
      ): Promise<Response> {
        await super.fetch(url, init);
        throw new Error('connection reset after request dispatch');
      }
    })();
    http.enqueue(
      respond(200, {
        access_token: 'unobservable',
        refresh_token: 'possibly-spent',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );
    const fixture = manager(http);
    await fixture.store.set(
      targetServiceKey(fixture.target.id),
      TARGET_ACCOUNT,
      'old-refresh-canary'
    );

    await assert.rejects(fixture.value.getAccessToken('capsule'), LoginRequiredError);
    assert.equal(
      await fixture.store.get(targetServiceKey(fixture.target.id), TARGET_ACCOUNT),
      null
    );
  });

  it('invalidates replacement state when secure-store replacement fails', async () => {
    let stored: string | null = 'old-refresh';
    const store: TargetCredentialStore = {
      get: async () => stored,
      set: async () => {
        throw new Error('keyring failed');
      },
      delete: async () => {
        stored = null;
      },
    };
    const http = new FakeHttpTransport();
    const fixture = manager(http, store);
    http.enqueue(
      respond(200, {
        access_token: 'access',
        refresh_token: 'replacement',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );
    http.enqueue(respond(200, {}));

    await assert.rejects(fixture.value.getAccessToken('capsule'), LoginRequiredError);
    assert.equal(stored, null);
    assert.equal(http.requests[1]?.url, 'https://api.test.example/oauth/revoke');
  });
});
