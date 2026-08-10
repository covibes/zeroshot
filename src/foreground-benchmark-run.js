const { buildBenchmarkResult, buildCancelledResult } = require('./foreground-benchmark-result');
const { writeBenchmarkResultBundle } = require('./foreground-benchmark-files');

const TERMINAL_TOPICS = ['CLUSTER_COMPLETE', 'CLUSTER_FAILED'];
const VERIFIER_ELIGIBLE = new Set(['completed', 'task_failure']);
const EXIT_CODES = Object.freeze({
  provider_failure: 20,
  engine_failure: 21,
  cancelled: 22,
});

function isForegroundStatusSettled(status) {
  return (
    status &&
    ['stopped', 'killed'].includes(status.state) &&
    status.isZombie === false &&
    Array.isArray(status.agents) &&
    status.agents.every((agent) => agent && (agent.pid === null || agent.pid === undefined))
  );
}

function terminalMessages(cluster, clusterId) {
  const messages = TERMINAL_TOPICS.flatMap((topic) =>
    cluster.messageBus.query({ cluster_id: clusterId, topic })
  );
  return messages.sort((left, right) => {
    const a = BigInt(left.sequence);
    const b = BigInt(right.sequence);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

function requireSettledStatus(orchestrator, clusterId) {
  const status = orchestrator.getStatus(clusterId);
  if (!isForegroundStatusSettled(status)) {
    throw new Error(`foreground cluster is not settled: ${String(status?.state || 'unavailable')}`);
  }
  return status;
}

function writeForegroundResult({ orchestrator, cluster, clusterId, resultPath, cancelled }) {
  const status = requireSettledStatus(orchestrator, clusterId);
  const terminals = terminalMessages(cluster, clusterId);
  let result;
  if (cancelled && terminals.length === 0) {
    result = buildCancelledResult({ runId: clusterId, agents: status.agents });
  } else {
    result = buildBenchmarkResult({
      runId: clusterId,
      terminalMessages: terminals,
      agents: status.agents,
    });
  }
  const snapshot = cluster.messageBus.readSnapshot(clusterId);
  return writeBenchmarkResultBundle(resultPath, result, snapshot);
}

function exitCodeForResult(result) {
  if (VERIFIER_ELIGIBLE.has(result.outcome)) return 0;
  const exitCode = EXIT_CODES[result.outcome];
  if (exitCode === undefined) throw new Error(`unsupported result outcome: ${result.outcome}`);
  return exitCode;
}

module.exports = {
  exitCodeForResult,
  isForegroundStatusSettled,
  terminalMessages,
  writeForegroundResult,
};
