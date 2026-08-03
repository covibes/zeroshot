'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { before, describe, it } = require('node:test');
const {
  InstallProtocolError,
  SealedInstallClient,
} = require('../../private/hosted-cli-candidate/install-client');

const RUNTIME_DIGEST = `sha256:${'a'.repeat(64)}`;
const AGENT_DIGEST = `sha256:${'b'.repeat(64)}`;
let privateKey;
let publicSpki;
let fingerprint;

before(() => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
  privateKey = pair.privateKey;
  publicSpki = pair.publicKey.export({ type: 'spki', format: 'der' });
  fingerprint = `sha256:${crypto.createHash('sha256').update(publicSpki).digest('hex')}`;
});

function route(template) {
  return {
    expand: ({ capsule_id: capsuleId }) =>
      template.replace('{capsule_id}', encodeURIComponent(capsuleId)),
  };
}

function contract() {
  const descriptor = {
    origin: 'https://target.example',
  };
  const installDescriptor = {
    kind: 'openengine.capsule-credential-install/v1',
    grant: { routeTemplate: route('/capsules/{capsule_id}/credential-grants'), method: 'POST' },
    install: { routeTemplate: route('/capsules/{capsule_id}/credentials'), method: 'PUT' },
    uploadUrlOrigin: 'same_origin',
    sealedEnvelopeAlgorithms: ['RSA-OAEP-3072-SHA256'],
    bounds: {
      maxEnvelopeBytes: 16384,
      maxBodyBytes: 16384,
      grantTtlSeconds: 300,
      maxClockSkewSeconds: 60,
    },
  };
  return {
    descriptor,
    adapter: { credentialInstall: { supported: true, descriptor: installDescriptor } },
    installDescriptor,
  };
}

function grant(overrides = {}) {
  return {
    version: 1,
    grant_id: 'grant1',
    expires_at: '2026-08-03T00:04:00.000Z',
    algorithm: 'RSA-OAEP-3072-SHA256',
    public_key_spki: publicSpki.toString('base64'),
    public_key_fingerprint: fingerprint,
    upload_url: 'https://target.example/capsules/cap1/credentials',
    binding: {
      owner_subject: 'owner:1',
      actor_handle: 'octocat',
      organization_id: 'org1',
      capsule_id: 'cap1',
      client_run_id: 'run1',
      apply_idempotency_key: 'apply1',
      execution: 1,
      attempt: 1,
      task_id: 'task1',
      runtime_epoch: 'epoch1',
      agent_image_digest: AGENT_DIGEST,
      oecp_image_digest: RUNTIME_DIGEST,
      repository: 'github.com/owner/repo',
      base_revision: 'abcdef1234567890',
      provider_profile: 'provider.codex-openrouter-pr@1',
      model: 'openai/gpt-5.2-codex',
      delivery_mode: 'pull_request',
    },
    ...overrides,
  };
}

function options(credentials) {
  const { descriptor, adapter } = contract();
  return {
    descriptor,
    adapter,
    sessionManager: {
      async getAccessToken(audience) {
        assert.equal(audience, 'credential-install');
        return 'access-token';
      },
    },
    credentials,
    identities: {
      clientRunId: 'run1',
      applyIdempotencyKey: 'apply1',
      installIdempotencyKey: 'install1',
      runtimeImageDigest: RUNTIME_DIGEST,
    },
    setup: {
      repository: 'github.com/owner/repo',
      profile: 'provider.codex-openrouter-pr@1',
      model: 'openai/gpt-5.2-codex',
    },
    capsuleId: 'cap1',
    organizationId: 'org1',
  };
}

function response(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('sealed credential install', () => {
  it('verifies binding/key/route, uploads one ciphertext envelope, and zeroes plaintexts', async () => {
    const github = Buffer.from('gh-canary-884');
    const openrouter = Buffer.from('or-canary-884');
    const calls = [];
    const transport = {
      async fetch(url, init) {
        calls.push({
          url,
          method: init.method,
          headers: { ...init.headers },
          body: Buffer.from(init.body),
        });
        if (calls.length === 1) return response(grant(), 201);
        return response(
          {
            version: 1,
            grant_id: 'grant1',
            capsule_id: 'cap1',
            receipt_id: 'receipt1',
            installed: true,
            deduped: false,
          },
          200
        );
      },
    };
    let uploadStarts = 0;
    const result = await new SealedInstallClient({
      transport,
      clock: { now: () => Date.parse('2026-08-03T00:00:00Z') },
    }).install({
      ...options({ githubToken: github, openrouterKey: openrouter }),
      onUploadStart: () => {
        uploadStarts += 1;
      },
    });
    assert.equal(result.receiptId, 'receipt1');
    assert.equal(uploadStarts, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((call) => [call.method, call.url]),
      [
        ['POST', 'https://target.example/capsules/cap1/credential-grants'],
        ['PUT', 'https://target.example/capsules/cap1/credentials'],
      ]
    );
    const transcript = Buffer.concat(calls.map((call) => call.body)).toString('utf8');
    assert.equal(transcript.includes('gh-canary-884'), false);
    assert.equal(transcript.includes('or-canary-884'), false);
    const envelope = JSON.parse(calls[1].body.toString('utf8'));
    assert.deepEqual(Object.keys(envelope).sort(), [
      'github_ciphertext',
      'grant_id',
      'openrouter_ciphertext',
      'version',
    ]);
    const decrypt = (ciphertext) =>
      JSON.parse(
        crypto
          .privateDecrypt(
            {
              key: privateKey,
              padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: 'sha256',
            },
            Buffer.from(ciphertext, 'base64')
          )
          .toString('utf8')
      );
    assert.equal(decrypt(envelope.github_ciphertext).value, 'gh-canary-884');
    assert.equal(decrypt(envelope.openrouter_ciphertext).value, 'or-canary-884');
    assert.ok(github.every((byte) => byte === 0));
    assert.ok(openrouter.every((byte) => byte === 0));
    for (const call of calls) call.body.fill(0);
  });

  it('rejects a fingerprint mismatch before upload and still zeroes both secret buffers', async () => {
    const github = Buffer.from('github-secret');
    const openrouter = Buffer.from('openrouter-secret');
    let calls = 0;
    const client = new SealedInstallClient({
      transport: {
        async fetch() {
          calls += 1;
          return response(grant({ public_key_fingerprint: `sha256:${'0'.repeat(64)}` }), 201);
        },
      },
      clock: { now: () => Date.parse('2026-08-03T00:00:00Z') },
    });
    await assert.rejects(
      client.install(options({ githubToken: github, openrouterKey: openrouter })),
      InstallProtocolError
    );
    assert.equal(calls, 1);
    assert.ok(github.every((byte) => byte === 0));
    assert.ok(openrouter.every((byte) => byte === 0));
  });

  it('rejects expired and wrong-runtime grants before any ciphertext upload', async () => {
    for (const bad of [
      { expires_at: '2026-08-02T23:59:59.000Z' },
      { binding: { ...grant().binding, oecp_image_digest: `sha256:${'c'.repeat(64)}` } },
    ]) {
      let calls = 0;
      const client = new SealedInstallClient({
        transport: {
          async fetch() {
            calls += 1;
            return response(grant(bad), 201);
          },
        },
        clock: { now: () => Date.parse('2026-08-03T00:00:00Z') },
      });
      await assert.rejects(
        client.install(
          options({
            githubToken: Buffer.from('github'),
            openrouterKey: Buffer.from('openrouter'),
          })
        ),
        InstallProtocolError
      );
      assert.equal(calls, 1);
    }
  });
});
