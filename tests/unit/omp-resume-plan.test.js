/**
 * The resume plumbing between an agent's snapshot and the detached watcher (issue #866):
 *
 *   agent providerSession.ompSession + taskId
 *     -> --omp-resume <descriptor>            src/agent/agent-task-executor.js#buildTaskRunArgs
 *     -> parseOmpResumeDescriptor             task-lib/commands/run.js  (strict, closed)
 *     -> resolveOmpResumeExpectation          task-lib/runner.js        (cross-checked vs the row)
 *     -> ompResumeExpectation                 task-lib/rpc-watcher.js
 *
 * The descriptor travels over argv, so it is never authoritative on its own: the prior owner's
 * persisted row is, and every field the descriptor asserts must match it exactly. These tests
 * cover the "conflicting IDs / wrong recorded cwd / moved workspace / incomplete prior lifecycle
 * never reaches a resume prompt" acceptance criteria at the point where a task row would
 * otherwise be created.
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

const zeroshotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-resume-plan-'));
const storeUrl = pathToFileURL(path.resolve(__dirname, '../../task-lib/store.js')).href;
const ownershipUrl = pathToFileURL(
  path.resolve(__dirname, '../../task-lib/omp-session-ownership.js')
).href;
const runnerUrl = pathToFileURL(path.resolve(__dirname, '../../task-lib/runner.js')).href;
const runCommandUrl = pathToFileURL(
  path.resolve(__dirname, '../../task-lib/commands/run.js')
).href;
const resumeCommandUrl = pathToFileURL(
  path.resolve(__dirname, '../../task-lib/commands/resume.js')
).href;

async function runScript(script) {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ZEROSHOT_HOME: zeroshotHome },
  });
  return stdout;
}

const DIGEST_MANIFEST = `sha256:${'a'.repeat(64)}`;
const DIGEST_FINGERPRINT = `sha256:${'b'.repeat(64)}`;

let idCounter = 0;
function nextTaskId(label) {
  idCounter += 1;
  return `omp-resume-plan-${label}-${idCounter}`;
}

/** Seed a task row whose ownership is committed over `partition`. */
async function seedCommittedOwner(id, { storageRoot, workspace, partition, owner }) {
  await runScript(`
    const { addTask } = await import(${JSON.stringify(storeUrl)});
    const { writeProvisionalOwnership, commitOwnership } = await import(${JSON.stringify(ownershipUrl)});
    addTask({
      id: ${JSON.stringify(id)},
      status: 'completed',
      provider: 'omp',
      cwd: ${JSON.stringify(workspace)},
      ompSessionOwnership: writeProvisionalOwnership({
        partitionId: ${JSON.stringify(partition.partitionId)},
        storageRoot: ${JSON.stringify(storageRoot)},
        canonicalWorkspace: ${JSON.stringify(workspace)},
        owner: ${JSON.stringify(owner)},
      }),
    });
    commitOwnership({
      taskId: ${JSON.stringify(id)},
      sessionId: ${JSON.stringify(partition.sessionId)},
      sessionFilePath: ${JSON.stringify(partition.sessionFilePath)},
      artifactManifestDigest: ${JSON.stringify(DIGEST_MANIFEST)},
      executionFingerprint: ${JSON.stringify(DIGEST_FINGERPRINT)},
      selectedProvider: 'anthropic',
      selectedModel: '@default',
    });
  `);
}

async function seedProvisionalOwner(id, { storageRoot, workspace, partition, owner }) {
  await runScript(`
    const { addTask } = await import(${JSON.stringify(storeUrl)});
    const { writeProvisionalOwnership } = await import(${JSON.stringify(ownershipUrl)});
    addTask({
      id: ${JSON.stringify(id)},
      status: 'completed',
      provider: 'omp',
      cwd: ${JSON.stringify(workspace)},
      ompSessionOwnership: writeProvisionalOwnership({
        partitionId: ${JSON.stringify(partition.partitionId)},
        storageRoot: ${JSON.stringify(storageRoot)},
        canonicalWorkspace: ${JSON.stringify(workspace)},
        owner: ${JSON.stringify(owner)},
      }),
    });
  `);
}

/** Call resolveOmpResumeExpectation in a child process; returns {ok, value} or {ok:false, error}. */
async function resolveExpectation({ descriptor, storageRoot, canonicalWorkspace }) {
  const stdout = await runScript(`
    const { resolveOmpResumeExpectation } = await import(${JSON.stringify(runnerUrl)});
    try {
      const value = resolveOmpResumeExpectation({
        descriptor: ${JSON.stringify(descriptor)},
        storageRoot: ${JSON.stringify(storageRoot)},
        canonicalWorkspace: ${JSON.stringify(canonicalWorkspace)},
      });
      process.stdout.write(JSON.stringify({ ok: true, value }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
    }
  `);
  return JSON.parse(stdout);
}

async function parseDescriptor(raw) {
  const stdout = await runScript(`
    const { parseOmpResumeDescriptor } = await import(${JSON.stringify(runCommandUrl)});
    try {
      process.stdout.write(JSON.stringify({ ok: true, value: parseOmpResumeDescriptor(${JSON.stringify(raw)}) ?? null }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
    }
  `);
  return JSON.parse(stdout);
}

async function buildResumeOptions(taskId) {
  const stdout = await runScript(`
    const { getTask } = await import(${JSON.stringify(storeUrl)});
    const { buildResumeTaskOptions } = await import(${JSON.stringify(resumeCommandUrl)});
    try {
      process.stdout.write(JSON.stringify({ ok: true, value: buildResumeTaskOptions(getTask(${JSON.stringify(taskId)})) }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
    }
  `);
  return JSON.parse(stdout);
}

const standaloneOwner = (taskId) => ({
  kind: 'standalone',
  clusterId: null,
  agentId: null,
  taskId,
});

describe('OMP resume descriptor -> expectation resolution', function () {
  this.timeout(30000);

  let storageRoot;
  let workspace;
  let partition;
  let priorId;
  let descriptor;

  beforeEach(async function () {
    storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'storage-'));
    workspace = fs.mkdtempSync(path.join(zeroshotHome, 'workspace-'));
    partition = makeSessionPartition({ storageRoot, cwd: workspace });
    priorId = nextTaskId('prior');
    await seedCommittedOwner(priorId, {
      storageRoot,
      workspace,
      partition,
      owner: standaloneOwner(priorId),
    });
    descriptor = {
      priorOwnerTaskId: priorId,
      partitionId: partition.partitionId,
      sessionFileName: partition.sessionFileName,
      expectedSessionId: partition.sessionId,
      expectedSessionFileIdentity: partition.sessionFileIdentity(),
      expectedArtifactManifestDigest: DIGEST_MANIFEST,
      expectedExecutionFingerprint: DIGEST_FINGERPRINT,
      expectedSelectedProvider: 'anthropic',
      expectedSelectedModel: '@default',
    };
  });

  it('resolves the complete expectation from the persisted row', async function () {
    const result = await resolveExpectation({
      descriptor,
      storageRoot,
      canonicalWorkspace: workspace,
    });
    assert.ok(result.ok, result.error);
    assert.deepStrictEqual(result.value, {
      priorOwnerTaskId: priorId,
      partitionId: partition.partitionId,
      partitionPath: partition.partitionPath,
      canonicalWorkspace: workspace,
      sessionFileName: partition.sessionFileName,
      sessionFilePath: partition.sessionFilePath,
      expectedSessionId: partition.sessionId,
      expectedPartitionIdentity: partition.identity(),
      expectedSessionFileIdentity: partition.sessionFileIdentity(),
      expectedArtifactManifestDigest: DIGEST_MANIFEST,
      expectedExecutionFingerprint: DIGEST_FINGERPRINT,
      expectedSelectedProvider: 'anthropic',
      expectedSelectedModel: '@default',
    });
  });

  it('rejects every conflicting descriptor field', async function () {
    // [descriptor field, conflicting value, label reported in the mismatch list]
    const conflicts = [
      ['partitionId', '11111111-1111-4111-8111-111111111111', 'partitionId'],
      ['expectedSessionId', 'a-different-session', 'sessionId'],
      ['sessionFileName', 'not-the-recorded-file.jsonl', 'sessionFileName'],
      ['expectedArtifactManifestDigest', `sha256:${'c'.repeat(64)}`, 'artifactManifestDigest'],
      ['expectedExecutionFingerprint', `sha256:${'d'.repeat(64)}`, 'executionFingerprint'],
      ['expectedSelectedProvider', 'openai', 'selectedProvider'],
      ['expectedSelectedModel', '@something-else', 'selectedModel'],
    ];
    for (const [field, value, label] of conflicts) {
      const result = await resolveExpectation({
        descriptor: { ...descriptor, [field]: value },
        storageRoot,
        canonicalWorkspace: workspace,
      });
      assert.strictEqual(result.ok, false, `${field} conflict must fail closed`);
      assert.match(result.error, /conflicts with the persisted owner record/);
      assert.match(result.error, new RegExp(label));
    }
  });

  it('rejects a conflicting session file identity (same name, different inode)', async function () {
    const recorded = partition.sessionFileIdentity();
    const result = await resolveExpectation({
      descriptor: {
        ...descriptor,
        expectedSessionFileIdentity: {
          device: recorded.device,
          inode: String(Number(recorded.inode) + 1),
        },
      },
      storageRoot,
      canonicalWorkspace: workspace,
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /sessionFileIdentity/);
  });

  it('checks an optional partition identity when the descriptor asserts one', async function () {
    const matching = await resolveExpectation({
      descriptor: { ...descriptor, expectedPartitionIdentity: partition.identity() },
      storageRoot,
      canonicalWorkspace: workspace,
    });
    assert.ok(matching.ok, matching.error);

    const conflicting = await resolveExpectation({
      descriptor: {
        ...descriptor,
        expectedPartitionIdentity: { device: '1', inode: '999999999' },
      },
      storageRoot,
      canonicalWorkspace: workspace,
    });
    assert.strictEqual(conflicting.ok, false);
    assert.match(conflicting.error, /partitionIdentity/);
  });

  it('rejects an existing-but-wrong recorded cwd and a moved workspace', async function () {
    const moved = fs.mkdtempSync(path.join(zeroshotHome, 'moved-workspace-'));
    const result = await resolveExpectation({
      descriptor,
      storageRoot,
      canonicalWorkspace: moved,
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /does not match the recorded/);

    const deleted = path.join(zeroshotHome, 'never-existed');
    const deletedResult = await resolveExpectation({
      descriptor,
      storageRoot,
      canonicalWorkspace: deleted,
    });
    assert.strictEqual(deletedResult.ok, false);
    assert.match(deletedResult.error, /does not match the recorded/);
  });

  it('rejects a storage root that is not the one the owner was recorded under', async function () {
    const otherRoot = fs.mkdtempSync(path.join(zeroshotHome, 'other-storage-'));
    const result = await resolveExpectation({
      descriptor,
      storageRoot: otherRoot,
      canonicalWorkspace: workspace,
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /storage root/);
  });

  it('rejects an incomplete prior lifecycle (provisional / missing / unknown owner)', async function () {
    const provisionalId = nextTaskId('provisional-prior');
    const otherPartition = makeSessionPartition({ storageRoot, cwd: workspace });
    await seedProvisionalOwner(provisionalId, {
      storageRoot,
      workspace,
      partition: otherPartition,
      owner: standaloneOwner(provisionalId),
    });

    const provisional = await resolveExpectation({
      descriptor: {
        ...descriptor,
        priorOwnerTaskId: provisionalId,
        partitionId: otherPartition.partitionId,
      },
      storageRoot,
      canonicalWorkspace: workspace,
    });
    assert.strictEqual(provisional.ok, false);
    assert.match(provisional.error, /is 'provisional', not a committed resumable session/);

    const unknown = await resolveExpectation({
      descriptor: { ...descriptor, priorOwnerTaskId: 'no-such-task' },
      storageRoot,
      canonicalWorkspace: workspace,
    });
    assert.strictEqual(unknown.ok, false);
    assert.match(unknown.error, /no valid OMP session ownership record/);
  });
});

describe('--omp-resume descriptor parsing (task-lib/commands/run.js)', function () {
  this.timeout(30000);

  const valid = {
    priorOwnerTaskId: 'prior-1',
    partitionId: '11111111-1111-4111-8111-111111111111',
    sessionFileName: 'a.jsonl',
    expectedSessionId: 'sess-1',
    expectedSessionFileIdentity: { device: '1', inode: '2' },
    expectedArtifactManifestDigest: `sha256:${'a'.repeat(64)}`,
    expectedExecutionFingerprint: `sha256:${'b'.repeat(64)}`,
    expectedSelectedProvider: 'anthropic',
    expectedSelectedModel: '@default',
  };

  it('accepts a complete descriptor and returns undefined when absent', async function () {
    const parsed = await parseDescriptor(JSON.stringify(valid));
    assert.ok(parsed.ok, parsed.error);
    assert.deepStrictEqual(parsed.value, valid);

    const absent = await parseDescriptor('');
    assert.ok(absent.ok);
    assert.strictEqual(absent.value, null, 'no --omp-resume means no resume plan');
  });

  it('accepts the optional partition identity', async function () {
    const parsed = await parseDescriptor(
      JSON.stringify({ ...valid, expectedPartitionIdentity: { device: '3', inode: '4' } })
    );
    assert.ok(parsed.ok, parsed.error);
    assert.deepStrictEqual(parsed.value.expectedPartitionIdentity, { device: '3', inode: '4' });
  });

  it('rejects malformed JSON, non-objects, and unknown fields', async function () {
    for (const raw of ['{not json', '"a string"', '[]', '42']) {
      const parsed = await parseDescriptor(raw);
      assert.strictEqual(parsed.ok, false, `raw ${raw} must be rejected`);
    }
    const extra = await parseDescriptor(JSON.stringify({ ...valid, smuggled: 'x' }));
    assert.strictEqual(extra.ok, false);
    assert.match(extra.error, /unknown field\(s\): smuggled/);
  });

  it('rejects a descriptor missing any required field', async function () {
    for (const field of Object.keys(valid)) {
      const incomplete = { ...valid };
      delete incomplete[field];
      const parsed = await parseDescriptor(JSON.stringify(incomplete));
      assert.strictEqual(parsed.ok, false, `missing ${field} must be rejected`);
      assert.match(parsed.error, new RegExp(field));
    }
  });

  it('rejects a malformed identity shape', async function () {
    for (const identity of [{ device: '01', inode: '2' }, { device: 1 }, 'x', null]) {
      const parsed = await parseDescriptor(
        JSON.stringify({ ...valid, expectedSessionFileIdentity: identity })
      );
      assert.strictEqual(parsed.ok, false);
    }
    const badOptional = await parseDescriptor(
      JSON.stringify({ ...valid, expectedPartitionIdentity: { device: 'x' } })
    );
    assert.strictEqual(badOptional.ok, false);
    assert.match(badOptional.error, /expectedPartitionIdentity/);
  });
});

describe('manual standalone resume (task-lib/commands/resume.js)', function () {
  this.timeout(30000);

  it('builds a complete descriptor from a committed row, pinned to its recorded storage root and workspace', async function () {
    const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'manual-storage-'));
    const workspace = fs.mkdtempSync(path.join(zeroshotHome, 'manual-workspace-'));
    const partition = makeSessionPartition({ storageRoot, cwd: workspace });
    const id = nextTaskId('manual');
    await seedCommittedOwner(id, {
      storageRoot,
      workspace,
      partition,
      owner: standaloneOwner(id),
    });

    const result = await buildResumeOptions(id);
    assert.ok(result.ok, result.error);
    assert.strictEqual(result.value.cwd, workspace);
    assert.strictEqual(result.value.storageRoot, storageRoot);
    assert.strictEqual(result.value.provider, 'omp');
    assert.strictEqual(result.value.clusterId, null);
    assert.strictEqual(result.value.agentId, null);
    assert.deepStrictEqual(result.value.ompResume, {
      priorOwnerTaskId: id,
      partitionId: partition.partitionId,
      sessionFileName: partition.sessionFileName,
      expectedSessionId: partition.sessionId,
      expectedPartitionIdentity: partition.identity(),
      expectedSessionFileIdentity: partition.sessionFileIdentity(),
      expectedArtifactManifestDigest: DIGEST_MANIFEST,
      expectedExecutionFingerprint: DIGEST_FINGERPRINT,
      expectedSelectedProvider: 'anthropic',
      expectedSelectedModel: '@default',
    });

    // The descriptor a manual resume produces must survive the strict parser the child uses.
    const parsed = await parseDescriptor(JSON.stringify(result.value.ompResume));
    assert.ok(parsed.ok, parsed.error);
  });

  it('refuses a provisional or cleanup-required row rather than guessing', async function () {
    const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'manual-uncommitted-storage-'));
    const workspace = fs.mkdtempSync(path.join(zeroshotHome, 'manual-uncommitted-workspace-'));
    const partition = makeSessionPartition({ storageRoot, cwd: workspace });
    const id = nextTaskId('manual-provisional');
    await seedProvisionalOwner(id, {
      storageRoot,
      workspace,
      partition,
      owner: standaloneOwner(id),
    });

    const result = await buildResumeOptions(id);
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /is 'provisional', not a committed resumable session/);
  });

  it('refuses a task with no OMP ownership record at all', async function () {
    const id = nextTaskId('manual-none');
    await runScript(`
      const { addTask } = await import(${JSON.stringify(storeUrl)});
      addTask({ id: ${JSON.stringify(id)}, status: 'completed', provider: 'omp', cwd: '/tmp' });
    `);
    const result = await buildResumeOptions(id);
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /no valid OMP session ownership record/);
  });
});

describe('agent-side descriptor emission (src/agent/agent-task-executor.js)', function () {
  const { buildTaskRunArgs } = require('../../src/agent/agent-task-executor');

  const PARTITION_ID = '11111111-1111-4111-8111-111111111111';

  function ompAgent(overrides = {}) {
    return {
      id: 'worker-1',
      iteration: 4,
      config: { cwd: '/work' },
      _resolveModelSpecSource: () => 'direct',
      providerSession: {
        provider: 'omp',
        sessionId: 'sess-prior',
        agentId: 'worker-1',
        taskId: 'prior-task-1',
        generation: 3,
        cwd: '/work',
        worktreePath: null,
        contextSequence: '1',
        guidanceSequence: null,
        promptIdentity: `sha256:${'c'.repeat(64)}`,
        ompSession: {
          schemaVersion: 1,
          partitionId: PARTITION_ID,
          sessionFileName: '2026-08-02T00-00-00-000Z_sess-prior.jsonl',
          sessionFileIdentity: { device: '2049', inode: '17' },
          artifactManifestDigest: `sha256:${'a'.repeat(64)}`,
          executionFingerprint: `sha256:${'b'.repeat(64)}`,
          selectedProvider: 'anthropic',
          selectedModel: '@default',
        },
      },
      ...overrides,
    };
  }

  function runArgs(agent) {
    return buildTaskRunArgs({
      agent,
      providerName: 'omp',
      modelSpec: { model: '@default' },
      runOutputFormat: 'stream-json',
    });
  }

  it('emits --omp-resume carrying the complete committed tuple, never a bare --resume', function () {
    const args = runArgs(ompAgent());
    const index = args.indexOf('--omp-resume');
    assert.ok(index >= 0, 'OMP must resume through the verified descriptor');
    assert.strictEqual(
      args.includes('--resume'),
      false,
      'a bare session id can never be trusted for OMP'
    );

    const descriptor = JSON.parse(args[index + 1]);
    assert.deepStrictEqual(descriptor, {
      priorOwnerTaskId: 'prior-task-1',
      partitionId: PARTITION_ID,
      sessionFileName: '2026-08-02T00-00-00-000Z_sess-prior.jsonl',
      expectedSessionId: 'sess-prior',
      expectedSessionFileIdentity: { device: '2049', inode: '17' },
      expectedArtifactManifestDigest: `sha256:${'a'.repeat(64)}`,
      expectedExecutionFingerprint: `sha256:${'b'.repeat(64)}`,
      expectedSelectedProvider: 'anthropic',
      expectedSelectedModel: '@default',
    });
    assert.ok(
      !args[index + 1].includes('/'),
      'the descriptor must not carry storage-root or partition paths'
    );
  });

  it('emits the descriptor the strict parser accepts', async function () {
    const args = runArgs(ompAgent());
    const parsed = await parseDescriptor(args[args.indexOf('--omp-resume') + 1]);
    assert.ok(parsed.ok, parsed.error);
  });

  it('emits no resume flag at all when the agent has no reusable OMP session', function () {
    for (const agent of [
      ompAgent({ providerSession: null }),
      // Worktree drift: the snapshot no longer matches this agent's workspace provenance.
      ompAgent({ config: { cwd: '/somewhere/else' } }),
      // Generation drift: the snapshot belongs to a turn other than the immediately preceding one.
      ompAgent({ iteration: 9 }),
      // Docker isolation never reuses a host session partition.
      ompAgent({ isolation: { enabled: true } }),
    ]) {
      const args = runArgs(agent);
      assert.strictEqual(args.includes('--omp-resume'), false);
      assert.strictEqual(args.includes('--resume'), false);
    }
  });
});
