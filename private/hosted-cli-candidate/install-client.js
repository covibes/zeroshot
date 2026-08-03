'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const ALGORITHM = 'RSA-OAEP-3072-SHA256';
const MAX_GRANT_RESPONSE_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OPAQUE_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

class InstallProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstallProtocolError';
  }
}

class InstallTransportUncertainError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'InstallTransportUncertainError';
  }
}

function record(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InstallProtocolError(`${field} must be an object`);
  }
  return value;
}

function exactKeys(value, field, keys) {
  const object = record(value, field);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new InstallProtocolError(`${field} does not match the closed contract`);
  }
  return object;
}

function requireString(value, field, pattern = OPAQUE_PATTERN) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new InstallProtocolError(`${field} is invalid`);
  }
  return value;
}

function requireDigest(value, field) {
  return requireString(value, field, DIGEST_PATTERN);
}

function canonicalBase64(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) {
    throw new InstallProtocolError(`${field} is invalid`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    bytes.fill(0);
    throw new InstallProtocolError(`${field} is not canonical base64`);
  }
  return bytes;
}

async function readBoundedJson(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new InstallProtocolError('install response body is missing');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      length += chunk.length;
      if (length > maxBytes) {
        chunk.fill(0);
        await reader.cancel().catch(() => undefined);
        throw new InstallProtocolError('install response exceeds the safety bound');
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, length);
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof InstallProtocolError) throw error;
      throw new InstallProtocolError('install response is not valid UTF-8 JSON');
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function routeUrl(descriptor, route, capsuleId) {
  let path;
  try {
    path = route.expand({ capsule_id: capsuleId });
  } catch {
    throw new InstallProtocolError('credential-install route expansion failed');
  }
  const url = new URL(path, descriptor.origin);
  if (url.origin !== descriptor.origin || url.username || url.password || url.search || url.hash) {
    throw new InstallProtocolError('credential-install route changed target authority');
  }
  return url;
}

function parseGrant(value, expected, capability, clock) {
  const grant = exactKeys(value, 'install grant', [
    'version',
    'grant_id',
    'expires_at',
    'algorithm',
    'public_key_spki',
    'public_key_fingerprint',
    'upload_url',
    'binding',
  ]);
  if (grant.version !== 1) throw new InstallProtocolError('install grant version is unsupported');
  const grantId = requireString(grant.grant_id, 'grant_id');
  if (grant.algorithm !== ALGORITHM)
    throw new InstallProtocolError('install grant algorithm is unsupported');
  const expiresAt = Date.parse(grant.expires_at);
  const now = clock.now();
  const maxExpiry =
    now + (capability.bounds.grantTtlSeconds + capability.bounds.maxClockSkewSeconds) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > maxExpiry) {
    throw new InstallProtocolError('install grant expiry is outside the advertised bound');
  }

  const binding = exactKeys(grant.binding, 'install grant binding', [
    'owner_subject',
    'actor_handle',
    'organization_id',
    'capsule_id',
    'client_run_id',
    'apply_idempotency_key',
    'execution',
    'attempt',
    'task_id',
    'runtime_epoch',
    'agent_image_digest',
    'oecp_image_digest',
    'repository',
    'base_revision',
    'provider_profile',
    'model',
    'delivery_mode',
  ]);
  requireString(binding.owner_subject, 'binding.owner_subject');
  requireString(binding.actor_handle, 'binding.actor_handle', /^[A-Za-z0-9-]{1,100}$/);
  requireString(binding.task_id, 'binding.task_id');
  requireString(binding.runtime_epoch, 'binding.runtime_epoch');
  requireString(binding.base_revision, 'binding.base_revision', /^[A-Fa-f0-9]{7,64}$/);
  requireDigest(binding.agent_image_digest, 'binding.agent_image_digest');
  requireDigest(binding.oecp_image_digest, 'binding.oecp_image_digest');
  const comparisons = [
    ['organization_id', expected.organizationId],
    ['capsule_id', expected.capsuleId],
    ['client_run_id', expected.clientRunId],
    ['apply_idempotency_key', expected.applyIdempotencyKey],
    ['repository', expected.repository],
    ['provider_profile', expected.providerProfile],
    ['model', expected.model],
    ['oecp_image_digest', expected.runtimeImageDigest],
  ];
  if (comparisons.some(([field, wanted]) => binding[field] !== wanted)) {
    throw new InstallProtocolError('install grant binding does not match the requested run');
  }
  if (
    binding.execution !== 1 ||
    binding.attempt !== 1 ||
    binding.delivery_mode !== 'pull_request'
  ) {
    throw new InstallProtocolError('install grant execution binding is unsupported');
  }

  const installUrl = routeUrl(
    expected.descriptor,
    capability.install.routeTemplate,
    expected.capsuleId
  );
  let uploadUrl;
  try {
    uploadUrl = new URL(grant.upload_url);
  } catch {
    throw new InstallProtocolError('install grant upload URL is invalid');
  }
  if (
    capability.uploadUrlOrigin !== 'same_origin' ||
    uploadUrl.href !== installUrl.href ||
    uploadUrl.origin !== expected.descriptor.origin ||
    uploadUrl.username ||
    uploadUrl.password ||
    uploadUrl.search ||
    uploadUrl.hash
  ) {
    throw new InstallProtocolError(
      'install grant upload URL does not match the same-origin install route'
    );
  }

  const spki = canonicalBase64(grant.public_key_spki, 'public_key_spki');
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    spki.fill(0);
    throw new InstallProtocolError('install grant public key is invalid');
  }
  const details = publicKey.asymmetricKeyDetails;
  if (publicKey.asymmetricKeyType !== 'rsa' || details?.modulusLength !== 3072) {
    spki.fill(0);
    throw new InstallProtocolError('install grant public key is not RSA-3072');
  }
  const fingerprint = `sha256:${crypto.createHash('sha256').update(spki).digest('hex')}`;
  spki.fill(0);
  if (grant.public_key_fingerprint !== fingerprint) {
    throw new InstallProtocolError('install grant public-key fingerprint mismatch');
  }

  return Object.freeze({
    grantId,
    expiresAt: grant.expires_at,
    uploadUrl: uploadUrl.href,
    publicKey,
    binding: Object.freeze({ ...binding }),
    fingerprint,
  });
}

function encryptSecret(publicKey, grant, expected, kind, secret) {
  if (!Buffer.isBuffer(secret) || secret.length === 0) {
    throw new InstallProtocolError('credential plaintext is missing');
  }
  const plaintext = Buffer.from(
    JSON.stringify({
      version: 1,
      grant_id: grant.grantId,
      capsule_id: expected.capsuleId,
      client_run_id: expected.clientRunId,
      runtime_epoch: grant.binding.runtime_epoch,
      kind,
      value: secret.toString('utf8'),
    }),
    'utf8'
  );
  try {
    return crypto.publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      plaintext
    );
  } catch (error) {
    throw new InstallProtocolError('credential plaintext exceeds the RSA-OAEP-3072-SHA256 bound', {
      cause: error,
    });
  } finally {
    plaintext.fill(0);
  }
}

class SealedInstallClient {
  constructor({ transport = globalThis, clock = Date } = {}) {
    this.transport = transport;
    this.clock = clock;
  }

  async install(options) {
    const {
      adapter,
      descriptor,
      sessionManager,
      credentials,
      identities,
      setup,
      capsuleId,
      organizationId,
    } = options;
    const capability = adapter.credentialInstall;
    if (!capability.supported)
      throw new InstallProtocolError('target does not advertise sealed credential installation');
    if (!capability.descriptor.sealedEnvelopeAlgorithms.includes(ALGORITHM)) {
      throw new InstallProtocolError('target does not advertise RSA-OAEP-3072-SHA256');
    }
    const expected = Object.freeze({
      descriptor,
      capsuleId,
      organizationId,
      clientRunId: identities.clientRunId,
      applyIdempotencyKey: identities.applyIdempotencyKey,
      repository: setup.repository,
      providerProfile: setup.profile,
      model: setup.model,
      runtimeImageDigest: identities.runtimeImageDigest,
    });
    const request = Buffer.from(
      JSON.stringify({
        version: 1,
        client_run_id: expected.clientRunId,
        apply_idempotency_key: expected.applyIdempotencyKey,
        execution: 1,
        attempt: 1,
        repository: expected.repository,
        provider_profile: expected.providerProfile,
        model: expected.model,
        delivery_mode: 'pull_request',
        oecp_image_digest: expected.runtimeImageDigest,
      })
    );
    if (request.length > capability.descriptor.bounds.maxBodyBytes) {
      request.fill(0);
      credentials.githubToken.fill(0);
      credentials.openrouterKey.fill(0);
      throw new InstallProtocolError('install grant request exceeds the advertised bound');
    }

    let grant;
    try {
      const grantUrl = routeUrl(descriptor, capability.descriptor.grant.routeTemplate, capsuleId);
      const token = await sessionManager.getAccessToken('credential-install', options.signal);
      const response = await this.#fetch(
        grantUrl.href,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': identities.installIdempotencyKey,
          },
          body: request,
          redirect: 'manual',
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        false
      );
      this.#verifyResponseRoute(response, grantUrl.href);
      if (response.status !== 201) {
        await response.body?.cancel().catch(() => undefined);
        throw new InstallProtocolError(`install grant was refused with status ${response.status}`);
      }
      grant = parseGrant(
        await readBoundedJson(response, MAX_GRANT_RESPONSE_BYTES),
        expected,
        capability.descriptor,
        this.clock
      );
    } catch (error) {
      credentials.githubToken.fill(0);
      credentials.openrouterKey.fill(0);
      throw error;
    } finally {
      request.fill(0);
    }

    let githubCiphertext;
    let openrouterCiphertext;
    let envelope;
    try {
      githubCiphertext = encryptSecret(
        grant.publicKey,
        grant,
        expected,
        'github_token',
        credentials.githubToken
      );
      openrouterCiphertext = encryptSecret(
        grant.publicKey,
        grant,
        expected,
        'openrouter_api_key',
        credentials.openrouterKey
      );
      envelope = Buffer.from(
        JSON.stringify({
          version: 1,
          grant_id: grant.grantId,
          github_ciphertext: githubCiphertext.toString('base64'),
          openrouter_ciphertext: openrouterCiphertext.toString('base64'),
        })
      );
      if (
        envelope.length > capability.descriptor.bounds.maxEnvelopeBytes ||
        envelope.length > capability.descriptor.bounds.maxBodyBytes
      ) {
        throw new InstallProtocolError('sealed credential envelope exceeds the advertised bound');
      }
      const token = await sessionManager.getAccessToken('credential-install', options.signal);
      options.onUploadStart?.();
      const response = await this.#fetch(
        grant.uploadUrl,
        {
          method: 'PUT',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': identities.installIdempotencyKey,
          },
          body: envelope,
          redirect: 'manual',
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        true
      );
      this.#verifyResponseRoute(response, grant.uploadUrl);
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new InstallProtocolError(`sealed install was refused with status ${response.status}`);
      }
      const receipt = exactKeys(
        await readBoundedJson(response, MAX_GRANT_RESPONSE_BYTES),
        'install receipt',
        ['version', 'grant_id', 'capsule_id', 'receipt_id', 'installed', 'deduped']
      );
      if (
        receipt.version !== 1 ||
        receipt.grant_id !== grant.grantId ||
        receipt.capsule_id !== capsuleId ||
        receipt.installed !== true ||
        typeof receipt.deduped !== 'boolean'
      ) {
        throw new InstallProtocolError('sealed install receipt does not match the grant');
      }
      requireString(receipt.receipt_id, 'receipt_id');
      return Object.freeze({
        grantId: grant.grantId,
        receiptId: receipt.receipt_id,
        deduped: receipt.deduped,
        publicKeyFingerprint: grant.fingerprint,
      });
    } finally {
      credentials.githubToken.fill(0);
      credentials.openrouterKey.fill(0);
      githubCiphertext?.fill(0);
      openrouterCiphertext?.fill(0);
      envelope?.fill(0);
    }
  }

  async #fetch(url, init, uncertain) {
    try {
      return await this.transport.fetch(url, init);
    } catch (error) {
      if (uncertain)
        throw new InstallTransportUncertainError(
          'sealed install transport outcome is unknown',
          error
        );
      throw new InstallTransportUncertainError('install grant transport outcome is unknown', error);
    }
  }

  #verifyResponseRoute(response, expectedUrl) {
    if (
      (response.status >= 300 && response.status < 400) ||
      (response.url && response.url !== expectedUrl)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new InstallProtocolError(
        'credential-install redirects and route changes are forbidden'
      );
    }
  }
}

module.exports = {
  ALGORITHM,
  InstallProtocolError,
  InstallTransportUncertainError,
  SealedInstallClient,
  encryptSecret,
  parseGrant,
  readBoundedJson,
};
