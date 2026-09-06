const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Ledger = require('../../src/ledger');
const MessageBus = require('../../src/message-bus');
const Orchestrator = require('../../src/orchestrator');

function createTempDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDirectory(tempDir) {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function createSqliteOrchestrator(storageDir, databaseName) {
  const orchestrator = new Orchestrator({ quiet: true, skipLoad: true, storageDir });
  const ledger = new Ledger(path.join(storageDir, databaseName));
  const messageBus = new MessageBus(ledger);
  return { orchestrator, ledger, messageBus };
}

function createClusterHarness(storageDir, clusterId) {
  const resources = createSqliteOrchestrator(storageDir, `${clusterId}.db`);
  const cluster = {
    id: clusterId,
    state: 'running',
    pid: null,
    agents: [],
    ledger: resources.ledger,
    messageBus: resources.messageBus,
    snapshotter: null,
    isolation: null,
    validatorIsolation: null,
    worktree: null,
    autoPr: false,
    createdAt: Date.now(),
  };
  resources.orchestrator.clusters.set(clusterId, cluster);
  return { ...resources, cluster };
}

function closeSqliteOrchestrator({ orchestrator, ledger }) {
  orchestrator.close();
  if (!ledger._closed) {
    ledger.close();
  }
}

module.exports = {
  closeSqliteOrchestrator,
  createClusterHarness,
  createSqliteOrchestrator,
  createTempDirectory,
  removeTempDirectory,
};
