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

function validDiscoveryFixture(name: string): Record<string, unknown> {
  const value = discoveryFixtures('valid').find((fixtureValue) => fixtureValue.name === name);
  assert.ok(value);
  return value.value.body;
}

function transport(document: Record<string, unknown>): { http: HttpTransport; requests: string[] } {
  const requests: string[] = [];
  const oauthValue = document.oauth;
  const oauth =
    oauthValue !== null && typeof oauthValue === 'object' && !Array.isArray(oauthValue)
      ? (oauthValue as Record<string, unknown>)
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
      assert.equal(
        descriptor.capsule.routes.inspect
          .expand({
            org_id: 'org/raw value',
            capsule_id: 'cap/raw value',
          })
          .includes('org%2Fraw%20value'),
        true
      );
    });
  }

  for (const { name, value } of discoveryFixtures('invalid').filter(
    ({ name }) => !name.includes('credential-install')
  )) {
    it(`rejects ${name} before post-discovery side effects`, async () => {
      const { http, requests } = transport(value.body);
      await assert.rejects(
        discoverTarget('https://hosted.openengine.example', http),
        TargetDiscoveryError
      );
      assert.ok(requests.length <= 2);
    });
  }

  it('rejects OAuth metadata authority disagreement', async () => {
    const minimal = validDiscoveryFixture('hosted-target-v1-minimal.json');
    const oauth = minimal.oauth as Record<string, unknown>;
    const bodies = [
      minimal,
      {
        device_authorization_endpoint: oauth.device_authorization_endpoint,
        token_endpoint: 'https://hosted.openengine.example/auth/other-token',
        revocation_endpoint: oauth.revocation_endpoint,
      },
    ];
    const http: HttpTransport = {
      async fetch() {
        return new Response(JSON.stringify(bodies.shift()), { status: 200 });
      },
    };
    await assert.rejects(
      discoverTarget('https://hosted.openengine.example', http),
      /OAuth metadata/
    );
  });

  it('accepts only same-origin closed RunIntent v2 routes', async () => {
    const document = structuredClone(
      validDiscoveryFixture('hosted-target-v1-credential-install-absent.json')
    );
    const extensions = document.extensions as Record<string, unknown>;
    extensions.run_intent = {
      kind: 'zeroshot.run-intent/v2',
      base_url: 'https://hosted.openengine.example/api/v1',
      route_templates: {
        submit: '/orgs/{org_id}/run-intents',
        status: '/orgs/{org_id}/run-intents/{intent_id}',
        cancel: '/orgs/{org_id}/run-intents/{intent_id}',
      },
    };
    const descriptor = await discoverTarget(
      'https://hosted.openengine.example',
      transport(document).http
    );
    assert.equal(descriptor.runIntent?.baseUrl, 'https://hosted.openengine.example/api/v1');
    assert.equal(
      descriptor.runIntent?.routes.status.expand({
        org_id: 'org/raw',
        intent_id: 'intent/raw',
      }),
      '/orgs/org%2Fraw/run-intents/intent%2Fraw'
    );

    const unsafe = structuredClone(document);
    const unsafeExtension = (unsafe.extensions as Record<string, unknown>).run_intent as Record<
      string,
      unknown
    >;
    unsafeExtension.base_url = 'https://attacker.example/api/v1';
    await assert.rejects(
      discoverTarget('https://hosted.openengine.example', transport(unsafe).http),
      TargetDiscoveryError
    );
  });
});

describe('hosted target capability discovery', () => {
  it('ignores extensions the CLI does not support', async () => {
    const document = structuredClone(
      validDiscoveryFixture('hosted-target-v1-credential-install-absent.json')
    );
    const extensions = document.extensions as Record<string, unknown>;
    extensions.credential_install = {
      malformed: 'unsupported capability payload',
    };
    extensions.future_capability = { authority: 'https://attacker.example' };
    const descriptor = await discoverTarget(
      'https://hosted.openengine.example',
      transport(document).http
    );
    assert.equal(descriptor.runIntent, null);
    assert.equal(Object.hasOwn(descriptor, 'credentialInstall'), false);

    const future = structuredClone(document);
    (future.extensions as Record<string, unknown>).run_intent = {
      kind: 'zeroshot.run-intent/v3',
      arbitrary_future_contract: true,
    };
    const futureDescriptor = await discoverTarget(
      'https://hosted.openengine.example',
      transport(future).http
    );
    assert.equal(futureDescriptor.runIntent, null);
  });
});
