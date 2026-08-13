/**
 * Tier 1 e2e: a cluster whose topology nobody hand-registered.
 *
 * The topology-designer emits an agent spec, the seed's transform expands it and
 * ships it as a CLUSTER_OPERATIONS `add_agents` chain, and the orchestrator
 * validates and spawns it. Everything above the provider process is real; only
 * the model's cognition is faked (tests/fixtures/fake-agent).
 *
 * This is the first exercise of the add_agents path outside the fuzzer - the
 * shipped templates all go through load_config instead.
 *
 * Scenario routing: the generated agents carry FAKE_AGENT_ID markers inside the
 * systemPrompts the designer emits, so each gets its own scenario. The designer
 * itself carries no marker and falls back to FAKE_AGENT_SCENARIO.
 */

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  setupE2ERepo,
  cleanupE2ERepo,
  runZeroshot,
  worktreePath,
  readLedgerMessages,
} = require('./helpers/e2e-harness');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'cluster-templates', 'topology-generator.json');
const DESIGN_PATH = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'topology-generator',
  'e2e-design.json'
);

function approvalScenario(reportName) {
  return {
    files: [{ path: reportName, content: 'APPROVED\n' }],
    messages: [
      'Checking.',
      JSON.stringify({
        approved: true,
        disposition: 'approved',
        summary: 'All checks passed',
        errors: [],
        evidence: [
          { check: 'read the file', method: 'docs/thing.md:1', output: 'ok', passed: true },
        ],
      }),
    ],
    exitCode: 0,
  };
}

describe('e2e: topology generator (add_agents)', function () {
  this.timeout(90000);

  let env;
  let scenarioDir;

  beforeEach(() => {
    env = setupE2ERepo();
    scenarioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-e2e-topogen-'));
  });

  afterEach(() => {
    cleanupE2ERepo(env);
    if (scenarioDir) fs.rmSync(scenarioDir, { recursive: true, force: true });
  });

  function writeScenario(name, body) {
    const file = path.join(scenarioDir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    return file;
  }

  it('designs, spawns and completes a topology that no template defines', function () {
    // The design the fake designer "returns". Read from a fixture so the JSON
    // stays readable instead of being escaped into a scenario string by hand.
    const design = JSON.parse(fs.readFileSync(DESIGN_PATH, 'utf8'));
    delete design.__comment;

    const designerScenario = writeScenario('topology-design', {
      messages: ['Designing the verification topology.', JSON.stringify(design)],
      exitCode: 0,
    });
    const writerScenario = writeScenario('topogen-writer', {
      files: [{ path: 'implementation.txt', content: 'rewritten intro\n' }],
      contextIncludes: [
        '"issue_number":',
        '"source": "file"',
        '"_originalTimestamp":',
        '"_originalMessageId":',
      ],
      messages: [
        'Writing.',
        JSON.stringify({
          completed: true,
          userDeliverable: 'The rewritten introduction is ready in implementation.txt.',
        }),
      ],
      exitCode: 0,
    });
    const structureApproval = approvalScenario('structure-report.txt');
    structureApproval.contextIncludes = [
      '"userDeliverable": "The rewritten introduction is ready in implementation.txt."',
    ];
    const structureScenario = writeScenario('topogen-structure', structureApproval);
    const fidelityScenario = writeScenario(
      'topogen-fidelity',
      approvalScenario('fidelity-report.txt')
    );

    const issueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-e2e-issue-'));
    const issuePath = path.join(issueDir, 'task.md');
    fs.writeFileSync(issuePath, '# Rewrite the intro\n\nRewrite the intro section of the docs.\n');

    const clusterId = 'e2e-topology-generator';
    const result = runZeroshot(env, ['run', issuePath, '--worktree', '--config', CONFIG_PATH], {
      ZEROSHOT_CLUSTER_ID: clusterId,
      // designer has no FAKE_AGENT_ID marker -> falls back to the default
      FAKE_AGENT_SCENARIO: designerScenario,
      FAKE_AGENT_SCENARIO_DOC_WRITER: writerScenario,
      FAKE_AGENT_SCENARIO_VERIFIER_STRUCTURE: structureScenario,
      FAKE_AGENT_SCENARIO_VERIFIER_SOURCE_FIDELITY: fidelityScenario,
    });

    assert.strictEqual(
      result.status,
      0,
      `zeroshot run exited ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );

    // --- the designed agents actually ran ---------------------------------
    const worktreeDir = worktreePath(env, clusterId);
    for (const file of ['implementation.txt', 'structure-report.txt', 'fidelity-report.txt']) {
      assert.ok(
        fs.existsSync(path.join(worktreeDir, file)),
        `expected ${file} in the worktree - the generated agent did not run`
      );
    }

    // --- the wiring the transform built is the wiring that fired ----------
    const implementationReady = readLedgerMessages(env, clusterId, 'IMPLEMENTATION_READY');
    assert.strictEqual(implementationReady.length, 1);
    assert.strictEqual(implementationReady[0].sender, 'doc-writer');
    assert.strictEqual(
      implementationReady[0].content.text,
      'Implementation artifact is ready for independent verification.'
    );
    assert.ok(
      !('summary' in implementationReady[0].content.data) &&
        !('filesChanged' in implementationReady[0].content.data),
      'verifiers must receive only a readiness signal, never the implementer account'
    );
    assert.strictEqual(
      implementationReady[0].content.data.userDeliverable,
      'The rewritten introduction is ready in implementation.txt.',
      'the actual user-facing deliverable must survive the readiness boundary'
    );

    const stage1 = readLedgerMessages(env, clusterId, 'STAGE_1_VALIDATION_RESULT');
    assert.strictEqual(stage1.length, 1, 'stage 1 verifier should have published exactly once');
    assert.strictEqual(stage1[0].sender, 'verifier-structure');

    // Stage 2 only runs because the stage gate saw stage 1 approve.
    const stage2 = readLedgerMessages(env, clusterId, 'VALIDATION_RESULT');
    assert.strictEqual(stage2.length, 1, 'stage 2 verifier should have published exactly once');
    assert.strictEqual(stage2[0].sender, 'verifier-source-fidelity');
    assert.ok(
      stage2[0].content.data.approved === true || stage2[0].content.data.approved === 'true',
      'stage 2 verdict should be approved'
    );

    // --- the designer did not re-fire on its own republish ----------------
    const operations = readLedgerMessages(env, clusterId, 'CLUSTER_OPERATIONS');
    assert.strictEqual(
      operations.length,
      1,
      'topology-designer should design exactly once - a second CLUSTER_OPERATIONS means the ' +
        'ISSUE_OPENED republish guard failed'
    );

    // The generated agents must receive the complete original task payload, not
    // only its text. Structured request fields are how non-code tasks retain
    // attachment/resource/integration handles across the dynamic spawn.
    const issueMessages = readLedgerMessages(env, clusterId, 'ISSUE_OPENED');
    const originalIssue = issueMessages.find((message) => !message.metadata?._republished);
    const republishedIssue = issueMessages.find(
      (message) => message.metadata?._republished === true
    );
    assert.ok(originalIssue, 'expected the original ISSUE_OPENED message');
    assert.ok(republishedIssue, 'expected the topology transform to republish ISSUE_OPENED');
    assert.deepStrictEqual(
      republishedIssue.content,
      originalIssue.content,
      'topology transform must preserve text and structured task data'
    );
    assert.strictEqual(
      republishedIssue.metadata.source,
      originalIssue.metadata.source,
      'topology transform must preserve task-source metadata while adding its loop guard'
    );
    assert.strictEqual(
      republishedIssue.metadata._originalTimestamp,
      originalIssue.timestamp,
      'relative-time tasks must retain the original request timestamp'
    );
    assert.strictEqual(
      republishedIssue.metadata._originalMessageId,
      originalIssue.id,
      'republished tasks must retain their original message identity'
    );

    fs.rmSync(issueDir, { recursive: true, force: true });
  });

  it('fails the cluster when the worker honestly cannot complete the requested task', function () {
    const design = JSON.parse(fs.readFileSync(DESIGN_PATH, 'utf8'));
    delete design.__comment;

    const designerScenario = writeScenario('blocked-topology-design', {
      messages: ['Designing the verification topology.', JSON.stringify(design)],
      exitCode: 0,
    });
    const blockedWorkerScenario = writeScenario('topogen-worker-blocked', {
      messages: [
        'The required external capability is unavailable.',
        JSON.stringify({
          completed: false,
          userDeliverable: 'No phone integration is connected, so no call was placed.',
        }),
      ],
      exitCode: 0,
    });
    const shouldNotRunScenario = writeScenario('topogen-validator-must-not-run', {
      files: [{ path: 'validator-ran.txt', content: 'this should never exist\n' }],
      messages: [
        JSON.stringify({
          approved: true,
          disposition: 'approved',
          summary: 'Incorrectly approved inability',
          errors: [],
          evidence: [{ check: 'none', method: 'none', passed: true }],
        }),
      ],
      exitCode: 0,
    });
    const issuePath = path.join(scenarioDir, 'blocked-task.md');
    fs.writeFileSync(
      issuePath,
      '# Impossible task\n\nCall a phone number, but no phone integration is connected.\n'
    );

    const clusterId = 'e2e-topology-generator-blocked';
    const result = runZeroshot(env, ['run', issuePath, '--worktree', '--config', CONFIG_PATH], {
      ZEROSHOT_CLUSTER_ID: clusterId,
      FAKE_AGENT_SCENARIO: designerScenario,
      FAKE_AGENT_SCENARIO_DOC_WRITER: blockedWorkerScenario,
      FAKE_AGENT_SCENARIO_VERIFIER_STRUCTURE: shouldNotRunScenario,
      FAKE_AGENT_SCENARIO_VERIFIER_SOURCE_FIDELITY: shouldNotRunScenario,
    });

    assert.strictEqual(
      result.status,
      0,
      `zeroshot run exited ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
    const failures = readLedgerMessages(env, clusterId, 'CLUSTER_FAILED');
    assert.strictEqual(failures.length, 1, 'completed:false must publish one terminal failure');
    assert.strictEqual(failures[0].sender, 'doc-writer');
    assert.strictEqual(failures[0].content.data.reason, 'implementation_incomplete');
    assert.strictEqual(
      failures[0].content.data.userDeliverable,
      'No phone integration is connected, so no call was placed.',
      'terminal failure must preserve the useful user-facing blocker explanation'
    );
    assert.strictEqual(
      readLedgerMessages(env, clusterId, 'IMPLEMENTATION_READY').length,
      0,
      'an incomplete task must never enter verification'
    );
    assert.strictEqual(
      readLedgerMessages(env, clusterId, 'VALIDATION_RESULT').length,
      0,
      'validators must not approve an inability artifact as task completion'
    );
    assert.ok(
      !fs.existsSync(path.join(worktreePath(env, clusterId), 'validator-ran.txt')),
      'no generated validator should run after terminal implementation failure'
    );
  });

  it('terminates an unresolvable evidence gap instead of retrying the worker', function () {
    const design = JSON.parse(fs.readFileSync(DESIGN_PATH, 'utf8'));
    delete design.__comment;

    const designerScenario = writeScenario('gap-topology-design', {
      messages: ['Designing the verification topology.', JSON.stringify(design)],
      exitCode: 0,
    });
    const writerScenario = writeScenario('gap-worker', {
      files: [{ path: 'implementation.txt', content: 'artifact exists\n' }],
      messages: [
        'Writing.',
        JSON.stringify({
          completed: true,
          userDeliverable: 'The artifact is ready in implementation.txt.',
        }),
      ],
      exitCode: 0,
    });
    const gapScenario = writeScenario('gap-validator', {
      messages: [
        'The required external authority is unavailable.',
        JSON.stringify({
          approved: false,
          disposition: 'evidence_gap',
          summary: 'External authority unavailable',
          errors: ['The independent source cannot be reached'],
          evidence: [
            {
              check: 'resolve authority',
              method: 'connector lookup',
              output: 'connector unavailable',
              passed: false,
            },
          ],
        }),
      ],
      exitCode: 0,
    });
    const shouldNotRunScenario = writeScenario('gap-stage-two-must-not-run', {
      files: [{ path: 'stage-two-ran.txt', content: 'this should never exist\n' }],
      messages: [
        JSON.stringify({
          approved: true,
          disposition: 'approved',
          summary: 'Should not run',
          errors: [],
          evidence: [{ check: 'none', method: 'none', passed: true }],
        }),
      ],
      exitCode: 0,
    });
    const issuePath = path.join(scenarioDir, 'evidence-gap-task.md');
    fs.writeFileSync(
      issuePath,
      '# Evidence-bound task\n\nVerify the artifact against an unavailable external authority.\n'
    );

    const clusterId = 'e2e-topology-generator-evidence-gap';
    const result = runZeroshot(env, ['run', issuePath, '--worktree', '--config', CONFIG_PATH], {
      ZEROSHOT_CLUSTER_ID: clusterId,
      FAKE_AGENT_SCENARIO: designerScenario,
      FAKE_AGENT_SCENARIO_DOC_WRITER: writerScenario,
      FAKE_AGENT_SCENARIO_VERIFIER_STRUCTURE: gapScenario,
      FAKE_AGENT_SCENARIO_VERIFIER_SOURCE_FIDELITY: shouldNotRunScenario,
    });

    assert.strictEqual(
      result.status,
      0,
      'zeroshot run exited ' +
        result.status +
        '\nSTDOUT:\n' +
        result.stdout +
        '\nSTDERR:\n' +
        result.stderr
    );
    const failures = readLedgerMessages(env, clusterId, 'CLUSTER_FAILED');
    assert.strictEqual(failures.length, 1, 'evidence gap must publish one terminal failure');
    assert.strictEqual(failures[0].sender, 'verifier-structure');
    assert.strictEqual(failures[0].content.data.reason, 'evidence_gap');
    assert.strictEqual(failures[0].content.data.approved, false);
    assert.strictEqual(
      readLedgerMessages(env, clusterId, 'IMPLEMENTATION_READY').length,
      1,
      'the implementation must run once and must not be retried for an unfixable evidence gap'
    );
    assert.strictEqual(
      readLedgerMessages(env, clusterId, 'STAGE_1_VALIDATION_RESULT').length,
      0,
      'terminal evidence gaps must not masquerade as retryable validation feedback'
    );
    assert.strictEqual(
      readLedgerMessages(env, clusterId, 'VALIDATION_RESULT').length,
      0,
      'later validation stages must not run after a terminal evidence gap'
    );
    assert.ok(
      !fs.existsSync(path.join(worktreePath(env, clusterId), 'stage-two-ran.txt')),
      'stage 2 must stay dormant after the stage 1 evidence gap'
    );
  });
});
