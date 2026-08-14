import crypto = require('crypto');
import fs = require('fs');
import os = require('os');
import path = require('path');

const SOCKET_ROOT = process.platform === 'win32' ? null : path.resolve(os.tmpdir());
const SOCKET_DIR_MODE = 0o700;

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function userNamespace(): string {
  if (typeof process.getuid === 'function') {
    return String(process.getuid());
  }
  return shortHash(os.userInfo().username);
}

function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZEROSHOT_HOME || env.HOME || env.USERPROFILE || os.homedir();
}

function getSocketDir(homeDir = resolveHomeDir()): string {
  if (SOCKET_ROOT === null) {
    return path.join(homeDir, '.zeroshot', 'sockets');
  }
  return path.join(SOCKET_ROOT, `zeroshot-${userNamespace()}-${shortHash(homeDir)}`);
}

function assertSafeSocketDir(socketDir: string): void {
  const stat = fs.lstatSync(socketDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Attach socket path is not a directory: ${socketDir}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Attach socket directory is not owned by the current user: ${socketDir}`);
  }
}

function ensureOwnedDirectory(socketDir: string): string {
  fs.mkdirSync(socketDir, { recursive: true, mode: SOCKET_DIR_MODE });
  assertSafeSocketDir(socketDir);
  if (process.platform !== 'win32') {
    fs.chmodSync(socketDir, SOCKET_DIR_MODE);
  }
  return socketDir;
}

function ensureSocketDir(homeDir = resolveHomeDir()): string {
  const socketDir = getSocketDir(homeDir);
  return ensureOwnedDirectory(socketDir);
}

function getTaskSocketPath(taskId: string, homeDir = resolveHomeDir()): string {
  return path.join(ensureSocketDir(homeDir), `${taskId}.sock`);
}

function getAgentSocketPath(
  clusterId: string,
  agentId: string,
  homeDir = resolveHomeDir()
): string {
  const clusterDir = path.join(ensureSocketDir(homeDir), clusterId);
  ensureOwnedDirectory(clusterDir);
  return path.join(clusterDir, `${agentId}.sock`);
}

function getClusterSocketPath(clusterId: string, homeDir = resolveHomeDir()): string {
  return path.join(ensureSocketDir(homeDir), `${clusterId}.sock`);
}

export = {
  SOCKET_DIR_MODE,
  resolveHomeDir,
  getSocketDir,
  ensureSocketDir,
  getTaskSocketPath,
  getAgentSocketPath,
  getClusterSocketPath,
};
