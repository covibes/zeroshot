const {
  assert,
  createOmpConfigOverlay,
  fs,
  nextTaskId,
  path,
  runWatcher,
  storeGetTask,
  zeroshotHome,
  makeBlobStore,
  makeSessionPartition,
  resumeCommandSpec,
  seedResumeLineage,
} = require('./helpers/omp-rpc-watcher-session-harness');

describe('OMP RPC watcher: resume blob integrity', function () {
  this.timeout(20000);

  it('fails closed before spawn when a referenced shared CAS blob is missing', async function () {
    const priorId = nextTaskId('resume-blob-prior');
    const resumedId = nextTaskId('resume-blob');
    const overlay = createOmpConfigOverlay();
    const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
    const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
    const blobs = makeBlobStore('omp-watcher-blobs-');
    const ref = blobs.put('externalized-image-bytes');
    const partition = makeSessionPartition({
      storageRoot,
      cwd,
      records: [{ type: 'message', content: [{ type: 'image', data: ref }] }],
    });
    const commandSpec = resumeCommandSpec(
      overlay,
      partition.partitionPath,
      partition.sessionFilePath,
      cwd
    );

    // The lineage must be recorded while the blob still resolves, i.e. under the same shared
    // root the watcher will use.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = blobs.blobRoot;
    let expectation;
    try {
      ({ expectation } = await seedResumeLineage({
        priorId,
        resumedId,
        storageRoot,
        cwd,
        commandSpec,
        partition,
      }));
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }

    const blobPath = path.join(blobs.blobsDir, ref.slice('blob:sha256:'.length));
    fs.rmSync(blobPath);

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
      env: { PI_CODING_AGENT_DIR: blobs.blobRoot },
    });
    assert.strictEqual(code, 1);

    const resumed = await storeGetTask(resumedId);
    assert.strictEqual(resumed.status, 'failed');
    assert.match(resumed.error, /blob/);
    assert.strictEqual(resumed.ompSessionOwnership.state, 'cleanup-required');
    assert.ok(fs.existsSync(blobs.blobsDir), 'the shared blob root itself is untouched');
  });
});
