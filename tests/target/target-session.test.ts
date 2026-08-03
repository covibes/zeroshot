import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetLogin,
  refreshAccessToken,
  getAccessTokenProvider,
  LoginRequiredError,
} from '../../src/target/target-session.ts';
import { UnboundSessionError } from '../../src/target/device-flow.ts';
import { targetServiceKey, TARGET_ACCOUNT } from '../../src/target/credential-store.ts';
import {
  FakeCredentialStore,
  FakeHttpTransport,
  FakeClock,
  FakeBrowserOpener,
  FakeStderr,
  respond,
  makeSettingsPort,
  makeDiscoveryEndpoints,
  makeTarget,
  fakeLock,
} from './harness.ts';

describe('targetLogin', () => {
  it('stores refresh token and updates organization on success', async () => {
    const http = new FakeHttpTransport();
    const clock = new FakeClock();
    const browser = new FakeBrowserOpener();
    const stderr = new FakeStderr();
    const credStore = new FakeCredentialStore();
    const settings = makeSettingsPort({ _targets: { staging: makeTarget() } });
    const target = makeTarget();

    // device code response
    http.enqueue(
      respond(200, {
        device_code: 'dev-123',
        user_code: 'ABCD',
        verification_uri: 'https://auth.example.com/device',
        verification_uri_complete: 'https://auth.example.com/device?code=ABCD',
        expires_in: 900,
        interval: 0,
      })
    );

    // token exchange response
    http.enqueue(
      respond(200, {
        access_token: 'access-tok',
        refresh_token: 'refresh-tok',
        token_type: 'Bearer',
        expires_in: 3600,
        organization: { id: 'org-1', name: 'TestOrg' },
      })
    );

    const result = await targetLogin('staging', target, credStore, fakeLock(), settings, {
      http,
      clock,
      browserOpener: browser,
      stderr,
      discoveryEndpoints: makeDiscoveryEndpoints(),
    });

    assert.equal(result.organization.name, 'TestOrg');
    assert.equal(result.organization.id, 'org-1');

    // Refresh token stored in keyring
    const stored = await credStore.get(targetServiceKey(target.id), TARGET_ACCOUNT);
    assert.equal(stored, 'refresh-tok');

    // Browser was opened
    assert.equal(browser.openedUrls.length, 1);

    // Stderr got user code message
    assert.ok(stderr.output.some((s) => s.includes('ABCD')));

    // Organization updated in settings
    const loaded = settings.load();
    assert.equal(loaded._targets?.['staging']?.organization?.name, 'TestOrg');

    const devicePoll = new URLSearchParams(http.requests[1]?.body ?? '');
    assert.equal(devicePoll.get('audience'), 'admin');
    assert.equal(devicePoll.get('device_token'), target.deviceToken);
    assert.equal(devicePoll.get('device_label'), 'Zeroshot CLI');
  });

  it('throws UnboundSessionError when no organization in response', async () => {
    const http = new FakeHttpTransport();
    const clock = new FakeClock();
    const credStore = new FakeCredentialStore();
    const settings = makeSettingsPort({ _targets: { staging: makeTarget() } });
    const target = makeTarget();

    http.enqueue(
      respond(200, {
        device_code: 'dev-123',
        user_code: 'ABCD',
        verification_uri: 'https://auth.example.com/device',
        expires_in: 900,
        interval: 0,
      })
    );

    http.enqueue(
      respond(200, {
        access_token: 'access-tok',
        refresh_token: 'refresh-tok',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );

    await assert.rejects(
      targetLogin('staging', target, credStore, fakeLock(), settings, {
        http,
        clock,
        browserOpener: new FakeBrowserOpener(),
        stderr: new FakeStderr(),
        discoveryEndpoints: makeDiscoveryEndpoints(),
      }),
      UnboundSessionError
    );
  });
});

describe('refreshAccessToken', () => {
  it('exchanges refresh token and stores new one', async () => {
    const http = new FakeHttpTransport();
    const credStore = new FakeCredentialStore();
    const target = makeTarget();
    const serviceKey = targetServiceKey(target.id);

    await credStore.set(serviceKey, TARGET_ACCOUNT, 'old-refresh');

    http.enqueue(
      respond(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );

    const result = await refreshAccessToken('staging', target, credStore, fakeLock(), {
      http,
      discoveryEndpoints: makeDiscoveryEndpoints(),
    });

    assert.equal(result.accessToken, 'new-access');
    assert.equal(result.expiresIn, 3600);

    const stored = await credStore.get(serviceKey, TARGET_ACCOUNT);
    assert.equal(stored, 'new-refresh');
    const refresh = new URLSearchParams(http.requests[0]?.body ?? '');
    assert.equal(refresh.get('audience'), 'capsule');
  });

  it('throws LoginRequiredError when no refresh token exists', async () => {
    const http = new FakeHttpTransport();
    const credStore = new FakeCredentialStore();
    const target = makeTarget();

    await assert.rejects(
      refreshAccessToken('staging', target, credStore, fakeLock(), {
        http,
        discoveryEndpoints: makeDiscoveryEndpoints(),
      }),
      LoginRequiredError
    );
  });

  it('throws LoginRequiredError with target name on invalid_grant', async () => {
    const http = new FakeHttpTransport();
    const credStore = new FakeCredentialStore();
    const target = makeTarget();
    const serviceKey = targetServiceKey(target.id);

    await credStore.set(serviceKey, TARGET_ACCOUNT, 'old-refresh');

    http.enqueue(respond(400, { error: 'invalid_grant' }));

    try {
      await refreshAccessToken('staging', target, credStore, fakeLock(), {
        http,
        discoveryEndpoints: makeDiscoveryEndpoints(),
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof LoginRequiredError);
      assert.ok(err.message.includes('zeroshot target login staging'));
    }

    // Token should be deleted from keyring
    const stored = await credStore.get(serviceKey, TARGET_ACCOUNT);
    assert.equal(stored, null);
  });

  it('revokes and deletes on keyring write failure', async () => {
    const http = new FakeHttpTransport();
    const target = makeTarget();
    const serviceKey = targetServiceKey(target.id);

    // Build a credential store that fails on set but works otherwise
    const store = new FakeCredentialStore();
    await store.set(serviceKey, TARGET_ACCOUNT, 'old-refresh');

    const failingStore: FakeCredentialStore = Object.create(store);
    let setCalls = 0;
    failingStore.set = async (_s: string, _a: string, _t: string): Promise<void> => {
      setCalls++;
      throw new Error('Keyring write failed');
    };
    failingStore.get = store.get.bind(store);
    failingStore.delete = store.delete.bind(store);

    // Refresh success response
    http.enqueue(
      respond(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );

    // Revocation response (best-effort)
    http.enqueue(respond(200, {}));

    await assert.rejects(
      refreshAccessToken('staging', target, failingStore, fakeLock(), {
        http,
        discoveryEndpoints: makeDiscoveryEndpoints(),
      }),
      LoginRequiredError
    );

    assert.equal(setCalls, 1);

    // Verify revoke was called with the NEW token (not the consumed one)
    const revokeReq = http.requests.find((r) => r.url.includes('/revoke'));
    assert.ok(revokeReq, 'Should have called revocation endpoint');
    assert.ok(revokeReq.body);
    const revokedParams = new URLSearchParams(revokeReq.body);
    assert.equal(
      revokedParams.get('token'),
      'new-refresh',
      'Must revoke the new (unpersisted) token, not the already-consumed old token'
    );
  });

  it('never retries a consumed refresh token', async () => {
    const http = new FakeHttpTransport();
    const credStore = new FakeCredentialStore();
    const target = makeTarget();
    const serviceKey = targetServiceKey(target.id);

    await credStore.set(serviceKey, TARGET_ACCOUNT, 'consumed-refresh');

    http.enqueue(respond(400, { error: 'invalid_grant' }));

    await assert.rejects(
      refreshAccessToken('staging', target, credStore, fakeLock(), {
        http,
        discoveryEndpoints: makeDiscoveryEndpoints(),
      }),
      LoginRequiredError
    );

    // Only one request made — no retry
    assert.equal(http.requests.length, 1);
  });
});

describe('getAccessTokenProvider', () => {
  it('returns cached token within expiry window', async () => {
    const http = new FakeHttpTransport();
    const clock = new FakeClock(0);
    const credStore = new FakeCredentialStore();
    const target = makeTarget();
    const serviceKey = targetServiceKey(target.id);

    await credStore.set(serviceKey, TARGET_ACCOUNT, 'refresh-1');

    http.enqueue(
      respond(200, {
        access_token: 'access-cached',
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );

    const provider = getAccessTokenProvider(
      'staging',
      target,
      credStore,
      fakeLock(),
      {
        http,
        discoveryEndpoints: makeDiscoveryEndpoints(),
      },
      clock
    );

    const token1 = await provider.getAccessToken();
    assert.equal(token1, 'access-cached');

    // Second call should use cache (no new HTTP request)
    const token2 = await provider.getAccessToken();
    assert.equal(token2, 'access-cached');
    assert.equal(http.requests.length, 1);
  });

  it('refreshes when cache expired', async () => {
    const http = new FakeHttpTransport();
    const clock = new FakeClock(0);
    const credStore = new FakeCredentialStore();
    const target = makeTarget();
    const serviceKey = targetServiceKey(target.id);

    await credStore.set(serviceKey, TARGET_ACCOUNT, 'refresh-1');

    http.enqueue(
      respond(200, {
        access_token: 'access-1',
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
        expires_in: 60,
      })
    );

    http.enqueue(
      respond(200, {
        access_token: 'access-2',
        refresh_token: 'refresh-3',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );

    const provider = getAccessTokenProvider(
      'staging',
      target,
      credStore,
      fakeLock(),
      {
        http,
        discoveryEndpoints: makeDiscoveryEndpoints(),
      },
      clock
    );

    const token1 = await provider.getAccessToken();
    assert.equal(token1, 'access-1');

    // Advance clock past expiry (60s - 30s buffer = 30s)
    clock.advance(31_000);

    const token2 = await provider.getAccessToken();
    assert.equal(token2, 'access-2');
    assert.equal(http.requests.length, 2);
  });
});
