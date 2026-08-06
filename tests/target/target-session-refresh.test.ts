import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LoginRequiredError } from '../helpers/target-runtime.mjs';
import { FakeHttpTransport } from './harness.mjs';
import { enqueueToken } from './response-fixtures.mjs';
import {
  getRefreshToken,
  makeSessionManager,
  setRefreshToken,
} from './session-harness.mjs';

  it('rotates one refresh family under the requested audience and caches only that audience', async () => {
    const http = new FakeHttpTransport();
    const fixture = makeSessionManager(http);
    await setRefreshToken(fixture, 'old-refresh');
    enqueueToken(http, { access_token: 'admin-access', refresh_token: 'new-refresh' });

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
      await getRefreshToken(fixture),
      'new-refresh'
    );
  });

  it('clears durable refresh state after a dispatched malformed exchange', async () => {
    const http = new FakeHttpTransport();
    const fixture = makeSessionManager(http);
    await setRefreshToken(fixture, 'old-refresh');
    enqueueToken(http, { access_token: 'access', refresh_token: 'replacement', token_type: 'bearer' });

    await assert.rejects(fixture.value.getAccessToken('capsule'), LoginRequiredError);
    assert.equal(
      await getRefreshToken(fixture),
      null
    );
  });

  it('deletes the old family after a post-dispatch ambiguous refresh', async () => {
    const http = new (class extends FakeHttpTransport {
      override async fetch(
        url: string,
        init: RequestInit & { redirect: 'error' | 'manual' }
      ): Promise<Response> {
        await super.fetch(url, init);
        throw new Error('connection reset after request dispatch');
      }
    })();
    enqueueToken(http, { access_token: 'unobservable', refresh_token: 'possibly-spent' });
    const fixture = makeSessionManager(http);
    await setRefreshToken(fixture, 'old-refresh-canary');

    await assert.rejects(fixture.value.getAccessToken('capsule'), LoginRequiredError);
    assert.equal(
      await getRefreshToken(fixture),
      null
    );
  });
