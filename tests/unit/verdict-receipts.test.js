/**
 * Tests for signed validator verdicts.
 *
 * The positive path is the least interesting thing here. Most of these tests
 * exist to prove a specific way of cheating does not work: tampering with a
 * verdict, signing with the wrong key while claiming a trusted one, signing
 * outside a key's validity window, and removing or reordering receipts.
 *
 * A test suite for this feature that only proves "a valid receipt verifies"
 * has demonstrated nothing about the property the feature is for.
 */

const assert = require('assert');
const crypto = require('node:crypto');

const {
  canonicalize,
  digestOf,
  generateSigningKey,
  keyIdFromPublicKey,
  createKeyring,
  buildVerdictPayload,
  signVerdict,
  receiptHash,
  verifyReceipt,
  verifyReceiptChain,
  exportVerificationBundle,
  SIGNING_DOMAIN,
} = require('../../src/verdict-receipts');

const T0 = 1_780_000_000_000;

function verdict(overrides = {}) {
  return buildVerdictPayload({
    clusterId: 'cluster-alpha',
    messageId: 'msg_0001',
    validatorId: 'validator-blinded-7f3a',
    decision: 'pass',
    timestamp: T0,
    issueRef: 'GH-123',
    criteria: ['tests-pass', 'lint-clean'],
    errors: [],
    contentDigest: 'a'.repeat(64),
    ...overrides,
  });
}

function chainOf(signingKey, count) {
  const receipts = [];
  let prev = null;
  for (let i = 0; i < count; i += 1) {
    const payload = verdict({
      messageId: `msg_${String(i).padStart(4, '0')}`,
      timestamp: T0 + i,
      prevReceiptHash: prev,
    });
    const receipt = signVerdict(payload, signingKey);
    receipts.push(receipt);
    prev = receiptHash(receipt);
  }
  return receipts;
}

let key;
let keyring;

describe('verdict receipts', function () {
  beforeEach(() => {
    key = generateSigningKey();
    keyring = createKeyring([key]);
  });

  registerCanonicalizationTests();
  registerKeyIdentityTests();
  registerSigningTests();
  registerRotationTests();
  registerChainTests();
  registerPayloadTests();
  registerBundleTests();
});

function registerCanonicalizationTests() {
  describe('canonicalization', function () {
    it('is independent of key insertion order', function () {
      assert.strictEqual(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
    });

    it('preserves array order, which is meaningful', function () {
      assert.notStrictEqual(canonicalize([1, 2]), canonicalize([2, 1]));
    });

    it('omits undefined rather than emitting it', function () {
      assert.strictEqual(canonicalize({ a: 1, b: undefined }), '{"a":1}');
    });

    it('refuses values it cannot reproduce identically on both sides', function () {
      assert.throws(() => canonicalize({ n: NaN }), /non-finite/);
      assert.throws(() => canonicalize({ n: 1.5 }), /integer/);
      assert.throws(() => canonicalize({ f: () => {} }), /unsupported value/);
    });
  });
}

function registerKeyIdentityTests() {
  describe('key identity', function () {
    it('derives the kid from the public key so a kid cannot be reassigned', function () {
      assert.strictEqual(keyIdFromPublicKey(key.public_key), key.kid);
    });

    it('rejects a keyring entry whose kid does not match its public key', function () {
      const other = generateSigningKey();
      const lying = createKeyring([{ ...key, public_key: other.public_key }]);
      const receipt = signVerdict(verdict(), key);
      const result = verifyReceipt(receipt, lying);
      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /does not match the public key it names/);
    });
  });
}

function registerSigningTests() {
  describe('signing and verification', function () {
    it('verifies a receipt it just signed', function () {
      const result = verifyReceipt(signVerdict(verdict(), key), keyring);
      assert.strictEqual(result.valid, true, result.reason);
    });

    it('rejects a verdict whose decision was flipped after signing', function () {
      const receipt = signVerdict(verdict({ decision: 'fail' }), key);
      receipt.payload.decision = 'pass';
      const result = verifyReceipt(receipt, keyring);
      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /signature does not verify/);
    });

    it('rejects a receipt signed by another key while claiming a trusted kid', function () {
      const attacker = generateSigningKey();
      const forged = signVerdict(verdict(), attacker);
      forged.signature.kid = key.kid;
      const result = verifyReceipt(forged, keyring);
      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /signature does not verify/);
    });

    it('rejects a receipt whose kid is absent from the keyring', function () {
      const stranger = generateSigningKey();
      const result = verifyReceipt(signVerdict(verdict(), stranger), keyring);
      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /no key in keyring/);
    });

    it('does not accept a signature made over the same JSON in another domain', function () {
      // Domain separation: without it, a signature over an identically shaped
      // object from elsewhere in the system could be replayed as a verdict.
      const payload = verdict();
      const privateKey = crypto.createPrivateKey(key.private_key_pem);
      const wrongDomain = Buffer.from(`other-domain\n${canonicalize(payload)}`, 'utf8');
      const receipt = {
        payload,
        signature: {
          alg: 'Ed25519',
          kid: key.kid,
          sig: crypto.sign(null, wrongDomain, privateKey).toString('base64'),
        },
      };
      assert.notStrictEqual(SIGNING_DOMAIN, 'other-domain');
      assert.strictEqual(verifyReceipt(receipt, keyring).valid, false);
    });
  });
}

function registerRotationTests() {
  describe('key rotation and revocation', function () {
    it('rejects a receipt signed before the key was valid', function () {
      const scoped = createKeyring([{ ...key, not_before: T0 + 1000 }]);
      const result = verifyReceipt(signVerdict(verdict(), key), scoped);
      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /predates the validity window/);
    });

    it('rejects a receipt signed after the key expired', function () {
      const scoped = createKeyring([{ ...key, not_after: T0 - 1 }]);
      const result = verifyReceipt(signVerdict(verdict(), key), scoped);
      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /postdates the validity window/);
    });

    it('keeps verdicts signed before revocation valid', function () {
      // Rotation must not silently void honest history, or no operator will
      // ever rotate.
      const revoked = createKeyring([{ ...key, status: 'revoked', revoked_at: T0 + 5000 }]);
      const result = verifyReceipt(signVerdict(verdict({ timestamp: T0 }), key), revoked);
      assert.strictEqual(result.valid, true, result.reason);
    });

    it('rejects verdicts signed at or after revocation', function () {
      const revoked = createKeyring([{ ...key, status: 'revoked', revoked_at: T0 }]);
      const result = verifyReceipt(signVerdict(verdict({ timestamp: T0 }), key), revoked);
      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /revoked before this receipt/);
    });

    it('verifies receipts across a rotation when both keys are published', function () {
      const oldKey = generateSigningKey({ notAfter: T0 + 10 });
      const newKey = generateSigningKey({ notBefore: T0 + 11 });
      const ring = createKeyring([oldKey, newKey]);

      const before = signVerdict(verdict({ timestamp: T0 }), oldKey);
      const after = signVerdict(verdict({ messageId: 'msg_0002', timestamp: T0 + 20 }), newKey);

      assert.strictEqual(verifyReceipt(before, ring).valid, true);
      assert.strictEqual(verifyReceipt(after, ring).valid, true);
    });
  });
}

function registerChainTests() {
  describe('chain integrity', function () {
    it('verifies an intact chain', function () {
      const report = verifyReceiptChain(chainOf(key, 4), keyring);
      assert.strictEqual(report.valid, true);
      assert.strictEqual(report.chain_intact, true);
      assert.strictEqual(report.signatures_invalid, 0);
    });

    it('detects a deleted receipt while signatures stay valid', function () {
      // This is the case the feature exists for: someone with write access to
      // the ledger removes an inconvenient verdict. Every remaining signature
      // is genuine, so signature checking alone would report success.
      const receipts = chainOf(key, 4);
      receipts.splice(2, 1);

      const report = verifyReceiptChain(receipts, keyring);
      assert.strictEqual(report.signatures_invalid, 0, 'signatures remain genuine');
      assert.strictEqual(report.chain_intact, false, 'the missing link is detected');
      assert.strictEqual(report.valid, false);
    });

    it('detects reordering', function () {
      const receipts = chainOf(key, 4);
      [receipts[1], receipts[2]] = [receipts[2], receipts[1]];

      const report = verifyReceiptChain(receipts, keyring);
      assert.strictEqual(report.signatures_invalid, 0);
      assert.strictEqual(report.chain_intact, false);
    });

    it('reports signature and chain failures independently', function () {
      // These are different failures calling for different responses, so the
      // report must not collapse them into one boolean.
      const receipts = chainOf(key, 3);
      receipts[1].payload.decision = 'fail';

      const report = verifyReceiptChain(receipts, keyring);
      assert.strictEqual(report.results[1].signature_valid, false);
      assert.strictEqual(report.results[1].chain_valid, true);
    });

    it('does not cascade one break into every later receipt', function () {
      const receipts = chainOf(key, 5);
      receipts.splice(1, 1);

      const report = verifyReceiptChain(receipts, keyring);
      const broken = report.results.filter((entry) => !entry.chain_valid);
      assert.strictEqual(broken.length, 1, 'exactly one link should be reported broken');
    });

    it('requires the first receipt to declare no predecessor', function () {
      const receipts = chainOf(key, 2);
      const orphan = signVerdict(
        verdict({ messageId: 'msg_orphan', prevReceiptHash: digestOf({ not: 'a real receipt' }) }),
        key
      );
      const report = verifyReceiptChain([orphan, ...receipts], keyring);
      assert.strictEqual(report.results[0].chain_valid, false);
    });
  });
}

function registerPayloadTests() {
  describe('payload construction', function () {
    it('rejects a decision that is neither pass nor fail', function () {
      assert.throws(() => verdict({ decision: 'maybe' }), /pass.*fail/);
    });

    it('requires the identifying fields', function () {
      assert.throws(() => buildVerdictPayload({ decision: 'pass', timestamp: T0 }), /clusterId/);
    });

    it('sorts criteria so an equivalent verdict has one signature', function () {
      const a = verdict({ criteria: ['b', 'a'] });
      const b = verdict({ criteria: ['a', 'b'] });
      assert.strictEqual(canonicalize(a), canonicalize(b));
    });

    it('preserves error order, which carries meaning', function () {
      const a = verdict({ decision: 'fail', errors: ['first', 'second'] });
      const b = verdict({ decision: 'fail', errors: ['second', 'first'] });
      assert.notStrictEqual(canonicalize(a), canonicalize(b));
    });
  });
}

function registerBundleTests() {
  describe('offline bundle', function () {
    it('verifies from the bundle alone with an independently supplied keyring', function () {
      const receipts = chainOf(key, 3);
      const bundle = exportVerificationBundle({
        clusterId: 'cluster-alpha',
        receipts,
        keyring,
      });

      // Round-trip through JSON to prove nothing depends on live object state.
      const transported = JSON.parse(JSON.stringify(bundle));
      const independentKeyring = createKeyring([
        { kid: key.kid, alg: key.alg, public_key: key.public_key },
      ]);

      const report = verifyReceiptChain(transported.receipts, independentKeyring);
      assert.strictEqual(report.valid, true, JSON.stringify(report.results));
    });

    it('states what verification does not establish', function () {
      const report = verifyReceiptChain(chainOf(key, 1), keyring);
      assert.ok(Array.isArray(report.does_not_establish));
      assert.ok(report.does_not_establish.some((line) => /correct/.test(line)));
    });
  });
}
