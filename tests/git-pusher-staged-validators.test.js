/**
 * Test: git-pusher must hand off for a STAGED topology, not just a flat one.
 *
 * HISTORY:
 * - The handoff trigger queried only `VALIDATION_RESULT` and then required one
 *   such message per validator: `latestByValidator.size < validators.length`.
 * - A generated topology validates in stages, and every stage except the last
 *   publishes `STAGE_<n>_VALIDATION_RESULT` instead. So an earlier-stage
 *   validator never counted, the size check could never be satisfied, and
 *   git-pusher stayed idle forever.
 * - Observed for real: a two-stage cluster built the change, both validators
 *   approved it, and nothing was ever committed or pushed. The work sat
 *   uncommitted in the worktree while the run reported retries exhausted.
 *
 * The trigger's intent is "every validator approved". A staged validator's
 * approval is in STAGE_<n>_VALIDATION_RESULT, so it has to count.
 */

const assert = require('assert');
const vm = require('vm');

const { SHARED_TRIGGER_SCRIPT } = require('../src/agents/git-pusher-template.js');

/**
 * Run the trigger the way the runtime does: it is stored as a script string and
 * evaluated in a sandbox, so the test compiles it the same way rather than
 * reimplementing the logic it is meant to cover.
 */
function evaluateTrigger({ cluster, ledger, agent }) {
  const script = new vm.Script(`(function() { 'use strict'; ${SHARED_TRIGGER_SCRIPT} })()`);
  return script.runInNewContext({ cluster, ledger, agent, require });
}

function makeLedger(messages) {
  return {
    findLast: ({ topic }) => [...messages].reverse().find((m) => m.topic === topic) || null,
    query: ({ topic, since }) =>
      messages.filter(
        (m) => (topic ? m.topic === topic : true) && (since ? m.timestamp >= since : true)
      ),
  };
}

function makeCluster(validators) {
  return {
    getAgentsByRole: (role) => (role === 'validator' ? validators : []),
    getAgent: () => null,
  };
}

function approval(sender, topic, approved) {
  return {
    topic,
    sender,
    timestamp: sender === 'toolchain-gate' ? 200 : 300,
    content: { data: { approved, disposition: approved ? 'approved' : 'rejected', errors: [] } },
  };
}

const IMPLEMENTATION_READY = {
  topic: 'IMPLEMENTATION_READY',
  sender: 'cancel-implementer',
  timestamp: 100,
  content: { data: { completed: true } },
};

const VALIDATORS = [{ id: 'toolchain-gate' }, { id: 'cancel-behaviour-audit' }];

describe('git-pusher handoff across validation stages', function () {
  it('hands off when every validator publishes a plain VALIDATION_RESULT', function () {
    const ready = evaluateTrigger({
      cluster: makeCluster(VALIDATORS),
      ledger: makeLedger([
        IMPLEMENTATION_READY,
        approval('toolchain-gate', 'VALIDATION_RESULT', true),
        approval('cancel-behaviour-audit', 'VALIDATION_RESULT', true),
      ]),
      agent: { id: 'git-pusher' },
    });

    assert.strictEqual(ready, true, 'a flat topology must still hand off');
  });

  it('hands off when an earlier stage approved under STAGE_<n>_VALIDATION_RESULT', function () {
    const ready = evaluateTrigger({
      cluster: makeCluster(VALIDATORS),
      ledger: makeLedger([
        IMPLEMENTATION_READY,
        // Stage 1 of a generated topology does not publish the plain topic.
        approval('toolchain-gate', 'STAGE_1_VALIDATION_RESULT', true),
        approval('cancel-behaviour-audit', 'VALIDATION_RESULT', true),
      ]),
      agent: { id: 'git-pusher' },
    });

    assert.strictEqual(
      ready,
      true,
      'a stage-1 approval must count, or approved work is built and never shipped'
    );
  });

  it('still blocks when a staged validator rejected', function () {
    const ready = evaluateTrigger({
      cluster: makeCluster(VALIDATORS),
      ledger: makeLedger([
        IMPLEMENTATION_READY,
        approval('toolchain-gate', 'STAGE_1_VALIDATION_RESULT', false),
        approval('cancel-behaviour-audit', 'VALIDATION_RESULT', true),
      ]),
      agent: { id: 'git-pusher' },
    });

    assert.strictEqual(ready, false, 'counting staged results must not weaken the gate');
  });

  it('does not let a cheap pre-check tier satisfy the ship gate', function () {
    // QUICK_ and HEAVY_VALIDATION_RESULT are tiers of the same check. Matching
    // validation topics by suffix would count the quick pass as approval and
    // ship on a pre-check, which is worse than not shipping.
    for (const tier of ['QUICK_VALIDATION_RESULT', 'HEAVY_VALIDATION_RESULT']) {
      const ready = evaluateTrigger({
        cluster: makeCluster(VALIDATORS),
        ledger: makeLedger([
          IMPLEMENTATION_READY,
          approval('toolchain-gate', tier, true),
          approval('cancel-behaviour-audit', 'VALIDATION_RESULT', true),
        ]),
        agent: { id: 'git-pusher' },
      });

      assert.strictEqual(ready, false, tier + ' must not count as a validator approval');
    }
  });

  it('blocks when a validator has not reported at all', function () {
    const ready = evaluateTrigger({
      cluster: makeCluster(VALIDATORS),
      ledger: makeLedger([
        IMPLEMENTATION_READY,
        approval('cancel-behaviour-audit', 'VALIDATION_RESULT', true),
      ]),
      agent: { id: 'git-pusher' },
    });

    assert.strictEqual(ready, false, 'a silent validator is not an approving one');
  });
});
