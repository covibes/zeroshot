#!/usr/bin/env node

/**
 * Watcher process for the rpc-stdio invoke lane (OMP RPC v2). Runs detached from the parent,
 * drives the session over stdio via the shared runOmpRpcTask driver (task-lib/runner.js resolves
 * this script instead of watcher.js whenever the resolved provider's invoke.lane is 'rpc-stdio'),
 * and updates task status on completion. Foreground (contract-invoke.ts) and this detached watcher
 * both call runOmpRpcTask and therefore produce identical result semantics; the only difference is
 * that this watcher persists OmpRpcSpawnEvidence via updateTask before the prompt is written.
 *
 * The prompt itself never appears in argv (`ps` and /proc/<pid>/cmdline would expose it for as long
 * as this watcher lives). task-lib/runner.js sends it over the private stdin pipe described in
 * src/watcher-prompt-channel.js, and OMP is not spawned until a complete payload has arrived.
 */

import { appendFileSync } from 'fs';
import { basename } from 'path';
import { getTask, updateTask } from './store.js';
import { createCommandSpecCleanup } from './command-spec-cleanup.js';
import {
  commitOwnership,
  computeExecutionFingerprint,
  markCleanupRequired,
  readOwnership,
  recordVerifiedMaterialization,
} from './omp-session-ownership.js';
import {
  completeWatcherFailure,
  completePendingWatcherCancellation,
  completeWatcherTask,
  createRpcWatcherOutputRuntime,
  terminateWatcherProvider,
} from './watcher-output-runtime.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  ABORT_GRACE_MS,
  DEFAULT_OMP_RPC_DECODER_LIMITS,
  EXIT_GRACE_MS,
  OMP_SUPPORTED_VERSION,
  runOmpRpcTask,
} = require('./provider-helper-runtime.js');
const { receiveWatcherPrompt } = require('../src/watcher-prompt-channel.js');
const {
  checkPartitionPathReady,
  verifyExistingOmpPartition,
  verifyFreshMaterialization,
} = require('../src/omp-session-verifier.js');

// No overall task timeout: detached tasks run until the provider produces a terminal frame,
// matching watcher.js's unbounded child.on('close') wait for every other lane.
const NO_TIMEOUT_MS = 2_147_483_647;

const [, , taskId, cwd, logFile, , configJson] = process.argv;
const config = configJson ? JSON.parse(configJson) : {};
const commandSpec = config.commandSpec || {};
const ompSession = config.ompSession || { kind: 'none' };
const ompResumeExpectation = config.ompResumeExpectation || null;

function log(msg) {
  appendFileSync(logFile, msg);
}

function emergencyLog(msg) {
  try {
    log(msg);
  } catch {
    process.stderr.write(msg);
  }
}

const commandCleanup = createCommandSpecCleanup(commandSpec, (cleanupPath, error) => {
  emergencyLog(`[${Date.now()}][CLEANUP] Failed to delete ${cleanupPath}: ${error.message}\n`);
});

const outputRuntime = createRpcWatcherOutputRuntime({ log });

let crashStarted = false;
let spawnEvidence = null;

function terminateOwnedProviderBoundary(exitObserved = false) {
  if (!spawnEvidence) return true;
  return terminateWatcherProvider(
    { pid: spawnEvidence.pid },
    { exitObserved, platform: process.platform }
  );
}

function markOmpCleanupRequiredSafely() {
  try {
    markCleanupRequired(taskId);
  } catch (error) {
    emergencyLog(
      `[${Date.now()}][OMP-OWNERSHIP] Failed to mark cleanup-required: ${error.message}\n`
    );
  }
}

async function crashWithError(error, source) {
  if (crashStarted) return;
  crashStarted = true;
  markOmpCleanupRequiredSafely();
  await completeWatcherFailure({
    taskId,
    error,
    source,
    commandCleanup,
    terminateProvider: terminateOwnedProviderBoundary,
    updateTask,
    emergencyLog,
  });
  process.exit(1);
}

/** Full structural verification of an existing (resume) partition, throwing on any drift from
 * the caller-supplied expectation. Runs twice by design: once before spawn (fail fast, never
 * start OMP against a doomed partition) and again from the onSession('ready') hook right before
 * the prompt is sent (closes the TOCTOU window between spawn and OMP actually opening the file).
 */
function verifyResumeSession(evidence) {
  const verified = verifyExistingOmpPartition(
    ompSession.partition.path,
    basename(ompSession.file.path)
  );
  if (!ompResumeExpectation) return verified;
  const identityMatches =
    verified.sessionFileIdentity.device ===
      ompResumeExpectation.expectedSessionFileIdentity?.device &&
    verified.sessionFileIdentity.inode === ompResumeExpectation.expectedSessionFileIdentity?.inode;
  const manifestMatches =
    verified.artifactManifestDigest === ompResumeExpectation.expectedArtifactManifestDigest;
  const selectorMatches =
    evidence === null ||
    (evidence.selectedProvider === ompResumeExpectation.expectedSelectedProvider &&
      evidence.selectedModel === ompResumeExpectation.expectedSelectedModel);
  if (!identityMatches || !manifestMatches || !selectorMatches) {
    throw new Error(
      `OMP resume verification detected drift (identity=${identityMatches}, manifest=${manifestMatches}, selector=${selectorMatches}); refusing to resume.`
    );
  }
  return verified;
}

function verifyOmpSessionBeforeSpawn() {
  if (ompSession.kind === 'none') return;
  if (ompSession.kind === 'fresh') {
    checkPartitionPathReady(ompSession.partition.path);
    return;
  }
  verifyResumeSession(null);
}

/**
 * Terminal OMP ownership boundary. Standalone owners have no parent process left to consult — the
 * watcher itself is the terminal boundary, so a materialized/verified session commits directly.
 * Cluster-agent owners are different: the spawning agent (agent-lifecycle.js, a *different*
 * process) still has to validate this turn's logical/schema output and run its onComplete hook, so
 * the watcher only records the owner-fenced verified evidence here and leaves the state
 * 'provisional'; commitRecordedOwnership() advances it to 'committed' from that later boundary.
 * Every failed/cancelled/uncertain path — including a still-provisional record after a supposedly
 * successful commit/record call — falls through to cleanup-required.
 */
function finalizeOmpOwnership(completion, result) {
  if (ompSession.kind === 'none') return;
  try {
    if (
      completion.status !== 'completed' ||
      !result.session?.sessionId ||
      !result.session?.sessionFile
    ) {
      markOmpCleanupRequiredSafely();
      return;
    }
    const sessionFileName = basename(result.session.sessionFile);
    const verified =
      ompSession.kind === 'fresh'
        ? verifyFreshMaterialization(ompSession.partition.path, sessionFileName)
        : verifyExistingOmpPartition(ompSession.partition.path, sessionFileName);
    const executionFingerprint = computeExecutionFingerprint({
      expectedVersion: OMP_SUPPORTED_VERSION,
      selectedProvider: result.session.selectedProvider,
      selectedModel: result.session.selectedModel,
      thinkingLevel: result.session.thinkingLevel,
    });
    const evidence = {
      taskId,
      sessionId: result.session.sessionId,
      sessionFilePath: verified.sessionFilePath,
      artifactManifestDigest: verified.artifactManifestDigest,
      executionFingerprint,
      selectedProvider: result.session.selectedProvider,
      selectedModel: result.session.selectedModel,
    };
    const ownerKind = readOwnership(taskId)?.owner?.kind;
    const advanced =
      ownerKind === 'cluster-agent'
        ? recordVerifiedMaterialization(evidence)
        : commitOwnership(evidence);
    if (!advanced) markOmpCleanupRequiredSafely();
  } catch (error) {
    emergencyLog(`[${Date.now()}][OMP-OWNERSHIP] Terminal verification failed: ${error.message}\n`);
    markOmpCleanupRequiredSafely();
  }
}

process.on('uncaughtException', (error) => {
  void crashWithError(error, 'uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  void crashWithError(reason, 'unhandledRejection');
});

async function run() {
  if (
    await completePendingWatcherCancellation({
      taskId,
      getTask,
      commandCleanup,
      terminateProvider: () => true,
      updateTask,
      emergencyLog,
    })
  ) {
    markOmpCleanupRequiredSafely();
    process.exit(0);
    return;
  }

  // Fail closed before any provider process exists: an absent, truncated, over-contract, or
  // early-closed prompt channel must end the task through the same ownership-aware cleanup path as
  // any other crash, never spawn OMP with a partial instruction. The 1 MiB ceiling is the pinned
  // physical RPC frame limit — a larger prompt could never be written as a `prompt` command anyway.
  let prompt;
  try {
    prompt = await receiveWatcherPrompt(process.stdin, {
      maxBytes: DEFAULT_OMP_RPC_DECODER_LIMITS.maxPhysicalFrameBytes,
    });
  } catch (error) {
    await crashWithError(error, 'prompt-channel');
    return;
  }

  // Two-phase verification, checkpoint 1 (before spawn): a resume partition/file that is missing,
  // over bounds, non-regular, or already drifted from what the owner recorded must never see OMP
  // spawned at all. Fresh sessions have nothing to verify yet — checkpoint 1 for them is the
  // partition-path sanity check at the 'ready' onSession hook below.
  try {
    verifyOmpSessionBeforeSpawn();
  } catch (error) {
    await crashWithError(error, 'omp-session-verify-before-spawn');
    return;
  }

  const controller = new AbortController();

  const result = await runOmpRpcTask(
    {
      commandSpec: { ...commandSpec, cwd: commandSpec.cwd || cwd },
      prompt,
      expectedVersion: OMP_SUPPORTED_VERSION,
      session: ompSession,
      signal: controller.signal,
      timeoutMs: NO_TIMEOUT_MS,
      abortGraceMs: ABORT_GRACE_MS,
      exitGraceMs: EXIT_GRACE_MS,
    },
    {
      onSpawn: async (evidence) => {
        spawnEvidence = evidence;
        await updateTask(taskId, {
          pid: evidence.pid,
          processGroupId: evidence.processGroupId,
          terminationStrategy: evidence.terminationStrategy,
        });
        if (getTask(taskId)?.cancelRequested) {
          crashStarted = true;
          controller.abort();
          markOmpCleanupRequiredSafely();
          await completePendingWatcherCancellation({
            taskId,
            getTask,
            commandCleanup,
            terminateProvider: terminateOwnedProviderBoundary,
            updateTask,
            emergencyLog,
          });
          process.exit(0);
        }
      },
      onEvent: (event) => {
        outputRuntime.logEvent(event);
        return Promise.resolve();
      },
      // Checkpoint 2 (before prompt): the driver awaits this hook before sending the `prompt`
      // command, so throwing here (drift, or an unready fresh partition) fails the task closed
      // without ever steering the resumed/fresh session.
      onSession: (evidence) => {
        if (evidence.phase !== 'ready') return;
        if (ompSession.kind === 'fresh') {
          checkPartitionPathReady(ompSession.partition.path);
        } else if (ompSession.kind === 'resume') {
          verifyResumeSession(evidence);
        }
      },
    }
  );

  if (crashStarted) return; // Cancelled mid-spawn; the onSpawn hook already exited the process.

  const completion = outputRuntime.complete(result);
  finalizeOmpOwnership(completion, result);
  await completeWatcherTask({
    taskId,
    completion,
    commandCleanup,
    terminateProvider: () => terminateOwnedProviderBoundary(true),
    updateTask,
    emergencyLog,
  });
  process.exit(0);
}

run().catch((error) => {
  void crashWithError(error, 'run');
});
