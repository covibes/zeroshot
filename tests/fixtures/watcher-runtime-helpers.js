const { spawn } = require('child_process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMessage, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await sleep(20);
  }
  throw new Error(timeoutMessage);
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKill(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already terminal.
  }
}

function forceKillOwnedGroup(pid) {
  if (!pid) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  } catch {
    // Already terminal.
  }
}

function spawnCapturedWatcher(watcherPath, args, options = {}) {
  const child = spawn(process.execPath, [watcherPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  return { child, output: () => output };
}

module.exports = {
  forceKill,
  forceKillOwnedGroup,
  isRunning,
  spawnCapturedWatcher,
  waitFor,
};
