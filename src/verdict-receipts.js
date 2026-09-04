/**
 * Signed validator verdicts.
 *
 * Validator verdicts are the one record in the ledger that a third party may
 * later be asked to rely on: "was this change independently validated before it
 * shipped?" Today they are rows in SQLite, so anyone who can write the database
 * can rewrite the answer after the fact.
 *
 * This module signs the verdict at the moment it is recorded and chains each
 * receipt to its predecessor, so that editing, deleting, or reordering verdicts
 * is detectable by someone who has only the exported receipts and a published
 * keyring.
 *
 * Three properties the design deliberately has:
 *
 * 1. Provider independence. Signing happens in the ledger write path, so it
 *    behaves identically whether the agent backend is Claude Code, Codex,
 *    Gemini, or a local model. Nothing here depends on a hook mechanism owned
 *    by one vendor.
 * 2. Explicit key trust and rotation. Keys live in a keyring document with
 *    validity windows and revocation. A verifier resolves the key named by the
 *    receipt and checks the receipt falls inside that key's window. Rotation
 *    does not invalidate history, and revocation does not retroactively void
 *    verdicts signed while the key was trusted.
 * 3. Offline verification. Verification needs the receipts and the keyring and
 *    nothing else. No running Zeroshot instance, no network, no vendor service.
 *
 * What a valid receipt establishes: this verdict, with exactly these fields,
 * was signed by the holder of this key at this time, and the verdict sequence
 * has not been altered since.
 *
 * What it does not establish: that the verdict was correct, that the validator
 * was competent or genuinely blind, or that a machine compromised at signing
 * time produced honest verdicts. Signing binds authorship and order. It does
 * not confer judgement.
 *
 * Uses only node:crypto. No new dependencies.
 */

const crypto = require('node:crypto');

const RECEIPT_TYPE = 'zeroshot.validator_verdict_receipt.v1';
const KEYRING_TYPE = 'zeroshot.verdict_keyring.v1';
const SIGNING_ALG = 'Ed25519';

/** Domain separation. A signature over one kind of object must never verify as another. */
const SIGNING_DOMAIN = 'zeroshot/validator-verdict/v1';

/**
 * Deterministic JSON serialization.
 *
 * Both signer and verifier must produce identical bytes from the same value or
 * every signature is a coin flip. Object keys are sorted by code unit, arrays
 * keep their order, and there is no insignificant whitespace.
 *
 * Scope is deliberately narrow: verdict payloads are strings, finite numbers,
 * booleans, null, arrays and plain objects. Anything else is rejected loudly
 * rather than serialized in a way the verifier might not reproduce. That is why
 * non-finite numbers and undefined are errors instead of being coerced.
 */
function canonicalize(value) {
  if (value === null) return 'null';

  const type = typeof value;

  if (type === 'boolean') return value ? 'true' : 'false';

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalize: non-finite numbers cannot be signed deterministically');
    }
    // Integers cover every field this module signs. Floats are refused rather
    // than risking a signer and verifier disagreeing on representation.
    if (!Number.isInteger(value)) {
      throw new TypeError('canonicalize: only integer numbers are supported in signed payloads');
    }
    return String(value);
  }

  if (type === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  if (type === 'object') {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new TypeError('canonicalize: only plain objects can be signed');
    }
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${entries.join(',')}}`;
  }

  throw new TypeError(`canonicalize: unsupported value of type ${type}`);
}

/** SHA-256 over canonical bytes, lowercase hex. */
function digestOf(value) {
  return crypto.createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/**
 * Bytes that get signed.
 *
 * The domain string is inside the signed material, so a signature produced here
 * cannot be replayed as a signature over some other Zeroshot object that
 * happens to canonicalize to the same JSON.
 */
function signingInput(payload) {
  return Buffer.from(`${SIGNING_DOMAIN}\n${canonicalize(payload)}`, 'utf8');
}

/**
 * Generate an Ed25519 signing identity.
 *
 * The key id is derived from the public key rather than assigned, so two
 * deployments cannot accidentally issue different keys under the same name, and
 * a kid can always be checked against the key it claims to identify.
 */
function generateSigningKey({ notBefore = null, notAfter = null } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicKeyB64 = publicKeyDer.toString('base64');

  return {
    kid: keyIdFromPublicKey(publicKeyB64),
    alg: SIGNING_ALG,
    public_key: publicKeyB64,
    private_key_pem: privateKeyPem,
    not_before: notBefore,
    not_after: notAfter,
  };
}

/** Deterministic key id: first 16 hex characters of SHA-256 over the SPKI bytes. */
function keyIdFromPublicKey(publicKeyB64) {
  const hash = crypto
    .createHash('sha256')
    .update(Buffer.from(publicKeyB64, 'base64'))
    .digest('hex');
  return `zsk_${hash.slice(0, 16)}`;
}

/**
 * A keyring is the trust input a verifier supplies from its own side. It is
 * published separately from the receipts on purpose: a receipt that carried its
 * own trust anchor would let a producer install trust in its own artifact.
 */
function createKeyring(keys = []) {
  return {
    type: KEYRING_TYPE,
    version: 1,
    keys: keys.map((key) => ({
      kid: key.kid,
      alg: key.alg || SIGNING_ALG,
      public_key: key.public_key,
      not_before: key.not_before ?? null,
      not_after: key.not_after ?? null,
      status: key.status || 'active',
      revoked_at: key.revoked_at ?? null,
    })),
  };
}

function assertKeyring(keyring) {
  if (!keyring || typeof keyring !== 'object') {
    throw new TypeError('keyring is required');
  }
  if (keyring.type !== KEYRING_TYPE) {
    throw new TypeError(`unsupported keyring type: ${String(keyring.type)}`);
  }
  if (!Array.isArray(keyring.keys)) {
    throw new TypeError('keyring.keys must be an array');
  }
}

/**
 * Resolve the key a receipt names, and decide whether it was trusted at the
 * moment the receipt claims to have been signed.
 *
 * Rotation and revocation semantics, stated explicitly because they are the
 * part reviewers should argue with:
 *
 * - not_before / not_after bound when a key may sign. A receipt outside the
 *   window fails even if the signature is mathematically valid.
 * - Revocation is not retroactive. A verdict signed while the key was trusted
 *   stays valid after revocation, because the alternative silently voids
 *   honest history every time an operator rotates hygiene keys. A deployment
 *   that needs retroactive invalidation should set revoked_at to the compromise
 *   time, which is what that field is for.
 */
function resolveKey(keyring, kid, atMs) {
  const key = keyring.keys.find((candidate) => candidate.kid === kid);
  if (!key) {
    return { ok: false, reason: `no key in keyring for kid ${kid}` };
  }
  if (key.alg !== SIGNING_ALG) {
    return { ok: false, reason: `key ${kid} uses unsupported algorithm ${key.alg}` };
  }
  if (keyIdFromPublicKey(key.public_key) !== key.kid) {
    return { ok: false, reason: `key ${kid} does not match the public key it names` };
  }
  if (typeof key.not_before === 'number' && atMs < key.not_before) {
    return { ok: false, reason: `receipt predates the validity window of key ${kid}` };
  }
  if (typeof key.not_after === 'number' && atMs > key.not_after) {
    return { ok: false, reason: `receipt postdates the validity window of key ${kid}` };
  }
  if (key.status === 'revoked' && typeof key.revoked_at === 'number' && atMs >= key.revoked_at) {
    return { ok: false, reason: `key ${kid} was revoked before this receipt was signed` };
  }
  return { ok: true, key };
}

/**
 * The signed fields of a verdict.
 *
 * Only what a relying party needs is included. Validator identity is carried as
 * whatever the caller supplies, so a deployment that blinds validator ids keeps
 * them blinded here; this module never de-anonymizes and never requires a real
 * name.
 */
function buildVerdictPayload({
  clusterId,
  messageId,
  validatorId,
  decision,
  timestamp,
  issueRef = null,
  criteria = [],
  errors = [],
  contentDigest = null,
  prevReceiptHash = null,
}) {
  if (!clusterId) throw new TypeError('clusterId is required');
  if (!messageId) throw new TypeError('messageId is required');
  if (!validatorId) throw new TypeError('validatorId is required');
  if (decision !== 'pass' && decision !== 'fail') {
    throw new TypeError(`decision must be "pass" or "fail", received ${String(decision)}`);
  }
  if (!Number.isInteger(timestamp)) throw new TypeError('timestamp must be an integer');

  return {
    type: RECEIPT_TYPE,
    version: 1,
    cluster_id: clusterId,
    message_id: messageId,
    validator_id: validatorId,
    decision,
    timestamp,
    issue_ref: issueRef,
    criteria: criteria.map((entry) => String(entry)).sort(),
    errors: errors.map((entry) => String(entry)),
    content_digest: contentDigest,
    prev_receipt_hash: prevReceiptHash,
  };
}

/**
 * Sign a verdict payload.
 *
 * The envelope keeps payload and signature separate so a verifier can recompute
 * the exact signed bytes without having to strip fields out of a merged object.
 */
function signVerdict(payload, signingKey) {
  if (!signingKey || !signingKey.private_key_pem) {
    throw new TypeError('signingKey with private_key_pem is required');
  }
  const privateKey = crypto.createPrivateKey(signingKey.private_key_pem);
  const signature = crypto.sign(null, signingInput(payload), privateKey);

  return {
    payload,
    signature: {
      alg: SIGNING_ALG,
      kid: signingKey.kid,
      sig: signature.toString('base64'),
    },
  };
}

/** SHA-256 over the whole envelope, which is what the next receipt chains to. */
function receiptHash(receipt) {
  return digestOf(receipt);
}

/**
 * Verify one receipt in isolation.
 *
 * Returns a structured result rather than throwing, because a verifier's job is
 * to report which receipts failed and why, not to stop at the first bad one.
 */
/** Structural checks, separated so verifyReceipt stays readable. */
function receiptShapeError(receipt) {
  if (!receipt || typeof receipt !== 'object') return 'receipt is not an object';
  if (!receipt.payload || typeof receipt.payload !== 'object') return 'receipt has no payload';
  if (!receipt.signature || typeof receipt.signature !== 'object')
    return 'receipt has no signature';
  if (receipt.payload.type !== RECEIPT_TYPE) {
    return `unsupported receipt type: ${String(receipt.payload.type)}`;
  }
  if (receipt.signature.alg !== SIGNING_ALG) {
    return `unsupported signature algorithm: ${String(receipt.signature.alg)}`;
  }
  return null;
}

function verifyReceipt(receipt, keyring) {
  assertKeyring(keyring);

  const fail = (reason) => ({ valid: false, reason, kid: receipt?.signature?.kid ?? null });

  const shapeError = receiptShapeError(receipt);
  if (shapeError) return fail(shapeError);

  const resolved = resolveKey(keyring, receipt.signature.kid, receipt.payload.timestamp);
  if (!resolved.ok) return fail(resolved.reason);

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({
      key: Buffer.from(resolved.key.public_key, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch (error) {
    return fail(`public key for ${receipt.signature.kid} could not be parsed: ${error.message}`);
  }

  let signatureValid;
  try {
    signatureValid = crypto.verify(
      null,
      signingInput(receipt.payload),
      publicKey,
      Buffer.from(receipt.signature.sig, 'base64')
    );
  } catch (error) {
    return fail(`signature could not be checked: ${error.message}`);
  }

  if (!signatureValid) return fail('signature does not verify over the receipt payload');

  return { valid: true, reason: null, kid: receipt.signature.kid };
}

/**
 * Verify an ordered sequence of receipts.
 *
 * Signature validity and chain integrity are reported separately and on
 * purpose. A validly signed receipt pointing at the wrong predecessor means
 * something was removed or reordered, which is a different failure from a
 * forged signature and calls for a different response. Collapsing them would
 * hide the distinction that makes the chain worth having.
 */
function describeHash(hash) {
  return hash === null ? 'null' : hash;
}

function chainMismatchReason(expected, actual) {
  return `expected prev_receipt_hash ${describeHash(expected)} but found ${describeHash(actual)}`;
}

function verifyReceiptChain(receipts, keyring) {
  assertKeyring(keyring);
  if (!Array.isArray(receipts)) throw new TypeError('receipts must be an array');

  const results = [];
  let previousHash = null;
  let signaturesValid = 0;
  let chainBroken = false;

  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    const signature = verifyReceipt(receipt, keyring);
    const expected = index === 0 ? null : previousHash;
    const actual = receipt?.payload?.prev_receipt_hash ?? null;
    const chainOk = actual === expected;

    if (signature.valid) signaturesValid += 1;
    if (!chainOk) chainBroken = true;

    results.push({
      index,
      message_id: receipt?.payload?.message_id ?? null,
      signature_valid: signature.valid,
      signature_reason: signature.reason,
      chain_valid: chainOk,
      chain_reason: chainOk ? null : chainMismatchReason(expected, actual),
    });

    // Chain from what is actually here, so one break does not cascade into
    // every later receipt reporting a failure it did not cause.
    previousHash = receiptHash(receipt);
  }

  return {
    type: 'zeroshot.verdict_chain_verification.v1',
    receipts_checked: receipts.length,
    signatures_valid: signaturesValid,
    signatures_invalid: receipts.length - signaturesValid,
    chain_intact: !chainBroken,
    valid: signaturesValid === receipts.length && !chainBroken,
    results,
    establishes:
      'Each verified verdict was signed by the named key while that key was trusted, and the verified sequence has not been altered.',
    does_not_establish: [
      'It does not establish that a verdict was correct.',
      'It does not establish that the validator was independent or competent.',
      'It does not establish that verdicts signed by a compromised key were honest.',
      'It does not establish that no verdict is missing from the front of the sequence.',
    ],
  };
}

/**
 * A self-contained bundle for offline verification.
 *
 * The keyring travels beside the receipts for convenience, but a verifier that
 * cares should use its own copy. The bundle says so rather than implying that
 * shipping a key with an artifact is what makes it trustworthy.
 */
function exportVerificationBundle({ clusterId, receipts, keyring }) {
  return {
    type: 'zeroshot.verdict_bundle.v1',
    version: 1,
    cluster_id: clusterId,
    exported_at: Date.now(),
    receipt_count: receipts.length,
    receipts,
    keyring_hint: keyring,
    verification_note:
      'Verify with an independently obtained keyring. A keyring carried inside the artifact it authenticates is a convenience, not a trust anchor.',
  };
}

module.exports = {
  RECEIPT_TYPE,
  KEYRING_TYPE,
  SIGNING_ALG,
  SIGNING_DOMAIN,
  canonicalize,
  digestOf,
  generateSigningKey,
  keyIdFromPublicKey,
  createKeyring,
  resolveKey,
  buildVerdictPayload,
  signVerdict,
  receiptHash,
  verifyReceipt,
  verifyReceiptChain,
  exportVerificationBundle,
};
