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

function expectedBinding(options) {
  return Object.freeze({
    descriptor: options.descriptor,
    organizationId: options.organizationId,
    clientRunId: options.identities.clientRunId,
    applyIdempotencyKey: options.identities.applyIdempotencyKey,
    repository: options.setup.repository,
    providerProfile: options.setup.profile,
    model: options.setup.model,
    runtimeImageDigest: options.identities.runtimeImageDigest,
    actorHandle: options.setup.github.account,
  });
}

function grantRequest(expected) {
  return Buffer.from(
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
}

function validateCapability(adapter) {
  const capability = adapter.credentialInstall;
  if (!capability?.supported) {
    throw new InstallProtocolError('target does not advertise sealed credential installation');
  }
  if (!capability.descriptor.sealedEnvelopeAlgorithms.includes(ALGORITHM)) {
    throw new InstallProtocolError('target does not advertise RSA-OAEP-3072-SHA256');
  }
  if (
    capability.descriptor.grant.method !== 'POST' ||
    capability.descriptor.install.method !== 'PUT' ||
    capability.descriptor.uploadUrlOrigin !== 'same_origin'
  ) {
    throw new InstallProtocolError('target credential-install request contract is unsupported');
  }
  return capability;
}

function validateCredentials(credentials) {
  if (
    !Buffer.isBuffer(credentials?.githubToken) ||
    credentials.githubToken.length === 0 ||
    !Buffer.isBuffer(credentials?.openrouterKey) ||
    credentials.openrouterKey.length === 0
  ) {
    credentials?.githubToken?.fill(0);
    credentials?.openrouterKey?.fill(0);
    throw new InstallProtocolError('credential provider returned invalid plaintext buffers');
  }
  return credentials;
}

class SealedInstallClient {
  constructor({ transport = globalThis, clock = Date } = {}) {
    this.transport = transport;
    this.clock = clock;
  }

  preflight(options) {
    const capability = validateCapability(options.adapter);
    const expected = expectedBinding(options);
    routeUrl(options.descriptor, capability.descriptor.grant.routeTemplate, 'preflight-capsule');
    routeUrl(options.descriptor, capability.descriptor.install.routeTemplate, 'preflight-capsule');
    const request = grantRequest(expected);
    try {
      if (request.length > capability.descriptor.bounds.maxBodyBytes) {
        throw new InstallProtocolError('install grant request exceeds the advertised bound');
      }
    } finally {
      request.fill(0);
    }
    return Object.freeze({ capability, expected });
  }

  async install(options) {
    const expected = Object.freeze({
      ...options.preparation.expected,
      capsuleId: options.capsuleId,
    });
    const grant = await this.#acquireGrant(options, expected);
    let credentials;
    try {
      credentials = validateCredentials(await options.credentialProvider());
      return await this.#upload(options, expected, grant, credentials);
    } finally {
      credentials?.githubToken.fill(0);
      credentials?.openrouterKey.fill(0);
    }
  }

  async #acquireGrant(options, expected) {
    const request = grantRequest(expected);
    const capability = options.preparation.capability;
    try {
      const grantUrl = routeUrl(
        expected.descriptor,
        capability.descriptor.grant.routeTemplate,
        options.capsuleId
      );
      const response = await this.#authorizedFetch(
        options,
        grantUrl.href,
        {
          method: 'POST',
          body: request,
          idempotencyKey: options.identities.installIdempotencyKey,
        },
        false
      );
      this.#verifyResponseRoute(response, grantUrl.href);
      if (response.status !== 201) {
        await response.body?.cancel().catch(() => undefined);
        throw new InstallProtocolError(`install grant was refused with status ${response.status}`);
      }
      return parseGrant(
        await readBoundedJson(response, MAX_GRANT_RESPONSE_BYTES),
        expected,
        capability.descriptor,
        this.clock
      );
    } finally {
      request.fill(0);
    }
  }

  async #upload(options, expected, grant, credentials) {
    const ciphertext = this.#buildEnvelope(grant, expected, credentials);
    try {
      const capability = options.preparation.capability;
      if (
        ciphertext.envelope.length > capability.descriptor.bounds.maxEnvelopeBytes ||
        ciphertext.envelope.length > capability.descriptor.bounds.maxBodyBytes
      ) {
        throw new InstallProtocolError('sealed credential envelope exceeds the advertised bound');
      }
      options.onUploadStart?.();
      const response = await this.#authorizedFetch(
        options,
        grant.uploadUrl,
        {
          method: 'PUT',
          body: ciphertext.envelope,
          idempotencyKey: options.identities.installIdempotencyKey,
        },
        true
      );
      return await this.#readReceipt(response, grant, options.capsuleId);
    } finally {
      ciphertext.github.fill(0);
      ciphertext.openrouter.fill(0);
      ciphertext.envelope.fill(0);
    }
  }

  #buildEnvelope(grant, expected, credentials) {
    const github = encryptSecret(
      grant.publicKey,
      grant,
      expected,
      'github_token',
      credentials.githubToken
    );
    const openrouter = encryptSecret(
      grant.publicKey,
      grant,
      expected,
      'openrouter_api_key',
      credentials.openrouterKey
    );
    const envelope = Buffer.from(
      JSON.stringify({
        version: 1,
        grant_id: grant.grantId,
        github_ciphertext: github.toString('base64'),
        openrouter_ciphertext: openrouter.toString('base64'),
      })
    );
    return { github, openrouter, envelope };
  }

  async #readReceipt(response, grant, capsuleId) {
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
  }

  async #authorizedFetch(options, url, request, uncertain) {
    const token = await options.sessionManager.getAccessToken('credential-install', options.signal);
    return this.#fetch(
      url,
      {
        method: request.method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': request.idempotencyKey,
        },
        body: request.body,
        redirect: 'manual',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      uncertain
    );
  }

  async #fetch(url, init, uncertain) {
    try {
      return await this.transport.fetch(url, init);
    } catch (error) {
      if (uncertain) {
        throw new InstallTransportUncertainError(
          'sealed install transport outcome is unknown',
          error
        );
      }
      throw new InstallTransportUncertainError('install grant transport outcome is unknown', error);
    }
  }

  #verifyResponseRoute(response, expectedUrl) {
    if (
      (response.status >= 300 && response.status < 400) ||
      (response.url && response.url !== expectedUrl)
    ) {
      response.body?.cancel().catch(() => undefined);
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
