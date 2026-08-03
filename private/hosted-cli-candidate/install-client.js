'use strict';

const {
  ALGORITHM,
  InstallProtocolError,
  MAX_GRANT_RESPONSE_BYTES,
  encryptSecret,
  exactKeys,
  parseGrant,
  readBoundedJson,
  requireString,
  routeUrl,
} = require('./install-protocol');

class InstallTransportUncertainError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'InstallTransportUncertainError';
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
