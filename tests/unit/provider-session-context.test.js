const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AgentWrapper = require('../../src/agent-wrapper');
const Ledger = require('../../src/ledger');
const MessageBus = require('../../src/message-bus');

describe('provider-session continuation context', function () {
  let tempDir;
  let ledger;
  let messageBus;
  let priorSettingsFile;

  beforeEach(function () {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-session-context-'));
    priorSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;
    process.env.ZEROSHOT_SETTINGS_FILE = path.join(tempDir, 'settings.json');
    fs.writeFileSync(
      process.env.ZEROSHOT_SETTINGS_FILE,
      JSON.stringify({ backoffBaseMs: 0, backoffMaxMs: 0, jitterFactor: 0 })
    );
    ledger = new Ledger(path.join(tempDir, 'ledger.db'));
    messageBus = new MessageBus(ledger);
  });

  afterEach(function () {
    ledger.close();
    if (priorSettingsFile === undefined) {
      delete process.env.ZEROSHOT_SETTINGS_FILE;
    } else {
      process.env.ZEROSHOT_SETTINGS_FILE = priorSettingsFile;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('sends static context once and only the new turn delta after resume', function () {
    const cluster = {
      id: 'session-context-cluster',
      createdAt: Date.now(),
      agents: [],
    };
    const agent = new AgentWrapper(
      {
        id: 'worker',
        role: 'implementation',
        provider: 'claude',
        prompt: 'STATIC-WORKER-INSTRUCTIONS',
        timeout: 0,
        contextStrategy: {
          sources: [
            { topic: 'ISSUE_OPENED', limit: 1 },
            { topic: 'PLAN_READY', limit: 1 },
            { topic: 'VALIDATION_RESULT', limit: 5 },
          ],
        },
      },
      messageBus,
      cluster,
      {
        testMode: true,
        mockSpawnFn: () => ({ success: true, output: '{}' }),
      }
    );
    const cwd = path.resolve(agent.config.cwd || process.cwd());

    messageBus.publish({
      cluster_id: cluster.id,
      topic: 'ISSUE_OPENED',
      sender: 'system',
      content: { text: 'STATIC-ISSUE-OPENED' },
    });
    messageBus.publish({
      cluster_id: cluster.id,
      topic: 'PLAN_READY',
      sender: 'planner',
      content: { text: 'STATIC-PLAN-READY' },
    });
    messageBus.publish({
      cluster_id: cluster.id,
      topic: 'VALIDATION_RESULT',
      sender: 'validator-old',
      content: { text: 'OLD-VALIDATION-RESULT' },
    });

    agent.iteration = 1;
    const firstContext = agent._buildContext({
      topic: 'ISSUE_OPENED',
      sender: 'system',
      content: { text: 'FIRST-TURN-TRIGGER' },
    });
    assert.match(firstContext, /STATIC-WORKER-INSTRUCTIONS/);
    assert.match(firstContext, /STATIC-ISSUE-OPENED/);
    assert.match(firstContext, /STATIC-PLAN-READY/);

    agent.providerSession = {
      provider: 'claude',
      sessionId: 'session-generation-1',
      agentId: 'worker',
      taskId: 'task-generation-1',
      generation: 1,
      cwd,
      worktreePath: null,
    };
    const deltaTimestamp = agent.lastAgentStartTime + 10;
    messageBus.publish({
      cluster_id: cluster.id,
      topic: 'VALIDATION_RESULT',
      sender: 'validator-a',
      timestamp: deltaTimestamp,
      content: { text: 'NEW-VALIDATION-A' },
    });
    messageBus.publish({
      cluster_id: cluster.id,
      topic: 'VALIDATION_RESULT',
      sender: 'validator-b',
      timestamp: deltaTimestamp + 1,
      content: { text: 'NEW-VALIDATION-B' },
    });
    agent.iteration = 2;
    const secondContext = agent._buildContext({
      topic: 'VALIDATION_RESULT',
      sender: 'validator',
      timestamp: deltaTimestamp + 2,
      content: { text: 'NEW-REJECTION-DELTA' },
    });

    assert.match(secondContext, /Continuation Turn/);
    assert.match(secondContext, /NEW-REJECTION-DELTA/);
    assert.match(secondContext, /NEW-VALIDATION-A/);
    assert.match(secondContext, /NEW-VALIDATION-B/);
    assert.doesNotMatch(secondContext, /STATIC-WORKER-INSTRUCTIONS/);
    assert.doesNotMatch(secondContext, /STATIC-ISSUE-OPENED/);
    assert.doesNotMatch(secondContext, /STATIC-PLAN-READY/);
    assert.doesNotMatch(secondContext, /FIRST-TURN-TRIGGER/);
    assert.doesNotMatch(secondContext, /OLD-VALIDATION-RESULT/);
  });

  it('clears a failed logical result before the retry is constructed', async function () {
    const cluster = { id: 'retry-cluster', createdAt: Date.now(), agents: [] };
    let attempts = 0;
    let agent;

    agent = new AgentWrapper(
      {
        id: 'worker',
        role: 'implementation',
        provider: 'claude',
        prompt: 'STATIC-RETRY-INSTRUCTIONS',
        outputFormat: 'text',
        maxRetries: 2,
        timeout: 0,
        contextStrategy: { sources: [] },
      },
      messageBus,
      cluster,
      {
        testMode: true,
        quiet: true,
        mockSpawnFn: (args, { context }) => {
          attempts += 1;
          if (attempts === 1) {
            return {
              success: false,
              error: 'logical schema failure',
              providerSession: {
                provider: 'claude',
                sessionId: 'must-not-resume',
                agentId: 'worker',
                taskId: 'failed-task',
                generation: 1,
                cwd: path.resolve(agent.config.cwd || process.cwd()),
                worktreePath: null,
              },
            };
          }

          assert.strictEqual(agent.providerSession, null);
          assert.ok(!args.includes('--resume'));
          assert.match(context, /STATIC-RETRY-INSTRUCTIONS/);
          return { success: true, output: 'done', providerSession: null };
        },
      }
    );
    agent.running = true;

    await agent._executeTask({
      topic: 'ISSUE_OPENED',
      sender: 'system',
      content: { text: 'retry me' },
    });

    assert.strictEqual(attempts, 2);
    assert.strictEqual(agent.providerSession, null);
    const failed = messageBus
      .query({
        cluster_id: cluster.id,
        topic: 'AGENT_LIFECYCLE',
        sender: 'worker',
      })
      .find((message) => message.content?.data?.event === 'TASK_FAILED');
    assert.ok(failed, 'failed attempt must be durable before retry');
  });
});
