const assert = require('assert');
const AgentWrapper = require('../src/agent-wrapper');
const MessageBus = require('../src/message-bus');
const Ledger = require('../src/ledger');
const { buildContextPacks } = require('../src/agent/context-pack-builder');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('context packs', () => {
  let tempDir;
  let ledger;
  let messageBus;
  let clusterId;
  let clusterCreatedAt;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-context-packs-'));
    const dbPath = path.join(tempDir, 'test-ledger.db');

    ledger = new Ledger(dbPath);
    messageBus = new MessageBus(ledger);

    clusterId = 'test-cluster-789';
    clusterCreatedAt = Date.now();
  });

  afterEach(() => {
    if (ledger) ledger.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  function createWorker(contextStrategy) {
    const workerConfig = {
      id: 'worker',
      role: 'implementation',
      modelLevel: 'level2',
      timeout: 0,
      contextStrategy,
    };

    const mockCluster = {
      id: clusterId,
      createdAt: clusterCreatedAt,
      agents: [],
    };

    return new AgentWrapper(workerConfig, messageBus, mockCluster, {
      testMode: true,
      mockSpawnFn: () => {},
    });
  }

  function publishMessage(topic, text, timestamp) {
    messageBus.publish({
      cluster_id: clusterId,
      topic,
      sender: 'system',
      content: { text },
      timestamp,
    });
  }

  function buildTriggeringMessage(timestamp, text = 'triggered') {
    return {
      id: 'msg_triggering_context',
      topic: 'WORKER_PROGRESS',
      sender: 'system',
      timestamp,
      content: { text, data: { attachmentRef: 'attachment://input', recordCount: 17 } },
      metadata: { source: 'connector', _originalTimestamp: timestamp - 1000 },
    };
  }

  it('keeps triggering message and required anchors under tight budgets', () => {
    const baseTime = Date.now();
    publishMessage('ISSUE_OPENED', 'Implement feature X', baseTime);
    publishMessage('PLAN_READY', '1. Do the thing', baseTime + 10);
    publishMessage('OPTIONAL_TOPIC', 'optional-detail', baseTime + 20);
    publishMessage('VALIDATION_RESULT', 'rejected: missing test', baseTime + 30);

    const worker = createWorker({
      sources: [
        { topic: 'ISSUE_OPENED', amount: 1 },
        { topic: 'PLAN_READY', amount: 1 },
        { topic: 'OPTIONAL_TOPIC', amount: 3 },
        { topic: 'VALIDATION_RESULT', amount: 3 },
      ],
      maxTokens: 1,
    });

    const context = worker._buildContext(buildTriggeringMessage(baseTime + 40, 'kickoff'));

    assert(context.includes('## Triggering Message'), 'Triggering message section must exist');
    assert(context.includes('kickoff'), 'Triggering message content must be preserved');
    assert(context.includes('msg_triggering_context'), 'Triggering message id must be visible');
    assert(context.includes('attachment://input'), 'Structured triggering data must be visible');
    assert(context.includes('"recordCount": 17'), 'Structured values must be visible');
    assert(context.includes('"source": "connector"'), 'Triggering metadata must be visible');
    assert(
      context.includes('"_originalTimestamp"'),
      'Original request-time provenance must be visible'
    );
    assert(context.includes('Messages from topic: ISSUE_OPENED'), 'Issue anchor must be preserved');
    assert(context.includes('Messages from topic: PLAN_READY'), 'Plan anchor must be preserved');
    assert(!context.includes('optional-detail'), 'Low-priority context should be dropped');
  });

  it('compacts high-priority packs before skipping low-priority packs', () => {
    const packs = [
      {
        id: 'header',
        section: 'header',
        priority: 'required',
        render: () => 'REQ\n',
      },
      {
        id: 'high',
        section: 'sources',
        priority: 'high',
        render: () => 'H'.repeat(40),
        compact: () => 'H\n',
      },
      {
        id: 'low',
        section: 'sources',
        priority: 'low',
        render: () => 'L'.repeat(40),
        compact: () => 'L\n',
      },
      {
        id: 'trigger',
        section: 'triggeringMessage',
        priority: 'required',
        preserve: true,
        render: () => 'TRIG\n',
      },
    ];

    const result = buildContextPacks({ packs, maxTokens: 4 });
    const highPack = result.packDecisions.find((pack) => pack.id === 'high');
    const lowPack = result.packDecisions.find((pack) => pack.id === 'low');

    assert.strictEqual(highPack.status, 'included');
    assert.strictEqual(highPack.variant, 'compact');
    assert.strictEqual(lowPack.status, 'skipped');
    assert(result.context.includes('H\n'), 'High-priority compact content should be included');
    assert(!result.context.includes('L'.repeat(40)), 'Low-priority full content should be dropped');
  });
});
