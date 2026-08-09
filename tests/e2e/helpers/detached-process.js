const { runZeroshot } = require('./e2e-harness');

function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitUntil(description, probe, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${description} was not observed within ${timeoutMs}ms`);
}

async function pollCliStatus(env, clusterId, predicate, timeoutMs = 10_000) {
  let diagnostic = '';
  try {
    return await waitUntil(
      `status predicate for ${clusterId}`,
      () => {
        const result = runZeroshot(env, ['status', clusterId, '--json']);
        diagnostic = result.stderr || result.stdout;
        if (result.status !== 0) return null;
        const status = JSON.parse(result.stdout);
        return predicate(status) ? status : null;
      },
      timeoutMs,
      75
    );
  } catch (error) {
    throw new Error(`${error.message}: ${diagnostic}`);
  }
}

function waitForPidExit(pid, timeoutMs = 10_000) {
  return waitUntil(`daemon pid ${pid} exit`, () => !pidExists(pid), timeoutMs, 50);
}

async function terminateDetachedDaemon(pid) {
  if (!pidExists(pid)) return;
  const target = process.platform === 'win32' ? pid : -pid;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(target, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        return;
      }
    }
    try {
      await waitForPidExit(pid, 2_000);
      return;
    } catch {
      // Escalate once from a graceful stop to a forced stop.
    }
  }
}

module.exports = { pidExists, pollCliStatus, waitForPidExit, terminateDetachedDaemon };
