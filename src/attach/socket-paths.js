/**
 * Deterministic attach socket paths.
 *
 * Unix-domain sockets have a small path budget (104 bytes on macOS). Keep the
 * live socket namespace independent from HOME while retaining one namespace
 * per OS user and Zeroshot home.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SOCKET_ROOT = process.platform === 'win32' ? null : '/tmp';
const SOCKET_DIR_MODE = 0o700;

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function userNamespace() {
  if (typeof process.getuid === 'function') {
    return String(process.getuid());
  }
  return shortHash(os.userInfo().username);
}

function resolveHomeDir(env = process.env) {
  return env.ZEROSHOT_HOME || env.HOME || env.USERPROFILE || os.homedir();
}

function getSocketDir(homeDir = resolveHomeDir()) {
  if (process.platform === 'win32') {
    return path.join(homeDir, '.zeroshot', 'sockets');
  }
  return path.join(SOCKET_ROOT, `zeroshot-${userNamespace()}-${shortHash(homeDir)}`);
}

function assertSafeSocketDir(socketDir) {
  const stat = fs.lstatSync(socketDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Attach socket path is not a directory: ${socketDir}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Attach socket directory is not owned by the current user: ${socketDir}`);
  }
}

function ensureOwnedDirectory(socketDir) {
  fs.mkdirSync(socketDir, { recursive: true, mode: SOCKET_DIR_MODE });
  assertSafeSocketDir(socketDir);
  if (process.platform !== 'win32') {
    fs.chmodSync(socketDir, SOCKET_DIR_MODE);
  }
  return socketDir;
}

function ensureSocketDir(homeDir = resolveHomeDir()) {
  const socketDir = getSocketDir(homeDir);
  return ensureOwnedDirectory(socketDir);
}

function getTaskSocketPath(taskId, homeDir = resolveHomeDir()) {
  return path.join(ensureSocketDir(homeDir), `${taskId}.sock`);
}

function getAgentSocketPath(clusterId, agentId, homeDir = resolveHomeDir()) {
  const clusterDir = path.join(ensureSocketDir(homeDir), clusterId);
  ensureOwnedDirectory(clusterDir);
  return path.join(clusterDir, `${agentId}.sock`);
}

function getClusterSocketPath(clusterId, homeDir = resolveHomeDir()) {
  return path.join(ensureSocketDir(homeDir), `${clusterId}.sock`);
}

module.exports = {
  SOCKET_DIR_MODE,
  resolveHomeDir,
  getSocketDir,
  ensureSocketDir,
  getTaskSocketPath,
  getAgentSocketPath,
  getClusterSocketPath,
};
