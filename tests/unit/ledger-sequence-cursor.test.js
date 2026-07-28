const assert = require('assert');
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Ledger = require('../../src/ledger');
const { compareMessageSequences, MAX_SQLITE_ROWID } = require('../../src/ledger-sequence');
const { normalizeProviderSession } = require('../../src/agent/provider-session');

const WRITER_FIXTURE = path.resolve(__dirname, '../fixtures/ledger-sequence-writer.js');

function waitForMessage(child, type) {
  return new Promise((resolve, reject) => {
    let onMessage;
    let onExit;
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    onMessage = (message) => {
      if (message.type === 'error') {
        cleanup();
        reject(new Error(message.error));
      } else if (message.type === type) {
        cleanup();
        resolve(message);
      }
    };
    onExit = (code) => {
      cleanup();
      reject(new Error(`ledger sequence writer exited before ${type} with code ${code}`));
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

describe('durable ledger sequence cursors', function () {
  it('orders same-millisecond writes from independent processes without loss', async function () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-ledger-sequence-'));
    const dbPath = path.join(tempDir, 'ledger.db');
    const clusterId = 'same-millisecond-cluster';
    const initializer = new Ledger(dbPath);
    initializer.close();

    const children = ['writer-a', 'writer-b'].map((sender) =>
      fork(WRITER_FIXTURE, [dbPath, clusterId, sender], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      })
    );

    try {
      await Promise.all(children.map((child) => waitForMessage(child, 'ready')));
      const timestamp = Date.now() + 60_000;
      const results = children.map((child) => {
        const appended = waitForMessage(child, 'appended');
        child.send({ timestamp });
        return appended;
      });
      const writes = (await Promise.all(results))
        .map(({ message }) => message)
        .sort((left, right) => compareMessageSequences(left.sequence, right.sequence));

      assert.strictEqual(writes[0].timestamp, timestamp);
      assert.strictEqual(writes[1].timestamp, timestamp);
      assert.strictEqual(compareMessageSequences(writes[0].sequence, writes[1].sequence), -1);

      const guidanceLedgers = [new Ledger(dbPath), new Ledger(dbPath)];
      const guidanceTimestamp = timestamp + 1;
      const guidanceWrites = guidanceLedgers
        .map((ledger, index) =>
          ledger.append({
            cluster_id: clusterId,
            topic: 'USER_GUIDANCE_AGENT',
            sender: `operator-${index}`,
            receiver: 'worker',
            timestamp: guidanceTimestamp,
            content: { text: `guidance-${index}` },
          })
        )
        .sort((left, right) => compareMessageSequences(left.sequence, right.sequence));
      guidanceLedgers.forEach((ledger) => ledger.close());
      assert.strictEqual(guidanceWrites[0].timestamp, guidanceTimestamp);
      assert.strictEqual(guidanceWrites[1].timestamp, guidanceTimestamp);

      const reader = new Ledger(dbPath, { readonly: true });
      try {
        const delta = reader.query({
          cluster_id: clusterId,
          afterId: writes[0].sequence,
          throughId: writes[1].sequence,
        });
        assert.deepStrictEqual(
          delta.map((message) => message.id),
          [writes[1].id],
          'a sequence-bounded continuation must include the second colliding write exactly once'
        );
        const guidanceDelta = reader.queryGuidanceMailbox({
          cluster_id: clusterId,
          target_agent_id: 'worker',
          afterId: guidanceWrites[0].sequence,
          throughId: guidanceWrites[1].sequence,
        });
        assert.deepStrictEqual(
          guidanceDelta.map((message) => message.id),
          [guidanceWrites[1].id],
          'guidance must use the same exact sequence bounds'
        );
      } finally {
        reader.close();
      }
    } finally {
      for (const child of children) {
        if (child.connected) {
          child.disconnect();
        }
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves adjacent rowids above Number.MAX_SAFE_INTEGER through queries and JSON state', function () {
    const ledger = new Ledger(':memory:');
    const clusterId = 'high-rowid-cluster';
    const first = 9007199254740992n;
    const rows = [
      [first, 'source-a', 'VALIDATION_RESULT', 'validator', 'broadcast'],
      [first + 1n, 'source-b', 'VALIDATION_RESULT', 'validator', 'broadcast'],
      [first + 2n, 'guidance-a', 'USER_GUIDANCE_AGENT', 'operator', 'worker'],
      [first + 3n, 'guidance-b', 'USER_GUIDANCE_AGENT', 'operator', 'worker'],
    ];
    const insert = ledger.db.prepare(`
      INSERT INTO messages (
        rowid, id, timestamp, topic, sender, receiver, content_text, content_data, metadata, cluster_id
      ) VALUES (
        @rowid, @id, @timestamp, @topic, @sender, @receiver, @text, NULL, NULL, @clusterId
      )
    `);

    try {
      for (const [rowid, id, topic, sender, receiver] of rows) {
        insert.run({
          rowid,
          id,
          timestamp: 1000,
          topic,
          sender,
          receiver,
          text: id,
          clusterId,
        });
      }

      const all = ledger.query({
        cluster_id: clusterId,
        afterId: (first - 1n).toString(),
        throughId: (first + 3n).toString(),
      });
      assert.deepStrictEqual(
        all.map(({ id, sequence }) => [id, sequence]),
        rows.map(([rowid, id]) => [id, rowid.toString()])
      );
      assert.strictEqual(new Set(all.map((message) => message.id)).size, rows.length);

      const sourceDelta = ledger.query({
        cluster_id: clusterId,
        topic: 'VALIDATION_RESULT',
        afterId: first.toString(),
        throughId: (first + 1n).toString(),
      });
      assert.deepStrictEqual(
        sourceDelta.map((message) => message.id),
        ['source-b']
      );

      const guidanceDelta = ledger.queryGuidanceMailbox({
        cluster_id: clusterId,
        target_agent_id: 'worker',
        afterId: (first + 2n).toString(),
        throughId: (first + 3n).toString(),
      });
      assert.deepStrictEqual(
        guidanceDelta.map((message) => message.id),
        ['guidance-b']
      );
      assert.strictEqual(
        ledger.findLast({ cluster_id: clusterId, orderBySequence: true }).sequence,
        (first + 3n).toString()
      );

      const persisted = JSON.parse(
        JSON.stringify(
          normalizeProviderSession({
            provider: 'claude',
            sessionId: 'high-rowid-session',
            agentId: 'worker',
            taskId: 'task-high-rowid',
            generation: 1,
            cwd: '/tmp/high-rowid',
            worktreePath: null,
            contextSequence: sourceDelta[0].sequence,
            guidanceSequence: guidanceDelta[0].sequence,
            promptIdentity: null,
          })
        )
      );
      assert.strictEqual(persisted.contextSequence, (first + 1n).toString());
      assert.strictEqual(persisted.guidanceSequence, (first + 3n).toString());

      const appended = ledger.append({
        cluster_id: clusterId,
        topic: 'VALIDATION_RESULT',
        sender: 'validator',
        content: { text: 'source-c' },
      });
      assert.strictEqual(appended.sequence, (first + 4n).toString());

      for (const invalid of [
        '',
        '01',
        '-1',
        (MAX_SQLITE_ROWID + 1n).toString(),
        Number.MAX_SAFE_INTEGER + 1,
        first,
      ]) {
        assert.throws(
          () => ledger.query({ cluster_id: clusterId, afterId: invalid }),
          /canonical non-negative decimal string|SQLite rowid range/
        );
      }
      assert.throws(
        () => ledger.query({ cluster_id: clusterId, throughId: '01' }),
        /canonical non-negative decimal string/
      );
      assert.strictEqual(
        normalizeProviderSession({
          ...persisted,
          contextSequence: (MAX_SQLITE_ROWID + 1n).toString(),
        }),
        null
      );
    } finally {
      ledger.close();
    }
  });
});
