/**
 * Tests for the verdict receipt store against a real ledger.
 *
 * These exercise the integration rather than the crypto: that attaching signs
 * real verdicts, that the core ledger is untouched when no store exists, that a
 * ledger edited behind the store's back is detected, and that an ambiguous
 * verdict is refused rather than signed as a pass.
 */

const assert = require('assert');
const Ledger = require('../../src/ledger');
const { VerdictReceiptStore, decisionFrom } = require('../../src/verdict-receipt-store');
const { generateSigningKey, createKeyring } = require('../../src/verdict-receipts');

const CLUSTER = 'cluster-under-test';

function verdictMessage({ id, approved, sender = 'validator-1', errors = [] }) {
  return {
    id,
    cluster_id: CLUSTER,
    topic: 'VALIDATION_RESULT',
    sender,
    receiver: 'broadcast',
    content: {
      text: approved ? 'looks good' : 'rejected',
      data: { approved, errors, criteriaResults: ['tests-pass'] },
    },
  };
}

describe('VerdictReceiptStore', function () {
  let ledger;
  let key;
  let keyring;
  let store;

  beforeEach(() => {
    ledger = new Ledger(':memory:');
    key = generateSigningKey();
    keyring = createKeyring([key]);
    store = new VerdictReceiptStore({ db: ledger.db, signingKey: key });
  });

  afterEach(() => {
    store.detach();
    ledger.close?.();
  });

  describe('attachment', function () {
    it('signs verdicts published through the ledger', function () {
      store.attach(ledger);

      ledger.append(verdictMessage({ id: 'v1', approved: true }));
      ledger.append(verdictMessage({ id: 'v2', approved: false, errors: ['missing null check'] }));

      assert.strictEqual(store.count(CLUSTER), 2);
      const report = store.verify(CLUSTER, keyring);
      assert.strictEqual(report.valid, true, JSON.stringify(report.results));
    });

    it('ignores topics that are not verdicts', function () {
      store.attach(ledger);

      ledger.append({
        id: 'p1',
        cluster_id: CLUSTER,
        topic: 'PLAN_READY',
        sender: 'planner',
        content: { text: 'a plan' },
      });

      assert.strictEqual(store.count(CLUSTER), 0);
    });

    it('detaches cleanly and stops signing', function () {
      const detach = store.attach(ledger);
      ledger.append(verdictMessage({ id: 'v1', approved: true }));
      detach();
      ledger.append(verdictMessage({ id: 'v2', approved: true }));

      assert.strictEqual(store.count(CLUSTER), 1);
    });

    it('does not let a signing failure break the ledger append', function () {
      // A store problem must never take down an unrelated write path.
      const seen = [];
      const failing = new VerdictReceiptStore({
        db: ledger.db,
        signingKey: key,
        onError: (error, message) => seen.push({ error, id: message.id }),
      });
      failing.attach(ledger);

      // approved is absent, so the store refuses to sign.
      const appended = ledger.append({
        id: 'v-ambiguous',
        cluster_id: CLUSTER,
        topic: 'VALIDATION_RESULT',
        sender: 'validator-1',
        content: { text: 'unclear', data: { errors: [] } },
      });

      assert.ok(appended, 'the verdict itself still lands in the ledger');
      assert.strictEqual(seen.length, 1);
      assert.match(seen[0].error.message, /refusing to sign a guess/);
      failing.detach();
    });
  });

  describe('refusal', function () {
    it('reads pass and fail only from a real boolean', function () {
      assert.strictEqual(decisionFrom(verdictMessage({ id: 'x', approved: true })), 'pass');
      assert.strictEqual(decisionFrom(verdictMessage({ id: 'x', approved: false })), 'fail');
    });

    it('refuses truthy stand-ins rather than coercing them to a pass', function () {
      // "approved": "yes" must not silently become a signed pass.
      for (const value of ['yes', 1, 'true', {}, null, undefined]) {
        const message = {
          id: 'x',
          cluster_id: CLUSTER,
          topic: 'VALIDATION_RESULT',
          sender: 'v',
          content: { data: { approved: value } },
        };
        assert.strictEqual(decisionFrom(message), null, `approved=${JSON.stringify(value)}`);
      }
    });
  });

  describe('tamper detection', function () {
    it('detects a verdict deleted from the ledger after signing', function () {
      store.attach(ledger);
      ['v1', 'v2', 'v3'].forEach((id, index) =>
        ledger.append(verdictMessage({ id, approved: index !== 1 }))
      );

      // Someone with database access removes the inconvenient rejection, from
      // both the messages table and the receipt table.
      ledger.db.prepare('DELETE FROM messages WHERE id = ?').run('v2');
      ledger.db.prepare('DELETE FROM verdict_receipts WHERE message_id = ?').run('v2');

      const report = store.verify(CLUSTER, keyring);
      assert.strictEqual(report.signatures_invalid, 0, 'remaining signatures are genuine');
      assert.strictEqual(report.chain_intact, false, 'the gap is still detectable');
      assert.strictEqual(report.valid, false);
    });

    it('detects a receipt edited in place', function () {
      store.attach(ledger);
      ledger.append(verdictMessage({ id: 'v1', approved: false }));

      const row = ledger.db.prepare('SELECT receipt_json FROM verdict_receipts').get();
      const receipt = JSON.parse(row.receipt_json);
      receipt.payload.decision = 'pass';
      ledger.db
        .prepare('UPDATE verdict_receipts SET receipt_json = ? WHERE message_id = ?')
        .run(JSON.stringify(receipt), 'v1');

      const report = store.verify(CLUSTER, keyring);
      assert.strictEqual(report.valid, false);
      assert.strictEqual(report.results[0].signature_valid, false);
    });

    it('reports verdicts that were never signed', function () {
      // A verdict recorded while no store was attached is a real gap and must
      // be visible rather than silently absent from the evidence.
      ledger.append(verdictMessage({ id: 'unsigned-1', approved: true }));
      store.attach(ledger);
      ledger.append(verdictMessage({ id: 'signed-1', approved: true }));

      const gaps = store.findUnsignedVerdicts(CLUSTER);
      assert.strictEqual(gaps.length, 1);
      assert.strictEqual(gaps[0].id, 'unsigned-1');
    });
  });

  describe('offline export', function () {
    it('produces a bundle that verifies without the store or the ledger', function () {
      store.attach(ledger);
      ['v1', 'v2'].forEach((id) => ledger.append(verdictMessage({ id, approved: true })));

      const bundle = JSON.parse(JSON.stringify(store.exportBundle(CLUSTER, keyring)));

      // Verify with a keyring built independently, holding only public material.
      const { verifyReceiptChain } = require('../../src/verdict-receipts');
      const independent = createKeyring([
        { kid: key.kid, alg: key.alg, public_key: key.public_key },
      ]);

      const report = verifyReceiptChain(bundle.receipts, independent);
      assert.strictEqual(report.valid, true, JSON.stringify(report.results));
      assert.strictEqual(bundle.receipt_count, 2);
    });
  });

  describe('non-intrusiveness', function () {
    it('leaves ledger behaviour unchanged when no store exists', function () {
      const plain = new Ledger(':memory:');
      const appended = plain.append(verdictMessage({ id: 'v1', approved: true }));

      assert.ok(appended.id);
      assert.strictEqual(appended.topic, 'VALIDATION_RESULT');
      const tables = plain.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='verdict_receipts'")
        .all();
      assert.strictEqual(tables.length, 0, 'no receipt table is created unless a store is built');
      plain.close?.();
    });
  });
});
