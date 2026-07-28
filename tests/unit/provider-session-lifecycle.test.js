const assert = require('assert');
const path = require('path');
const sinon = require('sinon');
const { buildCompletionResult } = require('../../src/agent/agent-task-executor');

const {
  buildProviderSession,
  createProviderSessionAgent,
  createProviderSessionHarness,
} = require('../helpers/provider-session-harness');

describe('provider-session lifecycle boundaries', function () {
  let harness;
  let messageBus;

  beforeEach(function () {
    harness = createProviderSessionHarness('zeroshot-session-lifecycle-');
    messageBus = harness.messageBus;
  });

  afterEach(function () {
    sinon.restore();
    harness.cleanup();
  });

  it('clears a failed logical result before the retry is constructed', async function () {
    const cluster = { id: 'retry-cluster', createdAt: Date.now(), agents: [] };
    let attempts = 0;
    let agent;

    agent = createProviderSessionAgent({
      cluster,
      messageBus,
      config: {
        prompt: 'STATIC-RETRY-INSTRUCTIONS',
        outputFormat: 'text',
        maxRetries: 2,
      },
      runtime: {
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
      },
    });
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

  it('fails a requested A resume captured as B then A before hooks and retries fresh', async function () {
    const cluster = { id: 'ambiguous-resume-cluster', createdAt: Date.now(), agents: [] };
    let attempts = 0;
    let agent;
    agent = createProviderSessionAgent({
      cluster,
      messageBus,
      config: {
        prompt: 'FULL-FRESH-RETRY-INSTRUCTIONS',
        outputFormat: 'text',
        maxRetries: 2,
        hooks: {
          onComplete: {
            action: 'publish_message',
            config: { topic: 'IMPLEMENTATION_READY' },
          },
        },
      },
      runtime: {
        quiet: true,
        providerCliFeatures: { claude: { supportsResume: true } },
        mockSpawnFn: (args, { context }) => {
          attempts += 1;
          if (attempts === 1) {
            const resumeIndex = args.indexOf('--resume');
            assert.ok(resumeIndex >= 0);
            assert.strictEqual(args[resumeIndex + 1], 'claude-session-1');
            return buildCompletionResult({
              agent,
              taskId: 'ambiguous-resume-task',
              providerName: 'claude',
              state: { output: 'done', logFilePath: null },
              stdout: 'Status: completed',
              success: true,
              taskInfo: {
                id: 'ambiguous-resume-task',
                provider: 'claude',
                status: 'completed',
                requestedResumeSessionId: 'claude-session-1',
                resumeIdentityVerified: true,
                sessionId: 'claude-session-1',
                sessionIdConflict: true,
              },
            });
          }

          assert.strictEqual(agent.providerSession, null);
          assert.ok(!args.includes('--resume'));
          assert.match(context, /FULL-FRESH-RETRY-INSTRUCTIONS/);
          return { success: true, output: 'fresh retry done', providerSession: null };
        },
      },
    });
    agent.iteration = 1;
    agent.providerSession = buildProviderSession({
      cwd: path.resolve(agent.config.cwd || process.cwd()),
    });
    agent.lastGuidanceAppliedId = agent.providerSession.guidanceSequence;
    agent.running = true;

    await agent._executeTask({
      topic: 'VALIDATION_RESULT',
      sender: 'validator',
      content: { text: 'retry the continuation' },
    });

    assert.strictEqual(attempts, 2);
    assert.strictEqual(
      messageBus.count({ cluster_id: cluster.id, topic: 'IMPLEMENTATION_READY' }),
      1,
      'the ambiguous resumed output must fail before its completion hook'
    );
    const lifecycleEvents = messageBus
      .query({
        cluster_id: cluster.id,
        topic: 'AGENT_LIFECYCLE',
        sender: 'worker',
      })
      .map((message) => message.content?.data?.event);
    assert.strictEqual(lifecycleEvents.filter((event) => event === 'TASK_COMPLETED').length, 1);
    assert.ok(lifecycleEvents.includes('TASK_FAILED'));
  });

  it('does not recognize a completed turn or session when the onComplete hook crashes', async function () {
    const clock = sinon.useFakeTimers();
    const cluster = { id: 'hook-crash-cluster', createdAt: Date.now(), agents: [] };
    let agent;
    agent = createProviderSessionAgent({
      cluster,
      messageBus,
      config: {
        prompt: 'STATIC-HOOK-INSTRUCTIONS',
        outputFormat: 'text',
        maxRetries: 1,
        hooks: { onComplete: { action: 'unknown_test_hook' } },
      },
      runtime: {
        quiet: true,
        providerCliFeatures: { claude: { supportsResume: true } },
        mockSpawnFn: () => ({
          success: true,
          output: 'done',
          providerSession: {
            provider: 'claude',
            sessionId: 'must-not-survive-hook-crash',
            agentId: 'worker',
            taskId: 'task-generation-1',
            generation: 1,
            cwd: path.resolve(agent.config.cwd || process.cwd()),
            worktreePath: null,
            contextSequence: agent.currentContextSequence,
            guidanceSequence: agent.currentGuidanceSequence,
            promptIdentity: agent.currentPromptIdentity,
          },
        }),
      },
    });
    agent.running = true;

    const execution = agent._executeTask({
      topic: 'ISSUE_OPENED',
      sender: 'system',
      content: { text: 'run hook crash' },
    });
    await clock.runAllAsync();
    await execution;

    const lifecycle = messageBus.query({
      cluster_id: cluster.id,
      topic: 'AGENT_LIFECYCLE',
      sender: 'worker',
    });
    assert.ok(
      !lifecycle.some((message) => message.content?.data?.event === 'TASK_COMPLETED'),
      'TASK_COMPLETED must follow successful hook publication'
    );
    assert.strictEqual(agent.providerSession, null);
    assert.ok(
      messageBus
        .query({ cluster_id: cluster.id, topic: 'CLUSTER_FAILED' })
        .some((message) => message.content?.data?.reason === 'on_complete_hook_failed')
    );
  });

  it('replays a changed rules prompt once but omits an unchanged subsequent prompt', function () {
    const cluster = { id: 'prompt-rules-cluster', createdAt: Date.now(), agents: [] };
    const agent = createProviderSessionAgent({
      cluster,
      messageBus,
      config: {
        prompt: {
          initial: 'FIRST-ITERATION-INSTRUCTIONS',
          subsequent: 'FOLLOW-UP-INSTRUCTIONS',
        },
      },
      runtime: {
        providerCliFeatures: { claude: { supportsResume: true } },
      },
    });
    const cwd = path.resolve(agent.config.cwd || process.cwd());

    agent.iteration = 1;
    const first = agent._buildContext({ topic: 'ISSUE_OPENED', content: { text: 'start' } });
    assert.match(first, /FIRST-ITERATION-INSTRUCTIONS/);

    agent.providerSession = {
      provider: 'claude',
      sessionId: 'generation-1',
      agentId: 'worker',
      taskId: 'task-1',
      generation: 1,
      cwd,
      worktreePath: null,
      contextSequence: agent.currentContextSequence,
      guidanceSequence: agent.currentGuidanceSequence,
      promptIdentity: agent.currentPromptIdentity,
    };
    agent.iteration = 2;
    const second = agent._buildContext({
      topic: 'VALIDATION_RESULT',
      content: { text: 'retry two' },
    });
    assert.match(second, /FOLLOW-UP-INSTRUCTIONS/);

    agent.providerSession = {
      ...agent.providerSession,
      sessionId: 'generation-2',
      taskId: 'task-2',
      generation: 2,
      contextSequence: agent.currentContextSequence,
      guidanceSequence: agent.currentGuidanceSequence,
      promptIdentity: agent.currentPromptIdentity,
    };
    agent.iteration = 3;
    const third = agent._buildContext({
      topic: 'VALIDATION_RESULT',
      content: { text: 'retry three' },
    });
    assert.match(third, /Continuation Turn/);
    assert.doesNotMatch(third, /FOLLOW-UP-INSTRUCTIONS/);
  });
});
