// Where OMP session partitions live on disk: the owning cluster's storageDir for cluster-agent
// tasks (passed down via env since agent-task-executor.js spawns this CLI as a child process), or
// the standalone TASKS_DIR otherwise. Never derived from prompt text or cwd.
import { TASKS_DIR } from './config.js';

export const OMP_STORAGE_ROOT_ENV = 'ZEROSHOT_OMP_STORAGE_ROOT';
export const OMP_OWNER_CLUSTER_ID_ENV = 'ZEROSHOT_CLUSTER_ID';
export const OMP_OWNER_AGENT_ID_ENV = 'ZEROSHOT_AGENT_ID';

export function resolveOmpStorageRoot(options = {}) {
  return options.storageRoot || process.env[OMP_STORAGE_ROOT_ENV] || TASKS_DIR;
}

/** cluster-agent when both a cluster and agent id are known, standalone otherwise. */
export function resolveOmpOwnerKind(options = {}) {
  const clusterId = options.clusterId || process.env[OMP_OWNER_CLUSTER_ID_ENV] || null;
  const agentId = options.agentId || process.env[OMP_OWNER_AGENT_ID_ENV] || null;
  if (clusterId && agentId) {
    return { kind: 'cluster-agent', clusterId, agentId };
  }
  return { kind: 'standalone', clusterId: null, agentId: null };
}
