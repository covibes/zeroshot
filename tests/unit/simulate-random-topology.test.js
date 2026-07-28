const assert = require('assert');
const path = require('node:path');

const {
  simulateRandomTopology,
} = require('../../src/template-validation/simulate-random-topology');

function createLoadConfigTopology(configReference) {
  const message = {
    topic: 'CLUSTER_OPERATIONS',
    content: {
      data: {
        operations: [{ action: 'load_config', config: configReference }],
      },
    },
  };

  return {
    agents: [
      {
        id: 'loader',
        role: 'orchestrator',
        outputFormat: 'json',
        jsonSchema: { type: 'object', properties: {} },
        triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
        hooks: {
          onComplete: {
            action: 'publish_message',
            transform: {
              engine: 'javascript',
              script: `return ${JSON.stringify(message)};`,
            },
          },
        },
      },
    ],
  };
}

describe('simulateRandomTopology', function () {
  it('passes for a topology with terminal completion path', async function () {
    const config = {
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          outputFormat: 'json',
          jsonSchema: {
            type: 'object',
            properties: {
              approved: { type: 'boolean' },
            },
            required: ['approved'],
          },
          triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              transform: {
                engine: 'javascript',
                script:
                  'return { topic: "VALIDATION_RESULT", content: { data: { approved: result.approved } } };',
              },
            },
          },
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'VALIDATION_RESULT', action: 'stop_cluster' }],
        },
      ],
    };

    const errors = await simulateRandomTopology({
      config,
      templateId: 'unit-sound',
      templatesDir: path.join(__dirname, '..', '..', 'cluster-templates'),
      samples: 3,
      maxSteps: 40,
      // Coverage + parallel test load can add scheduling noise; keep the contract
      // about terminal completion, not a razor-thin wall-clock budget.
      maxScenarioMs: 1000,
    });

    assert.deepStrictEqual(errors, []);
  });

  it('fails for sampled topology that can loop without terminal signal', async function () {
    const config = {
      agents: [
        {
          id: 'ping',
          role: 'implementation',
          outputFormat: 'json',
          jsonSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
          triggers: [
            { topic: 'ISSUE_OPENED', action: 'execute_task' },
            { topic: 'PONG', action: 'execute_task' },
          ],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'PING', content: { data: {} } },
            },
          },
        },
        {
          id: 'pong',
          role: 'implementation',
          outputFormat: 'json',
          jsonSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
          triggers: [{ topic: 'PING', action: 'execute_task' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'PONG', content: { data: {} } },
            },
          },
        },
      ],
    };

    const errors = await simulateRandomTopology({
      config,
      templateId: 'unit-loop',
      templatesDir: path.join(__dirname, '..', '..', 'cluster-templates'),
      samples: 1,
      maxSteps: 25,
      maxScenarioMs: 200,
    });

    assert.ok(
      errors.some(
        (error) =>
          error.includes('step budget') || error.includes('quiesced without CLUSTER_COMPLETE')
      ),
      `Expected loop/stuck error, got: ${errors.join(' | ')}`
    );
  });
});

describe('simulateRandomTopology load_config boundaries', function () {
  const templatesDir = path.join(__dirname, '..', '..', 'cluster-templates');

  for (const [description, configReference, expectedError] of [
    ['static traversal', '../package', 'Invalid config name'],
    [
      'parameterized traversal',
      { base: '../../package', params: {} },
      'Invalid base template name',
    ],
  ]) {
    it(`reports the shared resolver error for ${description}`, async function () {
      const errors = await simulateRandomTopology({
        config: createLoadConfigTopology(configReference),
        templateId: `unit-${description.replaceAll(' ', '-')}`,
        templatesDir,
        samples: 1,
        maxSteps: 10,
        maxScenarioMs: 1000,
      });

      assert.ok(
        errors.some(
          (error) => error.includes('invalid CLUSTER_OPERATIONS') && error.includes(expectedError)
        ),
        `Expected ${expectedError}, got: ${errors.join(' | ')}`
      );
    });
  }
});
