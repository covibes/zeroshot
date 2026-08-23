function publishConductorCompletion(messageBus, clusterId) {
  messageBus.publish({
    cluster_id: clusterId,
    topic: 'AGENT_LIFECYCLE',
    sender: 'conductor',
    content: { data: { event: 'TASK_COMPLETED', role: 'conductor' } },
  });
}

function publishClusterOperations(messageBus, clusterId) {
  messageBus.publish({
    cluster_id: clusterId,
    topic: 'CLUSTER_OPERATIONS',
    sender: 'conductor',
    content: { data: { operations: [] } },
  });
}

function publishTerminal(messageBus, clusterId, topic) {
  messageBus.publish({
    cluster_id: clusterId,
    topic,
    sender: 'test',
    content: { data: { reason: 'test_terminal' } },
  });
}

function watchdogFailures(messageBus, clusterId) {
  return messageBus
    .query({ cluster_id: clusterId, topic: 'CLUSTER_FAILED' })
    .filter((message) => message.content?.data?.reason === 'CONDUCTOR_WATCHDOG_TIMEOUT');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

module.exports = {
  deferred,
  publishClusterOperations,
  publishConductorCompletion,
  publishTerminal,
  watchdogFailures,
};
