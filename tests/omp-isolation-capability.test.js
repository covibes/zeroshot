/**
 * OMP isolation capability gating.
 *
 * omp advertises worktreeIsolation:true and dockerIsolation:false (see
 * tests/agent-cli-provider/omp-registry-capabilities.test.js for the registry-level contract).
 * This suite proves that gate is actually enforced at both call sites that create isolation
 * side effects: cli/preflight.js (pre-run validation) and orchestrator.js#_initializeIsolation
 * (the code path that creates the Docker container / git worktree). In both cases, `--provider
 * omp --docker` must fail before any Docker work happens, and `--provider omp --worktree` must
 * reach the existing (already-tested) worktree creation path unimpeded.
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

describe('OMP isolation capability gating', function () {
  this.timeout(10000);

  describe('preflight', function () {
    it('rejects --docker for omp with a capability error', async function () {
      const result = await runPreflight({ provider: 'omp', requireDocker: true });
      assert.strictEqual(result.valid, false);
      const messages = result.errors.join('\n');
      assert.match(messages, /does not advertise dockerIsolation/);
    });

    it('does not reject --worktree/--pr/--ship for omp', async function () {
      const result = await runPreflight({ provider: 'omp', requireGit: true });
      const messages = result.errors.join('\n');
      assert.doesNotMatch(messages, /does not advertise worktreeIsolation/);
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

    it('fails --provider omp --docker before Docker is even probed or a container is created', async function () {
      const originalIsDockerAvailable = IsolationManager.isDockerAvailable;
      const originalCreateContainer = IsolationManager.prototype.createContainer;
      let dockerProbed = false;
      let containerCreated = false;
      IsolationManager.isDockerAvailable = () => {
        dockerProbed = true;
        return true;
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
          /does not support Docker isolation/
        );
      } finally {
        IsolationManager.isDockerAvailable = originalIsDockerAvailable;
        IsolationManager.prototype.createContainer = originalCreateContainer;
      }

      assert.strictEqual(dockerProbed, false, 'must fail before checking Docker availability');
      assert.strictEqual(containerCreated, false, 'must fail before creating a container');
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
