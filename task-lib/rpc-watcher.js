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
 *
 * OMP session ownership (issue #866) is driven from here:
 *   before spawn   resume partitions are fully verified against the complete committed tuple
 *   at `ready`     re-verified, then the owner-fenced CAS transfer runs *before* the prompt write
 *   at terminal    the materialized session is verified and recorded/committed for the owner kind
 * Any drift, conflict, failure, cancellation, or uncertainty marks the row cleanup-required rather
 * than leaving a partition that a later turn could resume.
 */

import { appendFileSync } from 'fs';
import { basename, resolve as resolvePath } from 'path';
import { getTask, updateTask } from './store.js';
import { createCommandSpecCleanup } from './command-spec-cleanup.js';
import {
  commitOwnership,
  readOwnership,
  recordVerifiedMaterialization,
  retireOmpOwnershipAtTerminalBoundary,
  transferOmpSessionOwnership,
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
const { computeOmpExecutionFingerprint } = require('../src/omp-execution-fingerprint.js');

// No overall task timeout: detached tasks run until the provider produces a terminal frame,
// matching watcher.js's unbounded child.on('close') wait for every other lane.
const NO_TIMEOUT_MS = 2_147_483_647;

const [, , taskId, cwd, logFile, , configJson] = process.argv;
const config = configJson ? JSON.parse(configJson) : {};
const commandSpec = config.commandSpec || {};
const ompSession = config.ompSession || { kind: 'none' };
const ompResumeExpectation = config.ompResumeExpectation || null;
const ompCanonicalWorkspace = config.ompCanonicalWorkspace || null;

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
let ownershipTransferred = false;
let promptCheckpointPassed = false;

function terminateOwnedProviderBoundary(exitObserved = false) {
  if (!spawnEvidence) return true;
  return terminateWatcherProvider(
    { pid: spawnEvidence.pid },
    { exitObserved, platform: process.platform }
  );
}

/** Every failed/cancelled/uncertain terminal boundary in this watcher routes through the shared
 * durable-boundary retirement, so a post-transfer failure leaves the resumed row cleanup-required
 * rather than provisional forever. Idempotent and never throwing, so it cannot itself prevent the
 * task from reaching a terminal status. */
function markOmpCleanupRequiredSafely() {
  retireOmpOwnershipAtTerminalBoundary(taskId, (error) =>
    emergencyLog(
      `[${Date.now()}][OMP-OWNERSHIP] Failed to mark cleanup-required: ${error.message}\n`
    )
  );
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

function identityText(identity) {
  return identity ? `${identity.device}:${identity.inode}` : 'none';
}

/**
 * Compare a verified partition and OMP's reported evidence against the *complete* committed tuple
 * the resume descriptor carries. Every field is compared exactly and in full — never a basename,
 * never a prefix — so a returned session file that merely shares a basename with the requested one,
 * a re-minted session ID, a substituted inode, or an execution-contract change all fail here.
 *
 * `evidence` is null on the pre-spawn pass, where OMP has reported nothing yet; the structural and
 * identity halves still apply. When evidence *is* present this is the pre-prompt checkpoint, so
 * the echoed session identity must be complete (see assertEchoedSessionMatches).
 */
function assertNoResumeDrift(verified, evidence) {
  const expected = ompResumeExpectation;
  const drift = [];

  assertEchoedSessionMatches(evidence, drift, { requireComplete: evidence !== null });

  if (verified.sessionFileName !== expected.sessionFileName) {
    drift.push(`sessionFileName ${verified.sessionFileName} != ${expected.sessionFileName}`);
  }
  if (verified.sessionFilePath !== expected.sessionFilePath) {
    drift.push(`sessionFilePath ${verified.sessionFilePath} != ${expected.sessionFilePath}`);
  }
  if (
    identityText(verified.partitionIdentity) !== identityText(expected.expectedPartitionIdentity)
  ) {
    drift.push(
      `partitionIdentity ${identityText(verified.partitionIdentity)} != ${identityText(expected.expectedPartitionIdentity)}`
    );
  }
  if (
    identityText(verified.sessionFileIdentity) !==
    identityText(expected.expectedSessionFileIdentity)
  ) {
    drift.push(
      `sessionFileIdentity ${identityText(verified.sessionFileIdentity)} != ${identityText(expected.expectedSessionFileIdentity)}`
    );
  }
  if (verified.artifactManifestDigest !== expected.expectedArtifactManifestDigest) {
    drift.push('artifactManifestDigest');
  }
  // The session ID written into the transcript header is the on-disk truth about which session
  // this file is; a partition whose header names a different session is not the recorded one.
  if (verified.sessionHeader.sessionId !== expected.expectedSessionId) {
    drift.push(
      `header sessionId ${verified.sessionHeader.sessionId} != ${expected.expectedSessionId}`
    );
  }
  if (
    verified.sessionHeader.cwd !== null &&
    verified.sessionHeader.cwd !== expected.canonicalWorkspace
  ) {
    drift.push(`header cwd ${verified.sessionHeader.cwd} != ${expected.canonicalWorkspace}`);
  }

  if (drift.length > 0) {
    throw new Error(`OMP resume verification detected drift: ${drift.join('; ')}.`);
  }
}

/**
 * The half of the resume check that stays valid for the whole turn: what OMP itself says about the
 * session it opened, plus the execution contract it is running under.
 *
 * Split out from the structural half because `session_info_update` (a builtin slash-command side
 * channel, docs/rpc.md) re-fires the driver's `ready` hook *after* the prompt, by which point the
 * transcript has legitimately grown — re-running the manifest/inode comparison there would reject
 * a perfectly healthy turn. The identity and fingerprint comparisons below have no such staleness,
 * so a mid-turn switch to a different session or a changed model/thinking level is still caught.
 *
 * `requireComplete` is the difference between the two callers, and it is the difference between
 * "OMP agreed it opened exactly this session" and "OMP declined to say".
 *
 * At the pre-prompt checkpoint of a resume it is set, and both echoed values must be present and
 * exactly equal: the full session ID and the full absolute session file. Without it, a `get_state`
 * that simply omits `sessionId` (or `sessionFile`) would transfer a committed lineage and receive
 * the prompt on the strength of the *disk* alone — and disk state cannot answer the only question
 * that matters here, which is which session the running OMP process actually attached to. A prefix
 * is never enough either: OMP resolves `--resume` IDs by prefix (session-manager.ts), so a shorter
 * echoed ID is precisely the ambiguity this check exists to reject.
 *
 * `session_info_update` passes leave it unset: those frames legitimately carry only a subset
 * (docs/rpc.md), and the driver merges them onto evidence whose complete form this checkpoint has
 * already proven, so a partial later frame is checked against that proof rather than replacing it.
 */
function assertEchoedSessionMatches(evidence, drift, { requireComplete = false } = {}) {
  if (!evidence) return;
  const expected = ompResumeExpectation;

  if (requireComplete) {
    if (!evidence.sessionId) {
      drift.push('OMP reported no sessionId at the pre-prompt checkpoint');
    }
    if (!evidence.sessionFile) {
      drift.push('OMP reported no sessionFile at the pre-prompt checkpoint');
    }
  }

  if (evidence.selectedProvider !== expected.expectedSelectedProvider) {
    drift.push(
      `selectedProvider ${evidence.selectedProvider} != ${expected.expectedSelectedProvider}`
    );
  }
  if (evidence.selectedModel !== expected.expectedSelectedModel) {
    drift.push(`selectedModel ${evidence.selectedModel} != ${expected.expectedSelectedModel}`);
  }
  // Zeroshot selector / thinking / config-overlay / pinned-OMP-version drift, in one digest.
  const fingerprint = computeOmpExecutionFingerprint({
    expectedVersion: OMP_SUPPORTED_VERSION,
    commandSpec,
    evidence,
  });
  if (fingerprint !== expected.expectedExecutionFingerprint) {
    drift.push('executionFingerprint');
  }
  // OMP echoes the session it actually opened. Require the full path and the full ID, so a
  // different file under the same directory — or a session whose ID merely starts the same —
  // cannot be finalized in place of the requested one.
  if (evidence.sessionId !== null && evidence.sessionId !== expected.expectedSessionId) {
    drift.push(`echoed sessionId ${evidence.sessionId} != ${expected.expectedSessionId}`);
  }
  if (
    evidence.sessionFile !== null &&
    resolvePath(evidence.sessionFile) !== expected.sessionFilePath
  ) {
    drift.push(`echoed sessionFile ${evidence.sessionFile} != ${expected.sessionFilePath}`);
  }
}

/** Identity/fingerprint-only re-check for `ready` hooks that fire after the prompt. */
function assertNoEchoedResumeDrift(evidence) {
  const drift = [];
  assertEchoedSessionMatches(evidence, drift);
  if (drift.length > 0) {
    throw new Error(`OMP resume verification detected drift: ${drift.join('; ')}.`);
  }
}

/** Full structural verification of an existing (resume) partition against the recorded tuple.
 * Runs twice by design: once before spawn (fail fast, never start OMP against a doomed partition)
 * and again from the onSession('ready') hook right before the prompt is sent (closes the window
 * between spawn and OMP actually opening the file). */
function verifyResumeSession(evidence) {
  const verified = verifyExistingOmpPartition(
    ompResumeExpectation.partitionPath,
    ompResumeExpectation.sessionFileName,
    { expectedPartitionIdentity: ompResumeExpectation.expectedPartitionIdentity }
  );
  assertNoResumeDrift(verified, evidence);
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
 * Owner-fenced ownership transfer, run from the `ready` hook after re-verification and strictly
 * before the prompt command is written. One transaction moves the prior committed owner's lineage
 * onto this task's provisional row and clears the prior row, so the partition never has two
 * committed owners.
 *
 * From here to this turn's own success boundary the partition has *no* committed owner at all —
 * the authoritative live claimant is this still-`provisional` row, by design, and every partition
 * fence is written for that (see findAuthoritativeOwnersForPartition). A transfer that does not
 * apply (the prior owner moved, this row already advanced) throws, which fails the turn closed
 * through the same cleanup-required path as any other drift: the resumed session is never steered
 * on an unresolved ownership claim, and a turn that dies after the transfer retires the row it now
 * holds rather than stranding the lineage.
 */
function transferResumedOwnershipBeforePrompt() {
  if (ownershipTransferred) return;
  const transferred = transferOmpSessionOwnership({
    fromTaskId: ompResumeExpectation.priorOwnerTaskId,
    toTaskId: taskId,
  });
  if (!transferred) {
    throw new Error(
      `OMP resume: could not transfer ownership of partition ${ompResumeExpectation.partitionId} from task ${ompResumeExpectation.priorOwnerTaskId}; refusing to prompt.`
    );
  }
  ownershipTransferred = true;
  log(
    `[${Date.now()}][OMP-OWNERSHIP] Transferred partition ${ompResumeExpectation.partitionId} from ${ompResumeExpectation.priorOwnerTaskId}\n`
  );
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
    const current = readOwnership(taskId);
    if (!current || current.state !== 'provisional') {
      markOmpCleanupRequiredSafely();
      return;
    }

    const reportedSessionFile = resolvePath(result.session.sessionFile);
    const sessionFileName = basename(reportedSessionFile);
    const expectedPartitionPath = current.partitionPath;
    // The reported session file must live inside *this* task's partition; a session OMP wrote
    // somewhere else is not something this owner may claim.
    if (resolvePath(expectedPartitionPath, sessionFileName) !== reportedSessionFile) {
      throw new Error(
        `OMP reported session file ${reportedSessionFile}, which is not a direct child of ${expectedPartitionPath}.`
      );
    }

    const verified =
      ompSession.kind === 'fresh'
        ? verifyFreshMaterialization(expectedPartitionPath, sessionFileName, {
            expectedPartitionIdentity: current.partitionIdentity,
          })
        : verifyExistingOmpPartition(expectedPartitionPath, sessionFileName, {
            expectedPartitionIdentity: current.partitionIdentity,
          });

    // Descriptor/header verification for a fresh materialization: the transcript's own header must
    // name the session OMP reported and the workspace this task was canonicalized against.
    if (verified.sessionHeader.sessionId !== result.session.sessionId) {
      throw new Error(
        `Materialized session header id ${verified.sessionHeader.sessionId} does not match the reported ${result.session.sessionId}.`
      );
    }
    const expectedWorkspace = ompCanonicalWorkspace || current.canonicalWorkspace;
    if (verified.sessionHeader.cwd !== null && verified.sessionHeader.cwd !== expectedWorkspace) {
      throw new Error(
        `Materialized session header cwd ${verified.sessionHeader.cwd} does not match ${expectedWorkspace}.`
      );
    }
    if (ompSession.kind === 'resume') {
      if (!ownershipTransferred) {
        throw new Error('OMP resume completed without an applied ownership transfer.');
      }
      if (verified.sessionHeader.sessionId !== ompResumeExpectation.expectedSessionId) {
        throw new Error('Resumed session header id drifted from the recorded owner.');
      }
    }

    const executionFingerprint = computeOmpExecutionFingerprint({
      expectedVersion: OMP_SUPPORTED_VERSION,
      commandSpec,
      evidence: result.session,
    });
    const evidence = {
      taskId,
      sessionId: result.session.sessionId,
      sessionFilePath: verified.sessionFilePath,
      partitionIdentity: verified.partitionIdentity,
      sessionFileIdentity: verified.sessionFileIdentity,
      artifactManifestDigest: verified.artifactManifestDigest,
      executionFingerprint,
      selectedProvider: result.session.selectedProvider,
      selectedModel: result.session.selectedModel,
    };
    const advanced =
      current.owner.kind === 'cluster-agent'
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
      // command, so throwing here (drift, an unready fresh partition, or an ownership transfer
      // that did not apply) fails the task closed without ever steering the resumed/fresh session.
      //
      // This hook also re-fires later in the turn for `session_info_update` frames. Those passes
      // re-check only what OMP itself reports (see assertNoEchoedResumeDrift); the structural
      // manifest/inode comparison belongs to the pre-prompt pass alone, because the transcript is
      // supposed to grow once the turn is under way.
      onSession: (evidence) => {
        if (evidence.phase !== 'ready') return;
        if (ompSession.kind === 'fresh') {
          checkPartitionPathReady(ompSession.partition.path);
          return;
        }
        if (ompSession.kind !== 'resume') return;
        if (promptCheckpointPassed) {
          assertNoEchoedResumeDrift(evidence);
          return;
        }
        verifyResumeSession(evidence);
        transferResumedOwnershipBeforePrompt();
        promptCheckpointPassed = true;
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
