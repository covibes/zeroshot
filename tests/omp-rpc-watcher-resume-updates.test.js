const {
  assert,
  fs,
  path,
  runWatcher,
  storeGetTask,
  zeroshotHome,
  clearOwnershipFor,
  assertFailedBeforePrompt,
  prepareResumeCase,
} = require('./helpers/omp-rpc-watcher-session-harness');

describe('OMP RPC watcher: resume update handling', function () {
  this.timeout(20000);

  it('tolerates a mid-turn session_info_update that grew the transcript, and still catches one that switches session', async function () {
    // `session_info_update` re-fires the driver's `ready` hook *after* the prompt, by which
    // point the transcript has legitimately grown. Re-running the structural manifest/inode
    // comparison there would reject a healthy turn; only what OMP reports about the session it
    // has open is still meaningful, so that is all the post-prompt pass may check.
    const {
      resumedId: healthyResumedId,
      partition,
      commandSpec,
      expectation,
    } = await prepareResumeCase({ label: 'resume-info-update' });

    const before = fs.statSync(partition.sessionFilePath).size;
    const { code } = await runWatcher({
      id: healthyResumedId,
      commandSpec,
      scenario: 'session-info-update',
      ompSession: {
        kind: 'resume',
        partition: { path: partition.partitionPath },
        file: { path: partition.sessionFilePath },
      },
      ompResumeExpectation: expectation,
      env: {
        OMP_FAKE_RPC_APPEND_ON_UPDATE: '1',
        OMP_FAKE_RPC_UPDATED_SESSION_ID: partition.sessionId,
        OMP_FAKE_RPC_UPDATED_SESSION_FILE: partition.sessionFilePath,
      },
    });
    assert.strictEqual(code, 0);
    assert.ok(
      fs.statSync(partition.sessionFilePath).size > before,
      'the transcript really did grow mid-turn'
    );
    const healthy = await storeGetTask(healthyResumedId);
    assert.strictEqual(healthy.status, 'completed');
    assert.strictEqual(healthy.ompSessionOwnership.state, 'committed');

    // Same frame, but now naming a different session: that IS drift and must fail.
    const {
      resumedId: driftResumedId,
      partition: driftPartition,
      commandSpec: driftCommandSpec,
      expectation: driftExpectation,
    } = await prepareResumeCase({ label: 'resume-info-update-switch' });

    const drifted = await runWatcher({
      id: driftResumedId,
      commandSpec: driftCommandSpec,
      scenario: 'session-info-update',
      ompSession: {
        kind: 'resume',
        partition: { path: driftPartition.partitionPath },
        file: { path: driftPartition.sessionFilePath },
      },
      ompResumeExpectation: driftExpectation,
      env: {
        OMP_FAKE_RPC_UPDATED_SESSION_ID: 'a-completely-different-session',
        OMP_FAKE_RPC_UPDATED_SESSION_FILE: driftPartition.sessionFilePath,
      },
    });
    const driftTask = await storeGetTask(driftResumedId);
    assertFailedBeforePrompt({
      code: drifted.code,
      task: driftTask,
      errorPattern: /echoed sessionId/,
    });
  });

  it('fails closed when the prior owner is no longer committed (transfer cannot apply)', async function () {
    const { priorId, resumedId, partition, commandSpec, expectation } = await prepareResumeCase({
      label: 'resume-transfer-lost',
    });

    // Another process already claimed the lineage (or the row was cleared) before this
    // watcher reached its transfer point.
    await clearOwnershipFor(priorId);
    const promptSink = path.join(zeroshotHome, `${resumedId}-prompt.json`);

    const { code } = await runWatcher({
      id: resumedId,
      commandSpec,
      scenario: 'happy',
      ompSession: {
        kind: 'resume',
        partition: { path: partition.partitionPath },
        file: { path: partition.sessionFilePath },
      },
      ompResumeExpectation: expectation,
      env: { OMP_FAKE_RPC_PROMPT_SINK: promptSink },
    });
    assertFailedBeforePrompt({
      code,
      task: await storeGetTask(resumedId),
      promptSink,
      errorPattern: /transfer ownership/,
    });
  });
});
