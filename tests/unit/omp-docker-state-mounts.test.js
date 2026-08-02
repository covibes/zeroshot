/**
 * OMP's `~/.omp` credential mount is read-only, but the CLI writes runtime state (native addon
 * extraction, session DB, logs, ...) under it on startup. `_applyProviderStateMounts` nests
 * writable bind mounts for those registry-declared subpaths (docker.writableState) inside the
 * read-only mount so OMP can actually run under `--docker`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const IsolationManager = require('../../src/isolation-manager');

function vSpecs(args) {
  const out = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-v') out.push(args[i + 1]);
  }
  return out;
}

describe('OMP Docker writable state mounts', function () {
  let manager;
  let clusterId;
  let stateRoots;

  beforeEach(function () {
    manager = new IsolationManager();
    clusterId = `test-${crypto.randomBytes(6).toString('hex')}`;
    stateRoots = [];
  });

  afterEach(function () {
    for (const root of stateRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function stateRootFor(id) {
    const root = path.join(os.tmpdir(), 'zeroshot-provider-state', id, 'omp');
    stateRoots.push(path.join(os.tmpdir(), 'zeroshot-provider-state', id));
    return root;
  }

  it('emits writable -v entries for each registry-declared writableState subpath', function () {
    stateRootFor(clusterId);
    const args = [];
    manager._applyProviderStateMounts(args, {}, clusterId, '/root', 'omp');
    const specs = vSpecs(args);
    for (const sub of ['agent', 'natives', 'logs', 'run', 'cache']) {
      const match = specs.find((spec) => spec.endsWith(`/root/.omp/${sub}`));
      assert.ok(match, `expected a writable mount for ${sub}, got: ${JSON.stringify(specs)}`);
      assert.ok(!match.endsWith(':ro'), `${sub} mount must not be read-only: ${match}`);
    }
  });

  it('nests state paths under the read-only mount destination', function () {
    stateRootFor(clusterId);
    const args = [];
    manager._applyProviderStateMounts(args, {}, clusterId, '/root', 'omp');
    for (const spec of vSpecs(args)) {
      const dest = spec.slice(spec.indexOf(':') + 1);
      assert.ok(
        dest.startsWith('/root/.omp/'),
        `state mount ${dest} is not nested under /root/.omp`
      );
    }
  });

  it('honors a custom containerHome for $HOME expansion', function () {
    stateRootFor(clusterId);
    const args = [];
    manager._applyProviderStateMounts(args, {}, clusterId, '/home/node', 'omp');
    const specs = vSpecs(args);
    assert.ok(specs.some((spec) => spec.endsWith('/home/node/.omp/agent')));
  });

  it('is suppressed by noMounts', function () {
    stateRootFor(clusterId);
    const args = [];
    const result = manager._applyProviderStateMounts(
      args,
      { noMounts: true },
      clusterId,
      '/root',
      'omp'
    );
    assert.deepStrictEqual(result, []);
    assert.strictEqual(args.length, 0);
  });

  it('emits nothing for a provider with no declared writableState (copilot)', function () {
    const args = [];
    const result = manager._applyProviderStateMounts(args, {}, clusterId, '/root', 'copilot');
    assert.deepStrictEqual(result, []);
    assert.strictEqual(args.length, 0);
  });

  it('creates host state dirs, owner-only mode 0o700 (never world/group-writable)', function () {
    // os.tmpdir() is shared by every local user on the host; these dirs are bind-mounted
    // writable into the container, so a wider mode would let any local user plant a file the
    // container's provider process (e.g. a native addon OMP loads on startup) then executes.
    stateRootFor(clusterId);
    const args = [];
    const hostDirs = manager._applyProviderStateMounts(args, {}, clusterId, '/root', 'omp');
    assert.strictEqual(hostDirs.length, 5);
    for (const dir of hostDirs) {
      assert.ok(fs.existsSync(dir), `${dir} was not created`);
      const stat = fs.statSync(dir);
      assert.ok(stat.isDirectory());
      assert.strictEqual(stat.mode & 0o777, 0o700, `${dir} must be owner-only (0o700), got mode`);
    }
  });

  it('does not restrict the shared ancestor directory to owner-only', function () {
    // Only the leaf state dirs that get bind-mounted into the container need to be locked down;
    // the ancestors (zeroshot-provider-state/, <clusterId>/, <provider>/) hold no data themselves
    // and must stay at ordinary permissions so a different host user's own clusterId subtree
    // isn't blocked from being created under the same shared os.tmpdir() root.
    stateRootFor(clusterId);
    const args = [];
    manager._applyProviderStateMounts(args, {}, clusterId, '/root', 'omp');
    const providerRoot = path.join(os.tmpdir(), 'zeroshot-provider-state', clusterId, 'omp');
    const stat = fs.statSync(providerRoot);
    assert.notStrictEqual(
      stat.mode & 0o777,
      0o700,
      'the per-provider ancestor dir should not be locked to owner-only like the leaf state dirs'
    );
  });

  describe('cleanup() removes the provider-state dir (no disk leak)', function () {
    function clusterStateRoot(id) {
      return path.join(os.tmpdir(), 'zeroshot-provider-state', id);
    }

    it('removes the per-cluster provider-state directory on cleanup', async function () {
      stateRootFor(clusterId);
      const args = [];
      manager._applyProviderStateMounts(args, {}, clusterId, '/root', 'omp');
      const clusterRoot = clusterStateRoot(clusterId);
      assert.ok(fs.existsSync(clusterRoot), 'precondition: state dir should exist before cleanup');

      await manager.cleanup(clusterId);

      assert.ok(!fs.existsSync(clusterRoot), 'cleanup() left the provider-state dir behind');
    });

    it('removes the provider-state dir even when preserveWorkspace is set', async function () {
      // The state dir is ephemeral container runtime state, not the git workspace: it gets
      // recreated fresh by _applyProviderStateMounts on the next createContainer call regardless,
      // so preserving it across a paused/resumable cluster serves no purpose.
      stateRootFor(clusterId);
      const args = [];
      manager._applyProviderStateMounts(args, {}, clusterId, '/root', 'omp');
      const clusterRoot = clusterStateRoot(clusterId);

      await manager.cleanup(clusterId, { preserveWorkspace: true });

      assert.ok(!fs.existsSync(clusterRoot));
    });

    it('is a no-op when no provider-state dir was ever created', async function () {
      await assert.doesNotReject(manager.cleanup(clusterId));
    });
  });
});
