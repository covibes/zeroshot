/**
 * task-lib/omp-session-ownership.js — the owner-fenced ownership state machine of issue #866,
 * isolated from the detached-watcher plumbing exercised end-to-end in tests/omp-rpc-watcher.test.js.
 *
 * What this proves:
 *   - the two-boundary commit contract: a detached watcher may only *record* verified evidence for
 *     a cluster-agent owner; only the parent agent's post-hook boundary may commit it. Standalone
 *     owners commit directly, because the watcher IS their terminal boundary.
 *   - every transition is a full-value compare-and-swap, so a duplicate/re-entrant call from a
 *     racing crash-recovery path can never clobber a state another writer already advanced past.
 *   - the resume ownership transfer is atomic and fenced on both rows, so a partition is never
 *     owned by two committed rows. It regularly has NO committed owner: the authoritative live
 *     claimant for the whole span of a resumed turn is that turn's own `provisional` row, by
 *     design, and a post-transfer failure must retire it rather than strand the lineage.
 *   - every #866 ownership crash vector resolves to exactly one committed owner or a retryable
 *     cleanup-required state, and no unowned partition becomes resumable.
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

const { makeSessionPartition } = require('../helpers/omp-session-fixtures');

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

/** Insert a task row whose ompSessionOwnership is a fresh provisional record for `partition`. */
async function seedProvisionalTask(id, { owner, storageRoot, partitionId, workspace }) {
  const stdout = await runStoreScript(`
    const { addTask } = await import(${JSON.stringify(storeUrl)});
    const { writeProvisionalOwnership } = await import(${JSON.stringify(ownershipUrl)});
    const record = writeProvisionalOwnership({
      partitionId: ${JSON.stringify(partitionId)},
      storageRoot: ${JSON.stringify(storageRoot)},
      canonicalWorkspace: ${JSON.stringify(workspace ?? storageRoot)},
      owner: ${JSON.stringify(owner)},
    });
    addTask({
      id: ${JSON.stringify(id)},
      status: 'running',
      provider: 'omp',
      cwd: ${JSON.stringify(workspace ?? storageRoot)},
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

function evidenceLiteral(sessionFilePath, overrides = {}) {
  return JSON.stringify({
    sessionId: 'sess-1',
    sessionFilePath,
    artifactManifestDigest: `sha256:${'a'.repeat(64)}`,
    executionFingerprint: `sha256:${'b'.repeat(64)}`,
    selectedProvider: 'anthropic',
    selectedModel: '@default',
    ...overrides,
  });
}

async function callOwnership(fnName, argLiteral) {
  const stdout = await runStoreScript(`
    const mod = await import(${JSON.stringify(ownershipUrl)});
    process.stdout.write(JSON.stringify(mod.${fnName}(${argLiteral}) ?? null));
  `);
  return JSON.parse(stdout);
}

function recordVerifiedMaterializationFor(id, sessionFilePath, overrides) {
  return callOwnership(
    'recordVerifiedMaterialization',
    `{ taskId: ${JSON.stringify(id)}, ...${evidenceLiteral(sessionFilePath, overrides)} }`
  );
}

function commitOwnershipFor(id, sessionFilePath, overrides) {
  return callOwnership(
    'commitOwnership',
    `{ taskId: ${JSON.stringify(id)}, ...${evidenceLiteral(sessionFilePath, overrides)} }`
  );
}

function commitRecordedOwnershipFor(id) {
  return callOwnership('commitRecordedOwnership', JSON.stringify(id));
}

function markCleanupRequiredFor(id) {
  return callOwnership('markCleanupRequired', JSON.stringify(id));
}

/** The shared durable-boundary retirement every failed/cancelled/stale/killed transition uses. */
function retireAtTerminalBoundaryFor(id) {
  return callOwnership('retireOmpOwnershipAtTerminalBoundary', JSON.stringify(id));
}

function transferOwnership(fromTaskId, toTaskId) {
  return callOwnership('transferOmpSessionOwnership', JSON.stringify({ fromTaskId, toTaskId }));
}

function committedOwnersFor(partitionId, excludeTaskId = null) {
  return callOwnership(
    'findCommittedOwnersForPartition',
    `${JSON.stringify(partitionId)}, ${JSON.stringify(excludeTaskId)}`
  );
}

function authoritativeOwnersFor(partitionId, excludeTaskId = null) {
  return callOwnership(
    'findAuthoritativeOwnersForPartition',
    `${JSON.stringify(partitionId)}, ${JSON.stringify(excludeTaskId)}`
  );
}

describe('task-lib/omp-session-ownership.js (owner-fenced ownership state machine)', function () {
  this.timeout(30000);

  let storageRoot;
  let partition;

  beforeEach(function () {
    storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'storage-'));
    partition = makeSessionPartition({ storageRoot });
  });

  const clusterOwner = (id) => ({
    kind: 'cluster-agent',
    clusterId: 'c1',
    agentId: 'a1',
    taskId: id,
  });
  const standaloneOwner = (id) => ({
    kind: 'standalone',
    clusterId: null,
    agentId: null,
    taskId: id,
  });

  async function seedCluster(label) {
    const id = nextTaskId(label);
    await seedProvisionalTask(id, {
      owner: clusterOwner(id),
      storageRoot,
      partitionId: partition.partitionId,
    });
    return id;
  }

  async function seedStandalone(label, options = {}) {
    const id = nextTaskId(label);
    await seedProvisionalTask(id, {
      owner: standaloneOwner(id),
      storageRoot,
      partitionId: options.partitionId ?? partition.partitionId,
    });
    return id;
  }

  describe('two-boundary commit contract', function () {
    it('cluster-agent: recordVerifiedMaterialization persists evidence but leaves state provisional', async function () {
      const id = await seedCluster('cluster-record');
      assert.strictEqual(
        await recordVerifiedMaterializationFor(id, partition.sessionFilePath),
        true
      );

      const ownership = await getOwnership(id);
      assert.strictEqual(ownership.state, 'provisional', 'evidence recording must not commit');
      assert.strictEqual(ownership.session.sessionId, 'sess-1');
      assert.strictEqual(ownership.session.fileName, partition.sessionFileName);
      assert.deepStrictEqual(ownership.partitionIdentity, partition.identity());
      assert.deepStrictEqual(ownership.session.fileIdentity, partition.sessionFileIdentity());
    });

    it('cluster-agent: commitRecordedOwnership fails closed with no prior recorded evidence', async function () {
      const id = await seedCluster('cluster-commit-no-evidence');
      assert.strictEqual(await commitRecordedOwnershipFor(id), false);
      assert.strictEqual((await getOwnership(id)).state, 'provisional');
    });

    it('cluster-agent: commitRecordedOwnership commits exactly the evidence the watcher recorded', async function () {
      const id = await seedCluster('cluster-commit');
      await recordVerifiedMaterializationFor(id, partition.sessionFilePath);
      const recorded = await getOwnership(id);

      assert.strictEqual(await commitRecordedOwnershipFor(id), true);
      const committed = await getOwnership(id);
      assert.strictEqual(committed.state, 'committed');
      assert.deepStrictEqual(committed.session, recorded.session);
      assert.deepStrictEqual(committed.partitionIdentity, recorded.partitionIdentity);
    });

    it('standalone: commitOwnership is the direct terminal boundary and rejects a duplicate call', async function () {
      const id = await seedStandalone('standalone-commit');
      assert.strictEqual(await commitOwnershipFor(id, partition.sessionFilePath), true);
      assert.strictEqual((await getOwnership(id)).state, 'committed');
      assert.strictEqual(
        await commitOwnershipFor(id, partition.sessionFilePath),
        false,
        'the CAS must refuse a second commit rather than reprocessing'
      );
    });

    it('fails closed when the recorded partition or session file has vanished', async function () {
      const id = await seedStandalone('missing-session-file');
      fs.rmSync(partition.partitionPath, { recursive: true, force: true });
      assert.strictEqual(await commitOwnershipFor(id, partition.sessionFilePath), false);
      assert.strictEqual((await getOwnership(id)).state, 'provisional');
    });

    it('refuses to read or advance a record whose owner.taskId is a different row', async function () {
      const id = nextTaskId('foreign-owner');
      await runStoreScript(`
        const { addTask } = await import(${JSON.stringify(storeUrl)});
        const { writeProvisionalOwnership } = await import(${JSON.stringify(ownershipUrl)});
        addTask({
          id: ${JSON.stringify(id)},
          status: 'running',
          provider: 'omp',
          cwd: ${JSON.stringify(storageRoot)},
          ompSessionOwnership: writeProvisionalOwnership({
            partitionId: ${JSON.stringify(partition.partitionId)},
            storageRoot: ${JSON.stringify(storageRoot)},
            canonicalWorkspace: ${JSON.stringify(storageRoot)},
            owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: 'somebody-else' },
          }),
        });
      `);
      assert.strictEqual(await commitOwnershipFor(id, partition.sessionFilePath), false);
      assert.strictEqual(await commitRecordedOwnershipFor(id), false);
      assert.strictEqual(await markCleanupRequiredFor(id), null);
    });
  });

  describe('ownership crash vectors (#866 acceptance)', function () {
    it('row-before-directory: a provisional row whose partition was never created stays provisional and cleans up', async function () {
      const unmadePartitionId = require('crypto').randomUUID();
      const id = await seedStandalone('row-before-directory', { partitionId: unmadePartitionId });
      const ownership = await getOwnership(id);
      assert.strictEqual(ownership.state, 'provisional');
      assert.ok(!fs.existsSync(ownership.partitionPath), 'the directory must not exist yet');
      assert.strictEqual(
        await commitOwnershipFor(id, path.join(ownership.partitionPath, 'x.jsonl')),
        false,
        'nothing materialized, so nothing may be committed'
      );
      assert.strictEqual((await markCleanupRequiredFor(id)).state, 'cleanup-required');
    });

    it('fresh materialization-before-capture: a crash before evidence is recorded resolves to cleanup-required', async function () {
      const id = await seedCluster('materialization-before-capture');
      // The session file exists on disk, but the watcher died before recording anything.
      assert.ok(fs.existsSync(partition.sessionFilePath));
      assert.strictEqual((await markCleanupRequiredFor(id)).state, 'cleanup-required');
      assert.strictEqual(
        await commitRecordedOwnershipFor(id),
        false,
        'a retired record must never be resurrectable into a committed owner'
      );
      assert.strictEqual((await getOwnership(id)).state, 'cleanup-required');
    });

    it('provider-complete-before-hook: recorded evidence is not resumable until the hook boundary commits', async function () {
      const id = await seedCluster('provider-complete-before-hook');
      await recordVerifiedMaterializationFor(id, partition.sessionFilePath);
      assert.strictEqual((await getOwnership(id)).state, 'provisional');
      assert.deepStrictEqual(
        await committedOwnersFor(partition.partitionId),
        [],
        'no committed owner exists before the hook boundary'
      );
      assert.strictEqual(await commitRecordedOwnershipFor(id), true);
      assert.deepStrictEqual(await committedOwnersFor(partition.partitionId), [id]);
    });

    it('failed schema/hook: markCleanupRequired retires a provisional record even after evidence was recorded', async function () {
      const id = await seedCluster('failed-hook');
      await recordVerifiedMaterializationFor(id, partition.sessionFilePath);
      const retired = await markCleanupRequiredFor(id);
      assert.strictEqual(retired.state, 'cleanup-required');
      assert.strictEqual(retired.owner.taskId, id, 'the owner is preserved for cleanup to act on');
      assert.strictEqual(retired.session.sessionId, 'sess-1');
      assert.deepStrictEqual(await committedOwnersFor(partition.partitionId), []);
    });

    it('cancellation: a cancelled turn retires its record and is idempotent under repeated recovery', async function () {
      const id = await seedStandalone('cancelled');
      assert.strictEqual((await markCleanupRequiredFor(id)).state, 'cleanup-required');
      assert.strictEqual((await markCleanupRequiredFor(id)).state, 'cleanup-required');
      assert.strictEqual(await commitOwnershipFor(id, partition.sessionFilePath), false);
    });

    it('commit-before-agent-snapshot: a re-entrant commit after crash recovery is a safe no-op', async function () {
      const id = await seedCluster('commit-before-snapshot');
      await recordVerifiedMaterializationFor(id, partition.sessionFilePath);
      assert.strictEqual(await commitRecordedOwnershipFor(id), true);
      // The agent crashed before writing its in-memory snapshot; recovery retries the commit.
      assert.strictEqual(await commitRecordedOwnershipFor(id), false);
      assert.strictEqual((await getOwnership(id)).state, 'committed');
      assert.deepStrictEqual(
        await committedOwnersFor(partition.partitionId),
        [id],
        'exactly one committed owner'
      );
    });

    it('markCleanupRequired never downgrades an already-committed record', async function () {
      const id = await seedStandalone('no-downgrade');
      await commitOwnershipFor(id, partition.sessionFilePath);
      assert.strictEqual((await markCleanupRequiredFor(id)).state, 'committed');
      assert.strictEqual((await getOwnership(id)).state, 'committed');
    });
  });

  describe('resume ownership transfer', function () {
    async function seedCommittedPrior(label) {
      const priorId = await seedStandalone(`${label}-prior`);
      assert.strictEqual(await commitOwnershipFor(priorId, partition.sessionFilePath), true);
      return priorId;
    }

    it('atomically moves the committed lineage onto the resumed row and clears the prior owner', async function () {
      const priorId = await seedCommittedPrior('transfer');
      const priorRecord = await getOwnership(priorId);
      const resumedId = await seedStandalone('transfer-resumed');

      const transferred = await transferOwnership(priorId, resumedId);
      assert.ok(transferred, 'the transfer must apply');
      assert.strictEqual(transferred.state, 'provisional');
      assert.deepStrictEqual(transferred.session, priorRecord.session);
      assert.deepStrictEqual(transferred.partitionIdentity, priorRecord.partitionIdentity);
      assert.strictEqual(transferred.owner.taskId, resumedId);

      assert.strictEqual(await getOwnership(priorId), null, 'prior owner is released');
      assert.deepStrictEqual(
        await committedOwnersFor(partition.partitionId),
        [],
        'no committed owner exists mid-turn, so the partition is not resumable until this turn succeeds'
      );
    });

    it('is idempotent: a replayed transfer after re-entry does not apply twice', async function () {
      const priorId = await seedCommittedPrior('replay');
      const resumedId = await seedStandalone('replay-resumed');
      assert.ok(await transferOwnership(priorId, resumedId));
      assert.strictEqual(
        await transferOwnership(priorId, resumedId),
        null,
        'the prior owner has already been released; a second transfer must fail closed'
      );
    });

    it('refuses to transfer from a non-committed prior owner or onto an advanced row', async function () {
      const priorId = await seedStandalone('uncommitted-prior');
      const resumedId = await seedStandalone('uncommitted-resumed');
      assert.strictEqual(
        await transferOwnership(priorId, resumedId),
        null,
        'a provisional prior owner has no lineage to transfer'
      );

      const committedPrior = await seedCommittedPrior('advanced');
      const advancedResumed = await seedStandalone('advanced-resumed');
      await markCleanupRequiredFor(advancedResumed);
      assert.strictEqual(
        await transferOwnership(committedPrior, advancedResumed),
        null,
        'a row already retired must not be claimed as a transfer target'
      );
      assert.strictEqual(
        (await getOwnership(committedPrior)).state,
        'committed',
        'a failed transfer leaves the prior owner untouched'
      );
    });

    it('refuses to transfer between rows describing different partitions or storage roots', async function () {
      const priorId = await seedCommittedPrior('cross-partition');
      const otherStorage = fs.mkdtempSync(path.join(zeroshotHome, 'other-storage-'));
      const otherPartition = makeSessionPartition({ storageRoot: otherStorage });
      const strangerId = nextTaskId('cross-partition-stranger');
      await seedProvisionalTask(strangerId, {
        owner: standaloneOwner(strangerId),
        storageRoot: otherStorage,
        partitionId: otherPartition.partitionId,
      });
      assert.strictEqual(await transferOwnership(priorId, strangerId), null);
      assert.strictEqual((await getOwnership(priorId)).state, 'committed');
    });

    it('refuses a self-transfer and an unknown counterparty', async function () {
      const priorId = await seedCommittedPrior('self');
      assert.strictEqual(await transferOwnership(priorId, priorId), null);
      assert.strictEqual(await transferOwnership(priorId, 'does-not-exist'), null);
      assert.strictEqual(await transferOwnership('does-not-exist', priorId), null);
    });

    it('resume-transfer-before-prompt crash: the prior owner stays the single committed owner', async function () {
      // The resumed row exists (row-before-anything) but the watcher died before the transfer.
      const priorId = await seedCommittedPrior('crash-before-transfer');
      const resumedId = await seedStandalone('crash-before-transfer-resumed');
      assert.deepStrictEqual(
        await committedOwnersFor(partition.partitionId, resumedId),
        [priorId],
        'the prior owner still owns the partition, so cleanup driven by the resumed row must refuse'
      );
      assert.strictEqual((await markCleanupRequiredFor(resumedId)).state, 'cleanup-required');
      assert.strictEqual(
        (await getOwnership(priorId)).state,
        'committed',
        'the still-resumable prior session survives the failed resume attempt'
      );
    });

    it('third-owner interleaving: the retired loser is the only row a committed-only fence can see', async function () {
      // Prior owner P, plus two competing resumes A and B of the same committed session. A wins
      // the atomic transfer; B's transfer fails and its turn is retired. This is the exact state
      // in which a committed-only cleanup fence is blind: `findCommittedOwnersForPartition`
      // returns nothing at all, because the live owner A is *provisional*, and B's own record
      // carries no partitionIdentity to fail the descriptor-pinned identity check either — so
      // cleanup driven by B would have renamed and deleted A's live partition.
      const priorId = await seedCommittedPrior('third-owner');
      const winnerId = await seedStandalone('third-owner-winner');
      const loserId = await seedStandalone('third-owner-loser');

      assert.ok(await transferOwnership(priorId, winnerId), 'A wins the transfer');
      assert.strictEqual(
        await transferOwnership(priorId, loserId),
        null,
        'the prior owner is already released, so B fails closed'
      );
      const retired = await markCleanupRequiredFor(loserId);
      assert.strictEqual(retired.state, 'cleanup-required');
      assert.strictEqual(retired.partitionIdentity, null, 'B never observed the partition itself');

      assert.deepStrictEqual(
        await committedOwnersFor(partition.partitionId, loserId),
        [],
        'no row is committed mid-turn — this is why the committed-only fence let B through'
      );
      assert.deepStrictEqual(
        await authoritativeOwnersFor(partition.partitionId, loserId),
        [{ taskId: winnerId, state: 'provisional' }],
        "the authoritative fence sees A's live provisional claim and refuses on B's behalf"
      );
      assert.deepStrictEqual(
        await authoritativeOwnersFor(partition.partitionId, winnerId),
        [],
        'A itself is fenced only by rows other than its own; B is retired and claims nothing'
      );
    });

    it('a successful resumed turn commits the new evidence over the inherited lineage', async function () {
      const priorId = await seedCommittedPrior('resume-success');
      const resumedId = await seedStandalone('resume-success-resumed');
      await transferOwnership(priorId, resumedId);

      fs.appendFileSync(partition.sessionFilePath, '{"type":"message","role":"user"}\n');
      assert.strictEqual(
        await commitOwnershipFor(resumedId, partition.sessionFilePath, {
          sessionId: 'sess-1',
          artifactManifestDigest: `sha256:${'c'.repeat(64)}`,
        }),
        true
      );
      const committed = await getOwnership(resumedId);
      assert.strictEqual(committed.state, 'committed');
      assert.strictEqual(committed.session.artifactManifestDigest, `sha256:${'c'.repeat(64)}`);
      assert.deepStrictEqual(
        await committedOwnersFor(partition.partitionId),
        [resumedId],
        'exactly one committed owner after the resumed turn'
      );
    });

    it('every post-transfer terminal failure retires the resumed row instead of stranding it', async function () {
      // Terminal verification failure, a failed schema/hook boundary, a cancellation, a kill, a
      // spawn that never got off the ground: they are different code paths but the same durable
      // boundary, and the state that matters is the same. After the transfer the resumed row holds
      // the ONLY copy of the lineage — the prior owner's record was cleared — so a failure that
      // left it `provisional` would strand the partition forever behind the authoritative fence.
      const priorId = await seedCommittedPrior('post-transfer-failure');
      const resumedId = await seedStandalone('post-transfer-failure-resumed');
      assert.ok(await transferOwnership(priorId, resumedId), 'the transfer must apply first');

      assert.strictEqual(await retireAtTerminalBoundaryFor(resumedId), true);
      const retired = await getOwnership(resumedId);
      assert.strictEqual(retired.state, 'cleanup-required');
      assert.ok(retired.session, 'the inherited lineage is retained as evidence for cleanup');
      assert.strictEqual(
        await getOwnership(priorId),
        null,
        'the released prior owner must not reappear as a second committed owner'
      );
      assert.deepStrictEqual(
        await committedOwnersFor(partition.partitionId),
        [],
        'no committed owner survives a failed continuation'
      );
      assert.deepStrictEqual(
        await authoritativeOwnersFor(partition.partitionId),
        [],
        'a retired row claims nothing, so the partition is reclaimable by cleanup'
      );

      // Re-entry: a retried kill, a crash-recovery replay, or the watcher and its parent both
      // reacting to the same terminal frame must converge rather than fight.
      assert.strictEqual(await retireAtTerminalBoundaryFor(resumedId), true);
      assert.strictEqual((await getOwnership(resumedId)).state, 'cleanup-required');
    });

    it('the terminal-boundary retirement is total: unknown rows and committed rows are safe no-ops', async function () {
      // Callers are already committing a terminal task-status write when they call this, so it
      // must never throw and must never downgrade a session that legitimately succeeded.
      assert.strictEqual(await retireAtTerminalBoundaryFor('no-such-task'), true);
      assert.strictEqual(await retireAtTerminalBoundaryFor(''), true);

      const committedId = await seedCommittedPrior('retire-committed');
      assert.strictEqual(await retireAtTerminalBoundaryFor(committedId), true);
      assert.strictEqual(
        (await getOwnership(committedId)).state,
        'committed',
        'a committed record is the tail of an already-successful turn and is never downgraded'
      );
    });
  });
});
