/**
 * Socket Discovery - Utilities for socket path management
 *
 * Socket locations are allocated by socket-paths.js under a short, per-user
 * runtime directory so long HOME paths cannot exceed Unix socket limits.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import socketPaths from './socket-paths';

interface ClustersRegistryModule {
  readClustersFileSync(storageDir: string): unknown;
}

function isClustersRegistryModule(value: unknown): value is ClustersRegistryModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'readClustersFileSync' in value &&
    typeof value.readClustersFileSync === 'function'
  );
}

const clustersRegistryModule: unknown = require('../../lib/clusters-registry');
if (!isClustersRegistryModule(clustersRegistryModule)) {
  throw new TypeError('clusters registry must export readClustersFileSync');
}
const { readClustersFileSync } = clustersRegistryModule;

const ZEROSHOT_DIR = path.join(socketPaths.resolveHomeDir(), '.zeroshot');
const SOCKET_DIR = socketPaths.getSocketDir();

/** Check if an ID is a known cluster by looking up clusters.json. */
function isKnownCluster(id: string): boolean {
  try {
    const clusters = readClustersFileSync(ZEROSHOT_DIR);
    return typeof clusters === 'object' && clusters !== null && id in clusters;
  } catch {
    return false;
  }
}

/** Ensure socket directory exists. */
function ensureSocketDir(): void {
  socketPaths.ensureSocketDir();
}

/** Get socket path for a task. */
function getTaskSocketPath(taskId: string): string {
  return socketPaths.getTaskSocketPath(taskId);
}

/** Get socket path for a cluster agent. */
function getAgentSocketPath(clusterId: string, agentId: string): string {
  return socketPaths.getAgentSocketPath(clusterId, agentId);
}

/** Get socket path for any ID, auto-detecting task versus cluster. */
function getSocketPath(id: string, agentId: string | null = null): string {
  if (id.startsWith('task-')) {
    return getTaskSocketPath(id);
  }
  // Check for explicit 'cluster-' prefix OR known cluster in registry
  // Cluster IDs are generated without prefix (e.g., 'steady-pulse-42')
  if (id.startsWith('cluster-') || isKnownCluster(id)) {
    if (agentId) {
      return getAgentSocketPath(id, agentId);
    }
    // Cluster-level socket (future use)
    return socketPaths.getClusterSocketPath(id);
  }
  // Unknown format, treat as task
  return getTaskSocketPath(id);
}

/** Check if a socket exists and is connectable. */
function isSocketAlive(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);

    socket.on('connect', () => {
      clearTimeout(timeout);
      socket.end();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/** Remove a stale socket file if it is not connectable. */
async function cleanupStaleSocket(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) {
    return false;
  }

  const alive = await isSocketAlive(socketPath);
  if (!alive) {
    try {
      fs.unlinkSync(socketPath);
      return true;
    } catch {
      // Ignore errors (file may have been removed already)
    }
  }
  return false;
}

/** List task IDs with live sockets. */
async function listAttachableTasks(): Promise<string[]> {
  ensureSocketDir();
  const entries = fs.readdirSync(SOCKET_DIR, { withFileTypes: true });
  const tasks: string[] = [];

  for (const entry of entries) {
    // Check socket files (Unix sockets report isSocket(), not isFile())
    // Also accept regular files for compatibility
    const isSocketFile = (entry.isSocket() || entry.isFile()) && entry.name.endsWith('.sock');
    if (isSocketFile && !entry.isDirectory()) {
      const id = entry.name.slice(0, -5); // Remove .sock

      // Skip cluster-level sockets (cluster-xxx.sock)
      if (id.startsWith('cluster-')) {
        continue;
      }

      const socketPath = path.join(SOCKET_DIR, entry.name);
      if (await isSocketAlive(socketPath)) {
        tasks.push(id);
      }
    }
  }

  return tasks;
}

/** List agent IDs with live sockets for a cluster. */
async function listAttachableAgents(clusterId: string): Promise<string[]> {
  const clusterDir = path.join(SOCKET_DIR, clusterId);
  if (!fs.existsSync(clusterDir)) {
    return [];
  }

  const files = fs.readdirSync(clusterDir);
  const agents: string[] = [];

  for (const file of files) {
    if (file.endsWith('.sock')) {
      const agentId = file.slice(0, -5); // Remove .sock
      const socketPath = path.join(clusterDir, file);
      if (await isSocketAlive(socketPath)) {
        agents.push(agentId);
      }
    }
  }

  return agents;
}

/** List cluster IDs with at least one live agent socket. */
async function listAttachableClusters(): Promise<string[]> {
  ensureSocketDir();
  const entries = fs.readdirSync(SOCKET_DIR, { withFileTypes: true });
  const clusters: string[] = [];

  // Check socket directories (both 'cluster-' prefix and plain cluster IDs)
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Accept directories with 'cluster-' prefix OR that are known clusters
      if (entry.name.startsWith('cluster-') || isKnownCluster(entry.name)) {
        const agents = await listAttachableAgents(entry.name);
        if (agents.length > 0) {
          clusters.push(entry.name);
        }
      }
    }
  }

  return clusters;
}

/** Cleanup all sockets for a cluster when it stops. */
function cleanupClusterSockets(clusterId: string): void {
  const clusterDir = path.join(SOCKET_DIR, clusterId);
  if (fs.existsSync(clusterDir)) {
    const files = fs.readdirSync(clusterDir);
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(clusterDir, file));
      } catch {
        // Ignore
      }
    }
    try {
      fs.rmdirSync(clusterDir);
    } catch {
      // Ignore
    }
  }
}

export = {
  ZEROSHOT_DIR,
  SOCKET_DIR,
  ensureSocketDir,
  getTaskSocketPath,
  getAgentSocketPath,
  getSocketPath,
  isSocketAlive,
  cleanupStaleSocket,
  listAttachableTasks,
  listAttachableAgents,
  listAttachableClusters,
  cleanupClusterSockets,
  isKnownCluster,
};
