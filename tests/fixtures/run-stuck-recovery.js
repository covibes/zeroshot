const fs = require('fs');
const path = require('path');
const Orchestrator = require('../../src/orchestrator');
const { loadTasks } = require('../../task-lib/store.js');

async function main() {
  const storageDir = process.env.RECOVERY_STORAGE_DIR;
  const config = JSON.parse(fs.readFileSync(process.env.RECOVERY_CONFIG, 'utf8'));
  const orchestrator = new Orchestrator({ storageDir, skipLoad: true, quiet: true });
  const started = await orchestrator.start(config, { text: 'fake hang recovery' });
  const deadline = Date.now() + 45000;
  const registryPath = path.join(storageDir, 'clusters.json');

  while (Date.now() < deadline) {
    const status = orchestrator.getStatus(started.id);
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const saved = registry[started.id];
    const agent = saved?.agentStates?.[0];
    if (
      status.state === 'stopped' &&
      saved?.state === 'stopped' &&
      agent?.currentTask === false &&
      agent?.currentTaskId === null &&
      agent?.processPid === null
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const cluster = orchestrator.getCluster(started.id);
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const lifecycle = cluster.messageBus
    .query({
      cluster_id: started.id,
      topic: 'AGENT_LIFECYCLE',
      sender: 'worker',
    })
    .map((message) => message.content.data.event);
  const completion = cluster.messageBus.findLast({
    cluster_id: started.id,
    topic: 'CLUSTER_COMPLETE',
  });
  console.log(
    'RESULT:' +
      JSON.stringify({
        state: orchestrator.getStatus(started.id).state,
        configuredRole: config.agents[0].role,
        lifecycle,
        topics: cluster.messageBus.getAll(started.id).map((message) => message.topic),
        completionData: completion?.content?.data || null,
        agentState: registry[started.id].agentStates[0],
        tasks: Object.fromEntries(
          Object.entries(loadTasks()).map(([id, task]) => [
            id,
            {
              status: task.status,
              pid: task.pid,
              error: task.error,
              sessionId: task.sessionId,
              sessionIdConflict: task.sessionIdConflict,
              requestedResumeSessionId: task.requestedResumeSessionId,
              resumeIdentityVerified: task.resumeIdentityVerified,
            },
          ])
        ),
        fakeCount: fs.readFileSync(process.env.FAKE_CODEX_COUNT, 'utf8'),
      })
  );
  orchestrator.close();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
