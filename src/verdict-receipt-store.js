/**
 * Storage and lifecycle for signed validator verdicts.
 *
 * Deliberately additive. The core ledger write path is not modified: the Ledger
 * already emits `topic:VALIDATION_RESULT`, so this store attaches to that event
 * and signs verdicts as they land. A deployment that never constructs a store
 * behaves exactly as it does today, with no new table, no signing, and no cost.
 *
 * Two attachment modes, with an honest difference between them:
 *
 * - attach(ledger) is event-driven and requires no change to existing code. The
 *   receipt is written immediately after the verdict row, not inside the same
 *   transaction, so a process killed in the gap can leave a verdict without a
 *   receipt. Verification reports that as a missing receipt rather than
 *   pretending the verdict was never recorded.
 * - recordVerdict(message) is a direct call for callers that want the receipt
 *   written under their own control.
 *
 * The decision is read from the same fields the existing state reducer uses
 * (content.data.approved, errors, criteriaResults), so a receipt signs the
 * verdict zeroshot already acts on rather than a parallel interpretation of it.
 * When those fields do not yield an unambiguous decision, the store refuses to
 * sign instead of guessing. An unsigned verdict is a visible gap; a confidently
 * signed wrong one is worse.
 */

const {
  buildVerdictPayload,
  signVerdict,
  receiptHash,
  verifyReceiptChain,
  exportVerificationBundle,
  digestOf,
} = require('./verdict-receipts');

const VALIDATION_TOPIC = 'VALIDATION_RESULT';

class VerdictReceiptStore {
  /**
   * @param {Object} options
   * @param {Object} options.db better-sqlite3 database handle
   * @param {Object} options.signingKey key from generateSigningKey()
   * @param {Function} [options.onError] called with (error, message) instead of throwing
   *   from an event handler, since throwing inside an emit would take down an
   *   unrelated append path
   */
  constructor({ db, signingKey, onError = null } = {}) {
    if (!db) throw new TypeError('db is required');
    if (!signingKey || !signingKey.private_key_pem) {
      throw new TypeError('signingKey with private_key_pem is required');
    }

    this.db = db;
    this.signingKey = signingKey;
    this.onError = onError;
    this._attached = null;
    this._handler = null;

    this._initSchema();
    this._prepare();
  }

  _initSchema() {
    // Idempotent and separate from the messages table, so enabling or disabling
    // signing never migrates or rewrites message history.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verdict_receipts (
        message_id TEXT PRIMARY KEY,
        cluster_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        kid TEXT NOT NULL,
        receipt_hash TEXT NOT NULL,
        prev_receipt_hash TEXT,
        receipt_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_verdict_receipts_cluster
        ON verdict_receipts(cluster_id, timestamp);
    `);
  }

  _prepare() {
    this.stmts = {
      insert: this.db.prepare(`
        INSERT OR IGNORE INTO verdict_receipts
          (message_id, cluster_id, timestamp, kid, receipt_hash, prev_receipt_hash, receipt_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      lastForCluster: this.db.prepare(`
        SELECT receipt_hash FROM verdict_receipts
        WHERE cluster_id = ?
        ORDER BY timestamp DESC, rowid DESC
        LIMIT 1
      `),
      listForCluster: this.db.prepare(`
        SELECT receipt_json FROM verdict_receipts
        WHERE cluster_id = ?
        ORDER BY timestamp ASC, rowid ASC
      `),
      countForCluster: this.db.prepare(`
        SELECT COUNT(*) AS n FROM verdict_receipts WHERE cluster_id = ?
      `),
    };
  }

  /**
   * Subscribe to verdicts on a ledger. Returns a detach function.
   *
   * Errors are routed to onError rather than thrown, because this runs inside
   * the ledger's emit: a throw here would surface as a failure of an unrelated
   * append and could take down the cluster over a signing problem.
   */
  attach(ledger) {
    if (this._attached) throw new Error('store is already attached to a ledger');

    this._handler = (message) => {
      try {
        this.recordVerdict(message);
      } catch (error) {
        if (this.onError) this.onError(error, message);
      }
    };

    ledger.on(`topic:${VALIDATION_TOPIC}`, this._handler);
    this._attached = ledger;

    return () => this.detach();
  }

  detach() {
    if (!this._attached) return;
    this._attached.off(`topic:${VALIDATION_TOPIC}`, this._handler);
    this._attached = null;
    this._handler = null;
  }

  /**
   * Sign and store one verdict.
   *
   * @returns {Object|null} the receipt, or null when the message is not a
   *   verdict this store signs. Null is a deliberate outcome, not a failure.
   */
  recordVerdict(message) {
    if (!message || message.topic !== VALIDATION_TOPIC) return null;

    const decision = decisionFrom(message);
    if (decision === null) {
      throw new Error(
        `verdict ${message.id} has no unambiguous approved field; refusing to sign a guess`
      );
    }

    const data = message.content?.data || {};
    const prevReceiptHash = this.lastReceiptHash(message.cluster_id);

    const payload = buildVerdictPayload({
      clusterId: message.cluster_id,
      messageId: message.id,
      // The sender is whatever identity the deployment already uses for the
      // validator. If that is blinded upstream it stays blinded here.
      validatorId: message.sender,
      decision,
      timestamp: message.timestamp,
      issueRef: issueRefFrom(message),
      criteria: criteriaFrom(data),
      errors: errorsFrom(data),
      // Binds the verdict to the content it was rendered over without copying
      // that content into the receipt.
      contentDigest: message.content ? digestOf(normalizeContent(message.content)) : null,
      prevReceiptHash,
    });

    const receipt = signVerdict(payload, this.signingKey);
    const hash = receiptHash(receipt);

    this.stmts.insert.run(
      message.id,
      message.cluster_id,
      message.timestamp,
      this.signingKey.kid,
      hash,
      prevReceiptHash,
      JSON.stringify(receipt)
    );

    return receipt;
  }

  lastReceiptHash(clusterId) {
    const row = this.stmts.lastForCluster.get(clusterId);
    return row ? row.receipt_hash : null;
  }

  count(clusterId) {
    return this.stmts.countForCluster.get(clusterId).n;
  }

  /** Receipts in signing order. */
  list(clusterId) {
    return this.stmts.listForCluster.all(clusterId).map((row) => JSON.parse(row.receipt_json));
  }

  /**
   * Verify every stored receipt for a cluster against a keyring the caller
   * supplies. The store never supplies its own trust anchor.
   */
  verify(clusterId, keyring) {
    return verifyReceiptChain(this.list(clusterId), keyring);
  }

  /** A bundle that can be verified with no access to this instance. */
  exportBundle(clusterId, keyring) {
    return exportVerificationBundle({
      clusterId,
      receipts: this.list(clusterId),
      keyring,
    });
  }

  /**
   * Verdict rows in the ledger with no corresponding receipt.
   *
   * This is the honest counterpart to event-driven attachment: it reports the
   * gap rather than leaving a reader to assume every verdict was signed.
   */
  findUnsignedVerdicts(clusterId) {
    return this.db
      .prepare(
        `SELECT m.id, m.timestamp, m.sender
         FROM messages m
         LEFT JOIN verdict_receipts r ON r.message_id = m.id
         WHERE m.cluster_id = ? AND m.topic = ? AND r.message_id IS NULL
         ORDER BY m.timestamp ASC`
      )
      .all(clusterId, VALIDATION_TOPIC);
  }
}

/**
 * pass or fail, or null when the message does not say.
 *
 * Mirrors the existing state reducer, which treats content.data.approved as the
 * verdict. Anything other than a real boolean returns null so the caller
 * refuses rather than coercing a missing field into a pass.
 */
function decisionFrom(message) {
  const approved = message?.content?.data?.approved;
  if (approved === true) return 'pass';
  if (approved === false) return 'fail';
  return null;
}

function issueRefFrom(message) {
  const data = message?.content?.data || {};
  const ref = data.issue_ref ?? data.issueRef ?? message?.metadata?.issue_ref ?? null;
  return ref === null || ref === undefined ? null : String(ref);
}

function criteriaFrom(data) {
  const results = data.criteriaResults;
  if (Array.isArray(results)) {
    return results.map((entry) =>
      typeof entry === 'string' ? entry : String(entry?.id ?? entry?.name ?? JSON.stringify(entry))
    );
  }
  if (results && typeof results === 'object') return Object.keys(results);
  return [];
}

function errorsFrom(data) {
  const errors = data.errors;
  if (Array.isArray(errors)) {
    return errors.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)));
  }
  if (typeof errors === 'string' && errors.length > 0) return [errors];
  return [];
}

/**
 * Content reduced to something canonicalize() will accept, so the digest is
 * reproducible. Non-integer numbers and nested exotica are stringified rather
 * than rejected, because a content digest that fails to compute would block a
 * verdict from being signed at all.
 */
function normalizeContent(content) {
  return {
    text: typeof content.text === 'string' ? content.text : null,
    data: content.data === undefined ? null : JSON.stringify(content.data),
  };
}

module.exports = {
  VerdictReceiptStore,
  VALIDATION_TOPIC,
  decisionFrom,
};
