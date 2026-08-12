/**
 * Worktree Docker Compose Cleanup Test Suite
 *
 * Regression tests for worktree Docker Compose cleanup.
 *
 * Safety contract:
 * - automatic cleanup must never pass `--volumes`
 * - automatic cleanup must never touch a pinned/shared Compose project
 * - automatic cleanup may only tear down a project explicitly scoped to the
 *   worktree directory basename
 *
 * These tests cover both cleanup entry points:
 * - IsolationManager.removeWorktree() for completed --pr/--ship cleanup
 * - Orchestrator._teardownWorktreeCompose() for stop/Ctrl+C cleanup
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');

function isComposeDownCall(call) {
  return (
    call.command === 'docker' &&
    Array.isArray(call.args) &&
    call.args[0] === 'compose' &&
    call.args.includes('down')
  );
}

/**
 * Simulates lib/compose-utils failing to load — the shape a published install takes when one of
 * its runtime dependencies is missing from the installed tree.
 */
function withUnloadableComposeUtils(run) {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request.endsWith('lib/compose-utils')) {
      const error = new Error("Cannot find module 'js-yaml'");
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return origLoad.call(this, request, ...rest);
  };
  try {
    run();
  } finally {
    Module._load = origLoad;
  }
}

describe('Worktree Docker Compose Cleanup', function () {
  this.timeout(10000);

  let tmpDir;
  let origComposeProjectName;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-compose-cleanup-'));
    // Isolate from any host-level COMPOSE_PROJECT_NAME (e.g. this repo's own dev setup
    // may export one) so unpinned-project tests reflect the worktree-basename default.
    origComposeProjectName = process.env.COMPOSE_PROJECT_NAME;
    delete process.env.COMPOSE_PROJECT_NAME;
  });

  afterEach(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origComposeProjectName === undefined) {
      delete process.env.COMPOSE_PROJECT_NAME;
    } else {
      process.env.COMPOSE_PROJECT_NAME = origComposeProjectName;
    }
  });

  describe('IsolationManager.removeWorktree', function () {
    it('should call docker compose down before removing worktree with docker-compose.yml', function () {
      const origSpawnSync = childProcess.spawnSync;
      const calls = [];

      childProcess.spawnSync = function (command, args, opts) {
        calls.push({ command, args, cwd: opts?.cwd });
        if (command === 'git' && args[0] === 'worktree') {
          return { status: 1, stdout: '', stderr: 'not a git repo' };
        }
        return { status: 0, stdout: '', stderr: '' };
      };

      try {
        // Re-require because IsolationManager binds child_process helpers at import time.
        delete require.cache[require.resolve('../src/isolation-manager')];
        const IsolationManager = require('../src/isolation-manager');
        const manager = new IsolationManager();

        // Create a fake worktree directory with docker-compose.yml
        const fakeWorktreePath = path.join(tmpDir, 'test-worktree');
        fs.mkdirSync(fakeWorktreePath, { recursive: true });
        fs.writeFileSync(path.join(fakeWorktreePath, 'docker-compose.yml'), 'version: "3"');

        // Register worktree in manager's internal map
        manager.worktrees.set('test-cluster', {
          path: fakeWorktreePath,
          branch: 'zeroshot/test-cluster',
          repoRoot: tmpDir,
        });

        manager.cleanupWorktreeIsolation('test-cluster');

        // Verify docker compose down was called
        const composeDownCall = calls.find(isComposeDownCall);
        assert.ok(composeDownCall, 'docker compose down should be called during cleanup');
        assert.strictEqual(
          composeDownCall.cwd,
          fakeWorktreePath,
          'docker compose down should run in the worktree directory'
        );
        assert.ok(
          composeDownCall.args.includes('--remove-orphans'),
          'docker compose down should use --remove-orphans'
        );
        assert.ok(
          !composeDownCall.args.includes('--volumes'),
          'docker compose down must NEVER use --volumes (irreversible data loss on shared projects)'
        );
        assert.ok(
          composeDownCall.args.includes('-p') &&
            composeDownCall.args[composeDownCall.args.indexOf('-p') + 1] === 'test-worktree',
          'docker compose down should pin the project to the worktree directory basename'
        );

        // Verify ordering: compose down appears before git worktree remove
        const composeIdx = calls.findIndex(isComposeDownCall);
        const gitIdx = calls.findIndex(
          (c) =>
            c.command === 'git' &&
            c.args.join(' ') === `worktree remove --force ${fakeWorktreePath}`
        );
        assert.ok(
          composeIdx < gitIdx,
          `docker compose down (idx ${composeIdx}) should run before git worktree remove (idx ${gitIdx})`
        );
      } finally {
        childProcess.spawnSync = origSpawnSync;
        delete require.cache[require.resolve('../src/isolation-manager')];
      }
    });

    it('should still remove the worktree when lib/compose-utils cannot be loaded', function () {
      const origSpawnSync = childProcess.spawnSync;
      const calls = [];

      childProcess.spawnSync = function (command, args, opts) {
        calls.push({ command, args, cwd: opts?.cwd });
        if (command === 'git' && args[0] === 'worktree') {
          return { status: 1, stdout: '', stderr: 'not a git repo' };
        }
        return { status: 0, stdout: '', stderr: '' };
      };

      try {
        delete require.cache[require.resolve('../src/isolation-manager')];
        const IsolationManager = require('../src/isolation-manager');
        const manager = new IsolationManager();

        const fakeWorktreePath = path.join(tmpDir, 'unloadable-compose-worktree');
        fs.mkdirSync(fakeWorktreePath, { recursive: true });
        fs.writeFileSync(path.join(fakeWorktreePath, 'docker-compose.yml'), 'version: "3"');

        manager.worktrees.set('test-cluster', {
          path: fakeWorktreePath,
          branch: 'zeroshot/test-cluster',
          repoRoot: tmpDir,
        });

        withUnloadableComposeUtils(() => {
          assert.doesNotThrow(() => {
            manager.cleanupWorktreeIsolation('test-cluster');
          });
        });

        assert.ok(
          !calls.some(isComposeDownCall),
          'teardown must be skipped when compose support cannot be loaded'
        );
        assert.ok(
          calls.some(
            (call) =>
              call.command === 'git' &&
              call.args.join(' ') === `worktree remove --force ${fakeWorktreePath}`
          ),
          'worktree removal should still proceed'
        );
      } finally {
        childProcess.spawnSync = origSpawnSync;
        delete require.cache[require.resolve('../src/isolation-manager')];
      }
    });

    it('should skip docker compose down when no docker-compose.yml exists', function () {
      const origSpawnSync = childProcess.spawnSync;
      const calls = [];

      childProcess.spawnSync = function (command, args, opts) {
        calls.push({ command, args, cwd: opts?.cwd });
        if (command === 'git' && args[0] === 'worktree') {
          return { status: 1, stdout: '', stderr: 'not a git repo' };
        }
        return { status: 0, stdout: '', stderr: '' };
      };

      try {
        delete require.cache[require.resolve('../src/isolation-manager')];
        const IsolationManager = require('../src/isolation-manager');
        const manager = new IsolationManager();

        // Create a fake worktree directory WITHOUT docker-compose.yml
        const fakeWorktreePath = path.join(tmpDir, 'test-worktree-no-compose');
        fs.mkdirSync(fakeWorktreePath, { recursive: true });

        manager.worktrees.set('test-no-compose', {
          path: fakeWorktreePath,
          branch: 'zeroshot/test-no-compose',
          repoRoot: tmpDir,
        });

        manager.cleanupWorktreeIsolation('test-no-compose');

        const composeCall = calls.find(
          (c) => c.command === 'docker' && Array.isArray(c.args) && c.args[0] === 'compose'
        );
        assert.strictEqual(
          composeCall,
          undefined,
          'docker compose should NOT be called when no docker-compose.yml exists'
        );
      } finally {
        childProcess.spawnSync = origSpawnSync;
        delete require.cache[require.resolve('../src/isolation-manager')];
      }
    });

    it('should skip docker compose down when compose project name is pinned via top-level name', function () {
      const origSpawnSync = childProcess.spawnSync;
      const calls = [];

      childProcess.spawnSync = function (command, args, opts) {
        calls.push({ command, args, cwd: opts?.cwd });
        if (command === 'git' && args[0] === 'worktree') {
          return { status: 1, stdout: '', stderr: 'not a git repo' };
        }
        return { status: 0, stdout: '', stderr: '' };
      };

      try {
        delete require.cache[require.resolve('../src/isolation-manager')];
        const IsolationManager = require('../src/isolation-manager');
        const manager = new IsolationManager();

        const fakeWorktreePath = path.join(tmpDir, 'pinned-name-worktree');
        fs.mkdirSync(fakeWorktreePath, { recursive: true });
        fs.writeFileSync(
          path.join(fakeWorktreePath, 'docker-compose.yml'),
          'name: myproj\nservices:\n  db:\n    image: postgres\n'
        );

        manager.worktrees.set('test-pinned-name', {
          path: fakeWorktreePath,
          branch: 'zeroshot/test-pinned-name',
          repoRoot: tmpDir,
        });

        manager.cleanupWorktreeIsolation('test-pinned-name');

        const composeCall = calls.find(
          (c) => c.command === 'docker' && Array.isArray(c.args) && c.args[0] === 'compose'
        );
        assert.strictEqual(
          composeCall,
          undefined,
          'docker compose down must NOT be invoked when the project name is pinned'
        );
      } finally {
        childProcess.spawnSync = origSpawnSync;
        delete require.cache[require.resolve('../src/isolation-manager')];
      }
    });

    it('should skip docker compose down when COMPOSE_PROJECT_NAME env var is set', function () {
      const origSpawnSync = childProcess.spawnSync;
      const origEnv = process.env.COMPOSE_PROJECT_NAME;
      const calls = [];

      childProcess.spawnSync = function (command, args, opts) {
        calls.push({ command, args, cwd: opts?.cwd });
        if (command === 'git' && args[0] === 'worktree') {
          return { status: 1, stdout: '', stderr: 'not a git repo' };
        }
        return { status: 0, stdout: '', stderr: '' };
      };

      process.env.COMPOSE_PROJECT_NAME = 'shared-host-project';
      try {
        delete require.cache[require.resolve('../src/isolation-manager')];
        const IsolationManager = require('../src/isolation-manager');
        const manager = new IsolationManager();

        const fakeWorktreePath = path.join(tmpDir, 'pinned-env-worktree');
        fs.mkdirSync(fakeWorktreePath, { recursive: true });
        fs.writeFileSync(path.join(fakeWorktreePath, 'docker-compose.yml'), 'version: "3"');

        manager.worktrees.set('test-pinned-env', {
          path: fakeWorktreePath,
          branch: 'zeroshot/test-pinned-env',
          repoRoot: tmpDir,
        });

        manager.cleanupWorktreeIsolation('test-pinned-env');

        const composeCall = calls.find(
          (c) => c.command === 'docker' && Array.isArray(c.args) && c.args[0] === 'compose'
        );
        assert.strictEqual(
          composeCall,
          undefined,
          'docker compose down must NOT be invoked when COMPOSE_PROJECT_NAME pins a shared project'
        );
      } finally {
        if (origEnv === undefined) {
          delete process.env.COMPOSE_PROJECT_NAME;
        } else {
          process.env.COMPOSE_PROJECT_NAME = origEnv;
        }
        childProcess.spawnSync = origSpawnSync;
        delete require.cache[require.resolve('../src/isolation-manager')];
      }
    });

    it('should not fail when docker compose down throws', function () {
      const origSpawnSync = childProcess.spawnSync;

      childProcess.spawnSync = function (command, args) {
        if (command === 'docker' && args[0] === 'compose') {
          return { status: 1, stdout: '', stderr: 'Docker daemon not running' };
        }
        if (command === 'git') {
          return { status: 1, stdout: '', stderr: 'not a git repo' };
        }
        return { status: 0, stdout: '', stderr: '' };
      };

      try {
        delete require.cache[require.resolve('../src/isolation-manager')];
        const IsolationManager = require('../src/isolation-manager');
        const manager = new IsolationManager();

        const fakeWorktreePath = path.join(tmpDir, 'test-worktree-compose-fail');
        fs.mkdirSync(fakeWorktreePath, { recursive: true });
        fs.writeFileSync(path.join(fakeWorktreePath, 'docker-compose.yml'), 'version: "3"');

        manager.worktrees.set('test-compose-fail', {
          path: fakeWorktreePath,
          branch: 'zeroshot/test-compose-fail',
          repoRoot: tmpDir,
        });

        // Should not throw — compose down failure is best-effort
        assert.doesNotThrow(() => {
          manager.cleanupWorktreeIsolation('test-compose-fail');
        });
      } finally {
        childProcess.spawnSync = origSpawnSync;
        delete require.cache[require.resolve('../src/isolation-manager')];
      }
    });
  });

  describe('Orchestrator._teardownWorktreeCompose', function () {
    let origSpawnSync;

    beforeEach(function () {
      origSpawnSync = childProcess.spawnSync;
    });

    afterEach(function () {
      childProcess.spawnSync = origSpawnSync;
    });

    it('should tear down compose services during stop (Ctrl+C path)', function () {
      const Orchestrator = require('../src/orchestrator');
      const orchestrator = new Orchestrator({ dataDir: tmpDir });

      const fakeWorktreePath = path.join(tmpDir, 'stop-test-worktree');
      fs.mkdirSync(fakeWorktreePath, { recursive: true });
      fs.writeFileSync(path.join(fakeWorktreePath, 'docker-compose.yml'), 'version: "3"');

      const calls = [];
      childProcess.spawnSync = function (command, args, opts) {
        calls.push({ command, args, cwd: opts?.cwd });
        return { status: 0, stdout: '', stderr: '' };
      };

      orchestrator._teardownWorktreeCompose(fakeWorktreePath);

      const composeCall = calls.find(isComposeDownCall);
      assert.ok(composeCall, '_teardownWorktreeCompose should call docker compose down');
      assert.strictEqual(composeCall.cwd, fakeWorktreePath);
      assert.ok(composeCall.args.includes('--remove-orphans'));
      assert.ok(
        !composeCall.args.includes('--volumes'),
        'docker compose down must NEVER use --volumes (irreversible data loss on shared projects)'
      );
      assert.ok(
        composeCall.args.includes('-p') &&
          composeCall.args[composeCall.args.indexOf('-p') + 1] === 'stop-test-worktree',
        'docker compose down should pin the project to the worktree directory basename'
      );
    });

    it('should skip docker compose down when compose project name is pinned via top-level name', function () {
      const Orchestrator = require('../src/orchestrator');
      const orchestrator = new Orchestrator({ dataDir: tmpDir });

      const fakeWorktreePath = path.join(tmpDir, 'pinned-name-worktree');
      fs.mkdirSync(fakeWorktreePath, { recursive: true });
      fs.writeFileSync(
        path.join(fakeWorktreePath, 'docker-compose.yml'),
        'name: myproj\nservices:\n  db:\n    image: postgres\n'
      );

      const calls = [];
      childProcess.spawnSync = function (command, args, opts) {
        calls.push({ command, args, cwd: opts?.cwd });
        return { status: 0, stdout: '', stderr: '' };
      };

      orchestrator._teardownWorktreeCompose(fakeWorktreePath);
      assert.strictEqual(
        calls.length,
        0,
        'docker compose down must NOT be invoked when the project name is pinned (shared host project)'
      );
    });

    it('should skip docker compose down when COMPOSE_PROJECT_NAME env var is set', function () {
      const Orchestrator = require('../src/orchestrator');
      const orchestrator = new Orchestrator({ dataDir: tmpDir });

      const fakeWorktreePath = path.join(tmpDir, 'pinned-env-worktree');
      fs.mkdirSync(fakeWorktreePath, { recursive: true });
      fs.writeFileSync(path.join(fakeWorktreePath, 'docker-compose.yml'), 'version: "3"');

      const calls = [];
      childProcess.spawnSync = function (command, args, opts) {
        calls.push({ command, args, cwd: opts?.cwd });
        return { status: 0, stdout: '', stderr: '' };
      };

      const origEnv = process.env.COMPOSE_PROJECT_NAME;
      process.env.COMPOSE_PROJECT_NAME = 'shared-host-project';
      try {
        orchestrator._teardownWorktreeCompose(fakeWorktreePath);
        assert.strictEqual(
          calls.length,
          0,
          'docker compose down must NOT be invoked when COMPOSE_PROJECT_NAME pins a shared project'
        );
      } finally {
        if (origEnv === undefined) {
          delete process.env.COMPOSE_PROJECT_NAME;
        } else {
          process.env.COMPOSE_PROJECT_NAME = origEnv;
        }
      }
    });

    it('should skip when no docker-compose.yml exists', function () {
      const Orchestrator = require('../src/orchestrator');
      const orchestrator = new Orchestrator({ dataDir: tmpDir });

      const fakeWorktreePath = path.join(tmpDir, 'no-compose-worktree');
      fs.mkdirSync(fakeWorktreePath, { recursive: true });

      const calls = [];
      childProcess.spawnSync = function (command, args, opts) {
        calls.push({ command, args, cwd: opts?.cwd });
        return { status: 0, stdout: '', stderr: '' };
      };

      orchestrator._teardownWorktreeCompose(fakeWorktreePath);
      assert.strictEqual(
        calls.length,
        0,
        'No commands should be called without docker-compose.yml'
      );
    });

    it('should not throw when docker compose down fails', function () {
      const Orchestrator = require('../src/orchestrator');
      const orchestrator = new Orchestrator({ dataDir: tmpDir });

      const fakeWorktreePath = path.join(tmpDir, 'fail-compose-worktree');
      fs.mkdirSync(fakeWorktreePath, { recursive: true });
      fs.writeFileSync(path.join(fakeWorktreePath, 'docker-compose.yml'), 'version: "3"');

      childProcess.spawnSync = function (command, args) {
        if (command === 'docker' && args[0] === 'compose') {
          return { status: 1, stdout: '', stderr: 'no such service' };
        }
        return { status: 0, stdout: '', stderr: '' };
      };

      assert.doesNotThrow(() => {
        orchestrator._teardownWorktreeCompose(fakeWorktreePath);
      });
    });

    it('should not throw when lib/compose-utils cannot be loaded', function () {
      const Orchestrator = require('../src/orchestrator');
      const orchestrator = new Orchestrator({ dataDir: tmpDir });

      const fakeWorktreePath = path.join(tmpDir, 'unloadable-compose-worktree');
      fs.mkdirSync(fakeWorktreePath, { recursive: true });
      fs.writeFileSync(path.join(fakeWorktreePath, 'docker-compose.yml'), 'version: "3"');

      const calls = [];
      childProcess.spawnSync = function (command, args, opts) {
        calls.push({ command, args, cwd: opts?.cwd });
        return { status: 0, stdout: '', stderr: '' };
      };

      withUnloadableComposeUtils(() => {
        assert.doesNotThrow(() => {
          orchestrator._teardownWorktreeCompose(fakeWorktreePath);
        });
      });

      assert.ok(
        !calls.some(isComposeDownCall),
        'teardown must be skipped when compose support cannot be loaded'
      );
    });
  });
});
