/**
 * Ledger - Durable event log for multi-agent coordination
 *
 * Provides:
 * - Immutable control/replayable messages plus a bounded newest tail of raw AGENT_OUTPUT
 * - SQLite-backed message storage with indexes
 * - Query API for message retrieval
 * - In-memory cache for recent queries
 * - Subscription mechanism for real-time updates
 */

const Database = require('better-sqlite3');
const EventEmitter = require('events');
const crypto = require('crypto');
const {
  GUIDANCE_TOPICS,
  USER_GUIDANCE_AGENT,
  USER_GUIDANCE_CLUSTER,
} = require('./guidance-topics');
const { isReplayableMessage } = require('./agent/context-replay-policy');
const { messageSequenceFromSql, messageSequenceToSql } = require('./ledger-sequence');

const MESSAGE_SEQUENCE_SELECT = 'CAST(rowid AS TEXT) AS sequence';
const AGENT_OUTPUT_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const AGENT_OUTPUT_EXPORT_MAX_MESSAGES = 8192;
const EMPTY_OMISSION_DIGEST = '0'.repeat(64);
const AGENT_OUTPUT_RECEIPT_SENDER = 'zeroshot';

class Ledger extends EventEmitter {
  constructor(dbPath = ':memory:', options = {}) {
    super();
    this.dbPath = dbPath;
    this.readonly = options.readonly === true;
    const busyTimeoutMs = (() => {
      const raw = process.env.ZEROSHOT_SQLITE_BUSY_TIMEOUT_MS;
      if (!raw) return 5000;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : 5000;
    })();

    // Read-only connections (CLI list/status/logs) never take a write lock on
    // another process's live database and skip schema DDL entirely - the schema
    // is guaranteed to already exist for any cluster with a live daemon.
    this.db = this.readonly
      ? new Database(dbPath, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs })
      : new Database(dbPath, { timeout: busyTimeoutMs });
    this.cache = new Map(); // LRU cache for queries
    this.cacheLimit = 1000;
    this._closed = false; // Track closed state to prevent write-after-close
    this._lastTimestamp = 0;

    if (this.readonly) {
      this._prepareStatements();
      this._loadLastTimestamp();
    } else {
      this._initSchema();
    }
  }

  _initSchema() {
    const journalMode = (process.env.ZEROSHOT_SQLITE_JOURNAL_MODE || 'WAL').trim().toUpperCase();
    // Enable WAL mode for concurrent reads (default), but allow overrides for network filesystems.
    this.db.pragma(`journal_mode = ${journalMode}`);
    // Force synchronous writes so other processes see changes immediately
    this.db.pragma('synchronous = NORMAL');
    // Autocheckpoint trades latency for WAL growth; 1-page checkpoints are extremely slow on
    // higher-latency disks (common in Kubernetes PVs). Default to SQLite-ish behavior (1000 pages),
    // but allow override for niche correctness/debugging needs.
    const walAutocheckpointPages = (() => {
      const raw = process.env.ZEROSHOT_SQLITE_WAL_AUTOCHECKPOINT_PAGES;
      if (!raw) return 1000;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1000;
    })();
    this.db.pragma(`wal_autocheckpoint = ${walAutocheckpointPages}`);

    // Create messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        topic TEXT NOT NULL,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        content_text TEXT,
        content_data TEXT,
        metadata TEXT,
        cluster_id TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_topic ON messages(topic);
      CREATE INDEX IF NOT EXISTS idx_cluster_sender ON messages(cluster_id, sender);
      CREATE INDEX IF NOT EXISTS idx_cluster_topic ON messages(cluster_id, topic);
      CREATE INDEX IF NOT EXISTS idx_cluster_timestamp ON messages(cluster_id, timestamp);

      CREATE TABLE IF NOT EXISTS agent_output_compaction (
        cluster_id TEXT PRIMARY KEY,
        receipt_message_id TEXT,
        first_omitted_timestamp INTEGER,
        omitted_messages INTEGER NOT NULL DEFAULT 0,
        omitted_export_bytes INTEGER NOT NULL DEFAULT 0,
        omission_digest TEXT NOT NULL,
        retained_messages INTEGER NOT NULL DEFAULT 0,
        retained_export_bytes INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS ledger_sequence (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        value INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO ledger_sequence (singleton, value) VALUES (1, 0);
      UPDATE ledger_sequence
      SET value = MAX(value, COALESCE((SELECT MAX(rowid) FROM messages), 0))
      WHERE singleton = 1;
    `);

    this._prepareStatements();
    this._loadLastTimestamp();
    this._reconcileAgentOutput();
  }

  _prepareStatements() {
    const insert = this.db.prepare(`
        INSERT INTO messages (
          rowid, id, timestamp, topic, sender, receiver,
          content_text, content_data, metadata, cluster_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    insert.safeIntegers(true);

    this.stmts = {
      insert,

      queryBase: `SELECT ${MESSAGE_SEQUENCE_SELECT}, * FROM messages WHERE cluster_id = ?`,

      count: this.db.prepare(`SELECT COUNT(*) as count FROM messages WHERE cluster_id = ?`),

      getAll: this.db.prepare(
        `SELECT ${MESSAGE_SEQUENCE_SELECT}, * FROM messages WHERE cluster_id = ?` +
          ` ORDER BY timestamp ASC, rowid ASC`
      ),

      agentOutputRows: this.db.prepare(
        `SELECT ${MESSAGE_SEQUENCE_SELECT}, * FROM messages` +
          ` WHERE cluster_id = ? AND topic = 'AGENT_OUTPUT' ORDER BY timestamp ASC, rowid ASC`
      ),
    };

    if (!this.readonly) {
      const nextSequence = this.db.prepare(`
        UPDATE ledger_sequence
        SET value = MAX(value, COALESCE((SELECT MAX(rowid) FROM messages), 0)) + 1
        WHERE singleton = 1
          AND value < 9223372036854775807
          AND COALESCE((SELECT MAX(rowid) FROM messages), 0) < 9223372036854775807
        RETURNING value
      `);
      nextSequence.safeIntegers(true);
      this.stmts.nextSequence = nextSequence;
      this._prepareAgentOutputCompactionStatements();
    }
  }

  _prepareAgentOutputCompactionStatements() {
    this.compactionStmts = {
      get: this.db.prepare('SELECT * FROM agent_output_compaction WHERE cluster_id = ?'),
      insert: this.db.prepare(`
        INSERT INTO agent_output_compaction (
          cluster_id, receipt_message_id, first_omitted_timestamp,
          omitted_messages, omitted_export_bytes, omission_digest,
          retained_messages, retained_export_bytes
        ) VALUES (?, NULL, NULL, 0, 0, ?, ?, ?)
      `),
      update: this.db.prepare(`
        UPDATE agent_output_compaction
        SET receipt_message_id = ?, first_omitted_timestamp = ?, omitted_messages = ?,
            omitted_export_bytes = ?, omission_digest = ?, retained_messages = ?,
            retained_export_bytes = ?
        WHERE cluster_id = ?
      `),
      deleteMessage: this.db.prepare('DELETE FROM messages WHERE id = ?'),
      updateReceipt: this.db.prepare(`
        UPDATE messages SET content_data = ?, metadata = ? WHERE id = ?
      `),
      receiptExists: this.db.prepare('SELECT 1 FROM messages WHERE id = ?'),
      agentOutputClusterIds: this.db.prepare(`
        SELECT cluster_id FROM agent_output_compaction
        UNION
        SELECT cluster_id FROM messages WHERE topic = 'AGENT_OUTPUT'
      `),
      deleteState: this.db.prepare('DELETE FROM agent_output_compaction'),
    };
  }

  _reconcileAgentOutput() {
    const clusterIds = this.compactionStmts.agentOutputClusterIds
      .all()
      .map((row) => row.cluster_id);
    const reconcileCluster = this.db.transaction((clusterId) => {
      const measured = this._measureCompactableAgentOutput(clusterId);
      let state = this.compactionStmts.get.get(clusterId);
      if (!state) {
        if (measured.retained_messages === 0) return;
        state = this._createCompactionState(clusterId, measured);
      } else if (
        state.retained_messages !== measured.retained_messages ||
        state.retained_export_bytes !== measured.retained_export_bytes
      ) {
        state.retained_messages = measured.retained_messages;
        state.retained_export_bytes = measured.retained_export_bytes;
        this._updateCompactionState(state);
      }
      const receiptMissing =
        state.omitted_messages > 0 &&
        (!state.receipt_message_id ||
          !this.compactionStmts.receiptExists.get(state.receipt_message_id));
      if (
        receiptMissing ||
        state.retained_export_bytes > AGENT_OUTPUT_EXPORT_MAX_BYTES ||
        state.retained_messages > AGENT_OUTPUT_EXPORT_MAX_MESSAGES
      ) {
        this._compactAgentOutput(clusterId);
      }
    });
    for (const clusterId of clusterIds) {
      reconcileCluster.immediate(clusterId);
    }
  }

  _loadLastTimestamp() {
    const row = this.db.prepare('SELECT MAX(timestamp) AS max_timestamp FROM messages').get();
    if (row && Number.isFinite(row.max_timestamp)) {
      this._lastTimestamp = row.max_timestamp;
    }
  }

  _insertRecord(record) {
    const allocated = this.stmts.nextSequence.get();
    if (!allocated) {
      throw new RangeError('Ledger message sequence exhausted the SQLite rowid range');
    }
    this.stmts.insert.run(
      allocated.value,
      record.id,
      record.timestamp,
      record.topic,
      record.sender,
      record.receiver,
      record.content_text,
      record.content_data,
      record.metadata,
      record.cluster_id
    );
    record.sequence = messageSequenceFromSql(allocated.value);
    return this._deserializeMessage(record);
  }

  _recordExportBytes(record) {
    return Buffer.byteLength(JSON.stringify(this._deserializeMessage(record)));
  }

  _isCompactableAgentOutput(record) {
    if (record.topic !== 'AGENT_OUTPUT') return false;
    const message = this._deserializeMessage(record);
    return message.metadata?.compactionReceipt !== true && !isReplayableMessage(message);
  }

  _measureCompactableAgentOutput(clusterId) {
    let retainedMessages = 0;
    let retainedExportBytes = 0;
    for (const row of this.stmts.agentOutputRows.iterate(clusterId)) {
      if (!this._isCompactableAgentOutput(row)) continue;
      retainedMessages += 1;
      retainedExportBytes += this._recordExportBytes(row);
    }
    return {
      retained_messages: retainedMessages,
      retained_export_bytes: retainedExportBytes,
    };
  }

  _createCompactionState(clusterId, measured = this._measureCompactableAgentOutput(clusterId)) {
    this.compactionStmts.insert.run(
      clusterId,
      EMPTY_OMISSION_DIGEST,
      measured.retained_messages,
      measured.retained_export_bytes
    );
    return this.compactionStmts.get.get(clusterId);
  }

  _updateCompactionState(state) {
    this.compactionStmts.update.run(
      state.receipt_message_id,
      state.first_omitted_timestamp,
      state.omitted_messages,
      state.omitted_export_bytes,
      state.omission_digest,
      state.retained_messages,
      state.retained_export_bytes,
      state.cluster_id
    );
  }

  _oldestCompactableAgentOutput(clusterId) {
    for (const row of this.stmts.agentOutputRows.iterate(clusterId)) {
      if (this._isCompactableAgentOutput(row)) return row;
    }
    return null;
  }

  _nextOmissionDigest(previousDigest, record) {
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from(previousDigest, 'hex'));
    const exportedMessage = Buffer.from(JSON.stringify(this._deserializeMessage(record)));
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(exportedMessage.length));
    hash.update(length);
    hash.update(exportedMessage);
    return hash.digest('hex');
  }

  _agentOutputReceiptRecord(state) {
    const line =
      `[ZEROSHOT] Earlier raw provider output omitted from the durable control-plane tail ` +
      `(messages=${state.omitted_messages}, export_bytes=${state.omitted_export_bytes}, ` +
      `sha256_chain=${state.omission_digest}). The newest output is retained within ` +
      `${AGENT_OUTPUT_EXPORT_MAX_BYTES} exported bytes and ` +
      `${AGENT_OUTPUT_EXPORT_MAX_MESSAGES} messages. Complete output remains in task logs.`;
    return {
      id:
        state.receipt_message_id ||
        `agent_output_receipt_${crypto.createHash('sha256').update(state.cluster_id).digest('hex').slice(0, 24)}`,
      timestamp: state.first_omitted_timestamp,
      topic: 'AGENT_OUTPUT',
      sender: AGENT_OUTPUT_RECEIPT_SENDER,
      receiver: 'broadcast',
      content_text: null,
      content_data: JSON.stringify({
        type: 'output_omission',
        line,
        omittedMessages: state.omitted_messages,
        omittedExportBytes: state.omitted_export_bytes,
        sha256Chain: state.omission_digest,
        retainedExportByteLimit: AGENT_OUTPUT_EXPORT_MAX_BYTES,
        retainedMessageLimit: AGENT_OUTPUT_EXPORT_MAX_MESSAGES,
        completeOutputAuthority: 'task_logs',
      }),
      metadata: JSON.stringify({
        compactionReceipt: true,
        contextSafe: false,
        replayPolicy: 'raw_log_only',
      }),
      cluster_id: state.cluster_id,
    };
  }

  _persistAgentOutputReceipt(state) {
    const receipt = this._agentOutputReceiptRecord(state);
    const updated = state.receipt_message_id
      ? this.compactionStmts.updateReceipt.run(receipt.content_data, receipt.metadata, receipt.id)
      : { changes: 0 };
    if (updated.changes === 0) {
      this._insertRecord(receipt);
    }
    state.receipt_message_id = receipt.id;
  }

  _compactAgentOutput(clusterId) {
    const state = this.compactionStmts.get.get(clusterId) || this._createCompactionState(clusterId);
    while (
      state.retained_export_bytes > AGENT_OUTPUT_EXPORT_MAX_BYTES ||
      state.retained_messages > AGENT_OUTPUT_EXPORT_MAX_MESSAGES
    ) {
      const oldest = this._oldestCompactableAgentOutput(clusterId);
      if (!oldest) break;
      const exportBytes = this._recordExportBytes(oldest);
      state.first_omitted_timestamp ??= oldest.timestamp;
      state.omitted_messages += 1;
      state.omitted_export_bytes += exportBytes;
      state.omission_digest = this._nextOmissionDigest(state.omission_digest, oldest);
      state.retained_messages -= 1;
      state.retained_export_bytes -= exportBytes;
      if (
        !state.receipt_message_id ||
        !this.compactionStmts.receiptExists.get(state.receipt_message_id)
      ) {
        this._persistAgentOutputReceipt(state);
      }
      this.compactionStmts.deleteMessage.run(oldest.id);
    }
    if (state.omitted_messages > 0) {
      this._persistAgentOutputReceipt(state);
    }
    this._updateCompactionState(state);
  }

  _insertAndCompact(record) {
    const fullMessage = this._insertRecord(record);
    if (this._isCompactableAgentOutput(record)) {
      const state = this.compactionStmts.get.get(record.cluster_id);
      if (state) {
        state.retained_messages += 1;
        state.retained_export_bytes += this._recordExportBytes(record);
        this._updateCompactionState(state);
      }
      this._compactAgentOutput(record.cluster_id);
    }
    return fullMessage;
  }

  _appendRecord(record) {
    const compactable = this._isCompactableAgentOutput(record);
    if (!this._appendRecordTxn) {
      this._appendRecordTxn = this.db.transaction((item, compact) =>
        compact ? this._insertAndCompact(item) : this._insertRecord(item)
      );
    }
    return this._appendRecordTxn(record, compactable);
  }

  /**
   * Append a message to the ledger
   * @param {Object} message - Message object
   * @returns {Object} The appended message with generated ID
   */
  append(message) {
    // Guard against write-after-close race condition
    // This can happen when orchestrator closes ledger while agents are still publishing
    if (this._closed) {
      // Silent return - agent is being stopped, message loss is expected
      return null;
    }

    const id = message.id || `msg_${crypto.randomBytes(16).toString('hex')}`;
    const baseTimestamp = Math.max(Date.now(), this._lastTimestamp + 1);
    const requestedTimestamp = typeof message.timestamp === 'number' ? message.timestamp : null;
    const timestamp =
      requestedTimestamp !== null ? Math.max(requestedTimestamp, baseTimestamp) : baseTimestamp;

    const receiver = message.receiver || message.target_agent_id || 'broadcast';
    const record = {
      id,
      timestamp,
      topic: message.topic,
      sender: message.sender,
      receiver,
      content_text: message.content?.text || null,
      content_data: message.content?.data ? JSON.stringify(message.content.data) : null,
      metadata: message.metadata ? JSON.stringify(message.metadata) : null,
      cluster_id: message.cluster_id,
    };

    try {
      const fullMessage = this._appendRecord(record);

      // Invalidate cache
      this.cache.clear();

      this._lastTimestamp = Math.max(this._lastTimestamp, timestamp);

      // Emit event for subscriptions
      this.emit('message', fullMessage);
      this.emit(`topic:${message.topic}`, fullMessage);

      return fullMessage;
    } catch (error) {
      throw new Error(`Failed to append message: ${error.message}`);
    }
  }

  /**
   * Append multiple messages atomically using a transaction
   * All messages get contiguous timestamps and are committed together.
   * If any insert fails, the entire batch is rolled back.
   *
   * Use this for task completion messages to prevent interleaving:
   * - TOKEN_USAGE, TASK_COMPLETED, and hook messages published atomically
   * - Other agents' messages cannot appear between them
   *
   * @param {Array<Object>} messages - Array of message objects
   * @returns {Array<Object>} Array of appended messages with generated IDs
   */
  batchAppend(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return [];
    }

    // Guard against write-after-close race condition
    if (this._closed) {
      return [];
    }

    // Create transaction function - all inserts happen atomically
    const insertMany = this.db.transaction((msgs) => {
      const results = [];
      const baseTimestamp = Math.max(Date.now(), this._lastTimestamp + 1);

      for (let i = 0; i < msgs.length; i++) {
        const message = msgs[i];
        const id = message.id || `msg_${crypto.randomBytes(16).toString('hex')}`;
        // Use incrementing timestamps to preserve order within batch
        const timestamp = baseTimestamp + i;

        const receiver = message.receiver || message.target_agent_id || 'broadcast';
        const record = {
          id,
          timestamp,
          topic: message.topic,
          sender: message.sender,
          receiver,
          content_text: message.content?.text || null,
          content_data: message.content?.data ? JSON.stringify(message.content.data) : null,
          metadata: message.metadata ? JSON.stringify(message.metadata) : null,
          cluster_id: message.cluster_id,
        };

        results.push(this._insertAndCompact(record));
      }

      return { results, baseTimestamp };
    });

    try {
      // Execute transaction (atomic - all or nothing)
      const { results: appendedMessages, baseTimestamp } = insertMany(messages);

      // Invalidate cache
      this.cache.clear();

      this._lastTimestamp = Math.max(this._lastTimestamp, baseTimestamp + messages.length - 1);

      // Emit events for subscriptions AFTER transaction commits
      // This ensures listeners see consistent state
      for (const fullMessage of appendedMessages) {
        this.emit('message', fullMessage);
        this.emit(`topic:${fullMessage.topic}`, fullMessage);
      }

      return appendedMessages;
    } catch (error) {
      throw new Error(`Failed to batch append messages: ${error.message}`);
    }
  }

  /**
   * Query messages with filters
   * @param {Object} criteria - Query criteria
   * @returns {Array} Matching messages
   */
  query(criteria) {
    const {
      cluster_id,
      topic,
      sender,
      receiver,
      since,
      after,
      until,
      afterId,
      throughId,
      limit,
      offset,
    } = criteria;

    if (!cluster_id) {
      throw new Error('cluster_id is required for queries');
    }

    // Build query
    const conditions = ['cluster_id = ?'];
    const params = [cluster_id];

    if (topic) {
      conditions.push('topic = ?');
      params.push(topic);
    }

    if (sender) {
      conditions.push('sender = ?');
      params.push(sender);
    }

    if (receiver) {
      conditions.push('receiver = ?');
      params.push(receiver);
    }

    if (since) {
      conditions.push('timestamp >= ?');
      params.push(typeof since === 'number' ? since : new Date(since).getTime());
    }

    if (after !== undefined && after !== null) {
      if (!Number.isInteger(after) || after < 0) {
        throw new Error('after must be a non-negative durable ledger cursor');
      }
      conditions.push('timestamp > ?');
      params.push(after);
    }

    if (until) {
      conditions.push('timestamp <= ?');
      params.push(typeof until === 'number' ? until : new Date(until).getTime());
    }

    if (afterId !== undefined && afterId !== null) {
      conditions.push('rowid > ?');
      params.push(messageSequenceToSql(afterId, 'afterId'));
    }

    if (throughId !== undefined && throughId !== null) {
      conditions.push('rowid <= ?');
      params.push(messageSequenceToSql(throughId, 'throughId'));
    }

    // Defend against prototype pollution affecting default query ordering.
    // Only treat `criteria.order` as set if it's an own property.
    const orderValue = Object.prototype.hasOwnProperty.call(criteria, 'order')
      ? criteria.order
      : undefined;
    const direction = String(orderValue ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const sequenceBounded =
      (afterId !== undefined && afterId !== null) ||
      (throughId !== undefined && throughId !== null);
    const orderClause = sequenceBounded
      ? `rowid ${direction}`
      : `timestamp ${direction}, rowid ${direction}`;
    let sql =
      `SELECT ${MESSAGE_SEQUENCE_SELECT}, * FROM messages WHERE ${conditions.join(' AND ')}` +
      ` ORDER BY ${orderClause}`;

    if (limit) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    if (offset) {
      sql += ` OFFSET ?`;
      params.push(offset);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    return rows.map((row) => this._deserializeMessage(row));
  }

  /**
   * Query guidance mailbox for cluster-wide + agent-specific guidance
   * @param {Object} criteria - Timestamp compatibility filters plus afterId/throughId sequences
   * @returns {Array} Guidance messages ordered by durable message sequence ASC
   */
  queryGuidanceMailbox(criteria) {
    const { cluster_id, target_agent_id, lastDeliveredAt, afterId, throughId, limit } =
      criteria || {};

    if (!cluster_id) {
      throw new Error('cluster_id is required for guidance mailbox queries');
    }

    const guidanceTopics = new Set(GUIDANCE_TOPICS);
    if (!guidanceTopics.has(USER_GUIDANCE_CLUSTER) || !guidanceTopics.has(USER_GUIDANCE_AGENT)) {
      throw new Error('GUIDANCE_TOPICS must include USER_GUIDANCE_CLUSTER and USER_GUIDANCE_AGENT');
    }

    let sinceTimestamp = null;
    if (lastDeliveredAt !== undefined && lastDeliveredAt !== null) {
      const candidate =
        typeof lastDeliveredAt === 'number' ? lastDeliveredAt : new Date(lastDeliveredAt).getTime();
      if (!Number.isFinite(candidate)) {
        throw new Error('lastDeliveredAt must be a number or valid date');
      }
      sinceTimestamp = candidate;
    }

    const params = [cluster_id, USER_GUIDANCE_CLUSTER];
    let sql =
      `SELECT ${MESSAGE_SEQUENCE_SELECT}, * FROM messages ` + 'WHERE cluster_id = ? AND (topic = ?';

    if (target_agent_id) {
      params.push(USER_GUIDANCE_AGENT, target_agent_id);
      sql += ' OR (topic = ? AND receiver = ?)';
    }

    sql += ')';

    if (sinceTimestamp !== null) {
      params.push(sinceTimestamp);
      sql += ' AND timestamp > ?';
    }

    if (afterId !== undefined && afterId !== null) {
      params.push(messageSequenceToSql(afterId, 'afterId'));
      sql += ' AND rowid > ?';
    }

    if (throughId !== undefined && throughId !== null) {
      params.push(messageSequenceToSql(throughId, 'throughId'));
      sql += ' AND rowid <= ?';
    }

    sql +=
      (afterId !== undefined && afterId !== null) || (throughId !== undefined && throughId !== null)
        ? ' ORDER BY rowid ASC'
        : ' ORDER BY timestamp ASC, rowid ASC';

    if (limit) {
      params.push(limit);
      sql += ' LIMIT ?';
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    return rows.map((row) => this._deserializeMessage(row));
  }

  /**
   * Find the last message matching criteria
   * @param {Object} criteria - Query criteria
   * @returns {Object|null} Last matching message
   */
  findLast(criteria) {
    const { cluster_id, topic, sender, receiver, since, until, throughId, orderBySequence } =
      criteria;

    if (!cluster_id) {
      throw new Error('cluster_id is required for queries');
    }

    // Build query with DESC order
    const conditions = ['cluster_id = ?'];
    const params = [cluster_id];

    if (topic) {
      conditions.push('topic = ?');
      params.push(topic);
    }

    if (sender) {
      conditions.push('sender = ?');
      params.push(sender);
    }

    if (receiver) {
      conditions.push('receiver = ?');
      params.push(receiver);
    }

    if (since) {
      conditions.push('timestamp >= ?');
      params.push(typeof since === 'number' ? since : new Date(since).getTime());
    }

    if (until) {
      conditions.push('timestamp <= ?');
      params.push(typeof until === 'number' ? until : new Date(until).getTime());
    }

    if (throughId !== undefined && throughId !== null) {
      conditions.push('rowid <= ?');
      params.push(messageSequenceToSql(throughId, 'throughId'));
    }

    const orderClause =
      orderBySequence || throughId !== undefined ? 'rowid DESC' : 'timestamp DESC, rowid DESC';
    const sql =
      `SELECT ${MESSAGE_SEQUENCE_SELECT}, * FROM messages WHERE ${conditions.join(' AND ')}` +
      ` ORDER BY ${orderClause} LIMIT 1`;

    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params);
    return row ? this._deserializeMessage(row) : null;
  }

  /**
   * Count messages matching criteria
   * @param {Object} criteria - Query criteria
   * @returns {Number} Message count
   */
  count(criteria) {
    const { cluster_id, topic } = criteria;

    if (!cluster_id) {
      throw new Error('cluster_id is required for count');
    }

    let sql = 'SELECT COUNT(*) as count FROM messages WHERE cluster_id = ?';
    const params = [cluster_id];

    if (topic) {
      sql += ' AND topic = ?';
      params.push(topic);
    }

    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params);
    return result.count;
  }

  /**
   * Get messages since a specific timestamp
   * @param {Object} params - { cluster_id, timestamp }
   * @returns {Array} Messages since timestamp
   */
  since(params) {
    return this.query({
      cluster_id: params.cluster_id,
      since: params.timestamp,
    });
  }

  /**
   * Get all messages for a cluster
   * @param {String} cluster_id - Cluster ID
   * @returns {Array} All messages
   */
  getAll(cluster_id) {
    const rows = this.stmts.getAll.all(cluster_id);
    return rows.map((row) => this._deserializeMessage(row));
  }

  /**
   * Iterate over all cluster messages without materializing the complete ledger.
   * @param {String} cluster_id - Cluster ID
   * @yields {Object} One deserialized message at a time
   */
  *iterateAll(cluster_id) {
    for (const row of this.stmts.getAll.iterate(cluster_id)) {
      yield this._deserializeMessage(row);
    }
  }

  /**
   * Run synchronous reads against one stable SQLite snapshot.
   * @param {Function} callback - Work to perform inside the snapshot
   * @returns {*} The callback result
   */
  withReadSnapshot(callback) {
    return this.db.transaction(callback).deferred();
  }

  /**
   * Return whether a legacy cluster requires one writable compaction pass.
   * This preflight is read-only and does not acquire a writer lock.
   * @param {String} cluster_id - Cluster ID
   * @returns {Boolean} True when actual raw output disagrees with durable budget state
   */
  needsAgentOutputReconciliation(cluster_id) {
    const hasCompactionTable = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_output_compaction'"
      )
      .get();
    const state =
      hasCompactionTable &&
      this.db.prepare('SELECT * FROM agent_output_compaction WHERE cluster_id = ?').get(cluster_id);
    const measured = this._measureCompactableAgentOutput(cluster_id);
    if (!state) return measured.retained_messages > 0;
    if (
      state.retained_messages !== measured.retained_messages ||
      state.retained_export_bytes !== measured.retained_export_bytes
    ) {
      return true;
    }
    if (state.omitted_messages === 0) return false;
    if (!state.receipt_message_id) return true;
    return !this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(state.receipt_message_id);
  }

  /**
   * Get aggregated token usage by agent role
   * Queries TOKEN_USAGE messages and sums tokens per role
   * @param {String} cluster_id - Cluster ID
   * @returns {Object} Token usage aggregated by role
   *   Example: {
   *     implementation: { inputTokens: 5000, outputTokens: 2000, totalCostUsd: 0.05, count: 3 },
   *     validator: { inputTokens: 3000, outputTokens: 1500, totalCostUsd: 0.03, count: 2 },
   *     _total: { inputTokens: 8000, outputTokens: 3500, totalCostUsd: 0.08, count: 5 }
   *   }
   */
  getTokensByRole(cluster_id) {
    if (!cluster_id) {
      throw new Error('cluster_id is required for getTokensByRole');
    }
    return this._computeTokensByRole(cluster_id);
  }

  /**
   * @private
   */
  _computeTokensByRole(cluster_id) {
    // Query all TOKEN_USAGE messages for this cluster
    const sql =
      `SELECT ${MESSAGE_SEQUENCE_SELECT}, * FROM messages WHERE cluster_id = ?` +
      ` AND topic = 'TOKEN_USAGE' ORDER BY timestamp ASC, rowid ASC`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(cluster_id);

    const byRole = {};
    const total = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0,
      count: 0,
    };

    for (const row of rows) {
      const message = this._deserializeMessage(row);
      const data = message.content?.data || {};
      const role = data.role || 'unknown';

      // Initialize role bucket if needed
      if (!byRole[role]) {
        byRole[role] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalCostUsd: 0,
          count: 0,
        };
      }

      // Aggregate tokens for this role
      byRole[role].inputTokens += data.inputTokens || 0;
      byRole[role].outputTokens += data.outputTokens || 0;
      byRole[role].cacheReadInputTokens += data.cacheReadInputTokens || 0;
      byRole[role].cacheCreationInputTokens += data.cacheCreationInputTokens || 0;
      byRole[role].totalCostUsd += data.totalCostUsd || 0;
      byRole[role].count += 1;

      // Aggregate totals
      total.inputTokens += data.inputTokens || 0;
      total.outputTokens += data.outputTokens || 0;
      total.cacheReadInputTokens += data.cacheReadInputTokens || 0;
      total.cacheCreationInputTokens += data.cacheCreationInputTokens || 0;
      total.totalCostUsd += data.totalCostUsd || 0;
      total.count += 1;
    }

    // Add total as special _total key
    byRole._total = total;

    return byRole;
  }

  /**
   * Read messageCount and tokensByRole as one consistent point-in-time view.
   * Runs both queries inside a single BEGIN DEFERRED transaction so a concurrent
   * writer's commit can never be observed by one query but not the other
   * (the exact straddle that produced the msgs=0/$0 phantom in `zeroshot list`).
   * @param {String} cluster_id - Cluster ID
   * @returns {{ messageCount: number, tokensByRole: Object }}
   */
  readSnapshot(cluster_id) {
    if (!cluster_id) {
      throw new Error('cluster_id is required for readSnapshot');
    }
    if (!this._snapshotTxn) {
      this._snapshotTxn = this.db.transaction((id) => ({
        messageCount: this.stmts.count.get(id).count,
        tokensByRole: this._computeTokensByRole(id),
      })).deferred;
    }
    return this._snapshotTxn(cluster_id);
  }

  /**
   * Subscribe to new messages
   * @param {Function} callback - Called with each new message
   * @returns {Function} Unsubscribe function
   */
  subscribe(callback) {
    this.on('message', callback);
    return () => this.off('message', callback);
  }

  /**
   * Poll for new messages (cross-process support)
   * @param {String} clusterId - Cluster ID to poll (null for all clusters)
   * @param {Function} callback - Called with each new message
   * @param {Number} intervalMs - Poll interval (default 500ms)
   * @param {Number} initialCount - Number of messages to show initially (default 300)
   * @returns {Function} Stop polling function
   */
  pollForMessages(clusterId, callback, intervalMs = 500, initialCount = 300) {
    let lastSequence = '0';
    let lastMessageIds = new Set();
    let isFirstPoll = true;

    const poll = () => {
      try {
        let sql, params;

        if (isFirstPoll) {
          // First poll: get last N messages by count
          if (clusterId) {
            sql =
              `SELECT * FROM (SELECT ${MESSAGE_SEQUENCE_SELECT}, * FROM messages ` +
              'WHERE cluster_id = ? ORDER BY rowid DESC LIMIT ?) ' +
              'ORDER BY CAST(sequence AS INTEGER) ASC';
            params = [clusterId, initialCount];
          } else {
            sql =
              `SELECT * FROM (SELECT ${MESSAGE_SEQUENCE_SELECT}, * FROM messages ` +
              'ORDER BY rowid DESC LIMIT ?) ORDER BY CAST(sequence AS INTEGER) ASC';
            params = [initialCount];
          }
          isFirstPoll = false;
        } else {
          // Subsequent polls: get messages after the exact durable sequence.
          if (clusterId) {
            sql =
              `SELECT ${MESSAGE_SEQUENCE_SELECT}, * FROM messages ` +
              'WHERE cluster_id = ? AND rowid > ? ORDER BY rowid ASC';
            params = [clusterId, messageSequenceToSql(lastSequence)];
          } else {
            sql =
              `SELECT ${MESSAGE_SEQUENCE_SELECT}, * FROM messages ` +
              'WHERE rowid > ? ORDER BY rowid ASC';
            params = [messageSequenceToSql(lastSequence)];
          }
        }

        const stmt = this.db.prepare(sql);
        const rows = stmt.all(...params);

        for (const row of rows) {
          // Skip already-seen messages
          if (lastMessageIds.has(row.id)) continue;

          lastMessageIds.add(row.id);
          const message = this._deserializeMessage(row);
          callback(message);

          // Rows are delivered in SQLite rowid order, so the final row is the
          // exact database-serialized high-water mark.
          lastSequence = messageSequenceFromSql(row.sequence);
        }

        // Prune old message IDs to prevent memory leak
        if (lastMessageIds.size > 10000) {
          const idsArray = Array.from(lastMessageIds);
          lastMessageIds = new Set(idsArray.slice(-5000));
        }
      } catch (error) {
        // DB busy is expected during concurrent access - log but continue polling
        // Other errors indicate real bugs and should be visible
        console.error(`[Ledger] pollForMessages error (will retry): ${error.message}`);
      }
    };

    // Initial poll
    poll();

    // Set up interval
    const intervalId = setInterval(poll, intervalMs);

    // Return stop function
    return () => clearInterval(intervalId);
  }

  /**
   * Subscribe to specific topic
   * @param {String} topic - Topic to subscribe to
   * @param {Function} callback - Called with matching messages
   * @returns {Function} Unsubscribe function
   */
  subscribeTopic(topic, callback) {
    const event = `topic:${topic}`;
    this.on(event, callback);
    return () => this.off(event, callback);
  }

  /**
   * Deserialize a database row into a message object
   * @private
   */
  _deserializeMessage(row) {
    const message = {
      id: row.id,
      sequence:
        row.sequence === undefined
          ? undefined
          : messageSequenceFromSql(row.sequence, 'stored message sequence'),
      timestamp: row.timestamp,
      topic: row.topic,
      sender: row.sender,
      receiver: row.receiver,
      cluster_id: row.cluster_id,
    };

    if (row.content_text || row.content_data) {
      message.content = {};
      if (row.content_text) {
        message.content.text = row.content_text;
      }
      if (row.content_data) {
        try {
          message.content.data = JSON.parse(row.content_data);
        } catch {
          message.content.data = null;
        }
      }
    }

    if (row.metadata) {
      try {
        message.metadata = JSON.parse(row.metadata);
      } catch {
        message.metadata = null;
      }
    }

    return message;
  }

  /**
   * Close the database connection
   */
  close() {
    if (this._closed) {
      return;
    }
    this._closed = true; // Set flag BEFORE closing to prevent race conditions
    this.db.close();
  }

  /**
   * Clear all messages (for testing)
   */
  clear() {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM messages');
      if (this.compactionStmts) {
        this.compactionStmts.deleteState.run();
      }
    })();
    this.cache.clear();
  }
}

Ledger.AGENT_OUTPUT_EXPORT_LIMITS = Object.freeze({
  maxBytes: AGENT_OUTPUT_EXPORT_MAX_BYTES,
  maxMessages: AGENT_OUTPUT_EXPORT_MAX_MESSAGES,
});

module.exports = Ledger;
