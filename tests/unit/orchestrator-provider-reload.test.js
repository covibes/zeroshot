/**
 * Orchestrator Provider Reload Test
 *
 * Regression test for provider resolution when reloading clusters from storage.
 * Ensures forceProvider is honored in status output after reload.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Orchestrator = require('../../src/orchestrator.js');
const Ledger = require('../../src/ledger.js');
const { getDefaultProviderId } = require('../../lib/provider-names');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dirPath) {
  if (dirPath && fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

describe('Orchestrator provider reload', function () {
  const originalSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;

  afterEach(function () {
    if (originalSettingsFile === undefined) {
      delete process.env.ZEROSHOT_SETTINGS_FILE;
    } else {
      process.env.ZEROSHOT_SETTINGS_FILE = originalSettingsFile;
    }
  });

  it('uses config.forceProvider after reload', async function () {
    const storageDir = createTempDir('zeroshot-provider-reload-');
    const settingsDir = createTempDir('zeroshot-provider-settings-');
    const settingsFile = path.join(settingsDir, 'settings.json');

    fs.writeFileSync(settingsFile, JSON.stringify({ defaultProvider: 'claude' }));
    process.env.ZEROSHOT_SETTINGS_FILE = settingsFile;

    const clusterId = 'provider-reload-test';
    const clusterData = {
      id: clusterId,
      config: {
        forceProvider: 'codex',
        agents: [
          {
            id: 'worker',
            role: 'implementation',
            modelLevel: 'level2',
            outputFormat: 'text',
            triggers: [{ topic: 'ISSUE_OPENED', action: 'execute_task' }],
            prompt: 'Worker',
          },
        ],
      },
      state: 'stopped',
      createdAt: Date.now(),
      autoPr: false,
      prOptions: null,
      issue: null,
      isolation: null,
      worktree: null,
      agentStates: null,
    };

    const clustersFile = path.join(storageDir, 'clusters.json');
    fs.writeFileSync(clustersFile, JSON.stringify({ [clusterId]: clusterData }, null, 2));

    const dbPath = path.join(storageDir, `${clusterId}.db`);
    const ledger = new Ledger(dbPath);
    ledger.append({
      topic: 'TEST',
      sender: 'tester',
      receiver: 'tester',
      content_text: 'ok',
      cluster_id: clusterId,
    });
    ledger.close();

    let orchestrator;
    try {
      orchestrator = await Orchestrator.create({ storageDir, quiet: true });
      const status = orchestrator.getStatus(clusterId);
      const providers = status.agents.map((agent) => agent.provider);
      for (const provider of providers) {
        assert.strictEqual(provider, 'codex');
      }
    } finally {
      if (orchestrator) {
        orchestrator.close();
      }
      cleanupDir(storageDir);
      cleanupDir(settingsDir);
    }
  });

  it('_resolveClusterProvider falls back to the registry default when nothing is configured', function () {
    const orchestrator = Object.create(Orchestrator.prototype);
    const resolved = orchestrator._resolveClusterProvider({}, { defaultProvider: undefined });
    assert.strictEqual(resolved, getDefaultProviderId());
  });

  it('_resolveClusterProvider still prefers forceProvider and defaultProvider over the registry default', function () {
    const orchestrator = Object.create(Orchestrator.prototype);
    assert.strictEqual(
      orchestrator._resolveClusterProvider(
        { forceProvider: 'codex', defaultProvider: 'gemini' },
        { defaultProvider: 'opencode' }
      ),
      'codex'
    );
    assert.strictEqual(
      orchestrator._resolveClusterProvider(
        { defaultProvider: 'gemini' },
        { defaultProvider: 'opencode' }
      ),
      'gemini'
    );
    assert.strictEqual(
      orchestrator._resolveClusterProvider({}, { defaultProvider: 'opencode' }),
      'opencode'
    );
  });
});
