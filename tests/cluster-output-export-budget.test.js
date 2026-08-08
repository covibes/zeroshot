const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { streamClusterJsonExport } = require('../cli/json-export');
const Ledger = require('../src/ledger');
const MessageBus = require('../src/message-bus');

const EXPORT_LIMIT = 64 * 1024 * 1024;
const CLI_PATH = path.resolve(__dirname, '..', 'cli', 'index.js');
const RAW_METADATA = { contextSafe: false, replayPolicy: 'raw_log_only' };

const rawOutput = (id, line) => ({
  id,
  cluster_id: 'sequence-reservation',
  topic: 'AGENT_OUTPUT',
  sender: 'worker',
  metadata: RAW_METADATA,
  content: { data: { line } },
});

function extendDigest(previousDigest, message) {
  const messageBytes = Buffer.from(JSON.stringify(message));
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(messageBytes.length));
  return createHash('sha256')
    .update(Buffer.from(previousDigest, 'hex'))
    .update(length)
    .update(messageBytes)
    .digest('hex');
}

function insertLegacyMessage(insert, message) {
  const contentData = message.content?.data ? JSON.stringify(message.content.data) : null;
  const metadata = message.metadata ? JSON.stringify(message.metadata) : null;
  const result = insert.run(
    message.id,
    message.timestamp,
    message.topic,
    message.sender,
    'broadcast',
    message.content?.text || null,
    contentData,
    metadata,
    message.cluster_id
  );
  const exported = {
    id: message.id,
    sequence: String(result.lastInsertRowid),
    timestamp: message.timestamp,
    topic: message.topic,
    sender: message.sender,
    receiver: 'broadcast',
    cluster_id: message.cluster_id,
  };
  if (message.content) exported.content = message.content;
  if (message.metadata) exported.metadata = message.metadata;
  return exported;
}

function createLegacyDatabase(databasePath, clusterId) {
  const database = new Database(databasePath);
  database.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, topic TEXT NOT NULL,
    sender TEXT NOT NULL, receiver TEXT NOT NULL, content_text TEXT,
    content_data TEXT, metadata TEXT, cluster_id TEXT NOT NULL
  )`);
  const insert = database.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const payload = 'x'.repeat(1024 * 1024);
  const digestPrefixes = [];
  let digest = '0'.repeat(64);
  let timestamp = 1800000000000;
  const add = (id, topic, content, metadata) =>
    insertLegacyMessage(insert, {
      id,
      timestamp: timestamp++,
      topic,
      sender: 'worker',
      cluster_id: clusterId,
      content,
      metadata,
    });
  const insertAll = database.transaction(() => {
    for (let record = 0; record < 66; record += 1) {
      const output = add(
        `raw-${record}`,
        'AGENT_OUTPUT',
        { data: { line: `initial:${record}:${payload}`, record, type: 'text' } },
        RAW_METADATA
      );
      digest = extendDigest(digest, output);
      digestPrefixes.push(digest);
      if (record < 24) {
        add(`control-${record}`, 'EXECUTION_FINISHED', { data: { execution: record } });
        add(
          `context-${record}`,
          'AGENT_OUTPUT',
          { text: `context-safe-${record}` },
          { contextSafe: true, replayPolicy: 'context' }
        );
      }
    }
  });
  insertAll();
  return {
    database,
    digestPrefixes,
    insertStale(count) {
      database.transaction(() => {
        for (let record = 0; record < count; record += 1) {
          const output = add(
            `stale-${digestPrefixes.length}`,
            'AGENT_OUTPUT',
            { data: { line: `stale:${record}:${payload}`, record, type: 'text' } },
            RAW_METADATA
          );
          digest = extendDigest(digest, output);
          digestPrefixes.push(digest);
        }
      })();
    },
  };
}

function runCliExport(homeDir, clusterId, outputPath) {
  const result = spawnSync(
    process.execPath,
    [CLI_PATH, 'export', clusterId, '--format', 'json', '--output', outputPath],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir, NODE_OPTIONS: '--max-old-space-size=128' },
      timeout: 30000,
    }
  );
  assert.strictEqual(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
}

function findReceipt(ledger, clusterId) {
  return [...ledger.iterateAll(clusterId)].find((row) => row.metadata?.compactionReceipt);
}

function runLegacyUpgradeStress() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-legacy-output-'));
  const clusterId = 'legacy-output-stress';
  const databaseDir = path.join(homeDir, '.zeroshot');
  fs.mkdirSync(databaseDir);
  const databasePath = path.join(databaseDir, `${clusterId}.db`);
  const exportPath = path.join(homeDir, 'export.json');
  const legacy = createLegacyDatabase(databasePath, clusterId);
  try {
    assert.ok(fs.statSync(databasePath).size > EXPORT_LIMIT);
    runCliExport(homeDir, clusterId, exportPath);
    const directExport = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    let ledger = new Ledger(databasePath, { readonly: true });
    const directCount = ledger.readSnapshot(clusterId).messageCount;
    const directReceipt = findReceipt(ledger, clusterId);
    assert.ok(fs.statSync(exportPath).size < EXPORT_LIMIT);
    assert.strictEqual(directExport.messages.length, directCount);
    assert.strictEqual(
      directReceipt.content.data.sha256Chain,
      legacy.digestPrefixes[directReceipt.content.data.omittedMessages - 1]
    );
    ledger.close();

    ledger = new Ledger(databasePath, { readonly: true });
    ledger.withReadSnapshot(() => {
      assert.strictEqual(ledger.needsAgentOutputReconciliation(clusterId), false);
      legacy.insertStale(1);
      assert.strictEqual(legacy.database.pragma('journal_mode', { simple: true }), 'wal');
      streamClusterJsonExport({ ledger, clusterId, outputPath: exportPath });
    });
    ledger.close();
    assert.strictEqual(JSON.parse(fs.readFileSync(exportPath)).messages.length, directCount);
    legacy.insertStale(59);
    runCliExport(homeDir, clusterId, exportPath);
    const repaired = JSON.parse(fs.readFileSync(exportPath));
    ledger = new Ledger(databasePath, { readonly: true });
    const repairedCount = ledger.readSnapshot(clusterId).messageCount;
    const repairedReceipt = findReceipt(ledger, clusterId);
    assert.ok(fs.statSync(exportPath).size < EXPORT_LIMIT);
    assert.strictEqual(repaired.messages.length, repairedCount);
    assert.strictEqual(
      repairedReceipt.content.data.sha256Chain,
      legacy.digestPrefixes[repairedReceipt.content.data.omittedMessages - 1]
    );
    ledger.close();
    runCliExport(homeDir, clusterId, exportPath);
    assert.strictEqual(JSON.parse(fs.readFileSync(exportPath)).messages.length, repairedCount);

    ledger = new Ledger(databasePath);
    const messageBus = new MessageBus(ledger);
    let liveOutput = 0;
    const unsubscribe = messageBus.subscribeTopic('AGENT_OUTPUT', () => (liveOutput += 1));
    messageBus.publish({
      cluster_id: clusterId,
      topic: 'AGENT_OUTPUT',
      sender: 'worker',
      metadata: RAW_METADATA,
      content: { data: { line: 'newest-live-terminal', type: 'text' } },
    });
    assert.strictEqual(liveOutput, 1);
    const messageCount = ledger.readSnapshot(clusterId).messageCount;
    unsubscribe();
    messageBus.close();

    runCliExport(homeDir, clusterId, exportPath);
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    assert.ok(fs.statSync(exportPath).size < EXPORT_LIMIT);
    assert.strictEqual(exported.messages.length, messageCount);
    assert.strictEqual(
      exported.messages.filter((row) => row.topic === 'EXECUTION_FINISHED').length,
      24
    );
    assert.strictEqual(exported.messages.filter((row) => row.metadata?.contextSafe).length, 24);
    assert.ok(exported.messages.some((row) => row.content?.data?.line === 'newest-live-terminal'));
  } finally {
    legacy.database.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function runSinkFailureRegression() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-export-sink-'));
  const ledger = new Ledger(':memory:');
  ledger.append({ cluster_id: 'sink', topic: 'CONTROL', sender: 'worker', content: { text: 'x' } });
  const iterator = ledger.iterateAll('sink');
  const lifecycle = [];
  ledger.iterateAll = () => ({
    next: () => iterator.next(),
    return: () => {
      lifecycle.push('iterator');
      return iterator.return();
    },
  });
  const originalWrite = fs.writeSync;
  const originalClose = fs.closeSync;
  let writes = 0;
  fs.writeSync = (...args) => {
    if ((writes += 1) === 3) throw new Error('injected sink failure');
    return originalWrite(...args);
  };
  fs.closeSync = (...args) => {
    lifecycle.push('destination');
    return originalClose(...args);
  };
  try {
    assert.throws(
      () =>
        streamClusterJsonExport({ ledger, clusterId: 'sink', outputPath: path.join(tempDir, 'x') }),
      /injected sink failure/
    );
  } finally {
    fs.writeSync = originalWrite;
    fs.closeSync = originalClose;
  }
  ledger.close();
  lifecycle.push('ledger');
  assert.deepStrictEqual(lifecycle, ['iterator', 'destination', 'ledger']);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function runSequenceReservationRegression() {
  const ledger = new Ledger(':memory:');
  const oversized = 'o'.repeat(Ledger.AGENT_OUTPUT_EXPORT_LIMITS.maxBytes + 1024);
  const sequences = [
    ledger.append(rawOutput('oversized-first', oversized)).sequence,
    ledger.append(rawOutput('oversized-second', oversized)).sequence,
    ...ledger
      .batchAppend([
        rawOutput('oversized-batch', oversized),
        rawOutput('small-batch', 'batch-terminal'),
      ])
      .map((row) => row.sequence),
    ledger.append(rawOutput('small-final', 'final-terminal')).sequence,
  ];
  assert.strictEqual(new Set(sequences).size, sequences.length);
  for (let index = 1; index < sequences.length; index += 1) {
    assert.ok(BigInt(sequences[index]) > BigInt(sequences[index - 1]));
  }
  const afterFirst = ledger.query({ cluster_id: 'sequence-reservation', afterId: sequences[0] });
  const receipt = afterFirst.find((row) => row.metadata?.compactionReceipt);
  assert.deepStrictEqual(
    afterFirst.map((row) => row.sequence),
    [receipt.sequence, sequences[3], sequences[4]]
  );
  ledger.close();
}

describe('cluster-wide provider-output export budget', function () {
  this.timeout(120000);
  it('reconciles and exports a >64 MiB legacy ledger under 128 MiB', runLegacyUpgradeStress);
  it('closes export resources in order on sink failure', runSinkFailureRegression);
  it('never reuses deleted oversized output sequences', runSequenceReservationRegression);
});
