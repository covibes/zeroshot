const assert = require('assert');
const path = require('path');
const { promptIdentity } = require('../../src/agent/provider-session');

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
      contextSequence: agent.currentContextSequence,
      guidanceSequence: agent.currentGuidanceSequence,
      promptIdentity: agent.currentPromptIdentity,
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
    restoredAgent.lastGuidanceAppliedId = agent.providerSession.guidanceSequence;
    restoredAgent.iteration = 2;

    assert.ok(firstPostTurn.sequence > restoredAgent.providerSession.contextSequence);
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
      contextSequence: 1,
      guidanceSequence: null,
      promptIdentity: promptIdentity('STATIC-OLD-CLI-INSTRUCTIONS'),
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

  it('freezes lazy source rendering at the captured durable high-water sequence', function () {
    const cluster = { id: 'bounded-context-cluster', createdAt: Date.now(), agents: [] };
    const agent = createProviderSessionAgent({
      cluster,
      messageBus,
      config: {
        prompt: 'BOUNDED-CONTEXT-INSTRUCTIONS',
        contextStrategy: {
          sources: [{ topic: 'VALIDATION_RESULT' }],
        },
      },
    });

    messageBus.publish({
      cluster_id: cluster.id,
      topic: 'VALIDATION_RESULT',
      sender: 'validator',
      content: { text: 'BEFORE-SNAPSHOT' },
    });

    const originalQuery = messageBus.query.bind(messageBus);
    let injected = false;
    messageBus.query = (criteria) => {
      if (!injected && criteria.topic === 'VALIDATION_RESULT') {
        injected = true;
        messageBus.publish({
          cluster_id: cluster.id,
          topic: 'VALIDATION_RESULT',
          sender: 'validator',
          content: { text: 'AFTER-SNAPSHOT' },
        });
      }
      return originalQuery(criteria);
    };

    agent.iteration = 1;
    const first = agent._buildContext({
      topic: 'ISSUE_OPENED',
      sender: 'system',
      content: { text: 'start' },
    });
    assert.match(first, /BEFORE-SNAPSHOT/);
    assert.doesNotMatch(first, /AFTER-SNAPSHOT/);

    agent.providerSession = {
      provider: 'claude',
      sessionId: 'bounded-session',
      agentId: 'worker',
      taskId: 'task-generation-1',
      generation: 1,
      cwd: path.resolve(agent.config.cwd || process.cwd()),
      worktreePath: null,
      contextSequence: agent.currentContextSequence,
      guidanceSequence: agent.currentGuidanceSequence,
      promptIdentity: agent.currentPromptIdentity,
    };
    agent.iteration = 2;

    const second = agent._buildContext({
      topic: 'VALIDATION_RESULT',
      sender: 'validator',
      content: { text: 'next' },
    });
    assert.strictEqual(second.match(/AFTER-SNAPSHOT/g)?.length, 1);
    assert.doesNotMatch(second, /BEFORE-SNAPSHOT/);
  });
});
