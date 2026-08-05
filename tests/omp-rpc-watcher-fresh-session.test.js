const {
  assert,
  fs,
  path,
  runWatcher,
  storeGetTask,
  commitRecordedOwnershipFor,
  fingerprintFor,
  verifyExistingOmpPartition,
  prepareFreshCase,
} = require('./helpers/omp-rpc-watcher-session-harness');

describe('OMP RPC watcher: fresh session ownership', function () {
  this.timeout(20000);

  it('host: commits a standalone owner after descriptor/header/tree verification', async function () {
    const { id, partitionPath, commandSpec } = await prepareFreshCase({
      label: 'fresh-standalone',
    });

    const { code } = await runWatcher({
      id,
      commandSpec,
      scenario: 'happy',
      ompSession: { kind: 'fresh', partition: { path: partitionPath } },
      env: {
        OMP_FAKE_RPC_MINT_SESSION_ID: 'fresh-standalone-session',
        OMP_FAKE_RPC_SESSION_CWD: commandSpec.cwd,
        OMP_FAKE_RPC_ARTIFACT_DIR: '1',
      },
    });
    assert.strictEqual(code, 0);

    const task = await storeGetTask(id);
    assert.strictEqual(task.status, 'completed');
    const ownership = task.ompSessionOwnership;
    assert.strictEqual(ownership.state, 'committed');
    assert.strictEqual(ownership.session.sessionId, 'fresh-standalone-session');
    assert.match(ownership.session.fileName, /^.*_fresh-standalone-session\.jsonl$/);
    assert.match(ownership.session.artifactManifestDigest, /^sha256:[a-f0-9]{64}$/);
    assert.strictEqual(ownership.session.executionFingerprint, fingerprintFor(commandSpec));
    assert.strictEqual(ownership.session.selectedProvider, 'anthropic');
    assert.strictEqual(ownership.session.selectedModel, '@default');
    assert.ok(ownership.partitionIdentity, 'the verified partition identity is recorded');

    // The manifest the watcher committed is exactly what the verifier computes for the tree
    // OMP actually left behind, including the sibling artifacts directory.
    const reverified = verifyExistingOmpPartition(partitionPath, ownership.session.fileName);
    assert.strictEqual(reverified.artifactManifestDigest, ownership.session.artifactManifestDigest);
    assert.ok(fs.existsSync(path.join(partitionPath, ownership.session.fileName.slice(0, -6))));
  });

  it('worktree: commits under a cwd that is not the storage root', async function () {
    const {
      id,
      cwd: worktree,
      partitionPath,
      commandSpec,
    } = await prepareFreshCase({
      label: 'fresh-worktree',
      workspacePrefix: 'omp-worktree-',
    });

    const { code } = await runWatcher({
      id,
      commandSpec,
      scenario: 'happy',
      ompSession: { kind: 'fresh', partition: { path: partitionPath } },
      env: {
        OMP_FAKE_RPC_MINT_SESSION_ID: 'worktree-session',
        OMP_FAKE_RPC_SESSION_CWD: worktree,
      },
    });
    assert.strictEqual(code, 0);
    const task = await storeGetTask(id);
    assert.strictEqual(task.ompSessionOwnership.state, 'committed');
    assert.strictEqual(task.ompSessionOwnership.canonicalWorkspace, worktree);
  });

  it('detached cluster-agent: records verified evidence but leaves commit to the parent boundary', async function () {
    const { id, partitionPath, commandSpec } = await prepareFreshCase({
      label: 'fresh-cluster-agent',
      storagePrefix: 'omp-cluster-storage-',
      owner: (taskId) => ({
        kind: 'cluster-agent',
        clusterId: 'cluster-1',
        agentId: 'worker-1',
        taskId,
      }),
    });

    const { code } = await runWatcher({
      id,
      commandSpec,
      scenario: 'happy',
      ompSession: { kind: 'fresh', partition: { path: partitionPath } },
      env: {
        OMP_FAKE_RPC_MINT_SESSION_ID: 'cluster-agent-session',
        OMP_FAKE_RPC_SESSION_CWD: commandSpec.cwd,
      },
    });
    assert.strictEqual(code, 0);

    const task = await storeGetTask(id);
    assert.strictEqual(task.status, 'completed', 'the turn itself still completed');
    assert.strictEqual(
      task.ompSessionOwnership.state,
      'provisional',
      'a cluster-agent owner must not be committed by the watcher'
    );
    assert.strictEqual(task.ompSessionOwnership.session.sessionId, 'cluster-agent-session');
    assert.ok(task.ompSessionOwnership.partitionIdentity);

    const { committed, task: afterCommit } = await commitRecordedOwnershipFor(id);
    assert.strictEqual(committed, true);
    assert.strictEqual(afterCommit.ompSessionOwnership.state, 'committed');
    assert.strictEqual(afterCommit.ompSessionOwnership.session.sessionId, 'cluster-agent-session');
  });
});
