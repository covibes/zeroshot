import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverTargetSessionEndpoints,
  TargetDiscoveryError,
} from '../../src/target/discovery.ts';
import { FakeHttpTransport, respond } from './harness.ts';

function hostedDiscovery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'openengine.hosted-target/v1',
    organization_binding: 'device_approval',
    capsule_protocol: {
      name: 'openengine.capsules/v1',
      major_version: 1,
      base_url: 'https://api.test.example/api/v1',
    },
    oauth: {
      metadata_url: 'https://api.test.example/.well-known/openid-configuration',
      device_authorization_endpoint: 'https://api.test.example/oauth/device',
      token_endpoint: 'https://api.test.example/oauth/token',
      client_id: 'cli',
    },
    ...overrides,
  };
}

function oauthMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_authorization_endpoint: 'https://api.test.example/oauth/device',
    token_endpoint: 'https://api.test.example/oauth/token',
    revocation_endpoint: 'https://api.test.example/oauth/revoke',
    ...overrides,
  };
}

describe('target session discovery', () => {
  it('resolves advertised OAuth endpoints without posting to either discovery document', async () => {
    const http = new FakeHttpTransport();
    http.enqueue(respond(200, hostedDiscovery()));
    http.enqueue(respond(200, oauthMetadata()));

    const endpoints = await discoverTargetSessionEndpoints('https://api.test.example', http);

    assert.deepEqual(endpoints, {
      deviceAuthorizationEndpoint: 'https://api.test.example/oauth/device',
      tokenEndpoint: 'https://api.test.example/oauth/token',
      revocationEndpoint: 'https://api.test.example/oauth/revoke',
      clientId: 'cli',
      capsuleApiBaseUrl: 'https://api.test.example/api/v1',
    });
    assert.deepEqual(
      http.requests.map(({ url, method }) => ({ url, method })),
      [
        {
          url: 'https://api.test.example/.well-known/openengine-hosted-target',
          method: 'GET',
        },
        {
          url: 'https://api.test.example/.well-known/openid-configuration',
          method: 'GET',
        },
      ]
    );
  });

  it('rejects endpoints that leave the configured target origin', async () => {
    const http = new FakeHttpTransport();
    http.enqueue(
      respond(
        200,
        hostedDiscovery({
          oauth: {
            metadata_url: 'https://api.test.example/.well-known/openid-configuration',
            device_authorization_endpoint: 'https://attacker.example/oauth/device',
            token_endpoint: 'https://api.test.example/oauth/token',
            client_id: 'cli',
          },
        })
      )
    );

    await assert.rejects(
      discoverTargetSessionEndpoints('https://api.test.example', http),
      (error: unknown) =>
        error instanceof TargetDiscoveryError &&
        error.message.includes('must remain on the target origin')
    );
    assert.equal(http.requests.length, 1);
  });

  it('rejects OAuth metadata that disagrees with hosted-target discovery', async () => {
    const http = new FakeHttpTransport();
    http.enqueue(respond(200, hostedDiscovery()));
    http.enqueue(
      respond(200, oauthMetadata({ token_endpoint: 'https://api.test.example/oauth/other-token' }))
    );

    await assert.rejects(
      discoverTargetSessionEndpoints('https://api.test.example', http),
      (error: unknown) =>
        error instanceof TargetDiscoveryError && error.message.includes('does not match')
    );
  });

  it('bounds discovery responses before parsing them', async () => {
    const http = new FakeHttpTransport();
    http.enqueue({
      status: 200,
      body: '{}',
      headers: { 'Content-Length': String(64 * 1024 + 1) },
    });

    await assert.rejects(discoverTargetSessionEndpoints('https://api.test.example', http), {
      name: 'TargetDiscoveryError',
      message: 'Target discovery failed: response exceeds the size limit',
    });
  });
});
