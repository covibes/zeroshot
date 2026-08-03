import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { discoverTargetSessionEndpoints, TargetDiscoveryError } from '../../src/target/discovery.ts';
import type { HttpTransport } from '../../src/target/device-flow.ts';

const fixture = JSON.parse(readFileSync(resolve(
  'tests/fixtures/zero-cloud-44/contracts/http/hosted-target/fixtures/valid/hosted-target-v1-minimal.json',
), 'utf8')) as { body: Record<string, unknown> };
const networkPathFixture = JSON.parse(readFileSync(resolve(
  'tests/fixtures/zero-cloud-44/contracts/http/hosted-target/fixtures/invalid/hosted-target-v1-network-path-routes.json',
), 'utf8')) as { body: Record<string, unknown> };

function successfulTransport(): HttpTransport {
  const oauth = fixture.body.oauth as Record<string, unknown>;
  const responses = [fixture.body, {
    device_authorization_endpoint: oauth.device_authorization_endpoint,
    token_endpoint: oauth.token_endpoint,
    revocation_endpoint: oauth.revocation_endpoint,
  }];
  return {
    async fetch() {
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    },
  };
}

describe('target discovery bootstrap', () => {
  it('returns the complete server-validated session and capsule descriptor', async () => {
    const result = await discoverTargetSessionEndpoints(
      'https://hosted.openengine.example',
      successfulTransport(),
    );
    assert.equal(result.audience, 'capsule');
    assert.equal(result.sessionEndpoint, 'https://hosted.openengine.example/target-session');
    assert.equal(result.descriptor.capsule.routes.access.expand({ capsule_id: 'cap/raw' }), '/capsules/cap%2Fraw/access');
    assert.equal(
      result.descriptor.capsule.routes.list.expand({
        org_id: 'org',
        cursor: 'opaque cursor~',
        limit: 10,
      }),
      '/orgs/org/capsules?cursor=opaque%20cursor~&limit=10',
    );
    assert.throws(
      () => result.descriptor.capsule.routes.terminate.expand({ org_id: 'org', capsule_id: '..' }),
      /structural dot segment/,
    );
  });

  it('bounds the discovery response before parsing', async () => {
    const http: HttpTransport = {
      async fetch() {
        return new Response('{}', {
          status: 200,
          headers: { 'content-length': String(64 * 1024 + 1) },
        });
      },
    };
    await assert.rejects(
      discoverTargetSessionEndpoints('https://hosted.openengine.example', http),
      TargetDiscoveryError,
    );
  });

  it('cancels a chunked discovery body as soon as its cumulative bound is exceeded', async () => {
    let cancelled = false;
    const http: HttpTransport = {
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
      discoverTargetSessionEndpoints('https://hosted.openengine.example', http),
      /size limit/,
    );
    assert.equal(cancelled, true);
  });

  it('rejects the frozen network-path route fixture before OAuth metadata dispatch', async () => {
    let requests = 0;
    const http: HttpTransport = {
      async fetch() {
        requests += 1;
        return new Response(JSON.stringify(networkPathFixture.body), { status: 200 });
      },
    };
    await assert.rejects(
      discoverTargetSessionEndpoints('https://hosted.openengine.example', http),
      /safe relative route template/,
    );
    assert.equal(requests, 1);
  });

  it('rejects a changed response authority', async () => {
    const response = new Response(JSON.stringify(fixture.body), { status: 200 });
    Object.defineProperty(response, 'url', { value: 'https://attacker.example/discovery' });
    const http: HttpTransport = { fetch: async () => response };
    await assert.rejects(
      discoverTargetSessionEndpoints('https://hosted.openengine.example', http),
      /changed target route or authority/,
    );
  });
});
