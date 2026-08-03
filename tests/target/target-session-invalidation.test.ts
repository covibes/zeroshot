import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  TargetSessionManager,
  LoginRequiredError,
  type TargetCredentialStore,
  type HttpTransport,
} from '../helpers/target-runtime.mjs';
import {
  FakeClock,
  FakeHttpTransport,
  fakeLock,
  makeSessionDeps,
  makeSettingsPort,
  makeTarget,
  respond,
} from './harness.mjs';
import { enqueueToken, oversizedJsonResponse } from './response-fixtures.mjs';
import {
  getRefreshToken,
  makeSessionManager,
  setRefreshToken,
} from './session-harness.mjs';

  it('invalidates replacement state when secure-store replacement fails', async () => {
    let stored: string | null = 'old-refresh';
    const store: TargetCredentialStore = {
      get: async () => stored,
      set: async (_service, _account, token) => {
        if (token !== 'zeroshot.invalidated-refresh-family/v1') {
          throw new Error('keyring failed');
        }
        stored = token;
      },
      delete: async () => {
        stored = null;
      },
    };
    const http = new FakeHttpTransport();
    const fixture = makeSessionManager(http, store);
    enqueueToken(http, { access_token: 'access', refresh_token: 'replacement' });
    http.enqueue(respond(200, {}));

    await assert.rejects(fixture.value.getAccessToken('capsule'), LoginRequiredError);
    assert.equal(stored, null);
    assert.equal(http.requests[1]?.url, 'https://api.test.example/oauth/revoke');
  });

  it('leaves a durable non-secret tombstone when secure deletion fails', async () => {
    let stored: string | null = 'old-refresh-canary';
    let requests = 0;
    const store: TargetCredentialStore = {
      get: async () => stored,
      set: async (_service, _account, token) => {
        stored = token;
      },
      delete: async () => {
        throw new Error('secure delete failed');
      },
    };
    const http: HttpTransport = {
      async fetch() {
        requests += 1;
        assert.equal(stored, 'zeroshot.invalidated-refresh-family/v1');
        throw new Error('ambiguous refresh failure');
      },
    };
    const first = makeSessionManager(http, store);
    await assert.rejects(first.value.getAccessToken('capsule'), /secure delete failed/);
    assert.equal(stored, 'zeroshot.invalidated-refresh-family/v1');

    const second = makeSessionManager(http, store);
    await assert.rejects(second.value.getAccessToken('capsule'), LoginRequiredError);
    assert.equal(requests, 1);
  });

  it('persists a non-secret settings tombstone when the secure store cannot be changed', async () => {
    const target = makeTarget();
    const settings = makeSettingsPort({ _targets: { primary: target } });
    let reads = 0;
    const store: TargetCredentialStore = {
      get: async () => {
        reads += 1;
        return 'stale-refresh-canary';
      },
      set: async () => {
        throw new Error('secure store update failed');
      },
      delete: async () => {
        throw new Error('secure store delete failed');
      },
    };
    const http = new FakeHttpTransport();
    const create = () => new TargetSessionManager({
      targetName: 'primary',
      target,
      credentialStore: store,
      acquireLock: fakeLock(),
      settings,
      deps: makeSessionDeps({ http, clock: new FakeClock(1_000_000) }),
    });

    await assert.rejects(create().getAccessToken('capsule'), /secure store update failed/);
    await assert.rejects(create().getAccessToken('capsule'), LoginRequiredError);
    assert.equal(reads, 1);
    assert.equal(http.requests.length, 0);
    assert.equal(settings.load()._targets?.primary?.refreshInvalidated, true);
  });

  it('cancels an oversized chunked refresh response and invalidates the family', async () => {
    const oversized = oversizedJsonResponse(64 * 1024);
    const http: HttpTransport = { fetch: async () => oversized.response };
    const fixture = makeSessionManager(http);
    await setRefreshToken(fixture, 'old-refresh-canary');
    await assert.rejects(fixture.value.getAccessToken('capsule'), LoginRequiredError);
    assert.equal(oversized.wasCancelled(), true);
    assert.equal(
      await getRefreshToken(fixture),
      null,
    );
  });
