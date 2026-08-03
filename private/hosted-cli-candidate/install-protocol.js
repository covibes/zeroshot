'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { URL } = require('node:url');

const ALGORITHM = 'RSA-OAEP-3072-SHA256';
const MAX_GRANT_RESPONSE_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OPAQUE_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

class InstallProtocolError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'InstallProtocolError';
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
  let routePath;
  try {
    routePath = route.expand({ capsule_id: capsuleId });
  } catch {
    throw new InstallProtocolError('credential-install route expansion failed');
  }
  const url = new URL(routePath, descriptor.origin);
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
    ['actor_handle', expected.actorHandle],
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

function encodeCredentialPlaintext(grant, expected, kind, secret) {
  if (!Buffer.isBuffer(secret) || secret.length === 0) {
    throw new InstallProtocolError('credential plaintext is missing');
  }
  if (kind !== 'github_token' && kind !== 'openrouter_api_key') {
    throw new InstallProtocolError('credential plaintext kind is unsupported');
  }
  let escapedBytes = 0;
  for (const byte of secret) {
    if (byte < 0x20 || byte > 0x7e) {
      throw new InstallProtocolError('credential plaintext must be printable ASCII');
    }
    escapedBytes += byte === 0x22 || byte === 0x5c ? 2 : 1;
  }
  const skeleton = JSON.stringify({
    version: 1,
    grant_id: grant.grantId,
    capsule_id: expected.capsuleId,
    client_run_id: expected.clientRunId,
    runtime_epoch: grant.binding.runtime_epoch,
    kind,
    value: '',
  });
  if (!skeleton.endsWith('"}')) {
    throw new InstallProtocolError('credential plaintext encoding failed');
  }
  const prefix = Buffer.from(skeleton.slice(0, -2), 'utf8');
  const plaintext = Buffer.allocUnsafe(prefix.length + escapedBytes + 2);
  let offset = prefix.copy(plaintext);
  for (const byte of secret) {
    if (byte === 0x22 || byte === 0x5c) plaintext[offset++] = 0x5c;
    plaintext[offset++] = byte;
  }
  plaintext[offset++] = 0x22;
  plaintext[offset] = 0x7d;
  prefix.fill(0);
  return plaintext;
}

function encryptSecret(publicKey, grant, expected, kind, secret) {
  const plaintext = encodeCredentialPlaintext(grant, expected, kind, secret);
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

module.exports = {
  ALGORITHM,
  InstallProtocolError,
  MAX_GRANT_RESPONSE_BYTES,
  encryptSecret,
  encodeCredentialPlaintext,
  exactKeys,
  parseGrant,
  readBoundedJson,
  requireString,
  routeUrl,
};
