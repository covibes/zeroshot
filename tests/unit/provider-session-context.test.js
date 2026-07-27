const assert = require('assert');
const path = require('path');

const {
  createProviderSessionAgent,
  createProviderSessionHarness,
} = require('../helpers/provider-session-harness');

describe('provider-session continuation context', function () {
  let harness;
  let messageBus;

  beforeEach(function () {
    harness = createProviderSessionHarness('zeroshot-session-context-');
    messageBus = harness.messageBus;
  });

  afterEach(function () {
    harness.cleanup();
  });

  it('uses the exact durable cursor after restart and de-duplicates the triggering message', function () {
    const cluster = {
      id: 'session-context-cluster',
      createdAt: Date.now(),
      agents: [],
    };
    const agent = createProviderSessionAgent({
      cluster,
      messageBus,
      config: {
        prompt: 'STATIC-WORKER-INSTRUCTIONS',
        contextStrategy: {
          sources: [
            { topic: 'ISSUE_OPENED', limit: 1 },
            { topic: 'PLAN_READY', limit: 1 },
            { topic: 'VALIDATION_RESULT', limit: 5 },
          ],
        },
      },
    });
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
    messageBus.publish({
      cluster_id: cluster.id,
      topic: 'USER_GUIDANCE_AGENT',
      sender: 'operator',
      receiver: 'worker',
      content: { text: 'FIRST-TURN-GUIDANCE' },
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
    assert.match(firstContext, /FIRST-TURN-GUIDANCE/);

    agent.providerSession = {
      provider: 'claude',
      sessionId: 'session-generation-1',
      agentId: 'worker',
      taskId: 'task-generation-1',
      generation: 1,
      cwd,
      worktreePath: null,
      contextCursor: agent.currentContextCursor,
      guidanceCursor: agent.currentGuidanceCursor,
      promptText: agent.currentPromptText,
    };
    const firstPostTurn = messageBus.publish({
      cluster_id: cluster.id,
      topic: 'VALIDATION_RESULT',
      sender: 'validator-a',
      content: { text: 'NEW-VALIDATION-A' },
    });
    messageBus.publish({
      cluster_id: cluster.id,
      topic: 'VALIDATION_RESULT',
      sender: 'validator-b',
      content: { text: 'NEW-VALIDATION-B' },
    });
    const trigger = messageBus.publish({
      cluster_id: cluster.id,
      topic: 'VALIDATION_RESULT',
      sender: 'validator',
      content: { text: 'NEW-REJECTION-DELTA' },
    });
    messageBus.publish({
      cluster_id: cluster.id,
      topic: 'USER_GUIDANCE_AGENT',
      sender: 'operator',
      receiver: 'worker',
      content: { text: 'SECOND-TURN-GUIDANCE' },
    });

    const restoredAgent = createProviderSessionAgent({
      cluster,
      messageBus,
      config: agent.config,
      runtime: { providerCliFeatures: { claude: { supportsResume: true } } },
    });
    restoredAgent.providerSession = agent.providerSession;
    restoredAgent.lastGuidanceAppliedAt = agent.providerSession.guidanceCursor;
    restoredAgent.iteration = 2;

    assert.ok(firstPostTurn.timestamp > restoredAgent.providerSession.contextCursor);
    agent.iteration = 2;
    const secondContext = restoredAgent._buildContext(trigger);

    assert.match(secondContext, /Continuation Turn/);
    assert.match(secondContext, /NEW-REJECTION-DELTA/);
    assert.match(secondContext, /NEW-VALIDATION-A/);
    assert.match(secondContext, /NEW-VALIDATION-B/);
    assert.doesNotMatch(secondContext, /STATIC-WORKER-INSTRUCTIONS/);
    assert.doesNotMatch(secondContext, /STATIC-ISSUE-OPENED/);
    assert.doesNotMatch(secondContext, /STATIC-PLAN-READY/);
    assert.doesNotMatch(secondContext, /FIRST-TURN-TRIGGER/);
    assert.doesNotMatch(secondContext, /OLD-VALIDATION-RESULT/);
    assert.doesNotMatch(secondContext, /FIRST-TURN-GUIDANCE/);
    assert.match(secondContext, /SECOND-TURN-GUIDANCE/);
    assert.strictEqual(
      secondContext.match(/NEW-REJECTION-DELTA/g)?.length,
      1,
      'the trigger must not be duplicated as a source message'
    );
  });

  it('reconstructs full static context when the installed CLI cannot resume', function () {
    const cluster = { id: 'old-cli-cluster', createdAt: Date.now(), agents: [] };
    const agent = createProviderSessionAgent({
      cluster,
      messageBus,
      config: {
        prompt: 'STATIC-OLD-CLI-INSTRUCTIONS',
      },
      runtime: {
        providerCliFeatures: { claude: { supportsResume: false } },
      },
    });
    agent.iteration = 2;
    agent.providerSession = {
      provider: 'claude',
      sessionId: 'unsupported-resume-session',
      agentId: 'worker',
      taskId: 'task-generation-1',
      generation: 1,
      cwd: path.resolve(agent.config.cwd || process.cwd()),
      worktreePath: null,
      contextCursor: 1,
      guidanceCursor: null,
      promptText: 'STATIC-OLD-CLI-INSTRUCTIONS',
    };

    const context = agent._buildContext({
      topic: 'VALIDATION_RESULT',
      sender: 'validator',
      content: { text: 'retry with full context' },
    });

    assert.match(context, /STATIC-OLD-CLI-INSTRUCTIONS/);
    assert.doesNotMatch(context, /Continuation Turn/);
    assert.strictEqual(agent.providerSession, null);
  });
});
