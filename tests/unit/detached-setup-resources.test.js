const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Orchestrator = require('../../src/orchestrator');
const IsolationManager = require('../../src/isolation-manager');
const { getClustersFilePath, registerDetachedSetupCluster } = require('../../lib/detached-startup');

describe('detached setup resource cleanup', function () {
  let storageDir;

  beforeEach(function () {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-detached-resources-'));
  });

  afterEach(function () {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('records and removes deterministic Docker setup resources on kill', async function () {
    const clusterId = 'detached-resource-kill';
    const resources = IsolationManager.getDetachedSetupResources(clusterId);
    await registerDetachedSetupCluster({
      clusterId,
      pid: 999999,
      storageDir,
      runOptions: { docker: true },
    });
    fs.mkdirSync(resources.isolatedDir, { recursive: true });
    fs.mkdirSync(resources.configDir, { recursive: true });
    fs.writeFileSync(path.join(resources.isolatedDir, 'workspace.txt'), 'owned');
    fs.writeFileSync(path.join(resources.configDir, 'settings.json'), '{}');

    const persisted = JSON.parse(fs.readFileSync(getClustersFilePath(storageDir), 'utf8'));
    assert.deepStrictEqual(persisted[clusterId].setupResources, resources);

    let removedContainer = null;
    const originalRemoveContainerByName = IsolationManager.prototype._removeContainerByName;
    IsolationManager.prototype._removeContainerByName = function (name) {
      removedContainer = name;
    };

    const orchestrator = await Orchestrator.create({ quiet: true, storageDir });
    try {
      await orchestrator.kill(clusterId);
      assert.strictEqual(removedContainer, resources.containerName);
      assert.strictEqual(fs.existsSync(resources.isolatedDir), false);
      assert.strictEqual(fs.existsSync(resources.configDir), false);
      const afterKill = JSON.parse(fs.readFileSync(getClustersFilePath(storageDir), 'utf8'));
      assert.strictEqual(afterKill[clusterId], undefined);
    } finally {
      IsolationManager.prototype._removeContainerByName = originalRemoveContainerByName;
      orchestrator.close();
      fs.rmSync(resources.isolatedDir, { recursive: true, force: true });
      fs.rmSync(resources.configDir, { recursive: true, force: true });
    }
  });

  it('does not claim Docker resources for a detached host setup', async function () {
    await registerDetachedSetupCluster({
      clusterId: 'host-setup-cluster',
      pid: 12345,
      storageDir,
    });

    const clusters = JSON.parse(fs.readFileSync(getClustersFilePath(storageDir), 'utf8'));
    assert.strictEqual(clusters['host-setup-cluster'].setupResources, null);
  });

  it('rejects altered setup paths before cleanup', function () {
    const clusterId = 'bounded-setup-cluster';
    const resources = IsolationManager.getDetachedSetupResources(clusterId);
    const manager = new IsolationManager();

    assert.throws(
      () =>
        manager.cleanupDetachedSetupResources(clusterId, {
          ...resources,
          isolatedDir: path.join(os.tmpdir(), 'outside-owned-setup'),
        }),
      /do not match cluster/
    );
  });
});
