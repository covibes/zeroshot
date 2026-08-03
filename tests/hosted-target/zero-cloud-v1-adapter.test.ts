import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  discoverTarget,
  TargetDiscoveryError,
  type HttpTransport,
} from '../helpers/target-runtime.mjs';

const FIXTURES = resolve('tests/fixtures/zero-cloud-44/contracts/http/hosted-target/fixtures');

interface Fixture {
  readonly schema: string;
  readonly body: Record<string, unknown>;
}

function fixture(path: string): Fixture {
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

function discoveryFixtures(kind: 'valid' | 'invalid'): Array<{ name: string; value: Fixture }> {
  const directory = join(FIXTURES, kind);
  return readdirSync(directory)
    .filter((name) => name.startsWith('hosted-target-v1-'))
    .map((name) => ({ name, value: fixture(join(directory, name)) }));
}

function transport(document: Record<string, unknown>): { http: HttpTransport; requests: string[] } {
  const requests: string[] = [];
  const oauthValue = document.oauth;
  const oauth = oauthValue !== null && typeof oauthValue === 'object' && !Array.isArray(oauthValue)
    ? oauthValue as Record<string, unknown>
    : {};
  const metadata = {
    device_authorization_endpoint: oauth.device_authorization_endpoint,
    token_endpoint: oauth.token_endpoint,
    revocation_endpoint: oauth.revocation_endpoint,
  };
  const bodies = [document, metadata];
  return {
    requests,
    http: {
      async fetch(url, init) {
        requests.push(url);
        assert.equal(init.redirect, 'error');
        const body = bodies.shift();
        if (body === undefined) throw new Error('unexpected discovery side effect');
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  };
}

describe('Zero Cloud #44 hosted-target discovery fixtures', () => {
  for (const { name, value } of discoveryFixtures('valid')) {
    it(`accepts ${name}`, async () => {
      const { http } = transport(value.body);
      const descriptor = await discoverTarget('https://hosted.openengine.example', http);
      assert.equal(descriptor.origin, 'https://hosted.openengine.example');
      assert.equal(descriptor.oauth.audience, 'capsule');
      assert.equal(descriptor.capsule.routes.inspect.expand({
        org_id: 'org/raw value',
        capsule_id: 'cap/raw value',
      }).includes('org%2Fraw%20value'), true);
      assert.equal(descriptor.credentialInstall !== null, name.includes('credential-install-present'));
    });
  }

  for (const { name, value } of discoveryFixtures('invalid')) {
    it(`rejects ${name} before post-discovery side effects`, async () => {
      const { http, requests } = transport(value.body);
      await assert.rejects(
        discoverTarget('https://hosted.openengine.example', http),
        TargetDiscoveryError,
      );
      assert.ok(requests.length <= 2);
    });
  }

  it('rejects OAuth metadata authority disagreement', async () => {
    const minimal = discoveryFixtures('valid').find(({ name }) => name === 'hosted-target-v1-minimal.json');
    assert.ok(minimal);
    const oauth = minimal.value.body.oauth as Record<string, unknown>;
    const bodies = [minimal.value.body, {
      device_authorization_endpoint: oauth.device_authorization_endpoint,
      token_endpoint: 'https://hosted.openengine.example/auth/other-token',
      revocation_endpoint: oauth.revocation_endpoint,
    }];
    const http: HttpTransport = {
      async fetch() {
        return new Response(JSON.stringify(bodies.shift()), { status: 200 });
      },
    };
    await assert.rejects(discoverTarget('https://hosted.openengine.example', http), /OAuth metadata/);
  });
});
