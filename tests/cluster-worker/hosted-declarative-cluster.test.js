'use strict';

const assert = require('node:assert/strict');
const {
  assertDeclarativeClusterConfig,
} = require('../../zeroshot-rust/hosted-node/declarative-cluster');

function cluster(overrides = {}) {
  return {
    agents: [
      {
        id: 'worker',
        role: 'implementation',
        prompt: 'Complete the task.',
        triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
        hooks: {
          onComplete: {
            action: 'publish_message',
            config: { topic: 'CLUSTER_COMPLETE' },
          },
        },
      },
    ],
    ...overrides,
  };
}

describe('hosted declarative cluster boundary', () => {
  it('accepts static agents, triggers, prompts, hooks, and bounded subclusters', () => {
    const child = cluster().agents[0];
    assert.doesNotThrow(() =>
      assertDeclarativeClusterConfig(
        cluster({
          agents: [
            child,
            {
              id: 'nested',
              role: 'orchestrator',
              type: 'subcluster',
              config: cluster(),
              triggers: [{ topic: 'WORK_READY', action: 'execute_task' }],
              hooks: {
                onComplete: {
                  action: 'publish_message',
                  config: { topic: 'SUBCLUSTER_COMPLETE' },
                },
              },
            },
          ],
        })
      )
    );
  });

  it('rejects executable and dynamically loaded behavior', () => {
    for (const patch of [
      { params: { level: { default: 'level1' } } },
      { plugins: ['custom'] },
      { agents: [{ ...cluster().agents[0], cwd: '/outside' }] },
      { agents: [{ ...cluster().agents[0], loadConfig: { path: '/outside.json' } }] },
      { agents: [{ ...cluster().agents[0], taskExecutor: { command: 'shell' } }] },
      { agents: [{ ...cluster().agents[0], logic: { script: 'return true' } }] },
      {
        agents: [
          {
            ...cluster().agents[0],
            hooks: { onComplete: { action: 'execute_system_command', config: {} } },
          },
        ],
      },
      {
        agents: [
          {
            ...cluster().agents[0],
            hooks: {
              onComplete: { action: 'publish_message', config: {} },
              onFailure: { action: 'publish_message', config: {} },
            },
          },
        ],
      },
    ]) {
      assert.throws(() => assertDeclarativeClusterConfig(cluster(patch)), /Hosted cluster config/);
    }
  });
});
