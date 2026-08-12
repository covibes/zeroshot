const { buildBenchmarkResult, buildCancelledResult } = require('./foreground-benchmark-result');
const { writeBenchmarkResultBundle } = require('./foreground-benchmark-files');

const TERMINAL_TOPICS = ['CLUSTER_COMPLETE', 'CLUSTER_FAILED'];
const VERIFIER_ELIGIBLE = new Set(['completed', 'task_failure']);
const EXIT_CODES = Object.freeze({
  task_failure: 23,
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

function buildForegroundResult({ orchestrator, cluster, clusterId, cancelled }) {
  const finalRun = orchestrator.getFinalRun?.(clusterId);
  const status = finalRun?.status || requireSettledStatus(orchestrator, clusterId);
  const terminals = finalRun?.terminalMessages || terminalMessages(cluster, clusterId);
  if (cancelled && terminals.length === 0) {
    return buildCancelledResult({ runId: clusterId, agents: status.agents });
  }
  return buildBenchmarkResult({
    runId: clusterId,
    terminalMessages: terminals,
    agents: status.agents,
  });
}

function writeForegroundResult({ orchestrator, cluster, clusterId, resultPath, cancelled }) {
  const result = buildForegroundResult({ orchestrator, cluster, clusterId, cancelled });
  const snapshot =
    orchestrator.getFinalRun?.(clusterId)?.snapshot || cluster.messageBus.readSnapshot(clusterId);
  return writeBenchmarkResultBundle(resultPath, result, snapshot);
}

function exitCodeForResult(result) {
  if (VERIFIER_ELIGIBLE.has(result.outcome)) return 0;
  const exitCode = EXIT_CODES[result.outcome];
  if (exitCode === undefined) throw new Error(`unsupported result outcome: ${result.outcome}`);
  return exitCode;
}

function exitCodeForForegroundResult(result) {
  if (result.outcome === 'completed') return 0;
  return EXIT_CODES[result.outcome] ?? exitCodeForResult(result);
}

module.exports = {
  buildForegroundResult,
  exitCodeForResult,
  exitCodeForForegroundResult,
  isForegroundStatusSettled,
  terminalMessages,
  writeForegroundResult,
};
