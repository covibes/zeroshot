/**
 * Unit coverage for task-lib/omp-session-ownership.js's owner-fenced CAS transitions, isolated
 * from the detached watcher/subprocess plumbing exercised end-to-end in
 * tests/omp-rpc-watcher.test.js. Focuses on the two-boundary commit contract from issue #866:
 * the detached watcher may only ever record verified evidence for a cluster-agent owner
 * (recordVerifiedMaterialization); only the parent agent process's post-hook success boundary may
 * advance that evidence to 'committed' (commitRecordedOwnership). Standalone owners still commit
 * directly (commitOwnership) since the watcher IS their terminal boundary.
 *
 * Every task-lib/store.js read/write below runs in its own short-lived child process, matching
 * tests/omp-rpc-watcher.test.js: task-lib/store.js resolves its DB path from ZEROSHOT_HOME at ESM
 * module-load time and caches it per process, so a direct `import()` in this file would leak
 * across the other test files sharing a `mocha --parallel` worker.
 */

const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const zeroshotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-ownership-unit-'));
const storeUrl = pathToFileURL(path.resolve(__dirname, '../../task-lib/store.js')).href;
const ownershipUrl = pathToFileURL(
  path.resolve(__dirname, '../../task-lib/omp-session-ownership.js')
).href;

async function runStoreScript(script) {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ZEROSHOT_HOME: zeroshotHome },
  });
  return stdout;
}

let idCounter = 0;
function nextTaskId(label) {
  idCounter += 1;
  return `omp-ownership-unit-${label}-${idCounter}`;
}

async function seedProvisionalTask(id, { owner, storageRoot, partitionPath, partitionId }) {
  const stdout = await runStoreScript(`
    const { addTask } = await import(${JSON.stringify(storeUrl)});
    const { writeProvisionalOwnership } = await import(${JSON.stringify(ownershipUrl)});
    const record = writeProvisionalOwnership({
      partitionId: ${JSON.stringify(partitionId)},
      storageRoot: ${JSON.stringify(storageRoot)},
      partitionPath: ${JSON.stringify(partitionPath)},
      canonicalWorkspace: ${JSON.stringify(storageRoot)},
      owner: ${JSON.stringify(owner)},
    });
    addTask({
      id: ${JSON.stringify(id)},
      status: 'running',
      provider: 'omp',
      cwd: ${JSON.stringify(storageRoot)},
      ompSessionOwnership: record,
    });
    process.stdout.write(JSON.stringify(record));
  `);
  return JSON.parse(stdout);
}

async function getOwnership(id) {
  const stdout = await runStoreScript(`
    const { getTask } = await import(${JSON.stringify(storeUrl)});
    process.stdout.write(JSON.stringify(getTask(${JSON.stringify(id)})?.ompSessionOwnership ?? null));
  `);
  return JSON.parse(stdout);
}

function evidenceArgs(sessionFilePath) {
  return `{
    sessionId: 'sess-1',
    sessionFilePath: ${JSON.stringify(sessionFilePath)},
    artifactManifestDigest: 'sha256:${'a'.repeat(64)}',
    executionFingerprint: 'sha256:${'b'.repeat(64)}',
    selectedProvider: 'anthropic',
    selectedModel: '@default',
  }`;
}

async function recordVerifiedMaterializationFor(id, sessionFilePath) {
  const stdout = await runStoreScript(`
    const { recordVerifiedMaterialization } = await import(${JSON.stringify(ownershipUrl)});
    const recorded = recordVerifiedMaterialization({ taskId: ${JSON.stringify(id)}, ...${evidenceArgs(
      sessionFilePath
    )} });
    process.stdout.write(JSON.stringify(recorded));
  `);
  return JSON.parse(stdout);
}

async function commitOwnershipFor(id, sessionFilePath) {
  const stdout = await runStoreScript(`
    const { commitOwnership } = await import(${JSON.stringify(ownershipUrl)});
    const committed = commitOwnership({ taskId: ${JSON.stringify(id)}, ...${evidenceArgs(
      sessionFilePath
    )} });
    process.stdout.write(JSON.stringify(committed));
  `);
  return JSON.parse(stdout);
}

async function commitRecordedOwnershipFor(id) {
  const stdout = await runStoreScript(`
    const { commitRecordedOwnership } = await import(${JSON.stringify(ownershipUrl)});
    process.stdout.write(JSON.stringify(commitRecordedOwnership(${JSON.stringify(id)})));
  `);
  return JSON.parse(stdout);
}

async function markCleanupRequiredFor(id) {
  const stdout = await runStoreScript(`
    const { markCleanupRequired } = await import(${JSON.stringify(ownershipUrl)});
    process.stdout.write(JSON.stringify(markCleanupRequired(${JSON.stringify(id)})));
  `);
  return JSON.parse(stdout);
}

describe('task-lib/omp-session-ownership.js (owner-fenced CAS transitions)', function () {
  this.timeout(20000);

  let storageRoot;
  let partitionPath;
  let sessionFile;

  beforeEach(function () {
    storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'storage-'));
    partitionPath = fs.mkdtempSync(path.join(storageRoot, 'partition-'));
    sessionFile = path.join(partitionPath, 'session.jsonl');
    fs.writeFileSync(sessionFile, '{"turn":1}\n');
  });

  it('cluster-agent: recordVerifiedMaterialization persists evidence but leaves state provisional', async function () {
    const id = nextTaskId('cluster-agent-record');
    const partitionId = '11111111-1111-4111-8111-111111111111';
    await seedProvisionalTask(id, {
      owner: { kind: 'cluster-agent', clusterId: 'c1', agentId: 'a1', taskId: id },
      storageRoot,
      partitionPath,
      partitionId,
    });

    const recorded = await recordVerifiedMaterializationFor(id, sessionFile);
    assert.strictEqual(recorded, true);

    const ownership = await getOwnership(id);
    assert.strictEqual(ownership.state, 'provisional', 'evidence recording must not commit');
    assert.strictEqual(ownership.session.sessionId, 'sess-1');
    assert.ok(ownership.partitionIdentity, 'partitionIdentity must be populated');
  });

  it('cluster-agent: commitRecordedOwnership fails closed with no prior recorded evidence', async function () {
    const id = nextTaskId('cluster-agent-commit-without-evidence');
    const partitionId = '22222222-2222-4222-8222-222222222222';
    await seedProvisionalTask(id, {
      owner: { kind: 'cluster-agent', clusterId: 'c1', agentId: 'a1', taskId: id },
      storageRoot,
      partitionPath,
      partitionId,
    });

    const committed = await commitRecordedOwnershipFor(id);
    assert.strictEqual(
      committed,
      false,
      'must not commit without verified evidence recorded first'
    );

    const ownership = await getOwnership(id);
    assert.strictEqual(ownership.state, 'provisional');
  });

  it('cluster-agent: commitRecordedOwnership commits exactly the evidence the watcher recorded (post-hook success boundary)', async function () {
    const id = nextTaskId('cluster-agent-commit-after-record');
    const partitionId = '33333333-3333-4333-8333-333333333333';
    await seedProvisionalTask(id, {
      owner: { kind: 'cluster-agent', clusterId: 'c1', agentId: 'a1', taskId: id },
      storageRoot,
      partitionPath,
      partitionId,
    });

    assert.strictEqual(await recordVerifiedMaterializationFor(id, sessionFile), true);
    const committed = await commitRecordedOwnershipFor(id);
    assert.strictEqual(committed, true);

    const ownership = await getOwnership(id);
    assert.strictEqual(ownership.state, 'committed');
    assert.strictEqual(ownership.session.sessionId, 'sess-1');
  });

  it('commit-before-agent-snapshot crash vector: a re-entrant commit attempt after crash recovery is a safe no-op', async function () {
    // Models agent-lifecycle.js committing ownership, then crashing before the in-memory
    // providerSession snapshot is written, then a later recovery/retry path attempting to commit
    // again for the same taskId. The CAS must refuse the second attempt rather than silently
    // reprocessing or throwing — the row is durable proof of exactly one committed transition.
    const id = nextTaskId('commit-before-agent-snapshot');
    const partitionId = '44444444-4444-4444-8444-444444444444';
    await seedProvisionalTask(id, {
      owner: { kind: 'cluster-agent', clusterId: 'c1', agentId: 'a1', taskId: id },
      storageRoot,
      partitionPath,
      partitionId,
    });

    assert.strictEqual(await recordVerifiedMaterializationFor(id, sessionFile), true);
    assert.strictEqual(await commitRecordedOwnershipFor(id), true);

    // Simulated crash/retry: the same commit call fires again for the same taskId.
    const secondAttempt = await commitRecordedOwnershipFor(id);
    assert.strictEqual(
      secondAttempt,
      false,
      'a second commit attempt must not re-process or throw'
    );

    const ownership = await getOwnership(id);
    assert.strictEqual(
      ownership.state,
      'committed',
      'the original committed record must be intact'
    );
    assert.strictEqual(ownership.session.sessionId, 'sess-1');
  });

  it('failed onComplete hook after evidence was recorded: markCleanupRequired preserves taskId ownership for recovery', async function () {
    const id = nextTaskId('cluster-agent-hook-failure');
    const partitionId = '55555555-5555-4555-8555-555555555555';
    await seedProvisionalTask(id, {
      owner: { kind: 'cluster-agent', clusterId: 'c1', agentId: 'a1', taskId: id },
      storageRoot,
      partitionPath,
      partitionId,
    });

    assert.strictEqual(await recordVerifiedMaterializationFor(id, sessionFile), true);
    const updated = await markCleanupRequiredFor(id);
    assert.strictEqual(updated.state, 'cleanup-required');
    assert.strictEqual(
      updated.partitionId,
      partitionId,
      'taskId/partition ownership must survive cleanup marking'
    );
    assert.strictEqual(updated.owner.taskId, id);

    // The hook boundary must never be able to commit past this point.
    assert.strictEqual(await commitRecordedOwnershipFor(id), false);
  });

  it('markCleanupRequired never downgrades an already-committed record', async function () {
    const id = nextTaskId('no-downgrade-committed');
    const partitionId = '66666666-6666-4666-8666-666666666666';
    await seedProvisionalTask(id, {
      owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: id },
      storageRoot,
      partitionPath,
      partitionId,
    });

    assert.strictEqual(await commitOwnershipFor(id, sessionFile), true);
    const afterCleanupAttempt = await markCleanupRequiredFor(id);
    assert.strictEqual(
      afterCleanupAttempt.state,
      'committed',
      'a committed record must never be downgraded'
    );
  });

  it('standalone: commitOwnership is the direct terminal boundary and rejects a duplicate call', async function () {
    const id = nextTaskId('standalone-direct-commit');
    const partitionId = '77777777-7777-4777-8777-777777777777';
    await seedProvisionalTask(id, {
      owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: id },
      storageRoot,
      partitionPath,
      partitionId,
    });

    assert.strictEqual(await commitOwnershipFor(id, sessionFile), true);
    assert.strictEqual(
      await commitOwnershipFor(id, sessionFile),
      false,
      'a duplicate/re-entrant completion call must not re-commit'
    );

    const ownership = await getOwnership(id);
    assert.strictEqual(ownership.state, 'committed');
  });
});
