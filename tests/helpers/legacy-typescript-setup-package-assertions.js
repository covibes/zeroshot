const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '../..');

function assertSetupJournalOutput() {
  const journalPath = path.join(repoRoot, 'lib/setup-journal.js');
  assert.ok(fs.existsSync(journalPath), 'legacy TypeScript build must emit lib/setup-journal.js');
  const journal = require(journalPath);
  assert.deepStrictEqual(Reflect.ownKeys(journal), [
    'getJournalPath',
    'loadJournal',
    'saveJournal',
    'upsertJournalEntry',
    'getNestedValue',
    'setNestedValue',
    'deleteNestedKey',
    'deepEqual',
  ]);
}

function assertSetupUndoOutput() {
  const undoPath = path.join(repoRoot, 'lib/setup-undo.js');
  assert.ok(fs.existsSync(undoPath), 'legacy TypeScript build must emit lib/setup-undo.js');
  const setupUndo = require(undoPath);
  assert.deepStrictEqual(Reflect.ownKeys(setupUndo), ['undo']);
  assert.strictEqual(setupUndo.undo.length, 0);
}

function assertSetupPlanOutput() {
  const planPath = path.join(repoRoot, 'lib/setup-plan.js');
  assert.ok(fs.existsSync(planPath), 'legacy TypeScript build must emit lib/setup-plan.js');
  const setupPlan = require(planPath);
  assert.deepStrictEqual(Reflect.ownKeys(setupPlan), [
    'buildSetupPlan',
    'resolveDecisionPath',
    'domainFor',
    'DECISION_PATHS',
    'getNestedValue',
    'isConsumedPath',
    'CONSUMED_PATHS',
  ]);
  assert.deepStrictEqual(
    [
      setupPlan.buildSetupPlan,
      setupPlan.resolveDecisionPath,
      setupPlan.domainFor,
      setupPlan.getNestedValue,
      setupPlan.isConsumedPath,
    ].map((value) => value.length),
    [0, 1, 1, 2, 2]
  );
}

function assertSetupApplyOutput() {
  const applyPath = path.join(repoRoot, 'lib/setup-apply.js');
  assert.ok(fs.existsSync(applyPath), 'legacy TypeScript build must emit lib/setup-apply.js');
  const setupApply = require(applyPath);
  assert.deepStrictEqual(Reflect.ownKeys(setupApply), [
    'applyDecisions',
    'applyDecisionValues',
    'resolveAndValidateDecisions',
    'writeResolvedDecisions',
    'assertSecretSafePath',
    'isConsumedPath',
    'CONSUMED_PATHS',
  ]);
  assert.deepStrictEqual(
    [
      setupApply.applyDecisions,
      setupApply.applyDecisionValues,
      setupApply.resolveAndValidateDecisions,
      setupApply.writeResolvedDecisions,
      setupApply.assertSecretSafePath,
      setupApply.isConsumedPath,
    ].map((value) => value.length),
    [1, 1, 3, 2, 1, 2]
  );
}

function assertSetupOutputs() {
  assertSetupJournalOutput();
  assertSetupUndoOutput();
  assertSetupPlanOutput();
  assertSetupApplyOutput();
}

module.exports = { assertSetupOutputs };
