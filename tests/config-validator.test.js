/**
 * Config Validator Tests
 *
 * Tests all validation rules for cluster configurations including:
 * - Basic structure validation
 * - Message flow analysis
 * - Agent-specific validation
 * - Logic script validation
 */

const assert = require('assert');
const {
  validateConfig,
  validateBasicStructure,
  analyzeMessageFlow,
  validateAgents,
  validateLogicScripts,
  isValidIterationPattern,
  // Phase 5: Template variable validation
  validateTemplateVariables,
  extractTemplateVariables,
  extractSchemaProperties,
  validateAgentTemplateVariables,
} = require('../src/config-validator');

// === BASIC STRUCTURE TESTS ===

describe('validateBasicStructure', function () {
  it('should reject config without agents array', function () {
    const result = validateBasicStructure({});
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes('agents array is required'));
  });

  it('should reject empty agents array', function () {
    const result = validateBasicStructure({ agents: [] });
    assert.ok(result.errors.some((e) => e.includes('cannot be empty')));
  });

  it('should require agent id, role, and triggers', function () {
    const result = validateBasicStructure({
      agents: [{ prompt: 'test' }],
    });
    assert.ok(result.errors.some((e) => e.includes('.id is required')));
    assert.ok(result.errors.some((e) => e.includes('.role is required')));
    assert.ok(result.errors.some((e) => e.includes('.triggers array is required')));
  });

  it('should reject duplicate agent ids', function () {
    const result = validateBasicStructure({
      agents: [
        { id: 'worker', role: 'impl', triggers: [{ topic: 'A' }] },
        { id: 'worker', role: 'validator', triggers: [{ topic: 'B' }] },
      ],
    });
    assert.ok(result.errors.some((e) => e.includes('Duplicate agent id')));
  });

  it('should reject empty triggers array', function () {
    const result = validateBasicStructure({
      agents: [{ id: 'worker', role: 'impl', triggers: [] }],
    });
    assert.ok(result.errors.some((e) => e.includes('triggers cannot be empty')));
  });

  it('should reject invalid trigger action', function () {
    const result = validateBasicStructure({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'A', action: 'invalid_action' }],
        },
      ],
    });
    assert.ok(result.errors.some((e) => e.includes("must be 'execute_task' or 'stop_cluster'")));
  });

  it('should reject logic without script', function () {
    const result = validateBasicStructure({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'A', logic: { engine: 'javascript' } }],
        },
      ],
    });
    assert.ok(result.errors.some((e) => e.includes('logic.script is required')));
  });

  it('should pass valid basic config', function () {
    const result = validateBasicStructure({
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          triggers: [{ topic: 'ISSUE_OPENED' }],
        },
        {
          id: 'validator',
          role: 'validator',
          triggers: [{ topic: 'IMPL_READY' }],
        },
      ],
    });
    assert.strictEqual(result.errors.length, 0);
  });
});

// === MODEL RULES TESTS ===

describe('isValidIterationPattern', function () {
  it('should accept "all"', () => assert.ok(isValidIterationPattern('all')));
  it('should accept exact number "3"', () => assert.ok(isValidIterationPattern('3')));
  it('should accept range "1-3"', () => assert.ok(isValidIterationPattern('1-3')));
  it('should accept open-ended "5+"', () => assert.ok(isValidIterationPattern('5+')));
  it('should reject "1..3"', () => assert.ok(!isValidIterationPattern('1..3')));
  it('should reject "five"', () => assert.ok(!isValidIterationPattern('five')));
  it('should reject empty string', () => assert.ok(!isValidIterationPattern('')));
});

describe('modelRules validation', function () {
  // Note: modelRules catch-all validation is in validateRuleCoverage, called by validateConfig
  it('should reject modelRules without catch-all', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'A' }],
          modelRules: [
            { iterations: '1-3', model: 'sonnet' },
            // Missing catch-all for 4+
          ],
        },
      ],
    });
    assert.ok(result.errors.some((e) => e.includes('Add catch-all rule')));
    assert.ok(result.errors.some((e) => e.includes('"modelLevel": "level2"')));
  });

  it('should accept modelRules with "all" catch-all', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'A' }],
          modelRules: [
            { iterations: '1-3', model: 'sonnet' },
            { iterations: 'all', model: 'opus' },
          ],
        },
      ],
    });
    assert.ok(!result.errors.some((e) => e.includes('catch-all')));
  });

  it('should accept modelRules with "N+" catch-all', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'A' }],
          modelRules: [
            { iterations: '1-3', model: 'sonnet' },
            { iterations: '4+', model: 'opus' },
          ],
        },
      ],
    });
    assert.ok(!result.errors.some((e) => e.includes('catch-all')));
  });

  it('should warn on invalid model name', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'A' }],
          modelRules: [{ iterations: 'all', model: 'gpt4' }],
        },
      ],
    });
    assert.ok(result.warnings.some((w) => w.includes('model "gpt4"') && w.includes('not valid')));
  });
});

// === MESSAGE FLOW TESTS ===

describe('analyzeMessageFlow - kickoff requirements', function () {
  it('should error if no agent triggers on ISSUE_OPENED', function () {
    const result = analyzeMessageFlow({
      agents: [{ id: 'worker', role: 'impl', triggers: [{ topic: 'PLAN_READY' }] }],
    });
    assert.ok(result.errors.some((e) => e.includes('No agent triggers on ISSUE_OPENED')));
  });

  it('should error if no completion handler exists', function () {
    const result = analyzeMessageFlow({
      agents: [{ id: 'worker', role: 'impl', triggers: [{ topic: 'ISSUE_OPENED' }] }],
    });
    assert.ok(result.errors.some((e) => e.includes('No completion handler found')));
  });

  it('should error on multiple completion handlers', function () {
    const result = analyzeMessageFlow({
      agents: [
        { id: 'worker', role: 'impl', triggers: [{ topic: 'ISSUE_OPENED' }] },
        {
          id: 'completion-detector',
          role: 'orchestrator',
          triggers: [{ topic: 'X', action: 'stop_cluster' }],
        },
        {
          id: 'git-pusher',
          role: 'orchestrator',
          triggers: [{ topic: 'Y', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(result.errors.some((e) => e.includes('Multiple completion handlers')));
  });
});

describe('analyzeMessageFlow - topic coverage', function () {
  it('should error when topic is never produced', function () {
    const result = analyzeMessageFlow({
      agents: [
        { id: 'worker', role: 'impl', triggers: [{ topic: 'ISSUE_OPENED' }] },
        {
          id: 'validator',
          role: 'validator',
          triggers: [{ topic: 'PLAN_READY' }],
        }, // Never produced!
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'X', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(result.errors.some((e) => e.includes('PLAN_READY') && e.includes('never produced')));
  });

  it('should warn on orphan topics (produced but never consumed)', function () {
    const result = analyzeMessageFlow({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'ISSUE_OPENED' }],
          hooks: { onComplete: { config: { topic: 'ORPHAN_TOPIC' } } },
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'ISSUE_OPENED', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(
      result.warnings.some((w) => w.includes('ORPHAN_TOPIC') && w.includes('never consumed'))
    );
  });

  it('should error on self-triggering agent', function () {
    const result = analyzeMessageFlow({
      agents: [
        {
          id: 'echo',
          role: 'impl',
          triggers: [{ topic: 'ECHO' }],
          hooks: { onComplete: { config: { topic: 'ECHO' } } },
        },
        {
          id: 'starter',
          role: 'impl',
          triggers: [{ topic: 'ISSUE_OPENED' }],
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'X', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(result.errors.some((e) => e.includes('echo') && e.includes('infinite loop')));
  });
});

describe('analyzeMessageFlow - cycle handling', function () {
  it('should warn on circular dependency without escape logic', function () {
    const result = analyzeMessageFlow({
      agents: [
        {
          id: 'a',
          role: 'impl',
          triggers: [{ topic: 'ISSUE_OPENED' }, { topic: 'B_OUTPUT' }],
          hooks: { onComplete: { config: { topic: 'A_OUTPUT' } } },
        },
        {
          id: 'b',
          role: 'validator',
          triggers: [{ topic: 'A_OUTPUT' }],
          hooks: { onComplete: { config: { topic: 'B_OUTPUT' } } },
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'X', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(result.warnings.some((w) => w.includes('Circular dependency')));
  });

  it('should not warn on circular dependency WITH escape logic', function () {
    const result = analyzeMessageFlow({
      agents: [
        {
          id: 'a',
          role: 'impl',
          triggers: [
            { topic: 'ISSUE_OPENED' },
            {
              topic: 'B_OUTPUT',
              logic: { script: 'return !message.content.approved;' },
            },
          ],
          hooks: { onComplete: { config: { topic: 'A_OUTPUT' } } },
        },
        {
          id: 'b',
          role: 'validator',
          triggers: [{ topic: 'A_OUTPUT' }],
          hooks: { onComplete: { config: { topic: 'B_OUTPUT' } } },
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'X', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(!result.warnings.some((w) => w.includes('Circular dependency')));
  });
});

describe('analyzeMessageFlow - validator flows', function () {
  it('should error when worker has validators but no re-trigger on rejection', function () {
    const result = analyzeMessageFlow({
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          triggers: [{ topic: 'ISSUE_OPENED' }], // No VALIDATION_RESULT trigger!
          hooks: { onComplete: { config: { topic: 'IMPL_READY' } } },
        },
        {
          id: 'validator',
          role: 'validator',
          triggers: [{ topic: 'IMPL_READY' }],
          hooks: { onComplete: { config: { topic: 'VALIDATION_RESULT' } } },
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'VALIDATION_RESULT', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(
      result.errors.some(
        (e) =>
          e.includes('worker') &&
          e.includes('VALIDATION_RESULT') &&
          e.includes('Rejections will be ignored')
      )
    );
  });

  it('should warn when context strategy missing trigger topic', function () {
    const result = analyzeMessageFlow({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'ISSUE_OPENED' }, { topic: 'FEEDBACK' }],
          contextStrategy: {
            sources: [{ topic: 'ISSUE_OPENED', limit: 1 }],
            // Missing FEEDBACK!
          },
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'X', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(
      result.warnings.some(
        (w) => w.includes('worker') && w.includes('FEEDBACK') && w.includes('contextStrategy')
      )
    );
  });

  it('should pass a valid minimal config', function () {
    const result = analyzeMessageFlow({
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          triggers: [{ topic: 'ISSUE_OPENED' }],
          hooks: { onComplete: { config: { topic: 'DONE' } } },
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
        },
      ],
    });
    assert.strictEqual(result.errors.length, 0);
  });
});

describe('analyzeMessageFlow - resolved topology regression checks', function () {
  it('should not skip flow validation when conductor config already has runtime agents', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'junior-conductor',
          role: 'conductor',
          triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: {
                topic: 'CLUSTER_OPERATIONS',
                content: {
                  data: {
                    operations: [{ action: 'load_config', config: 'worker-validator' }],
                  },
                },
              },
            },
          },
        },
        {
          id: 'worker',
          role: 'implementation',
          triggers: [{ topic: 'PLAN_READY', action: 'execute_task' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'IMPLEMENTATION_READY' },
            },
          },
        },
        {
          id: 'completion-detector',
          role: 'orchestrator',
          triggers: [{ topic: 'IMPLEMENTATION_READY', action: 'stop_cluster' }],
        },
      ],
    });

    assert.ok(
      result.errors.some((e) => e.includes('PLAN_READY') && e.includes('never produced')),
      `Expected unproduced PLAN_READY error, got: ${result.errors.join(' | ')}`
    );
  });

  it('should flag dead-end flows that cannot reach completion', function () {
    const result = analyzeMessageFlow({
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'WORKER_PROGRESS' },
            },
          },
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
        },
      ],
    });

    assert.ok(
      result.errors.some((e) =>
        e.includes('No reachable path from ISSUE_OPENED to terminal signal')
      ),
      `Expected missing completion path error, got: ${result.errors.join(' | ')}`
    );
  });
});

describe('analyzeMessageFlow - schema contract regression checks', function () {
  it('should flag trigger scripts that require missing content.data keys', function () {
    const result = analyzeMessageFlow({
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: {
                topic: 'VALIDATION_RESULT',
                content: {
                  data: {
                    approved: true,
                  },
                },
              },
            },
          },
        },
        {
          id: 'downstream-consumer',
          role: 'implementation',
          triggers: [
            {
              topic: 'VALIDATION_RESULT',
              logic: {
                script: 'return message.content.data.errors.length === 0;',
              },
              action: 'execute_task',
            },
          ],
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'VALIDATION_RESULT', action: 'stop_cluster' }],
        },
      ],
    });

    assert.ok(
      result.errors.some(
        (e) => e.includes('expects content.data.errors') && e.includes('VALIDATION_RESULT')
      ),
      `Expected schema contract error, got: ${result.errors.join(' | ')}`
    );
  });

  it('should not treat optional chained content.data access as required', function () {
    const result = analyzeMessageFlow({
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: {
                topic: 'VALIDATION_RESULT',
                content: {
                  data: {
                    approved: true,
                    errors: [],
                  },
                },
              },
            },
          },
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [
            {
              topic: 'VALIDATION_RESULT',
              action: 'stop_cluster',
              logic: {
                script: 'return message?.content?.data?.criteriaResults?.length > 0;',
              },
            },
          ],
        },
      ],
    });

    assert.ok(
      !result.errors.some((e) => e.includes('criteriaResults') && e.includes('no producer for')),
      `Expected no criteriaResults schema error, got: ${result.errors.join(' | ')}`
    );
  });
});

// === AGENT VALIDATION TESTS ===

describe('validateAgents', function () {
  it('should warn when orchestrator has execute_task action', function () {
    const result = validateAgents({
      agents: [
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'X', action: 'execute_task' }], // Should be stop_cluster
        },
      ],
    });
    assert.ok(
      result.warnings.some(
        (w) => w.toLowerCase().includes('orchestrator') && w.includes('execute_task')
      )
    );
  });

  it('should warn when json output has no schema', function () {
    const result = validateAgents({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'X' }],
          outputFormat: 'json',
          // Missing jsonSchema
        },
      ],
    });
    assert.ok(result.warnings.some((w) => w.includes('json') && w.includes('jsonSchema')));
  });

  it('should warn on very high maxIterations', function () {
    const result = validateAgents({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'X' }],
          maxIterations: 100,
        },
      ],
    });
    assert.ok(result.warnings.some((w) => w.includes('maxIterations') && w.includes('100')));
  });

  it('should error when logic references non-existent role', function () {
    const result = validateAgents({
      agents: [
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [
            {
              topic: 'X',
              logic: {
                script: 'return cluster.getAgentsByRole("reviewer").length > 0;',
              },
            },
          ],
        },
      ],
    });
    assert.ok(
      result.warnings.some((e) => e.includes('reviewer') && e.includes('no agent has that role'))
    );
  });

  it('should pass when logic references existing role', function () {
    const result = validateAgents({
      agents: [
        { id: 'val', role: 'validator', triggers: [{ topic: 'Y' }] },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [
            {
              topic: 'X',
              logic: {
                script: 'return cluster.getAgentsByRole("validator").length > 0;',
              },
            },
          ],
        },
      ],
    });
    assert.ok(!result.errors.some((e) => e.includes('validator') && e.includes('no agent')));
  });
});

describe('validateAgents - validator Git usage', function () {
  function validatePrompt(prompt) {
    return validateAgents({
      agents: [
        {
          id: 'validator',
          role: 'validator',
          triggers: [{ topic: 'IMPLEMENTATION_READY' }],
          prompt,
        },
      ],
    }).errors;
  }

  it('allows clear prohibitions of Git inspection commands', function () {
    const safePrompts = [
      'Do NOT use git diff or git status. Read files directly.',
      'never run git log',
      'git status is forbidden',
      'NEVER RUN GIT SHOW',
      'Don’t use git diff. Read files directly.',
      'Do not run the command git diff.',
      'Avoid running git status; read files directly.',
      'The validator is forbidden from running git log.',
      'git diff and git status are forbidden.',
      'git log must not be used.',
      'Do not ever use git diff.',
      'git diff must never be used.',
      'Both git diff and git status are forbidden.',
      'git diff is forbidden and git status is prohibited.',
      'Do not use git diff and never run git status.',
      'Do not use git diff, and do not use git status.',
      { system: 'Do not inspect git diff and git status. Read files directly.' },
    ];

    for (const prompt of safePrompts) {
      assert.deepStrictEqual(
        validatePrompt(prompt),
        [],
        `Expected prompt to be allowed: ${prompt}`
      );
    }
  });

  it('rejects affirmative Git inspection instructions case-insensitively', function () {
    const unsafePrompts = [
      ['run git diff', 'git diff'],
      ['inspect git status', 'git status'],
      ['RUN GIT SHOW', 'git show'],
      ['run git\nstatus', 'git status'],
      ['run git\r\nstatus', 'git status'],
      [{ system: 'Run Git Log before validating.' }, 'git log'],
    ];

    for (const [prompt, command] of unsafePrompts) {
      const errors = validatePrompt(prompt);
      assert.strictEqual(errors.length, 1, `Expected prompt to be rejected: ${prompt}`);
      assert.ok(errors[0].includes(`'${command}'`), errors[0]);
      assert.ok(errors[0].includes('instructs use'), errors[0]);
      assert.ok(errors[0].includes('Read files directly'), errors[0]);
    }
  });

  it('treats string prompts and prompt.system identically', function () {
    for (const prompt of ['never run git log', 'inspect git status']) {
      assert.deepStrictEqual(validatePrompt(prompt), validatePrompt({ system: prompt }));
    }
  });

  it('rejects negation reversal instructions', function () {
    const errors = validatePrompt('do not forget to run git log');

    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes("'git log'"), errors[0]);
  });

  it('evaluates mixed clauses independently', function () {
    const mixedPrompts = [
      'do not use git diff, but run git show',
      'Do not use git diff, and git show must be inspected.',
      'Do not use git diff or git show should be inspected.',
      'Do not use git diff, or git show may be used.',
      'Do not use git diff, and git show has to be inspected.',
      'Do not use git diff, and git show ought to be inspected.',
      'Do not use git diff or git show provides useful context.',
      'Do not use git diff and run git show.',
    ];

    for (const prompt of mixedPrompts) {
      const errors = validatePrompt(prompt);
      assert.strictEqual(errors.length, 1, `Expected one unsafe clause: ${prompt}`);
      assert.ok(!errors[0].includes("'git diff'"), errors[0]);
      assert.ok(errors[0].includes("'git show'"), errors[0]);
    }
  });

  it('rejects conditional exceptions to prohibitive wording', function () {
    const prompts = [
      'Do not use git diff unless necessary.',
      'Never run git log without first reading the files.',
      'Git status is forbidden except during final validation.',
    ];

    for (const prompt of prompts) {
      assert.strictEqual(
        validatePrompt(prompt).length,
        1,
        `Expected prompt to be unsafe: ${prompt}`
      );
    }
  });

  it('handles long malformed command lists without pathological backtracking', function () {
    const prompt = `Do not use git diff,${' '.repeat(20_000)}then inspect git status`;
    const errors = validatePrompt(prompt);

    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes("'git status'"), errors[0]);
  });
});

// === LOGIC SCRIPT TESTS ===

describe('validateLogicScripts', function () {
  it('should error on syntax error in logic script', function () {
    const result = validateLogicScripts({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [
            {
              topic: 'X',
              logic: { script: 'return ledger.query({ topic: "X" ).length;' }, // Missing ]
            },
          ],
        },
      ],
    });
    assert.ok(result.errors.some((e) => e.includes('invalid logic script')));
  });

  it('should warn when script is just "return false"', function () {
    const result = validateLogicScripts({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [
            {
              topic: 'X',
              logic: { script: 'return false;' },
            },
          ],
        },
      ],
    });
    assert.ok(
      result.warnings.some((w) => w.includes('return false') && w.includes('never trigger'))
    );
  });

  it('should warn when script is just "return true"', function () {
    const result = validateLogicScripts({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [
            {
              topic: 'X',
              logic: { script: 'return true;' },
            },
          ],
        },
      ],
    });
    assert.ok(result.warnings.some((w) => w.includes('return true') && w.includes('Consider')));
  });

  it('should NOT warn on complex scripts with return false in conditional', function () {
    const result = validateLogicScripts({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [
            {
              topic: 'X',
              logic: { script: 'if (!condition) return false; return true;' },
            },
          ],
        },
      ],
    });
    assert.ok(
      !result.warnings.some((w) => w.includes('return false') && w.includes('never trigger'))
    );
  });

  it('should warn on potential undefined variable access', function () {
    const result = validateLogicScripts({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [
            {
              topic: 'X',
              logic: { script: 'return unknownVar.length > 0;' },
            },
          ],
        },
      ],
    });
    assert.ok(result.warnings.some((w) => w.includes('unknownVar') && w.includes('undefined')));
  });

  it('should pass valid logic script', function () {
    const result = validateLogicScripts({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [
            {
              topic: 'X',
              logic: {
                script: `
              const validators = cluster.getAgentsByRole('validator');
              const responses = ledger.query({ topic: 'VALIDATION_RESULT' });
              return responses.length >= validators.length;
            `,
              },
            },
          ],
        },
      ],
    });
    assert.strictEqual(result.errors.length, 0);
  });
});

// === FULL VALIDATION TESTS ===

describe('validateConfig (full)', function () {
  it('should validate full-workflow config without errors', function () {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(
      __dirname,
      '..',
      'cluster-templates',
      'base-templates',
      'full-workflow.json'
    );
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    const result = validateConfig(config);
    assert.strictEqual(result.valid, true, `Errors: ${result.errors.join(', ')}`);
  });

  it('should validate single-worker config (warning about no completion handler is expected)', function () {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(
      __dirname,
      '..',
      'cluster-templates',
      'base-templates',
      'single-worker.json'
    );
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    const result = validateConfig(config);
    // simple-worker intentionally has no completion handler - this triggers a warning/error
    // The config is still valid for simple tasks that complete in one shot
    // We just check it doesn't have other structural errors
    const nonCompletionErrors = result.errors.filter((e) => !e.includes('completion handler'));
    assert.strictEqual(
      nonCompletionErrors.length,
      0,
      `Unexpected errors: ${nonCompletionErrors.join(', ')}`
    );
  });

  it('should catch multiple issues in broken config', function () {
    const brokenConfig = {
      agents: [
        {
          // Missing id
          role: 'impl',
          triggers: [], // Empty triggers
        },
        {
          id: 'worker',
          // Missing role
          triggers: [{ topic: 'NEVER_PRODUCED' }],
        },
      ],
    };

    const result = validateConfig(brokenConfig);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length >= 3); // At least: missing id, missing role, empty triggers
  });
});

// === PHASE 5: TEMPLATE VARIABLE VALIDATION TESTS ===
// Tests cross-validation between jsonSchema definitions and {{result.*}} template usage

describe('extractTemplateVariables - mustache parsing', function () {
  // Test 1: Mustache in string
  it('should extract single mustache variable from string', function () {
    const agent = {
      hooks: {
        onComplete: {
          config: {
            content: { text: '{{result.summary}}' },
          },
        },
      },
    };
    const vars = extractTemplateVariables(agent);
    assert.ok(vars.has('summary'));
    assert.strictEqual(vars.size, 1);
  });

  // Test 2: Multiple mustache same string
  it('should extract multiple mustache variables from same string', function () {
    const agent = {
      hooks: {
        onComplete: {
          config: {
            content: { text: '{{result.a}} and {{result.b}}' },
          },
        },
      },
    };
    const vars = extractTemplateVariables(agent);
    assert.ok(vars.has('a'));
    assert.ok(vars.has('b'));
    assert.strictEqual(vars.size, 2);
  });

  // Test 3: Mustache in nested object
  it('should extract mustache from deeply nested object', function () {
    const agent = {
      hooks: {
        onComplete: {
          config: {
            x: { y: { z: '{{result.deep}}' } },
          },
        },
      },
    };
    const vars = extractTemplateVariables(agent);
    assert.ok(vars.has('deep'));
  });

  // Test 4: Mustache in array
  it('should extract mustache from array elements', function () {
    const agent = {
      hooks: {
        onComplete: {
          config: {
            items: ['{{result.item1}}', '{{result.item2}}'],
          },
        },
      },
    };
    const vars = extractTemplateVariables(agent);
    assert.ok(vars.has('item1'));
    assert.ok(vars.has('item2'));
  });

  // Test 5: Mustache in deeply nested array
  it('should extract mustache from nested array of objects', function () {
    const agent = {
      hooks: {
        onComplete: {
          config: {
            arr: [{ obj: '{{result.x}}' }],
          },
        },
      },
    };
    const vars = extractTemplateVariables(agent);
    assert.ok(vars.has('x'));
  });
});

describe('extractTemplateVariables - transform scripts', function () {
  // Test 6: Transform script direct access
  it('should extract direct result access from transform script', function () {
    const agent = {
      hooks: {
        onComplete: {
          transform: {
            script: 'return result.approved ? "yes" : "no";',
          },
        },
      },
    };
    const vars = extractTemplateVariables(agent);
    assert.ok(vars.has('approved'));
  });

  // Test 7: Transform script multiple access
  it('should extract multiple result accesses from transform script', function () {
    const agent = {
      hooks: {
        onComplete: {
          transform: {
            script: 'return result.a + result.b;',
          },
        },
      },
    };
    const vars = extractTemplateVariables(agent);
    assert.ok(vars.has('a'));
    assert.ok(vars.has('b'));
  });

  // Test 8: Both mustache AND script
  it('should extract from both mustache config and transform script', function () {
    const agent = {
      hooks: {
        onComplete: {
          config: { text: '{{result.fromConfig}}' },
          transform: { script: 'return result.fromScript;' },
        },
      },
    };
    const vars = extractTemplateVariables(agent);
    assert.ok(vars.has('fromConfig'));
    assert.ok(vars.has('fromScript'));
  });
});

describe('extractTemplateVariables - trigger hooks', function () {
  // Test 9: Triggers array pattern
  it('should extract from triggers[].onComplete', function () {
    const agent = {
      triggers: [
        {
          topic: 'X',
          onComplete: {
            config: { text: '{{result.triggerVar}}' },
          },
        },
      ],
    };
    const vars = extractTemplateVariables(agent);
    assert.ok(vars.has('triggerVar'));
  });

  // Test 16: Multiple triggers with different template vars
  // REGRESSION: Ensure ALL triggers are scanned, not just the first
  it('should extract from ALL triggers onComplete hooks', function () {
    const agent = {
      triggers: [
        {
          topic: 'TOPIC_A',
          onComplete: {
            config: { text: '{{result.fromTriggerA}}' },
          },
        },
        {
          topic: 'TOPIC_B',
          onComplete: {
            config: { text: '{{result.fromTriggerB}}' },
          },
        },
        {
          topic: 'TOPIC_C',
          onComplete: {
            config: { nested: { deep: '{{result.fromTriggerC}}' } },
          },
        },
      ],
    };
    const vars = extractTemplateVariables(agent);
    assert.ok(vars.has('fromTriggerA'), 'should find var from first trigger');
    assert.ok(vars.has('fromTriggerB'), 'should find var from second trigger');
    assert.ok(vars.has('fromTriggerC'), 'should find var from third trigger');
    assert.strictEqual(vars.size, 3);
  });

  // Test 17: triggers[].onComplete.transform.script extraction
  // REGRESSION: Transform scripts inside triggers were not being extracted
  it('should extract from triggers[].onComplete.transform.script', function () {
    const agent = {
      triggers: [
        {
          topic: 'VALIDATION',
          onComplete: {
            transform: {
              script: 'return result.approved && result.score > 0.8;',
            },
            config: { text: '{{result.summary}}' },
          },
        },
      ],
    };
    const vars = extractTemplateVariables(agent);
    assert.ok(vars.has('approved'), 'should find approved from transform script');
    assert.ok(vars.has('score'), 'should find score from transform script');
    assert.ok(vars.has('summary'), 'should find summary from config');
    assert.strictEqual(vars.size, 3);
  });
});

describe('extractTemplateVariables - empty inputs', function () {
  // Test 10: No hooks at all
  it('should return empty set when agent has no hooks', function () {
    const agent = { id: 'test', role: 'impl' };
    const vars = extractTemplateVariables(agent);
    assert.strictEqual(vars.size, 0);
  });

  // Test 11: Hooks but no onComplete
  it('should return empty set when hooks has no onComplete', function () {
    const agent = { hooks: {} };
    const vars = extractTemplateVariables(agent);
    assert.strictEqual(vars.size, 0);
  });

  // Test 12: Empty config object
  it('should return empty set for empty config object', function () {
    const agent = { hooks: { onComplete: { config: {} } } };
    const vars = extractTemplateVariables(agent);
    assert.strictEqual(vars.size, 0);
  });

  // Test 18: Empty onComplete object
  it('should return empty set for empty onComplete object', function () {
    const agent = { hooks: { onComplete: {} } };
    const vars = extractTemplateVariables(agent);
    assert.strictEqual(vars.size, 0);
  });
});

describe('extractTemplateVariables - edge cases', function () {
  // Test 13: Duplicate variable refs (deduplication)
  it('should deduplicate multiple references to same variable', function () {
    const agent = {
      hooks: {
        onComplete: {
          config: {
            text: '{{result.x}} {{result.x}} {{result.x}}',
          },
        },
      },
    };
    const vars = extractTemplateVariables(agent);
    assert.ok(vars.has('x'));
    assert.strictEqual(vars.size, 1);
  });

  // Test 14: Malformed mustache (edge case) - missing field name
  it('should not match malformed mustache {{result.}}', function () {
    const agent = {
      hooks: {
        onComplete: {
          config: { text: '{{result.}}' },
        },
      },
    };
    const vars = extractTemplateVariables(agent);
    assert.strictEqual(vars.size, 0);
  });

  // Test 15: Malformed mustache - no dot
  it('should not match {{result}} without field', function () {
    const agent = {
      hooks: {
        onComplete: {
          config: { text: '{{result}}' },
        },
      },
    };
    const vars = extractTemplateVariables(agent);
    assert.strictEqual(vars.size, 0);
  });

  // Test 19: Regex lastIndex pollution
  // REGRESSION: Global regex /g with lastIndex can skip matches on consecutive calls
  it('should not be affected by regex lastIndex state pollution', function () {
    // Create two agents and call extraction multiple times
    const agent1 = {
      hooks: {
        onComplete: {
          config: { text: '{{result.first}} {{result.second}}' },
        },
      },
    };
    const agent2 = {
      hooks: {
        onComplete: {
          config: { text: '{{result.third}} {{result.fourth}}' },
        },
      },
    };

    // Call multiple times in sequence - regex state should not pollute
    const vars1a = extractTemplateVariables(agent1);
    const vars2 = extractTemplateVariables(agent2);
    const vars1b = extractTemplateVariables(agent1);

    // First call for agent1
    assert.ok(vars1a.has('first'));
    assert.ok(vars1a.has('second'));
    assert.strictEqual(vars1a.size, 2);

    // Call for agent2
    assert.ok(vars2.has('third'));
    assert.ok(vars2.has('fourth'));
    assert.strictEqual(vars2.size, 2);

    // Second call for agent1 (same result - no pollution)
    assert.ok(vars1b.has('first'));
    assert.ok(vars1b.has('second'));
    assert.strictEqual(vars1b.size, 2);
  });

  // Test 20: Nested result path like {{result.nested.field}}
  it('should extract full path for nested result access', function () {
    const agent = {
      hooks: {
        onComplete: {
          config: { text: '{{result.nested.field}}' },
        },
      },
    };
    const vars = extractTemplateVariables(agent);
    // Should extract "nested.field" as the full path
    assert.ok(vars.has('nested.field') || vars.has('nested'), 'should extract nested path');
  });
});

describe('extractSchemaProperties', function () {
  // Test 1: Non-JSON agent (outputFormat: 'text')
  it('should return null for outputFormat: text', function () {
    const agent = { outputFormat: 'text' };
    const props = extractSchemaProperties(agent);
    assert.strictEqual(props, null);
  });

  // Test 2: No outputFormat specified
  it('should return null when outputFormat is undefined', function () {
    const agent = {};
    const props = extractSchemaProperties(agent);
    assert.strictEqual(props, null);
  });

  // Test 3: JSON without explicit schema - default
  it('should return default schema for json without explicit schema', function () {
    const agent = { outputFormat: 'json' };
    const props = extractSchemaProperties(agent);
    assert.ok(props.has('summary'));
    assert.ok(props.has('result'));
    assert.strictEqual(props.size, 2);
  });

  // Test 4: JSON with explicit schema
  it('should return schema properties from explicit jsonSchema', function () {
    const agent = {
      outputFormat: 'json',
      jsonSchema: {
        type: 'object',
        properties: {
          approved: { type: 'boolean' },
          issues: { type: 'array' },
          summary: { type: 'string' },
        },
      },
    };
    const props = extractSchemaProperties(agent);
    assert.ok(props.has('approved'));
    assert.ok(props.has('issues'));
    assert.ok(props.has('summary'));
    assert.strictEqual(props.size, 3);
  });

  // Test 5: Empty properties object
  it('should return empty set for empty properties', function () {
    const agent = {
      outputFormat: 'json',
      jsonSchema: {
        type: 'object',
        properties: {},
      },
    };
    const props = extractSchemaProperties(agent);
    assert.strictEqual(props.size, 0);
  });

  // Test 6: Schema with nested properties - only top-level
  it('should extract only top-level properties from nested schema', function () {
    const agent = {
      outputFormat: 'json',
      jsonSchema: {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: { innerField: { type: 'string' } },
          },
        },
      },
    };
    const props = extractSchemaProperties(agent);
    assert.ok(props.has('nested'));
    assert.ok(!props.has('innerField')); // Only top-level
    assert.strictEqual(props.size, 1);
  });

  // Test 7: Schema with required array
  it('should extract from properties, not required array', function () {
    const agent = {
      outputFormat: 'json',
      jsonSchema: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a'],
      },
    };
    const props = extractSchemaProperties(agent);
    assert.ok(props.has('a'));
    assert.ok(props.has('b'));
    assert.strictEqual(props.size, 2);
  });

  // Test 8: Null jsonSchema with JSON outputFormat
  it('should return default schema when jsonSchema is null', function () {
    const agent = { outputFormat: 'json', jsonSchema: null };
    const props = extractSchemaProperties(agent);
    assert.ok(props.has('summary'));
    assert.ok(props.has('result'));
  });

  // Test 9: stream-json outputFormat - should validate like 'json'
  // REGRESSION: Bug where stream-json was skipped because only 'json' was checked
  it('should return schema properties for stream-json outputFormat', function () {
    const agent = {
      outputFormat: 'stream-json',
      jsonSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          approved: { type: 'boolean' },
        },
      },
    };
    const props = extractSchemaProperties(agent);
    assert.ok(props !== null, 'stream-json should not return null');
    assert.ok(props.has('summary'));
    assert.ok(props.has('approved'));
    assert.strictEqual(props.size, 2);
  });

  // Test 10: stream-json without explicit schema - should use defaults
  it('should return default schema for stream-json without explicit schema', function () {
    const agent = { outputFormat: 'stream-json' };
    const props = extractSchemaProperties(agent);
    assert.ok(props !== null, 'stream-json should not return null');
    assert.ok(props.has('summary'));
    assert.ok(props.has('result'));
    assert.strictEqual(props.size, 2);
  });
});

describe('validateAgentTemplateVariables', function () {
  // Helper to create a valid JSON agent with schema and hooks
  function createJsonAgent(schemaProps, templateVars) {
    const agent = {
      id: 'test-agent',
      outputFormat: 'json',
      jsonSchema: {
        type: 'object',
        properties: {},
      },
      hooks: {
        onComplete: {
          config: { text: '' },
        },
      },
    };
    // Add schema properties
    for (const prop of schemaProps) {
      agent.jsonSchema.properties[prop] = { type: 'string' };
    }
    // Add template variables
    agent.hooks.onComplete.config.text = templateVars.map((v) => `{{result.${v}}}`).join(' ');
    return agent;
  }

  // Test 1: Ref exists in schema - no error
  it('should not error when template ref exists in schema', function () {
    const agent = createJsonAgent(['summary'], ['summary']);
    const result = validateAgentTemplateVariables(agent, 'test');
    assert.strictEqual(result.errors.length, 0);
  });

  // Test 2: Ref NOT in schema - ERROR
  it('should error when template references undefined field', function () {
    const agent = createJsonAgent(['summary'], ['nonexistent']);
    const result = validateAgentTemplateVariables(agent, 'test');
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes('nonexistent'));
    assert.ok(result.errors[0].includes('not defined in jsonSchema'));
  });

  // Test 3: Multiple undefined refs - multiple ERRORs
  it('should error for each undefined field', function () {
    const agent = createJsonAgent(['summary'], ['bad1', 'bad2', 'bad3']);
    const result = validateAgentTemplateVariables(agent, 'test');
    assert.strictEqual(result.errors.length, 3);
  });

  // Test 4: Schema prop unused - WARNING
  it('should warn when schema property is never referenced', function () {
    const agent = createJsonAgent(['summary', 'unused'], ['summary']);
    const result = validateAgentTemplateVariables(agent, 'test');
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('unused'));
    assert.ok(result.warnings[0].includes('never referenced'));
  });

  // Test 5: Multiple unused props - multiple WARNINGs
  it('should warn for each unused property', function () {
    const agent = createJsonAgent(['a', 'b', 'c', 'd'], ['a']);
    const result = validateAgentTemplateVariables(agent, 'test');
    assert.strictEqual(result.warnings.length, 3); // b, c, d unused
  });

  // Test 6: All refs valid, all props used - clean
  it('should return clean result when all vars match schema', function () {
    const agent = createJsonAgent(['a', 'b'], ['a', 'b']);
    const result = validateAgentTemplateVariables(agent, 'test');
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.warnings.length, 0);
  });

  // Test 7: Some valid, some invalid - mixed
  it('should return both errors and warnings for mixed issues', function () {
    const agent = createJsonAgent(['valid', 'unused'], ['valid', 'invalid']);
    const result = validateAgentTemplateVariables(agent, 'test');
    assert.strictEqual(result.errors.length, 1); // invalid
    assert.strictEqual(result.warnings.length, 1); // unused
  });

  // Test 8: Non-JSON agent - skip validation
  it('should skip validation for non-json outputFormat', function () {
    const agent = { id: 'test', outputFormat: 'text' };
    const result = validateAgentTemplateVariables(agent, 'test');
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.warnings.length, 0);
  });

  // Test 9: Default schema used
  it('should validate against default schema when no explicit schema', function () {
    const agent = {
      id: 'test',
      outputFormat: 'json',
      hooks: {
        onComplete: {
          config: { text: '{{result.summary}} {{result.result}}' },
        },
      },
    };
    const result = validateAgentTemplateVariables(agent, 'test');
    assert.strictEqual(result.errors.length, 0);
  });

  // Test 10: Error message format - contains agent ID and field name
  it('should include agent ID and field name in error message', function () {
    const agent = createJsonAgent(['a'], ['badfield']);
    const result = validateAgentTemplateVariables(agent, 'my-agent');
    assert.ok(result.errors[0].includes("Agent 'my-agent'"));
    assert.ok(result.errors[0].includes('badfield'));
  });

  // Test 11: Warning message format
  it('should include agent ID and field name in warning message', function () {
    const agent = createJsonAgent(['unusedField'], []);
    const result = validateAgentTemplateVariables(agent, 'my-agent');
    assert.ok(result.warnings[0].includes("Agent 'my-agent'"));
    assert.ok(result.warnings[0].includes('unusedField'));
  });

  // Test 12: Empty hooks + default schema - warnings for unused defaults
  it('should warn about unused default schema fields', function () {
    const agent = {
      id: 'test',
      outputFormat: 'json',
      hooks: { onComplete: { config: {} } },
    };
    const result = validateAgentTemplateVariables(agent, 'test');
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.warnings.length, 2); // summary and result unused
  });
});

describe('validateTemplateVariables (Phase 5 entry)', function () {
  // Helper to create minimal valid agent
  function createAgent(id, schemaProps, templateVars) {
    const agent = {
      id,
      role: 'impl',
      triggers: [{ topic: 'X' }],
      outputFormat: 'json',
      jsonSchema: { type: 'object', properties: {} },
      hooks: { onComplete: { config: { text: '' } } },
    };
    for (const prop of schemaProps) {
      agent.jsonSchema.properties[prop] = { type: 'string' };
    }
    agent.hooks.onComplete.config.text = templateVars.map((v) => `{{result.${v}}}`).join(' ');
    return agent;
  }

  // Test 1: Single agent, all valid
  it('should return clean result for valid single agent', function () {
    const config = {
      agents: [createAgent('worker', ['a'], ['a'])],
    };
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.warnings.length, 0);
  });

  // Test 2: Single agent, undefined ref
  it('should error for single agent with undefined ref', function () {
    const config = {
      agents: [createAgent('worker', ['a'], ['bad'])],
    };
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes('bad'));
  });

  // Test 3: Multiple agents, one invalid
  it('should only error for invalid agent', function () {
    const config = {
      agents: [
        createAgent('valid-worker', ['a'], ['a']),
        createAgent('invalid-worker', ['b'], ['nonexistent']),
      ],
    };
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes('invalid-worker'));
  });

  // Test 4: Multiple agents, multiple invalid
  it('should error for each invalid agent', function () {
    const config = {
      agents: [createAgent('bad1', ['a'], ['x']), createAgent('bad2', ['b'], ['y'])],
    };
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.errors.length, 2);
  });

  // Test 5: Sub-cluster depth 1
  it('should prefix errors with sub-cluster name', function () {
    const config = {
      agents: [
        {
          id: 'sub1',
          type: 'subcluster',
          config: {
            agents: [createAgent('inner-worker', ['a'], ['bad'])],
          },
        },
      ],
    };
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes("Sub-cluster 'sub1'"));
  });

  // Test 6: Sub-cluster depth 2
  it('should double-prefix for nested sub-clusters', function () {
    const config = {
      agents: [
        {
          id: 'outer',
          type: 'subcluster',
          config: {
            agents: [
              {
                id: 'inner',
                type: 'subcluster',
                config: {
                  agents: [createAgent('deepest', ['a'], ['bad'])],
                },
              },
            ],
          },
        },
      ],
    };
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes("Sub-cluster 'outer'"));
    assert.ok(result.errors[0].includes("Sub-cluster 'inner'"));
  });

  // Test 7: Empty agents array
  it('should return clean result for empty agents array', function () {
    const config = { agents: [] };
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.warnings.length, 0);
  });

  // Test 8: Null config.agents
  it('should return clean result for null agents', function () {
    const config = { agents: null };
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.errors.length, 0);
  });

  // Test 9: Undefined config.agents
  it('should return clean result for undefined agents', function () {
    const config = {};
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.errors.length, 0);
  });

  // Test 10: Mixed root valid, sub-cluster invalid
  it('should only error for sub-cluster agent', function () {
    const config = {
      agents: [
        createAgent('root-worker', ['a'], ['a']),
        {
          id: 'sub',
          type: 'subcluster',
          config: {
            agents: [createAgent('sub-worker', ['b'], ['bad'])],
          },
        },
      ],
    };
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes("Sub-cluster 'sub'"));
    assert.ok(result.errors[0].includes('sub-worker'));
  });
});

describe('Integration with validateConfig()', function () {
  // Test 1: Phase 5 runs (errors block validation)
  it('should block validation when template var errors exist', function () {
    const config = {
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          triggers: [{ topic: 'ISSUE_OPENED' }],
          outputFormat: 'json',
          jsonSchema: { type: 'object', properties: { summary: { type: 'string' } } },
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'DONE', content: { text: '{{result.nonexistent}}' } },
            },
          },
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
        },
      ],
    };
    const result = validateConfig(config);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('nonexistent')));
  });

  // Test 2: Phase 5 warnings don't block
  it('should not block validation for warnings only', function () {
    const config = {
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          triggers: [{ topic: 'ISSUE_OPENED' }],
          outputFormat: 'json',
          jsonSchema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              unusedProp: { type: 'string' },
            },
          },
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'DONE', content: { text: '{{result.summary}}' } },
            },
          },
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
        },
      ],
    };
    const result = validateConfig(config);
    assert.strictEqual(result.valid, true);
    assert.ok(result.warnings.some((w) => w.includes('unusedProp')));
  });

  // Test 3: Real config: full-workflow.json
  it('should validate full-workflow.json without template errors', function () {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(
      __dirname,
      '..',
      'cluster-templates',
      'base-templates',
      'full-workflow.json'
    );
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    const result = validateConfig(config);
    // Filter to only template-related errors
    const templateErrors = result.errors.filter(
      (e) => e.includes('{{result.') || e.includes('not defined in jsonSchema')
    );
    assert.strictEqual(templateErrors.length, 0, `Template errors: ${templateErrors.join(', ')}`);
  });

  // Test 4: Real config: conductor-bootstrap.json (if exists)
  it('should validate conductor-bootstrap.json without template errors', function () {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(__dirname, '..', 'cluster-templates', 'conductor-bootstrap.json');

    // Skip if file doesn't exist
    if (!fs.existsSync(configPath)) {
      this.skip();
      return;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const result = validateConfig(config);
    const templateErrors = result.errors.filter(
      (e) => e.includes('{{result.') || e.includes('not defined in jsonSchema')
    );
    assert.strictEqual(templateErrors.length, 0, `Template errors: ${templateErrors.join(', ')}`);
  });

  // Test 5: Non-JSON agents pass without template validation
  it('should skip template validation for non-JSON agents', function () {
    const config = {
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          triggers: [{ topic: 'ISSUE_OPENED' }],
          // No outputFormat or text format - template validation skipped
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'DONE', content: { text: '{{result.anything}}' } },
            },
          },
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
        },
      ],
    };
    const result = validateConfig(config);
    // Should have no template-related errors (non-JSON agents are skipped)
    const templateErrors = result.errors.filter((e) => e.includes('not defined in jsonSchema'));
    assert.strictEqual(templateErrors.length, 0);
  });
});

describe('Real-World Regression Tests', function () {
  // Test 1: Typo in template var
  it('should catch typo: {{result.sumary}} instead of summary', function () {
    const config = {
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'X' }],
          outputFormat: 'json',
          jsonSchema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
          },
          hooks: {
            onComplete: {
              config: { text: '{{result.sumary}}' }, // Typo!
            },
          },
        },
      ],
    };
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes('sumary'));
  });

  // Test 2: Case sensitivity
  it('should catch case mismatch: {{result.Summary}} vs summary', function () {
    const config = {
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'X' }],
          outputFormat: 'json',
          jsonSchema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
          },
          hooks: {
            onComplete: {
              config: { text: '{{result.Summary}}' }, // Wrong case!
            },
          },
        },
      ],
    };
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes('Summary'));
  });

  // Test 3: Added schema field, forgot hook
  it('should warn when schema field added but not used in hooks', function () {
    const config = {
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'X' }],
          outputFormat: 'json',
          jsonSchema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              newField: { type: 'string' }, // Added but not used
            },
          },
          hooks: {
            onComplete: {
              config: { text: '{{result.summary}}' },
            },
          },
        },
      ],
    };
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('newField'));
  });

  // Test 4: Removed schema field, forgot hook
  it('should error when hook references removed schema field', function () {
    const config = {
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'X' }],
          outputFormat: 'json',
          jsonSchema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
            // 'oldField' was removed from schema
          },
          hooks: {
            onComplete: {
              config: { text: '{{result.summary}} {{result.oldField}}' }, // oldField no longer exists
            },
          },
        },
      ],
    };
    const result = validateTemplateVariables(config);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes('oldField'));
  });

  // Test 5: Nested field access (edge case)
  it('should extract nested field access as single key', function () {
    const config = {
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'X' }],
          outputFormat: 'json',
          jsonSchema: {
            type: 'object',
            properties: {
              'nested.field': { type: 'string' },
            },
          },
          hooks: {
            onComplete: {
              config: { text: '{{result.nested.field}}' },
            },
          },
        },
      ],
    };
    const result = validateTemplateVariables(config);
    // nested.field is treated as single key name
    assert.strictEqual(result.errors.length, 0);
  });
});

// === SEMANTIC VALIDATION TESTS (ISSUE #14) ===

describe('Semantic Validation - Critical Gaps (1-2)', function () {
  describe('Gap 1: Hook action missing', function () {
    it('should error when hook has no action field', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            hooks: {
              onComplete: {
                config: { topic: 'DONE' }, // Missing action field
              },
            },
          },
        ],
      };
      const result = validateConfig(config);
      assert.strictEqual(result.valid, false);
      const hookErrors = result.errors.filter((e) => e.includes('[Gap 1]'));
      assert.ok(hookErrors.length > 0, 'Should have Gap 1 error');
      assert.ok(hookErrors[0].includes('action'));
    });

    it('should pass when hook has action field', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const hookErrors = result.errors.filter((e) => e.includes('[Gap 1]'));
      assert.strictEqual(hookErrors.length, 0);
    });
  });

  describe('Gap 2: Transform output shape invalid', function () {
    it('should error when transform script missing topic', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                transform: {
                  script: 'return { content: { data: result } }', // Missing topic
                },
              },
            },
          },
        ],
      };
      const result = validateConfig(config);
      const transformErrors = result.errors.filter((e) => e.includes('[Gap 2]'));
      assert.ok(transformErrors.length > 0, 'Should have Gap 2 error');
      assert.ok(transformErrors.some((e) => e.includes('topic')));
    });

    it('should error when transform script missing content', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                transform: {
                  script: 'return { topic: "DONE" }', // Missing content
                },
              },
            },
          },
        ],
      };
      const result = validateConfig(config);
      const transformErrors = result.errors.filter((e) => e.includes('[Gap 2]'));
      assert.ok(transformErrors.length > 0, 'Should have Gap 2 error');
      assert.ok(transformErrors.some((e) => e.includes('content')));
    });

    it('should pass when transform script has both topic and content', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                transform: {
                  script: 'return { topic: "DONE", content: { data: result } }',
                },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const transformErrors = result.errors.filter((e) => e.includes('[Gap 2]'));
      assert.strictEqual(transformErrors.length, 0);
    });
  });
});

describe('Semantic Validation - Critical Gap 4', function () {
  describe('Gap 4: Model rule iteration gaps', function () {
    it('should error when model rules have gaps', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            maxIterations: 10,
            modelRules: [{ iterations: '1-3', model: 'opus' }], // Gap: 4-10
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const gapErrors = result.errors.filter((e) => e.includes('[Gap 4]'));
      assert.ok(gapErrors.length > 0, 'Should have Gap 4 error');
      assert.ok(gapErrors[0].includes('4-10') || gapErrors[0].includes('gaps'));
    });

    it('should pass when model rules have catch-all', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            maxIterations: 10,
            modelRules: [
              { iterations: '1-3', model: 'opus' },
              { iterations: '4+', model: 'sonnet' }, // Catch-all
            ],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const gapErrors = result.errors.filter((e) => e.includes('[Gap 4]'));
      assert.strictEqual(gapErrors.length, 0);
    });

    it('should pass when model rules use "all"', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            maxIterations: 30,
            modelRules: [{ iterations: 'all', model: 'sonnet' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const gapErrors = result.errors.filter((e) => e.includes('[Gap 4]'));
      assert.strictEqual(gapErrors.length, 0);
    });
  });
});

describe('Semantic Validation - Critical Gap 5', function () {
  describe('Gap 5: Prompt rule iteration gaps', function () {
    it('should error when prompt rules have gaps', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            maxIterations: 10,
            promptConfig: {
              type: 'rules',
              rules: [{ iterations: '1-5', prompt: 'First pass' }], // Gap: 6-10
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const gapErrors = result.errors.filter((e) => e.includes('[Gap 5]'));
      assert.ok(gapErrors.length > 0, 'Should have Gap 5 error');
      assert.ok(gapErrors[0].includes('6-10') || gapErrors[0].includes('gaps'));
    });

    it('should pass when prompt rules have catch-all', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            maxIterations: 10,
            promptConfig: {
              type: 'rules',
              rules: [
                { iterations: '1-5', prompt: 'First pass' },
                { iterations: '6+', prompt: 'Retry mode' },
              ],
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const gapErrors = result.errors.filter((e) => e.includes('[Gap 5]'));
      assert.strictEqual(gapErrors.length, 0);
    });
  });
});

describe('Semantic Validation - Critical Gap 6', function () {
  describe('Gap 6: 3+ agent circular dependencies', function () {
    it('should error for 3-agent cycle without escape logic', function () {
      const config = {
        agents: [
          {
            id: 'agentA',
            role: 'implementation',
            triggers: [{ topic: 'TOPIC_C' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'TOPIC_A', content: {} },
              },
            },
          },
          {
            id: 'agentB',
            role: 'validator',
            triggers: [{ topic: 'TOPIC_A' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'TOPIC_B', content: {} },
              },
            },
          },
          {
            id: 'agentC',
            role: 'orchestrator',
            triggers: [{ topic: 'TOPIC_B' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'TOPIC_C', content: {} },
              },
            },
          },
        ],
      };
      const result = validateConfig(config);
      const cycleErrors = result.errors.filter((e) => e.includes('[Gap 6]'));
      assert.ok(cycleErrors.length > 0, 'Should detect 3-agent cycle');
      assert.ok(cycleErrors[0].includes('→'), 'Should show cycle path');
    });

    it('should warn for 3-agent cycle with escape logic', function () {
      const config = {
        agents: [
          {
            id: 'agentA',
            role: 'implementation',
            triggers: [
              {
                topic: 'TOPIC_C',
                logic: { script: 'return message.iteration < 5' }, // Escape logic
              },
            ],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'TOPIC_A', content: {} },
              },
            },
          },
          {
            id: 'agentB',
            role: 'validator',
            triggers: [{ topic: 'TOPIC_A' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'TOPIC_B', content: {} },
              },
            },
          },
          {
            id: 'agentC',
            role: 'orchestrator',
            triggers: [{ topic: 'TOPIC_B' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'TOPIC_C', content: {} },
              },
            },
          },
        ],
      };
      const result = validateConfig(config);
      const cycleErrors = result.errors.filter((e) => e.includes('[Gap 6]'));
      assert.strictEqual(cycleErrors.length, 0, 'Should not error with escape logic');
      const cycleWarnings = result.warnings.filter((w) => w.includes('Circular dependency'));
      assert.ok(cycleWarnings.length > 0, 'Should warn about cycle');
    });

    it('should not error for acyclic graph', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'WORK_DONE', content: {} },
              },
            },
          },
          {
            id: 'validator',
            role: 'validator',
            triggers: [{ topic: 'WORK_DONE' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'VALIDATION_RESULT', content: {} },
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
      const result = validateConfig(config);
      const cycleErrors = result.errors.filter((e) => e.includes('[Gap 6]'));
      assert.strictEqual(cycleErrors.length, 0);
    });
  });
});

describe('Semantic Validation - Critical Gap 7', function () {
  describe('Gap 7: CLUSTER_OPERATIONS payload invalid', function () {
    it('should error when CLUSTER_OPERATIONS missing operations field', function () {
      const config = {
        agents: [
          {
            id: 'conductor',
            role: 'conductor',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                transform: {
                  script: 'return { topic: "CLUSTER_OPERATIONS", content: { data: {} } }', // Missing operations
                },
              },
            },
          },
        ],
      };
      const result = validateConfig(config);
      const opErrors = result.errors.filter((e) => e.includes('[Gap 7]'));
      assert.ok(opErrors.length > 0, 'Should have Gap 7 error');
      assert.ok(opErrors[0].includes('operations'));
    });

    it('should pass when CLUSTER_OPERATIONS has operations field', function () {
      const config = {
        agents: [
          {
            id: 'conductor',
            role: 'conductor',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                transform: {
                  script:
                    'return { topic: "CLUSTER_OPERATIONS", content: { data: { operations: JSON.stringify([]) } } }',
                },
              },
            },
          },
        ],
      };
      const result = validateConfig(config);
      const opErrors = result.errors.filter((e) => e.includes('[Gap 7]'));
      assert.strictEqual(opErrors.length, 0);
    });
  });
});

describe('Semantic Validation - Medium Gaps (8-9)', function () {
  describe('Gap 8: JSON schema structurally invalid', function () {
    it('should error when jsonSchema is not an object', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            jsonSchema: 'invalid', // Not an object
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const schemaErrors = result.errors.filter((e) => e.includes('[Gap 8]'));
      assert.ok(schemaErrors.length > 0, 'Should have Gap 8 error');
    });

    it('should pass when jsonSchema is valid object', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            jsonSchema: {
              type: 'object',
              properties: { summary: { type: 'string' } },
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const schemaErrors = result.errors.filter((e) => e.includes('[Gap 8]'));
      assert.strictEqual(schemaErrors.length, 0);
    });
  });

  describe('Gap 9: Context sources never produced', function () {
    it('should warn when context topic is never produced', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            contextStrategy: {
              sources: [{ topic: 'NONEXISTENT_TOPIC', amount: 1 }],
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const contextWarnings = result.warnings.filter((w) => w.includes('[Gap 9]'));
      assert.ok(contextWarnings.length > 0, 'Should have Gap 9 warning');
    });

    it('should not warn for STATE_SNAPSHOT context source', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            contextStrategy: {
              sources: [{ topic: 'STATE_SNAPSHOT', amount: 1 }],
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const snapshotWarnings = result.warnings.filter(
        (warning) => warning.includes('[Gap 9]') && warning.includes('STATE_SNAPSHOT')
      );
      assert.strictEqual(snapshotWarnings.length, 0, 'STATE_SNAPSHOT should not trigger Gap 9');
    });
  });
});

describe('Semantic Validation - Medium Gaps (10-11)', function () {
  describe('Gap 10: Isolation config invalid', function () {
    it('should error when docker isolation missing image', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            isolation: {
              type: 'docker',
              // Missing image field
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const isolationErrors = result.errors.filter((e) => e.includes('[Gap 10]'));
      assert.ok(isolationErrors.length > 0, 'Should have Gap 10 error');
      assert.ok(isolationErrors[0].includes('image'));
    });

    it('should error for unknown isolation type', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            isolation: {
              type: 'invalid-type',
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const isolationErrors = result.errors.filter((e) => e.includes('[Gap 10]'));
      assert.ok(isolationErrors.length > 0, 'Should have Gap 10 error');
      assert.ok(isolationErrors[0].includes('Unknown isolation type'));
    });
  });

  describe('Gap 11: Agent ID conflicts across subclusters', function () {
    it('should error when duplicate agent ID in subcluster', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'sub',
            type: 'subcluster',
            role: 'orchestrator', // Subclusters need a role too
            config: {
              agents: [
                {
                  id: 'worker', // Duplicate ID
                  role: 'validator',
                  triggers: [{ topic: 'X' }],
                  hooks: {
                    onComplete: {
                      action: 'publish_message',
                      config: { topic: 'DONE', content: {} },
                    },
                  },
                },
              ],
            },
          },
        ],
      };
      const result = validateConfig(config);
      const idErrors = result.errors.filter((e) => e.includes('[Gap 11]'));
      assert.ok(idErrors.length > 0, 'Should have Gap 11 error');
      assert.ok(idErrors[0].includes('Duplicate agent ID'));
    });
  });
});

describe('Semantic Validation - Medium Gaps (12-13)', function () {
  describe('Gap 12: Load config file paths dont exist', function () {
    it('should error when loadConfig path doesnt exist', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            loadConfig: {
              path: '/nonexistent/path/config.json',
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const pathErrors = result.errors.filter((e) => e.includes('[Gap 12]'));
      assert.ok(pathErrors.length > 0, 'Should have Gap 12 error');
      assert.ok(pathErrors[0].includes('does not exist'));
    });
  });

  describe('Gap 13: Task executor config invalid', function () {
    it('should error when task executor missing command', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            taskExecutor: {
              retries: 3,
              // Missing command
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const execErrors = result.errors.filter((e) => e.includes('[Gap 13]'));
      assert.ok(execErrors.length > 0, 'Should have Gap 13 error');
      assert.ok(execErrors[0].includes('command'));
    });

    it('should error when retries is negative', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            taskExecutor: {
              command: 'claude',
              retries: -1,
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const execErrors = result.errors.filter((e) => e.includes('[Gap 13]'));
      assert.ok(execErrors.length > 0, 'Should have Gap 13 error');
      assert.ok(execErrors[0].includes('retries'));
    });

    it('should error when timeout is invalid', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            taskExecutor: {
              command: 'claude',
              timeout: -1000,
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const execErrors = result.errors.filter((e) => e.includes('[Gap 13]'));
      assert.ok(execErrors.length > 0, 'Should have Gap 13 error');
      assert.ok(execErrors[0].includes('timeout'));
    });
  });
});

describe('Semantic Validation - Medium Gap 14', function () {
  describe('Gap 14: Context source format invalid', function () {
    it('should error when context strategy has invalid value', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            contextStrategy: {
              sources: [{ topic: 'TEST', amount: 1, strategy: 'invalid-strategy' }],
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'tester',
            role: 'validator',
            triggers: [{ topic: 'X' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'TEST', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const strategyErrors = result.errors.filter((e) => e.includes('[Gap 14]'));
      assert.ok(strategyErrors.length > 0, 'Should have Gap 14 error');
      assert.ok(strategyErrors[0].includes('strategy'));
    });

    it('should warn when context source missing amount', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            contextStrategy: {
              sources: [{ topic: 'TEST', strategy: 'latest' }], // Missing amount
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'tester',
            role: 'validator',
            triggers: [{ topic: 'X' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'TEST', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const amountWarnings = result.warnings.filter((w) => w.includes('[Gap 14]'));
      assert.ok(amountWarnings.length > 0, 'Should have Gap 14 warning');
      assert.ok(amountWarnings[0].includes('amount'));
    });

    it('should accept limit as amount alias without warning', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [{ topic: 'ISSUE_OPENED' }],
            contextStrategy: {
              sources: [{ topic: 'TEST', limit: 1 }],
            },
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'tester',
            role: 'validator',
            triggers: [{ topic: 'X' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'TEST', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const amountWarnings = result.warnings.filter(
        (w) => w.includes('[Gap 14]') && w.includes('amount')
      );
      assert.strictEqual(amountWarnings.length, 0);
    });
  });
});

describe('Semantic Validation - Medium Gap 15', function () {
  describe('Gap 15: Role references stricter', function () {
    it('should error when critical logic references missing role', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [
              {
                topic: 'VALIDATION_RESULT',
                logic: {
                  script: 'return cluster.getAgentsByRole("validator").length > 0', // References missing role
                },
              },
            ],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const roleErrors = result.errors.filter((e) => e.includes('[Gap 15]'));
      assert.ok(roleErrors.length > 0, 'Should have Gap 15 error');
      assert.ok(roleErrors[0].includes('validator'));
    });

    it('should pass when role exists', function () {
      const config = {
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            triggers: [
              {
                topic: 'VALIDATION_RESULT',
                logic: {
                  script: 'return cluster.getAgentsByRole("validator").length > 0',
                },
              },
            ],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'DONE', content: {} },
              },
            },
          },
          {
            id: 'validator',
            role: 'validator',
            triggers: [{ topic: 'WORK_DONE' }],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'VALIDATION_RESULT', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const roleErrors = result.errors.filter((e) => e.includes('[Gap 15]'));
      assert.strictEqual(roleErrors.length, 0);
    });

    it('should pass when logic has zero-length fallback (git-pusher pattern)', function () {
      // This tests the git-pusher agent pattern that checks validators.length === 0
      // and returns early if no validators exist (valid TRIVIAL/SIMPLE workflow)
      const config = {
        agents: [
          {
            id: 'git-pusher',
            role: 'completion-detector',
            triggers: [
              {
                topic: 'VALIDATION_RESULT',
                logic: {
                  // This is the exact pattern from git-pusher-agent.json
                  // It correctly handles zero validators with an early return
                  script:
                    "const validators = cluster.getAgentsByRole('validator'); if (validators.length === 0) return true; return validators.length > 0;",
                },
              },
            ],
            hooks: {
              onComplete: {
                action: 'publish_message',
                config: { topic: 'PR_CREATED', content: {} },
              },
            },
          },
          {
            id: 'completion',
            role: 'orchestrator',
            triggers: [{ topic: 'PR_CREATED', action: 'stop_cluster' }],
          },
        ],
      };
      const result = validateConfig(config);
      const roleErrors = result.errors.filter((e) => e.includes('[Gap 15]'));
      assert.strictEqual(
        roleErrors.length,
        0,
        'Should not error when logic has zero-length fallback pattern'
      );
    });
  });
});

describe('Regression: No existing validation failures', function () {
  it('should not break existing configs', function () {
    // Basic valid config from earlier tests
    const config = {
      agents: [
        {
          id: 'worker',
          role: 'implementation',
          triggers: [{ topic: 'ISSUE_OPENED' }],
          modelRules: [{ iterations: 'all', model: 'sonnet' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'DONE', content: {} },
            },
          },
        },
        {
          id: 'completion',
          role: 'orchestrator',
          triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
        },
      ],
    };
    const result = validateConfig(config);
    // Should pass all phases including new semantic validation
    assert.strictEqual(result.valid, true);
  });
});

// === PROVIDER-AGNOSTIC MODEL VALIDATION ===
// Prevents hardcoding provider-specific model names (haiku/sonnet/opus/gpt-4/gemini)
// which break when switching providers. Use modelLevel: level1/level2/level3 instead.

describe('Provider-agnostic model validation', function () {
  it('should ERROR when agent uses direct model field', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          model: 'haiku', // FORBIDDEN - must use modelLevel
          triggers: [{ topic: 'START' }],
        },
      ],
    });
    assert.ok(
      result.errors.some((e) => e.includes("uses 'model:")),
      'Expected error about direct model usage. Errors: ' + JSON.stringify(result.errors)
    );
  });

  it('should ERROR for ANY direct model value, not just known names', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          model: 'some-random-model-name',
          triggers: [{ topic: 'START' }],
        },
      ],
    });
    assert.ok(
      result.errors.some((e) => e.includes("uses 'model:")),
      'Expected error about direct model usage. Errors: ' + JSON.stringify(result.errors)
    );
  });

  it('should ALLOW modelLevel field', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          modelLevel: 'level1', // ALLOWED
          triggers: [{ topic: 'START' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'DONE', content: {} },
            },
          },
        },
        {
          id: 'orch',
          role: 'orchestrator',
          triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(
      !result.errors.some((e) => e.includes('model')),
      'Should not error on modelLevel. Errors: ' + JSON.stringify(result.errors)
    );
  });

  it('should ALLOW modelRules with model inside rules (iteration-based selection)', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'START' }],
          modelRules: [
            { iterations: '1-3', model: 'sonnet' },
            { iterations: 'all', model: 'haiku' },
          ],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'DONE', content: {} },
            },
          },
        },
        {
          id: 'orch',
          role: 'orchestrator',
          triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
        },
      ],
    });
    // modelRules is allowed because it's a different system (iteration-based)
    assert.ok(
      !result.errors.some((e) => e.includes("uses 'model:")),
      'modelRules should be allowed. Errors: ' + JSON.stringify(result.errors)
    );
  });
});

// === HOOK LOGIC VALIDATION TESTS ===

describe('Hook Logic Validation - valid cases', function () {
  it('should accept valid hook logic block', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'START' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: {
                topic: 'IMPL_READY',
                content: { text: 'done' },
              },
              logic: {
                engine: 'javascript',
                script: "if (!result.canValidate) return { topic: 'PROGRESS' };",
              },
            },
          },
        },
        {
          id: 'orch',
          role: 'orchestrator',
          triggers: [
            { topic: 'IMPL_READY', action: 'stop_cluster' },
            { topic: 'PROGRESS', action: 'stop_cluster' },
          ],
        },
      ],
    });
    const logicErrors = result.errors.filter((e) => e.includes('logic'));
    assert.strictEqual(
      logicErrors.length,
      0,
      'Should accept valid logic block: ' + JSON.stringify(logicErrors)
    );
  });
});

describe('Hook Logic Validation - engine and script errors', function () {
  it('should reject hook logic with non-javascript engine', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'START' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'DONE', content: {} },
              logic: {
                engine: 'python',
                script: 'return True',
              },
            },
          },
        },
        {
          id: 'orch',
          role: 'orchestrator',
          triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(
      result.errors.some((e) => e.includes("engine must be 'javascript'")),
      'Should reject non-javascript engine. Errors: ' + JSON.stringify(result.errors)
    );
  });

  it('should reject hook logic without script property', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'START' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'DONE', content: {} },
              logic: {
                engine: 'javascript',
              },
            },
          },
        },
        {
          id: 'orch',
          role: 'orchestrator',
          triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(
      result.errors.some((e) => e.includes("must have a 'script' property")),
      'Should reject logic without script. Errors: ' + JSON.stringify(result.errors)
    );
  });

  it('should reject hook logic with syntax error in script', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'START' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'DONE', content: {} },
              logic: {
                engine: 'javascript',
                script: 'if (x { return true; }',
              },
            },
          },
        },
        {
          id: 'orch',
          role: 'orchestrator',
          triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(
      result.errors.some((e) => e.includes('syntax error')),
      'Should reject script with syntax error. Errors: ' + JSON.stringify(result.errors)
    );
  });

  it('should accept hook logic with non-string script (treated as missing)', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'START' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              config: { topic: 'DONE', content: {} },
              logic: {
                engine: 'javascript',
                script: 123,
              },
            },
          },
        },
        {
          id: 'orch',
          role: 'orchestrator',
          triggers: [{ topic: 'DONE', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(
      result.errors.some((e) => e.includes('script must be a string')),
      'Should reject non-string script. Errors: ' + JSON.stringify(result.errors)
    );
  });
});

describe('Hook Logic Validation - missing output', function () {
  it('should reject hook logic without config or transform', function () {
    const result = validateConfig({
      agents: [
        {
          id: 'worker',
          role: 'impl',
          triggers: [{ topic: 'START' }],
          hooks: {
            onComplete: {
              action: 'publish_message',
              logic: {
                engine: 'javascript',
                script: "return { topic: 'NEW_TOPIC' };",
              },
            },
          },
        },
        {
          id: 'orch',
          role: 'orchestrator',
          triggers: [{ topic: 'NEW_TOPIC', action: 'stop_cluster' }],
        },
      ],
    });
    assert.ok(
      result.errors.some((e) => e.includes("must also have 'config' or 'transform'")),
      'Should reject logic without config. Errors: ' + JSON.stringify(result.errors)
    );
  });
});
