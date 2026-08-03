import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createTargetAdapter } from '../../src/hosted-target/target-adapter.ts';
import { discoverTarget } from '../../src/target/discovery.ts';
import { TargetSessionManager } from '../../src/target/target-session.ts';
import {
  FakeBrowserOpener,
  FakeClock,
  FakeCredentialStore,
  FakeHttpTransport,
  FakeStderr,
  fakeLock,
  makeSettingsPort,
  makeTarget,
  respond,
} from '../target/harness.ts';

const require = createRequire(resolve('tests/hosted-target/vertical.test.ts'));
const { HostedSessionCoordinator } = require('../../lib/hosted-session/index.cjs') as {
  HostedSessionCoordinator: new (init: Record<string, unknown>) => {
    open(): Promise<{
      connection: { close(): Promise<void> };
      initializeResult: { status: unknown };
    }>;
    close(): Promise<void>;
  };
};
const { FakeWebSocket, settle } = require('../cluster/harness') as {
  FakeWebSocket: new () => {
    request(method: string): { id: string } | undefined;
    respond(id: string, result: unknown): void;
  };
  settle(): Promise<void>;
};

async function waitForRequest(
  socket: InstanceType<typeof FakeWebSocket>,
  method: string
): Promise<{ id: string }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const request = socket.request(method);
    if (request) return request;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${method}`);
}

const discoveryFixture = JSON.parse(
  readFileSync(
    resolve(
      'tests/fixtures/zero-cloud-44/contracts/http/hosted-target/fixtures/valid/hosted-target-v1-minimal.json'
    ),
    'utf8'
  )
) as { body: Record<string, unknown> };

function capsule(state = 'ready') {
  return {
    capsule_id: 'capsule-a',
    state,
    label: null,
    created_at: '2026-08-03T00:00:00Z',
  };
}

describe('descriptor-driven hosted client vertical', () => {
  it('completes discovery, verified login, capsule lifecycle, access, and initialize', async () => {
    const http = new FakeHttpTransport();
    const oauth = discoveryFixture.body.oauth as Record<string, string>;
    http.enqueue(respond(200, discoveryFixture.body));
    http.enqueue(
      respond(200, {
        device_authorization_endpoint: oauth.device_authorization_endpoint,
        token_endpoint: oauth.token_endpoint,
        revocation_endpoint: oauth.revocation_endpoint,
      })
    );
    const descriptor = await discoverTarget('https://hosted.openengine.example', http);

    const target = makeTarget({ id: 'target-vertical', url: descriptor.origin });
    const settings = makeSettingsPort({ _targets: { primary: target } });
    const store = new FakeCredentialStore();
    http.enqueue(
      respond(200, {
        device_code: 'device-code',
        user_code: 'USER-CODE',
        verification_uri: 'https://hosted.openengine.example/activate',
        expires_in: 900,
        interval: 0,
      })
    );
    http.enqueue(
      respond(200, {
        access_token: 'capsule-audience-token',
        refresh_token: 'refresh-family-token',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );
    http.enqueue(
      respond(200, {
        kind: 'openengine.target-session/v1',
        organization_id: 'org/opaque',
      })
    );
    const manager = new TargetSessionManager({
      targetName: 'primary',
      target,
      credentialStore: store,
      acquireLock: fakeLock(),
      settings,
      deps: {
        http,
        clock: new FakeClock(1_000_000),
        browserOpener: new FakeBrowserOpener(),
        stderr: new FakeStderr(),
        discoveryEndpoints: {
          deviceAuthorizationEndpoint: descriptor.oauth.deviceAuthorizationEndpoint,
          tokenEndpoint: descriptor.oauth.tokenEndpoint,
          revocationEndpoint: descriptor.oauth.revocationEndpoint,
          clientId: descriptor.oauth.clientId,
          deviceGrantType: descriptor.oauth.deviceGrantType,
          audience: descriptor.oauth.audience,
          sessionEndpoint: new URL(descriptor.session.routeTemplate.template, descriptor.origin)
            .href,
          descriptor,
        },
      },
    });
    const login = await manager.login();
    assert.deepEqual(login.organization, { id: 'org/opaque' });

    const adapter = createTargetAdapter({
      descriptor,
      organization: login.organization,
      tokenProvider: manager.tokenProvider('capsule'),
      transport: http,
      retryPolicy: { shouldRetry: () => ({ retry: false, delayMs: 0 }) },
    });
    http.enqueue(respond(201, capsule('provisioning')));
    http.enqueue(respond(200, { capsules: [capsule()], next_cursor: null }));
    http.enqueue(respond(200, capsule()));
    http.enqueue(respond(200, { active_capsules: 1, max_active_capsules: null }));
    http.enqueue(
      respond(200, {
        protocol: 'openengine.cluster/v1',
        websocket_url: 'wss://hosted.openengine.example/v1/capsules/capsule-a/oecp',
        access_token: 'oecp-grant-one',
        token_type: 'Bearer',
        expires_at: '2099-08-03T00:00:00Z',
      })
    );
    http.enqueue(respond(202, capsule('terminating')));

    assert.equal((await adapter.allocate({ idempotencyKey: 'vertical-1' })).state, 'provisioning');
    assert.equal((await adapter.list()).capsules.length, 1);
    assert.equal((await adapter.inspect('capsule-a')).state, 'ready');
    assert.equal((await adapter.limits()).maxActiveCapsules, null);
    assert.equal((await adapter.access('capsule-a')).accessToken, 'oecp-grant-one');
    assert.equal((await adapter.terminate('capsule-a')).state, 'terminating');

    http.enqueue(
      respond(200, {
        protocol: 'openengine.cluster/v1',
        websocket_url: 'wss://hosted.openengine.example/v1/capsules/capsule-a/oecp',
        access_token: 'oecp-grant-two',
        token_type: 'Bearer',
        expires_at: '2099-08-03T00:00:00Z',
      })
    );
    const socket = new FakeWebSocket();
    const coordinator = new HostedSessionCoordinator({
      adapter,
      capsuleId: 'capsule-a',
      targetAuthority: descriptor.origin,
      connectOptions: { webSocketFactory: () => socket },
    });
    const opening = coordinator.open();
    await settle();
    const initialize = await waitForRequest(socket, 'initialize');
    socket.respond(initialize.id, {
      protocolVersion: 'openengine.cluster/v1',
      capabilities: { logs: true, agentAttach: true, graphProfiles: ['openengine.graph.full/v1'] },
      status: { phase: 'running' },
    });
    const session = await opening;
    assert.deepEqual(session.initializeResult.status, { phase: 'running' });
    await coordinator.close();

    const accessRequests = http.requests.filter((request) =>
      request.url.endsWith('/capsules/capsule-a/access')
    );
    assert.equal(accessRequests.length, 2);
    assert.equal(
      accessRequests.every(
        (request) => request.headers.Authorization === 'Bearer capsule-audience-token'
      ),
      true
    );
  });
});
