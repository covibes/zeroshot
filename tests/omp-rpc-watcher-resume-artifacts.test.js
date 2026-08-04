const {
  assert,
  fs,
  path,
  runWatcher,
  storeGetTask,
  prepareResumeCase,
} = require('./helpers/omp-rpc-watcher-session-harness');

describe('OMP RPC watcher: resume artifact drift', function () {
  this.timeout(20000);

  it('fails closed before spawn on artifact-tree drift', async function () {
    const { resumedId, partition, commandSpec, expectation } = await prepareResumeCase({
      label: 'resume-manifest-drift',
      partitionOptions: { artifacts: ['a.txt'] },
    });

    // Someone edited the artifact tree between the recorded turn and this resume.
    fs.appendFileSync(path.join(partition.artifactsDir, 'a.txt'), 'tampered');

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
    assert.strictEqual(code, 1, 'the pre-spawn check fails the watcher outright');

    const resumed = await storeGetTask(resumedId);
    assert.strictEqual(resumed.status, 'failed');
    assert.match(resumed.error, /artifactManifestDigest/);
    assert.strictEqual(resumed.ompSessionOwnership.state, 'cleanup-required');
  });

  it('fails closed before spawn when the session file inode has been substituted', async function () {
    const { resumedId, storageRoot, partition, commandSpec, expectation } = await prepareResumeCase(
      { label: 'resume-inode' }
    );

    // Byte-identical replacement: only the inode changes, so nothing but the pinned identity
    // can catch it.
    const contents = fs.readFileSync(partition.sessionFilePath);
    const staging = path.join(storageRoot, 'replacement.jsonl');
    fs.writeFileSync(staging, contents);
    fs.renameSync(staging, partition.sessionFilePath);

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
    assert.match(resumed.error, /sessionFileIdentity/);
    assert.strictEqual(resumed.ompSessionOwnership.state, 'cleanup-required');
  });
});
