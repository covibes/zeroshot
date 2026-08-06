/**
 * The `providerSession.ompSession` snapshot and the commit-then-snapshot ordering (issue #866).
 *
 * Two things are proven here:
 *
 * 1. `ompSession` is an *exact optional* field: required in addition to the generic tuple for
 *    provider `omp`, absent for every other provider, closed against unknown keys, and only ever
 *    derived from a `committed` ownership record fenced to that same task row.
 *
 * 2. The ordering in agent-lifecycle.js is checked-commit-then-rebuild. The detached watcher
 *    deliberately leaves a cluster-agent owner `provisional`, so the snapshot computed at
 *    completion time is null by construction; if the agent stored that snapshot instead of
 *    rebuilding after the commit, cluster OMP sessions would silently never be reusable.
 */

const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { promisify } = require('util');
const testFileUrl = pathToFileURL(__filename).href;

const execFileAsync = promisify(execFile);

const { makeSessionPartition } = require('../helpers/omp-session-fixtures');
const { normalizeProviderSession } = require('../../src/agent/provider-session');

const zeroshotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-provider-session-'));
const storeUrl = pathToFileURL(path.resolve(__dirname, '../../task-lib/store.js')).href;
const ownershipUrl = pathToFileURL(
  path.resolve(__dirname, '../../task-lib/omp-session-ownership.js')
).href;

async function runScript(script) {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ZEROSHOT_HOME: zeroshotHome },
  });
  return stdout;
}

const PARTITION_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST_MANIFEST = `sha256:${'a'.repeat(64)}`;
const DIGEST_FINGERPRINT = `sha256:${'b'.repeat(64)}`;
const PROMPT_IDENTITY = `sha256:${'c'.repeat(64)}`;

function ompSessionValue(overrides = {}) {
  return {
    schemaVersion: 1,
    partitionId: PARTITION_ID,
    sessionFileName: '2026-08-02T00-00-00-000Z_sess-1.jsonl',
    sessionFileIdentity: { device: '2049', inode: '17' },
    artifactManifestDigest: DIGEST_MANIFEST,
    executionFingerprint: DIGEST_FINGERPRINT,
    selectedProvider: 'anthropic',
    selectedModel: '@default',
    ...overrides,
  };
}

function providerSessionValue(overrides = {}) {
  return {
    provider: 'omp',
    sessionId: 'sess-1',
    agentId: 'worker-1',
    taskId: 'task-1',
    generation: 3,
    cwd: '/work',
    worktreePath: null,
    contextSequence: '1',
    guidanceSequence: null,
    promptIdentity: PROMPT_IDENTITY,
    ompSession: ompSessionValue(),
    ...overrides,
  };
}

describe('providerSession.ompSession (exact optional field)', function () {
  it('accepts a complete OMP snapshot and preserves exactly its fixed field set', function () {
    const normalized = normalizeProviderSession(providerSessionValue());
    assert.ok(normalized);
    assert.deepStrictEqual(normalized.ompSession, ompSessionValue());
    assert.deepStrictEqual(Object.keys(normalized.ompSession), [
      'schemaVersion',
      'partitionId',
      'sessionFileName',
      'sessionFileIdentity',
      'artifactManifestDigest',
      'executionFingerprint',
      'selectedProvider',
      'selectedModel',
    ]);
  });

  it('requires ompSession for provider omp and forbids it for every other provider', function () {
    const missing = providerSessionValue();
    delete missing.ompSession;
    assert.strictEqual(normalizeProviderSession(missing), null, 'omp requires ompSession');
    assert.strictEqual(normalizeProviderSession(providerSessionValue({ ompSession: null })), null);

    const claude = normalizeProviderSession(
      providerSessionValue({ provider: 'claude', ompSession: undefined })
    );
    // `ompSession: undefined` is still an own property, so it must be rejected as "present".
    assert.strictEqual(claude, null, 'a present ompSession key is forbidden for non-omp providers');

    const claudeClean = providerSessionValue({ provider: 'claude' });
    delete claudeClean.ompSession;
    const normalizedClaude = normalizeProviderSession(claudeClean);
    assert.ok(normalizedClaude);
    assert.ok(!Object.hasOwn(normalizedClaude, 'ompSession'));
  });

  it('rejects unknown keys inside ompSession and inside its identity', function () {
    assert.strictEqual(
      normalizeProviderSession(
        providerSessionValue({ ompSession: ompSessionValue({ smuggled: 1 }) })
      ),
      null
    );
    assert.strictEqual(
      normalizeProviderSession(
        providerSessionValue({
          ompSession: ompSessionValue({
            sessionFileIdentity: { device: '1', inode: '2', extra: 3 },
          }),
        })
      ),
      null
    );
  });

  it('rejects a non-UUID partition id and a non-direct-child/non-.jsonl file name', function () {
    for (const partitionId of ['nope', '../escape', '']) {
      assert.strictEqual(
        normalizeProviderSession(
          providerSessionValue({ ompSession: ompSessionValue({ partitionId }) })
        ),
        null,
        `partitionId ${JSON.stringify(partitionId)}`
      );
    }
    for (const sessionFileName of ['sub/a.jsonl', '../a.jsonl', 'a.txt', '.jsonl', '']) {
      assert.strictEqual(
        normalizeProviderSession(
          providerSessionValue({ ompSession: ompSessionValue({ sessionFileName }) })
        ),
        null,
        `sessionFileName ${JSON.stringify(sessionFileName)}`
      );
    }
  });

  it('rejects malformed digests, identities, and schema versions', function () {
    const bad = [
      { artifactManifestDigest: 'sha256:' + 'A'.repeat(64) },
      { executionFingerprint: 'nope' },
      { sessionFileIdentity: { device: '01', inode: '2' } },
      { sessionFileIdentity: null },
      { schemaVersion: 2 },
      { selectedProvider: '' },
      { selectedModel: '' },
    ];
    for (const overrides of bad) {
      assert.strictEqual(
        normalizeProviderSession(providerSessionValue({ ompSession: ompSessionValue(overrides) })),
        null,
        JSON.stringify(overrides)
      );
    }
  });

  it('requires device/inode to already BE canonical decimal strings, and never coerces them', function () {
    // Issue #866 fixes these as canonical unsigned decimal strings. The snapshot is compared field
    // by field against the persisted ownership record, so accepting a JSON number here (and
    // stringifying it) would let a snapshot that never contained the canonical form compare equal
    // to a record that did — the exact-identity check would be asserting against a value this
    // normalizer invented.
    const notStrings = [
      { device: 2049, inode: '17' },
      { device: '2049', inode: 17 },
      { device: 2049, inode: 17 },
      { device: 0, inode: 0 },
      { device: ['2049'], inode: '17' },
      { device: { toString: () => '2049' }, inode: '17' },
      { device: true, inode: '17' },
      { device: null, inode: '17' },
    ];
    for (const sessionFileIdentity of notStrings) {
      assert.strictEqual(
        normalizeProviderSession(
          providerSessionValue({ ompSession: ompSessionValue({ sessionFileIdentity }) })
        ),
        null,
        `identity ${JSON.stringify(sessionFileIdentity)} must not be coerced into a string`
      );
    }

    const noncanonicalStrings = [
      { device: '+2049', inode: '17' },
      { device: '-1', inode: '17' },
      { device: '02049', inode: '17' },
      { device: ' 2049', inode: '17' },
      { device: '2049 ', inode: '17' },
      { device: '2049\n', inode: '17' },
      { device: '2_049', inode: '17' },
      { device: '2.0', inode: '17' },
      { device: '2e3', inode: '17' },
      { device: '0x801', inode: '17' },
      { device: '', inode: '17' },
      { device: '2049', inode: '18446744073709551616e0' },
    ];
    for (const sessionFileIdentity of noncanonicalStrings) {
      assert.strictEqual(
        normalizeProviderSession(
          providerSessionValue({ ompSession: ompSessionValue({ sessionFileIdentity }) })
        ),
        null,
        `identity ${JSON.stringify(sessionFileIdentity)} is not canonical and must be rejected`
      );
    }

    // Missing and extra keys are equally fatal: the pair is closed.
    for (const sessionFileIdentity of [
      { device: '2049' },
      { inode: '17' },
      {},
      { device: '2049', inode: '17', dev: '2049' },
    ]) {
      assert.strictEqual(
        normalizeProviderSession(
          providerSessionValue({ ompSession: ompSessionValue({ sessionFileIdentity }) })
        ),
        null,
        `identity ${JSON.stringify(sessionFileIdentity)} is not a closed device/inode pair`
      );
    }

    // A very large but canonical decimal string is accepted as-is; it is an opaque identifier, not
    // a number, and must survive byte-for-byte.
    const huge = { device: '18446744073709551615', inode: '9007199254740993' };
    const accepted = normalizeProviderSession(
      providerSessionValue({ ompSession: ompSessionValue({ sessionFileIdentity: huge }) })
    );
    assert.deepStrictEqual(accepted.ompSession.sessionFileIdentity, huge);
  });

  it('never carries storage-root or partition paths', function () {
    const normalized = normalizeProviderSession(providerSessionValue());
    const serialized = JSON.stringify(normalized.ompSession);
    assert.ok(!serialized.includes('/'), 'no path-shaped value may appear in the agent snapshot');
    assert.ok(!Object.hasOwn(normalized.ompSession, 'storageRoot'));
    assert.ok(!Object.hasOwn(normalized.ompSession, 'partitionPath'));
  });
});

describe('commit-then-snapshot ordering (agent-lifecycle.js)', function () {
  this.timeout(30000);

  let storageRoot;
  let workspace;
  let partition;

  beforeEach(function () {
    storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'storage-'));
    workspace = fs.mkdtempSync(path.join(zeroshotHome, 'workspace-'));
    partition = makeSessionPartition({ storageRoot, cwd: workspace });
  });

  /**
   * Drive the real finalizeProviderSessionAfterCommit against a real task row whose ownership is
   * exactly where the detached watcher leaves it for a cluster-agent owner (provisional + verified
   * evidence), and report both the pre-commit snapshot and the post-commit one.
   */
  async function finalize(taskId, { recordEvidence = true } = {}) {
    const stdout = await runScript(`
      const { addTask, updateTask, getTask } = await import(${JSON.stringify(storeUrl)});
      const { writeProvisionalOwnership, recordVerifiedMaterialization } =
        await import(${JSON.stringify(ownershipUrl)});
      const { createRequire } = await import('module');
      const require = createRequire(${JSON.stringify(testFileUrl)});
      const lifecycle = require(${JSON.stringify(path.resolve(__dirname, '../../src/agent/agent-lifecycle.js'))});
      const { providerSessionFromCompletedTask } =
        require(${JSON.stringify(path.resolve(__dirname, '../../src/agent/provider-session.js'))});

      addTask({
        id: ${JSON.stringify(taskId)},
        status: 'completed',
        provider: 'omp',
        cwd: ${JSON.stringify(workspace)},
        ompSessionOwnership: writeProvisionalOwnership({
          partitionId: ${JSON.stringify(partition.partitionId)},
          storageRoot: ${JSON.stringify(storageRoot)},
          canonicalWorkspace: ${JSON.stringify(workspace)},
          owner: {
            kind: 'cluster-agent',
            clusterId: 'cluster-1',
            agentId: 'worker-1',
            taskId: ${JSON.stringify(taskId)},
          },
        }),
      });
      if (${recordEvidence}) {
        recordVerifiedMaterialization({
          taskId: ${JSON.stringify(taskId)},
          sessionId: ${JSON.stringify(partition.sessionId)},
          sessionFilePath: ${JSON.stringify(partition.sessionFilePath)},
          artifactManifestDigest: ${JSON.stringify(DIGEST_MANIFEST)},
          executionFingerprint: ${JSON.stringify(DIGEST_FINGERPRINT)},
          selectedProvider: 'anthropic',
          selectedModel: '@default',
        });
      }

      const agent = {
        id: 'worker-1',
        iteration: 3,
        config: { cwd: ${JSON.stringify(workspace)} },
        currentContextSequence: '1',
        currentGuidanceSequence: null,
        currentPromptIdentity: ${JSON.stringify(PROMPT_IDENTITY)},
        _resolveProvider: () => 'omp',
      };

      // What buildCompletionResult() computes at completion time, i.e. against the row as the
      // watcher left it.
      const preCommitSnapshot = providerSessionFromCompletedTask({
        agent,
        providerName: 'omp',
        taskInfo: getTask(${JSON.stringify(taskId)}),
        logicalSuccess: true,
      });

      const result = { taskId: ${JSON.stringify(taskId)}, providerSession: preCommitSnapshot };
      const finalized = lifecycle.finalizeProviderSessionAfterCommit(agent, result);

      process.stdout.write(JSON.stringify({
        preCommitSnapshot,
        finalized,
        resultProviderSession: result.providerSession,
        ownership: getTask(${JSON.stringify(taskId)})?.ompSessionOwnership ?? null,
      }));
    `);
    return JSON.parse(stdout);
  }

  it('rebuilds the snapshot after the commit rather than publishing the stale provisional one', async function () {
    const out = await finalize('omp-commit-then-snapshot-1');

    assert.strictEqual(
      out.preCommitSnapshot,
      null,
      'the completion-time snapshot is null by construction while the row is provisional'
    );
    assert.strictEqual(out.ownership.state, 'committed', 'the commit ran first');
    assert.ok(out.finalized, 'a resumable snapshot must exist after the commit');
    assert.strictEqual(out.finalized.provider, 'omp');
    assert.strictEqual(out.finalized.sessionId, partition.sessionId);
    assert.strictEqual(out.finalized.ompSession.partitionId, partition.partitionId);
    assert.strictEqual(out.finalized.ompSession.sessionFileName, partition.sessionFileName);
    assert.strictEqual(out.finalized.ompSession.artifactManifestDigest, DIGEST_MANIFEST);
    assert.strictEqual(out.finalized.ompSession.executionFingerprint, DIGEST_FINGERPRINT);
    assert.deepStrictEqual(
      out.resultProviderSession,
      out.finalized,
      'TASK_COMPLETED must publish the rebuilt snapshot, not the stale one'
    );
    assert.ok(
      normalizeProviderSession(out.finalized),
      'the rebuilt snapshot must survive re-normalization on the next turn'
    );
  });

  it('retires the partition and yields no snapshot when there is no evidence to commit', async function () {
    const out = await finalize('omp-commit-then-snapshot-2', { recordEvidence: false });

    assert.strictEqual(out.finalized, null);
    assert.strictEqual(out.resultProviderSession, null);
    assert.strictEqual(
      out.ownership.state,
      'cleanup-required',
      'an uncommittable turn retires its partition instead of leaving it resumable'
    );
  });
});
