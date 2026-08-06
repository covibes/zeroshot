import chalk from 'chalk';
import { createRequire } from 'module';
import { getTask } from '../store.js';
import { spawnTask } from '../runner.js';
import { validateOwnedByTask } from '../omp-session-ownership-schema.js';

const require = createRequire(import.meta.url);
const { providerSupportsCapability } = require('../../lib/provider-names.js');

/**
 * Manual standalone resume (`zeroshot task resume <id>`) reuses the *exact* persisted partition
 * under the storage root recorded on the owner row, and asserts the complete committed tuple —
 * including the partition identity, which the cluster path can only learn from the row itself.
 * `state === 'committed'` is required: a provisional or cleanup-required record never durably
 * proved a resumable session, so anything less fails closed to a fresh context.
 *
 * This surface is standalone-only, and refuses a `cluster-agent` owner outright.
 *
 * A cluster-agent lineage belongs to a live agent generation: the committed record is the tail of
 * an `agentId`/`clusterId`/iteration chain whose next turn is spawned by that agent process, and
 * only that process can reach the post-hook boundary where a cluster-agent owner may be committed
 * (agent-lifecycle.js#finalizeProviderSessionAfterCommit). Handing those ids to a detached
 * `zeroshot task resume` would transfer the whole lineage onto a row no parent agent knows about
 * or can ever commit: the prior owner's record is cleared by the transfer, the resumed row stays
 * provisional to the end of time, and the partition becomes unreclaimable while the agent that
 * *should* own the continuation silently falls back to a fresh context. Refusing before spawn is
 * what keeps that lineage intact and resumable by its real owner.
 */
function buildOmpResumeTaskOptions(task) {
  const ownership = validateOwnedByTask(task.ompSessionOwnership, task.id);
  if (!ownership) {
    throw new Error(`Task ${task.id} has no valid OMP session ownership record; refusing resume.`);
  }
  if (ownership.owner.kind !== 'standalone') {
    throw new Error(
      `Task ${task.id} OMP session is owned by cluster agent ${ownership.owner.clusterId}/${ownership.owner.agentId}; manual resume is standalone-only. Let the owning agent continue it.`
    );
  }
  if (ownership.state !== 'committed' || !ownership.session || !ownership.partitionIdentity) {
    throw new Error(
      `Task ${task.id} OMP session ownership is '${ownership.state}', not a committed resumable session; refusing resume.`
    );
  }
  return {
    cwd: ownership.canonicalWorkspace,
    provider: task.provider,
    storageRoot: ownership.storageRoot,
    // A standalone owner carries null cluster/agent ids by schema, so the resumed row is
    // standalone too. They are passed explicitly rather than omitted so this stays an exact
    // lineage copy of the record above, not an inference.
    clusterId: ownership.owner.clusterId,
    agentId: ownership.owner.agentId,
    ompResume: {
      priorOwnerTaskId: task.id,
      partitionId: ownership.partitionId,
      sessionFileName: ownership.session.fileName,
      expectedSessionId: ownership.session.sessionId,
      expectedPartitionIdentity: ownership.partitionIdentity,
      expectedSessionFileIdentity: ownership.session.fileIdentity,
      expectedArtifactManifestDigest: ownership.session.artifactManifestDigest,
      expectedExecutionFingerprint: ownership.session.executionFingerprint,
      expectedSelectedProvider: ownership.session.selectedProvider,
      expectedSelectedModel: ownership.session.selectedModel,
    },
  };
}

export function buildResumeTaskOptions(task) {
  if (!providerSupportsCapability(task.provider, 'sessionResume')) {
    throw new Error(`Provider ${task.provider} does not support safe session resume.`);
  }
  if (task.provider === 'omp') {
    return buildOmpResumeTaskOptions(task);
  }
  if (
    task.requestedResumeSessionId &&
    (task.status !== 'completed' || task.resumeIdentityVerified !== true)
  ) {
    throw new Error(
      `Task ${task.id} did not durably verify its requested provider session; refusing resume.`
    );
  }
  if (!task.sessionId) {
    throw new Error(
      `Task ${task.id} has no captured provider session ID; refusing cwd-wide continuation.`
    );
  }
  return {
    cwd: task.cwd,
    resume: task.sessionId,
    provider: task.provider,
  };
}

export async function resumeTask(taskId, newPrompt) {
  const task = getTask(taskId);

  if (!task) {
    console.log(chalk.red(`Task not found: ${taskId}`));
    process.exit(1);
  }

  if (task.status === 'running') {
    console.log(
      chalk.yellow(`Task is still running. Use 'zeroshot logs -f ${taskId}' to follow output.`)
    );
    return;
  }

  const prompt = newPrompt || 'Continue from where you left off. Complete the task.';

  console.log(chalk.dim(`Resuming task ${taskId}...`));
  console.log(chalk.dim(`Original prompt: ${task.prompt}`));
  console.log(chalk.dim(`Resume prompt: ${prompt}`));

  const newTask = await spawnTask(prompt, buildResumeTaskOptions(task));

  console.log(chalk.green(`\n✓ Resumed as new task: ${chalk.cyan(newTask.id)}`));
  console.log(chalk.dim(`  PID: ${newTask.pid}`));
  console.log(chalk.dim(`  Log: ${newTask.logFile}`));

  console.log(chalk.dim('\nCommands:'));
  console.log(chalk.dim(`  zeroshot logs -f ${newTask.id}   # Follow output`));
  console.log();

  return newTask;
}
