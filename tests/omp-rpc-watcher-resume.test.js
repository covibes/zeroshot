const {
  assert,
  fs,
  path,
  runWatcher,
  storeGetTask,
  zeroshotHome,
  assertFailedBeforePrompt,
  prepareResumeCase,
} = require('./helpers/omp-rpc-watcher-session-harness');

describe('OMP RPC watcher: verified resume', function () {
  this.timeout(20000);

  it('transfers ownership before the prompt and commits the new evidence on success', async function () {
    const { priorId, resumedId, partition, commandSpec, expectation } = await prepareResumeCase({
      label: 'resume-new',
    });
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
    assert.strictEqual(code, 0);

    const resumed = await storeGetTask(resumedId);
    assert.strictEqual(resumed.status, 'completed');
    assert.strictEqual(resumed.ompSessionOwnership.state, 'committed');
    assert.strictEqual(resumed.ompSessionOwnership.session.sessionId, partition.sessionId);
    assert.strictEqual(resumed.ompSessionOwnership.partitionId, partition.partitionId);
    assert.strictEqual(resumed.ompSessionOwnership.owner.taskId, resumedId);

    const prior = await storeGetTask(priorId);
    assert.strictEqual(
      prior.ompSessionOwnership,
      null,
      'the prior owner is released atomically, so exactly one row holds the lineage'
    );
    assert.ok(fs.existsSync(promptSink), 'the prompt is written only after the transfer');
  });

  it('never prompts and never transfers when the echoed session ID differs from the recorded one', async function () {
    const { priorId, resumedId, partition, commandSpec, expectation } = await prepareResumeCase({
      label: 'resume-id-drift',
    });
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
      env: {
        OMP_FAKE_RPC_SESSION_ID: `${partition.sessionId}-and-more`,
        OMP_FAKE_RPC_PROMPT_SINK: promptSink,
      },
    });
    const resumed = await storeGetTask(resumedId);
    assertFailedBeforePrompt({
      code,
      task: resumed,
      promptSink,
      errorPattern: /echoed sessionId/,
    });

    const prior = await storeGetTask(priorId);
    assert.strictEqual(
      prior.ompSessionOwnership.state,
      'committed',
      'a refused resume leaves the prior owner intact'
    );
  });
});
