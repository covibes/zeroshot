/**
 * OMP Docker platform gating.
 *
 * omp now advertises dockerIsolation:true (see
 * tests/agent-cli-provider/omp-registry-capabilities.test.js for the registry-level contract) and
 * worktreeIsolation:true. Its Docker path additionally requires a pre-effect platform probe
 * (registry-owned `docker.platform === 'linux/amd64'`, see docker/zeroshot-cluster/Dockerfile's
 * hard-coded x86-64 tool layers) before any workspace/container side effect. This suite proves
 * that probe is enforced at both call sites that create isolation side effects: cli/preflight.js
 * (pre-run validation) and orchestrator.js#_initializeIsolation (the code path that creates the
 * Docker container / git worktree). `--provider omp --worktree` must still reach the existing
 * (already-tested) worktree creation path unimpeded.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Orchestrator = require('../src/orchestrator.js');
const IsolationManager = require('../src/isolation-manager.js');
const { runPreflight } = require('../src/preflight.js');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-isolation-'));
}

describe('OMP Docker platform gating', function () {
  this.timeout(30000);

  describe('preflight', function () {
    it('no longer rejects --docker for omp on capability grounds', async function () {
      const result = await runPreflight({ provider: 'omp', requireDocker: true });
      const messages = result.errors.join('\n');
      assert.doesNotMatch(messages, /does not advertise dockerIsolation/);
    });

    it('does not reject --worktree/--pr/--ship for omp', async function () {
      const result = await runPreflight({ provider: 'omp', requireGit: true });
      const messages = result.errors.join('\n');
      assert.doesNotMatch(messages, /does not advertise worktreeIsolation/);
    });

    it('surfaces the platform error when the Docker engine cannot run the required platform', async function () {
      const original = IsolationManager.assertPlatformSupported;
      IsolationManager.assertPlatformSupported = () => {
        throw new Error(
          'Docker engine cannot run linux/amd64 (server linux/arm64, no buildx emulation). ' +
            'Install Buildx and run: docker run --privileged --rm tonistiigi/binfmt --install amd64'
        );
      };
      try {
        const result = await runPreflight({ provider: 'omp', requireDocker: true });
        assert.strictEqual(result.valid, false);
        const messages = result.errors.join('\n');
        assert.match(messages, /Docker cannot run required platform/);
        assert.match(messages, /linux\/amd64/);
      } finally {
        IsolationManager.assertPlatformSupported = original;
      }
    });
  });

  describe('orchestrator _initializeIsolation', function () {
    let orchestrator;
    let storageDir;

    beforeEach(function () {
      storageDir = createTempDir();
      orchestrator = new Orchestrator({ storageDir, skipLoad: true, quiet: true });
    });

    afterEach(function () {
      orchestrator.close();
      fs.rmSync(storageDir, { recursive: true, force: true });
    });

    it('fails --provider omp --docker before any image/container side effect when the platform is unsupported', async function () {
      const originalIsDockerAvailable = IsolationManager.isDockerAvailable;
      const originalAssertPlatformSupported = IsolationManager.assertPlatformSupported;
      const originalEnsureImage = IsolationManager.ensureImage;
      const originalCreateContainer = IsolationManager.prototype.createContainer;
      let dockerProbed = false;
      let ensureImageCalled = false;
      let containerCreated = false;

      IsolationManager.isDockerAvailable = () => {
        dockerProbed = true;
        return true;
      };
      IsolationManager.assertPlatformSupported = () => {
        throw new Error(
          'Docker engine cannot run linux/amd64 (server linux/arm64, no buildx emulation)'
        );
      };
      IsolationManager.ensureImage = () => {
        ensureImageCalled = true;
        return Promise.resolve();
      };
      IsolationManager.prototype.createContainer = function () {
        containerCreated = true;
        return Promise.resolve('fake-container-id');
      };

      try {
        await assert.rejects(
          orchestrator._initializeIsolation(
            { isolation: true, cwd: '/tmp/repo' },
            { forceProvider: 'omp' },
            'cluster-omp-docker'
          ),
          /Docker engine cannot run linux\/amd64/
        );
      } finally {
        IsolationManager.isDockerAvailable = originalIsDockerAvailable;
        IsolationManager.assertPlatformSupported = originalAssertPlatformSupported;
        IsolationManager.ensureImage = originalEnsureImage;
        IsolationManager.prototype.createContainer = originalCreateContainer;
      }

      assert.strictEqual(dockerProbed, true, 'Docker availability is still checked first');
      assert.strictEqual(ensureImageCalled, false, 'must fail before building/ensuring the image');
      assert.strictEqual(containerCreated, false, 'must fail before creating a container');
    });

    it('threads the registry-owned platform into ensureImage/createContainer when the probe passes', async function () {
      const originalIsDockerAvailable = IsolationManager.isDockerAvailable;
      const originalAssertPlatformSupported = IsolationManager.assertPlatformSupported;
      const originalEnsureImage = IsolationManager.ensureImage;
      const originalCreateContainer = IsolationManager.prototype.createContainer;
      const ensureImageCalls = [];
      let createContainerConfig = null;

      IsolationManager.isDockerAvailable = () => true;
      IsolationManager.assertPlatformSupported = () => {};
      IsolationManager.ensureImage = (image, autoBuild, buildArgs, platform) => {
        ensureImageCalls.push({ image, buildArgs, platform });
        return Promise.resolve();
      };
      IsolationManager.prototype.createContainer = function (clusterId, config) {
        createContainerConfig = config;
        return Promise.resolve('fake-container-id');
      };

      try {
        await orchestrator._initializeIsolation(
          { isolation: true, cwd: '/tmp/repo' },
          { forceProvider: 'omp' },
          'cluster-omp-docker-ok'
        );
      } finally {
        IsolationManager.isDockerAvailable = originalIsDockerAvailable;
        IsolationManager.assertPlatformSupported = originalAssertPlatformSupported;
        IsolationManager.ensureImage = originalEnsureImage;
        IsolationManager.prototype.createContainer = originalCreateContainer;
      }

      assert.strictEqual(ensureImageCalls.length, 1);
      assert.strictEqual(ensureImageCalls[0].platform, 'linux/amd64');
      assert.ok(createContainerConfig);
      assert.strictEqual(createContainerConfig.platform, 'linux/amd64');
    });

    it('succeeds --provider omp --worktree, reaching the existing worktree creation path', async function () {
      const originalCreateWorktreeIsolation = IsolationManager.prototype.createWorktreeIsolation;
      const calls = [];
      IsolationManager.prototype.createWorktreeIsolation = function (clusterId, workDir, options) {
        calls.push({ clusterId, workDir, options });
        return {
          path: '/tmp/zeroshot-worktree-omp',
          branch: 'zeroshot/cluster-omp-worktree',
          repoRoot: workDir,
          baseSha: 'deadbeef',
        };
      };

      try {
        const result = await orchestrator._initializeIsolation(
          { worktree: true, cwd: '/tmp/repo' },
          { forceProvider: 'omp' },
          'cluster-omp-worktree'
        );
        assert.strictEqual(calls.length, 1);
        assert.ok(result.worktreeInfo);
        assert.strictEqual(result.worktreeInfo.path, '/tmp/zeroshot-worktree-omp');
      } finally {
        IsolationManager.prototype.createWorktreeIsolation = originalCreateWorktreeIsolation;
      }
    });
  });
});
