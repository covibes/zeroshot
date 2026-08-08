/**
 * TEST: Agent Task Not Found - Fail-Safe Restart Behavior
 *
 * Verifies that when zeroshot status returns "ID not found", the agent
 * immediately fails with restart error instead of polling 30 times.
 *
 * POSTMORTEM (2026-01-29): Agent worker polling failed 30 times when task
 * completed and was cleaned up before worker could detect it. Worker treated
 * "not found" as retryable error, wasting 30+ seconds before giving up.
 *
 * FIX: Detect "ID not found" immediately → return error → trigger restart (fail-safe)
 *
 * This test verifies the fix at the code level by reading the implementation.
 * Integration test would require complex mocking of child processes and timers.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('Agent Task Not Found - Fail-Safe Restart', () => {
  const sourceFile = path.join(__dirname, '..', 'src', 'agent', 'agent-task-executor.js');
  let sourceCode;

  before(() => {
    sourceCode = fs.readFileSync(sourceFile, 'utf8');
  });

  it('should have handleStatusExecError function that detects "ID not found"', () => {
    // Verify the function exists
    assert.ok(
      sourceCode.includes('function handleStatusExecError'),
      'handleStatusExecError function should exist'
    );

    // Verify it checks for "ID not found" pattern
    assert.ok(
      sourceCode.includes('ID not found') || sourceCode.includes('Not found in tasks'),
      'Should check for "ID not found" or "Not found in tasks" patterns'
    );
  });

  it('should check both error.message and stderr for "not found" patterns', () => {
    // Extract the handleStatusExecError function
    const functionMatch = sourceCode.match(
      /function handleStatusExecError\([^)]*\)\s*{[\s\S]*?^}/m
    );

    assert.ok(functionMatch, 'Should find handleStatusExecError function');

    const functionBody = functionMatch[0];

    // Verify it checks error message
    assert.ok(
      functionBody.includes('error.message') || functionBody.includes('errorMessage'),
      'Should check error.message for patterns'
    );

    // Verify it checks stderr
    assert.ok(
      functionBody.includes('stderr') || functionBody.includes('stderrMessage'),
      'Should check stderr for patterns'
    );

    // Verify it looks for both "ID not found" and "Not found in tasks"
    const hasIdNotFound = functionBody.includes('ID not found');
    const hasNotFoundInTasks = functionBody.includes('Not found in tasks');

    assert.ok(
      hasIdNotFound && hasNotFoundInTasks,
      'Should check for both "ID not found" and "Not found in tasks" patterns'
    );
  });

  it('should return error immediately when task not found (not retry)', () => {
    const functionMatch = sourceCode.match(
      /function handleStatusExecError\([^)]*\)\s*{[\s\S]*?^}/m
    );

    assert.ok(functionMatch, 'Should find handleStatusExecError function');

    const functionBody = functionMatch[0];
    const settlementBody = sourceCode.match(
      /function settleHostStatusFailure\([^)]*\)\s*{[\s\S]*?^}/m
    )[0];

    // Verify it has a dedicated "not found" check BEFORE the retry counter
    const notFoundCheckIndex = functionBody.indexOf('ID not found');
    const retryCounterIndex = functionBody.indexOf('consecutiveExecFailures++');

    assert.ok(
      notFoundCheckIndex > 0 && notFoundCheckIndex < retryCounterIndex,
      'Should check for "not found" BEFORE incrementing retry counter'
    );

    // Verify it resolves immediately when not found
    const notFoundSection = functionBody.substring(notFoundCheckIndex, retryCounterIndex);

    assert.ok(
      notFoundSection.includes('settleHostStatusFailure(') && settlementBody.includes('resolve('),
      'Should call resolve() immediately when task not found'
    );

    assert.ok(
      settlementBody.includes('success: false'),
      'Should resolve with success: false when task not found'
    );

    assert.ok(
      notFoundSection.includes('restarting') || notFoundSection.includes('restart'),
      'Error message should mention restarting'
    );
  });

  it('should publish AGENT_ERROR event when task not found', () => {
    const functionMatch = sourceCode.match(
      /function handleStatusExecError\([^)]*\)\s*{[\s\S]*?^}/m
    );

    const functionBody = functionMatch[0];
    const settlementBody = sourceCode.match(
      /function settleHostStatusFailure\([^)]*\)\s*{[\s\S]*?^}/m
    )[0];

    // Find the "not found" section
    const notFoundStart = functionBody.indexOf('ID not found');
    const retryCounterIndex = functionBody.indexOf('consecutiveExecFailures++');
    const notFoundSection = functionBody.substring(notFoundStart, retryCounterIndex);

    // Verify it publishes an error event
    assert.ok(
      notFoundSection.includes('settleHostStatusFailure(') &&
        settlementBody.includes('_publish') &&
        settlementBody.includes('AGENT_ERROR'),
      'Should publish AGENT_ERROR event when task not found'
    );

    // Verify error type is appropriate
    assert.ok(
      notFoundSection.includes('task_not_found') || notFoundSection.includes('not_found'),
      'Error event should have appropriate error type'
    );
  });

  it('should have improved warning message', () => {
    const functionMatch = sourceCode.match(
      /function handleStatusExecError\([^)]*\)\s*{[\s\S]*?^}/m
    );

    const functionBody = functionMatch[0];

    // Verify warning message is helpful
    const notFoundStart = functionBody.indexOf('ID not found');
    const retryCounterIndex = functionBody.indexOf('consecutiveExecFailures++');
    const notFoundSection = functionBody.substring(notFoundStart, retryCounterIndex);

    assert.ok(
      notFoundSection.includes('will restart') || notFoundSection.includes('restarting'),
      'Warning message should explain that task will be restarted'
    );

    assert.ok(
      notFoundSection.includes('ensure completion') || notFoundSection.includes('safety'),
      'Warning message should explain fail-safe reasoning'
    );
  });
});
