const base = require('./omp-rpc-watcher-harness');
const { makeBlobStore, makeSessionPartition } = require('./omp-session-fixtures');
const { verifyExistingOmpPartition } = require('../../src/omp-session-verifier');
const { computeOmpExecutionFingerprint } = require('../../src/omp-execution-fingerprint');
const {
  generateOmpPartitionId,
  partitionPathFor,
  createOmpSessionPartitionDirectory,
} = require('../../src/omp-session-partition');
const { OMP_SUPPORTED_VERSION } = require('../../lib/agent-cli-provider/omp/release.js');
const {
  FAKE_OMP_RPC_PATH,
  assert,
  buildCommandSpec,
  commitOwnershipFor,
  createOmpConfigOverlay,
  fs,
  nextTaskId,
  path,
  runWatcher,
  seedTask,
  storeGetTask,
  writeProvisionalOwnershipFor,
  zeroshotHome,
} = base;

/** Ready-hook failures race between a failed-result exit 0 and a crash-handler exit 1. Assert the
 * durable failure contract rather than the scheduler-dependent exit path.
 */
function assertFailedBeforePrompt({ code, task, promptSink, errorPattern }) {
  assert.ok(code === 0 || code === 1, `watcher must terminate, got exit ${code}`);
  assert.strictEqual(task.status, 'failed');
  assert.match(task.error, errorPattern);
  assert.strictEqual(task.ompSessionOwnership.state, 'cleanup-required');
  if (promptSink !== undefined) {
    assert.strictEqual(
      fs.existsSync(promptSink),
      false,
      'OMP must never receive the prompt once the pre-prompt checks have failed'
    );
  }
}

function freshCommandSpec(overlay, partitionPath, cwd) {
  return buildCommandSpec(overlay, {
    args: [
      FAKE_OMP_RPC_PATH,
      '--mode',
      'rpc',
      '--session-dir',
      partitionPath,
      '--model',
      '@default',
      '--thinking',
      'medium',
      '--approval-mode',
      'yolo',
    ],
    ...(cwd ? { cwd } : {}),
  });
}

function resumeCommandSpec(overlay, partitionPath, sessionFilePath, cwd) {
  return buildCommandSpec(overlay, {
    args: [
      FAKE_OMP_RPC_PATH,
      '--mode',
      'rpc',
      '--session-dir',
      partitionPath,
      '--resume',
      sessionFilePath,
      '--model',
      '@default',
      '--thinking',
      'medium',
      '--approval-mode',
      'yolo',
    ],
    ...(cwd ? { cwd } : {}),
  });
}

function fingerprintFor(commandSpec, evidence = {}) {
  return computeOmpExecutionFingerprint({
    expectedVersion: OMP_SUPPORTED_VERSION,
    commandSpec,
    evidence: {
      selectedProvider: 'anthropic',
      selectedModel: '@default',
      thinkingLevel: 'medium',
      ...evidence,
    },
  });
}

async function prepareFreshCase({ label, storagePrefix = 'omp-storage-', workspacePrefix, owner }) {
  const id = nextTaskId(label);
  const overlay = createOmpConfigOverlay();
  const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, storagePrefix));
  const cwd = workspacePrefix
    ? fs.mkdtempSync(path.join(zeroshotHome, workspacePrefix))
    : undefined;
  const partitionId = generateOmpPartitionId();
  const partitionPath = partitionPathFor(storageRoot, partitionId);
  createOmpSessionPartitionDirectory(partitionPath);
  const commandSpec = freshCommandSpec(overlay, partitionPath, cwd);
  const canonicalWorkspace = cwd ?? commandSpec.cwd;
  const selectedOwner =
    typeof owner === 'function'
      ? owner(id)
      : (owner ?? { kind: 'standalone', clusterId: null, agentId: null, taskId: id });

  await seedTask(id, commandSpec);
  await writeProvisionalOwnershipFor(id, {
    partitionId,
    storageRoot,
    cwd: canonicalWorkspace,
    owner: selectedOwner,
  });
  return {
    id,
    overlay,
    storageRoot,
    cwd: canonicalWorkspace,
    partitionId,
    partitionPath,
    commandSpec,
  };
}

/** Seed the row + provisional ownership for a fresh turn and return the allocated partition. */
async function seedFreshOwner(id, { storageRoot, cwd, owner, commandSpec }) {
  const partitionId = generateOmpPartitionId();
  const partitionPath = partitionPathFor(storageRoot, partitionId);
  createOmpSessionPartitionDirectory(partitionPath);
  await seedTask(id, commandSpec);
  await writeProvisionalOwnershipFor(id, { partitionId, storageRoot, cwd, owner });
  return { partitionId, partitionPath };
}

/**
 * Seed a *prior* committed owner over a materialized partition, plus the resumed task's own
 * provisional row, and return the complete resume expectation the watcher receives — exactly
 * what task-lib/runner.js#resolveOmpResumeExpectation derives from the persisted record.
 */
async function seedResumeLineage({
  priorId,
  resumedId,
  storageRoot,
  cwd,
  commandSpec,
  partition,
  owner = (taskId) => ({ kind: 'standalone', clusterId: null, agentId: null, taskId }),
  expectationOverrides = {},
}) {
  const verified = verifyExistingOmpPartition(partition.partitionPath, partition.sessionFileName);
  const executionFingerprint = fingerprintFor(commandSpec);

  await seedTask(priorId, commandSpec);
  await writeProvisionalOwnershipFor(priorId, {
    partitionId: partition.partitionId,
    storageRoot,
    cwd,
    owner: owner(priorId),
  });
  await commitOwnershipFor(priorId, {
    sessionId: partition.sessionId,
    sessionFilePath: partition.sessionFilePath,
    artifactManifestDigest: verified.artifactManifestDigest,
    executionFingerprint,
  });

  await seedTask(resumedId, commandSpec);
  await writeProvisionalOwnershipFor(resumedId, {
    partitionId: partition.partitionId,
    storageRoot,
    cwd,
    owner: owner(resumedId),
  });

  return {
    verified,
    expectation: {
      priorOwnerTaskId: priorId,
      partitionId: partition.partitionId,
      partitionPath: partition.partitionPath,
      canonicalWorkspace: cwd,
      sessionFileName: partition.sessionFileName,
      sessionFilePath: partition.sessionFilePath,
      expectedSessionId: partition.sessionId,
      expectedPartitionIdentity: verified.partitionIdentity,
      expectedSessionFileIdentity: verified.sessionFileIdentity,
      expectedArtifactManifestDigest: verified.artifactManifestDigest,
      expectedExecutionFingerprint: executionFingerprint,
      expectedSelectedProvider: 'anthropic',
      expectedSelectedModel: '@default',
      ...expectationOverrides,
    },
  };
}

async function prepareResumeCase({ label, partitionOptions = {}, expectationOverrides = {} }) {
  const priorId = nextTaskId(`${label}-prior`);
  const resumedId = nextTaskId(label);
  const overlay = createOmpConfigOverlay();
  const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
  const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
  const partition = makeSessionPartition({ ...partitionOptions, storageRoot, cwd });
  const commandSpec = resumeCommandSpec(
    overlay,
    partition.partitionPath,
    partition.sessionFilePath,
    cwd
  );
  const lineage = await seedResumeLineage({
    priorId,
    resumedId,
    storageRoot,
    cwd,
    commandSpec,
    partition,
    expectationOverrides,
  });
  return {
    priorId,
    resumedId,
    overlay,
    storageRoot,
    cwd,
    partition,
    commandSpec,
    ...lineage,
  };
}

async function runEchoCase({ label, env, errorPattern, decoyPartition = false }) {
  const { priorId, resumedId, cwd, partition, commandSpec, expectation } = await prepareResumeCase({
    label: `resume-echo-${label}`,
  });
  // A wholly different partition's transcript, for the "OMP opened some other session"
  // case. It lives outside this partition, so the artifact manifest is untouched and the
  // only thing that can fail is the echoed identity itself.
  const other = decoyPartition
    ? makeSessionPartition({
        storageRoot: fs.mkdtempSync(path.join(zeroshotHome, 'omp-other-storage-')),
        cwd,
      })
    : null;
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
      OMP_FAKE_RPC_PROMPT_SINK: promptSink,
      ...env({ partition, other }),
    },
  });

  const resumed = await storeGetTask(resumedId);
  assertFailedBeforePrompt({ code, task: resumed, promptSink, errorPattern });
  const prior = await storeGetTask(priorId);
  assert.strictEqual(
    prior.ompSessionOwnership.state,
    'committed',
    'the lineage stays with its prior owner: no transfer may happen without agreement'
  );
  assert.ok(
    fs.existsSync(partition.partitionPath),
    'the still-resumable session survives a refused continuation'
  );
}

module.exports = {
  ...base,
  assertFailedBeforePrompt,
  createOmpSessionPartitionDirectory,
  generateOmpPartitionId,
  fingerprintFor,
  prepareFreshCase,
  freshCommandSpec,
  makeBlobStore,
  makeSessionPartition,
  partitionPathFor,
  resumeCommandSpec,
  prepareResumeCase,
  runEchoCase,
  seedFreshOwner,
  seedResumeLineage,
  verifyExistingOmpPartition,
};
