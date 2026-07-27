const assert = require('assert');
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Ledger = require('../../src/ledger');

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
        .sort((left, right) => left.sequence - right.sequence);

      assert.strictEqual(writes[0].timestamp, timestamp);
      assert.strictEqual(writes[1].timestamp, timestamp);
      assert.ok(writes[0].sequence < writes[1].sequence);

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
        .sort((left, right) => left.sequence - right.sequence);
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
});
