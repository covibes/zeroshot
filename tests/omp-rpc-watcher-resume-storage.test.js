const {
  assert,
  fs,
  path,
  runWatcher,
  storeGetTask,
  zeroshotHome,
  prepareResumeCase,
} = require('./helpers/omp-rpc-watcher-session-harness');

describe('OMP RPC watcher: resume storage drift', function () {
  this.timeout(20000);

  it('fails closed before spawn when the resume file has been substituted for a symlink', async function () {
    const { resumedId, partition, commandSpec, expectation } = await prepareResumeCase({
      label: 'resume-symlink',
    });

    const outsideTarget = path.join(zeroshotHome, `${resumedId}-outside.jsonl`);
    fs.copyFileSync(partition.sessionFilePath, outsideTarget);
    fs.rmSync(partition.sessionFilePath);
    fs.symlinkSync(outsideTarget, partition.sessionFilePath);

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
    });
    assert.strictEqual(code, 1);

    const resumed = await storeGetTask(resumedId);
    assert.strictEqual(resumed.status, 'failed');
    assert.match(resumed.error, /symlink/);
    assert.strictEqual(resumed.ompSessionOwnership.state, 'cleanup-required');
  });

  it('fails closed before spawn when the partition identity no longer matches', async function () {
    const { resumedId, partition, commandSpec, expectation } = await prepareResumeCase({
      label: 'resume-partition-identity',
      expectationOverrides: {
        expectedPartitionIdentity: { device: '1', inode: '999999999' },
      },
    });

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
    });
    assert.strictEqual(code, 1);

    const resumed = await storeGetTask(resumedId);
    assert.strictEqual(resumed.status, 'failed');
    assert.match(resumed.error, /identity .* does not match the recorded owner/);
    assert.strictEqual(resumed.ompSessionOwnership.state, 'cleanup-required');
  });
});
