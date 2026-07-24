/**
 * Test: Worktree Isolation - Lightweight git-based isolation
 *
 * Tests the worktree isolation mode that provides:
 * - Git worktree creation at ~/.zeroshot/worktrees/{clusterId}
 * - Separate branch (zeroshot/{clusterId}) without copying files
 * - Fast setup (<1s vs 30-60s for Docker)
 * - No Docker dependency
 *
 * REQUIRES: Git installed
 * NO Docker required (that's the point!)
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const IsolationManager = require('../../src/isolation-manager');
const Orchestrator = require('../../src/orchestrator');
const { buildStartOptions } = require('../../lib/start-cluster');

let manager;
let testRepoDir;
const testClusterId = 'test-worktree-' + Date.now();

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: options.encoding || 'utf8',
    stdio: options.stdio || 'pipe',
  });
  if (result.status !== 0 || result.error) {
    const detail = result.error?.message || result.stderr || 'no stderr';
    throw new Error(`git ${args.join(' ')} failed in ${options.cwd || process.cwd()}: ${detail}`);
  }
  return result.stdout || '';
}

function createTempGitRepo(prefix) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  runGit(['init'], { cwd: repoDir });
  runGit(['config', 'user.email', 'test@test.com'], { cwd: repoDir });
  runGit(['config', 'user.name', 'Test User'], { cwd: repoDir });

  fs.writeFileSync(path.join(repoDir, 'test.txt'), 'initial content');
  runGit(['add', 'test.txt'], { cwd: repoDir });
  runGit(['commit', '-m', 'Initial commit'], { cwd: repoDir });

  return repoDir;
}

function createStaleRemoteBaseFixture(prefix) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const remoteDir = path.join(fixtureRoot, 'origin.git');
  const sourceDir = path.join(fixtureRoot, 'source');
  const publisherDir = path.join(fixtureRoot, 'publisher');

  fs.mkdirSync(remoteDir);
  runGit(['init', '--bare'], { cwd: remoteDir });

  fs.mkdirSync(sourceDir);
  runGit(['init'], { cwd: sourceDir });
  runGit(['config', 'user.email', 'test@test.com'], { cwd: sourceDir });
  runGit(['config', 'user.name', 'Test User'], { cwd: sourceDir });
  fs.writeFileSync(path.join(sourceDir, 'test.txt'), 'initial content');
  runGit(['add', 'test.txt'], { cwd: sourceDir });
  runGit(['commit', '-m', 'Initial commit'], { cwd: sourceDir });
  runGit(['branch', '-M', 'dev'], { cwd: sourceDir });
  runGit(['remote', 'add', 'origin', remoteDir], { cwd: sourceDir });
  runGit(['push', '-u', 'origin', 'dev'], { cwd: sourceDir });

  runGit(['clone', '--branch', 'dev', remoteDir, publisherDir], { cwd: fixtureRoot });
  runGit(['config', 'user.email', 'test@test.com'], { cwd: publisherDir });
  runGit(['config', 'user.name', 'Test User'], { cwd: publisherDir });
  fs.writeFileSync(path.join(publisherDir, 'test.txt'), 'remote content');
  runGit(['add', 'test.txt'], { cwd: publisherDir });
  runGit(['commit', '-m', 'Advance remote'], { cwd: publisherDir });
  runGit(['push', 'origin', 'dev'], { cwd: publisherDir });

  return {
    fixtureRoot,
    sourceDir,
    localSha: runGit(['rev-parse', 'dev'], { cwd: sourceDir }).trim(),
    remoteSha: runGit(['rev-parse', 'refs/heads/dev'], { cwd: remoteDir }).trim(),
  };
}

function findGitBinary() {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  throw new Error('Unable to locate the git executable');
}

function listTemporaryBaseRefs(repoDir) {
  return runGit(['for-each-ref', '--format=%(refname)', 'refs/zeroshot/base-fetch/'], {
    cwd: repoDir,
  })
    .trim()
    .split('\n')
    .filter(Boolean);
}

function createGitInterventionShim(
  fixtureRoot,
  { repoDir, sharedRefSha = null, failWorktreeAdd = false }
) {
  const shimDir = path.join(fixtureRoot, 'git-shim');
  const shimPath = path.join(shimDir, 'git');
  const realGit = findGitBinary();
  fs.mkdirSync(shimDir);

  const script = [
    '#!/usr/bin/env node',
    "const { spawnSync } = require('child_process');",
    `const realGit = ${JSON.stringify(realGit)};`,
    `const repoDir = ${JSON.stringify(repoDir)};`,
    `const sharedRefSha = ${JSON.stringify(sharedRefSha)};`,
    `const failWorktreeAdd = ${JSON.stringify(failWorktreeAdd)};`,
    'const args = process.argv.slice(2);',
    "if (args[0] === 'worktree' && args[1] === 'add') {",
    '  const refs = spawnSync(',
    '    realGit,',
    "    ['for-each-ref', '--format=%(refname)', 'refs/zeroshot/base-fetch/'],",
    "    { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }",
    '  );',
    '  if (refs.status !== 0 || refs.error || !refs.stdout.trim()) {',
    "    process.stderr.write('temporary base ref missing before worktree add\\n');",
    '    process.exit(97);',
    '  }',
    '  if (failWorktreeAdd) {',
    "    process.stderr.write('injected worktree add failure\\n');",
    '    process.exit(98);',
    '  }',
    '  if (sharedRefSha) {',
    '    const update = spawnSync(',
    '      realGit,',
    "      ['update-ref', 'refs/remotes/origin/dev', sharedRefSha],",
    "      { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }",
    '    );',
    '    if (update.status !== 0 || update.error) {',
    "      process.stderr.write(update.error?.message || update.stderr || 'ref update failed');",
    '      process.exit(96);',
    '    }',
    '  }',
    '}',
    "const child = spawnSync(realGit, args, { stdio: 'inherit' });",
    'if (child.error) {',
    '  process.stderr.write(child.error.message);',
    '  process.exit(1);',
    '}',
    'process.exit(child.status === null ? 1 : child.status);',
    '',
  ].join('\n');

  fs.writeFileSync(shimPath, script, { mode: 0o755 });
  return shimDir;
}

function registerRepositoryHooks() {
  before(function () {
    testRepoDir = createTempGitRepo('zs-worktree-test-repo-');
    manager = new IsolationManager();
  });

  afterEach(function () {
    try {
      manager.cleanupWorktreeIsolation(testClusterId);
    } catch {
      // Ignore cleanup errors
    }
  });

  after(function () {
    if (testRepoDir && fs.existsSync(testRepoDir)) {
      fs.rmSync(testRepoDir, { recursive: true, force: true });
    }
  });
}

function registerCreateWorktreeIsolationTests() {
  describe('createWorktreeIsolation()', function () {
    registerWorktreePathTest();
    registerWorktreeBranchTest();
    registerWorktreeRepoRootTest();
    registerWorktreeGitRepoTest();
    registerWorktreeContentTest();
    registerWorktreeBranchCheckoutTest();
    registerWorktreeCommitTest();
    registerWorktreeIsolationTest();
    registerWorktreeNonGitTest();
    registerWorktreeCleanupBeforeCreateTest();
    registerWorktreeSetupCommandTest();
    registerRemotePrBaseTests();
  });
}

function registerWorktreePathTest() {
  it('should create worktree at expected path', function () {
    const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

    assert(info.path, 'Should return worktree path');
    const expectedRoot = fs.realpathSync(path.join(os.homedir(), '.zeroshot', 'worktrees'));
    const worktreePath = fs.realpathSync(info.path);
    assert(
      worktreePath.startsWith(expectedRoot + path.sep),
      `Path should be in ${expectedRoot}${path.sep}`
    );
    assert(info.path.includes(testClusterId), 'Path should include cluster ID');
    assert(fs.existsSync(info.path), 'Worktree directory should exist');
  });
}

function registerWorktreeBranchTest() {
  it('should create branch with zeroshot/ prefix', function () {
    const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

    assert(info.branch, 'Should return branch name');
    assert(
      info.branch.startsWith('zeroshot/'),
      `Branch should start with zeroshot/, got: ${info.branch}`
    );

    const branches = runGit(['branch', '--list'], { cwd: testRepoDir });
    assert(branches.includes(info.branch), `Branch ${info.branch} should exist`);
  });
}

function registerWorktreeRepoRootTest() {
  it('should return correct repoRoot', function () {
    const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

    assert.strictEqual(
      fs.realpathSync(info.repoRoot),
      fs.realpathSync(testRepoDir),
      'repoRoot should match source directory'
    );
  });
}

function registerWorktreeGitRepoTest() {
  it('should create working git repo in worktree', function () {
    const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

    const gitDir = runGit(['rev-parse', '--git-dir'], { cwd: info.path }).trim();

    assert(gitDir.includes('.git/worktrees/'), `Should be a worktree, got git-dir: ${gitDir}`);
  });
}

function registerWorktreeContentTest() {
  it('should have same content as source repo', function () {
    const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

    const worktreeTestFile = path.join(info.path, 'test.txt');
    assert(fs.existsSync(worktreeTestFile), 'test.txt should exist in worktree');

    const content = fs.readFileSync(worktreeTestFile, 'utf8');
    assert.strictEqual(content, 'initial content', 'Content should match source');
  });
}

function registerWorktreeBranchCheckoutTest() {
  it('should be on the new branch', function () {
    const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

    const currentBranch = runGit(['branch', '--show-current'], { cwd: info.path }).trim();

    assert.strictEqual(currentBranch, info.branch, 'Worktree should be on the new branch');
  });
}

function registerWorktreeCommitTest() {
  it('should allow commits in worktree', function () {
    const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

    fs.writeFileSync(path.join(info.path, 'new-file.txt'), 'worktree content');

    runGit(['add', 'new-file.txt'], { cwd: info.path });
    runGit(['commit', '-m', 'Add new file in worktree'], { cwd: info.path });

    const log = runGit(['log', '--oneline'], { cwd: info.path });
    assert(log.includes('Add new file in worktree'), 'Commit should exist');
  });
}

function registerWorktreeIsolationTest() {
  it('should isolate changes from main repo', function () {
    const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

    fs.writeFileSync(path.join(info.path, 'isolated-file.txt'), 'isolated content');
    runGit(['add', 'isolated-file.txt'], { cwd: info.path });
    runGit(['commit', '-m', 'Isolated commit'], { cwd: info.path });

    assert(
      !fs.existsSync(path.join(testRepoDir, 'isolated-file.txt')),
      'Isolated file should NOT appear in main repo'
    );
  });
}

function registerWorktreeNonGitTest() {
  it('should throw for non-git directory', function () {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));

    try {
      manager.createWorktreeIsolation('test-fail', nonGitDir);
      assert.fail('Should throw for non-git directory');
    } catch (err) {
      assert(err.message.includes('git repository'), `Error should mention git: ${err.message}`);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
}

function registerWorktreeCleanupBeforeCreateTest() {
  it('should clean up existing worktree before creating', function () {
    const info1 = manager.createWorktreeIsolation(testClusterId, testRepoDir);
    const path1 = info1.path;

    fs.writeFileSync(path.join(path1, 'marker.txt'), 'first run');

    manager.worktrees.delete(testClusterId);

    const info2 = manager.createWorktreeIsolation(testClusterId, testRepoDir);

    assert(
      !fs.existsSync(path.join(info2.path, 'marker.txt')),
      'Old marker should be removed (fresh worktree)'
    );
  });
}

function registerWorktreeSetupCommandTest() {
  it('should run worktree.setup command from repo settings', function () {
    const settingsDir = path.join(testRepoDir, '.zeroshot');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ worktree: { setup: 'touch setup-ran.marker' } })
    );
    runGit(['add', '.zeroshot/settings.json'], { cwd: testRepoDir });
    runGit(['commit', '-m', 'Add zeroshot settings'], { cwd: testRepoDir });

    const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);

    const markerPath = path.join(info.path, 'setup-ran.marker');
    assert(fs.existsSync(markerPath), 'Setup command should have created marker file in worktree');
  });

  it('should honor worktree.setupTimeoutMs from repo settings', function () {
    const timeoutRepoDir = createTempGitRepo('zs-worktree-timeout-repo-');
    const timeoutClusterId = 'test-worktree-timeout-' + Date.now();
    const timeoutManager = new IsolationManager();
    const settingsDir = path.join(timeoutRepoDir, '.zeroshot');
    const worktreePath = path.join(os.homedir(), '.zeroshot', 'worktrees', timeoutClusterId);

    try {
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({
          worktree: {
            setup: `${shellQuote(process.execPath)} -e "setTimeout(() => {}, 1000)"`,
            setupTimeoutMs: 50,
          },
        })
      );
      runGit(['add', '.zeroshot/settings.json'], { cwd: timeoutRepoDir });
      runGit(['commit', '-m', 'Add timeout settings'], { cwd: timeoutRepoDir });

      assert.throws(
        () => timeoutManager.createWorktreeIsolation(timeoutClusterId, timeoutRepoDir),
        /ETIMEDOUT|timed out|SIGTERM|spawnSync/,
        'Setup command should be killed by the repo-configured timeout'
      );
    } finally {
      try {
        runGit(['worktree', 'remove', '--force', worktreePath], { cwd: timeoutRepoDir });
      } catch {
        // Ignore cleanup errors after timeout races.
      }
      try {
        runGit(['worktree', 'prune'], { cwd: timeoutRepoDir });
      } catch {
        // Ignore cleanup errors.
      }
      fs.rmSync(timeoutRepoDir, { recursive: true, force: true });
    }
  });
}

function registerRemotePrBaseTests() {
  it('fetches the remote commit for direct and detached-derived PR options', async function () {
    const orchestrator = new Orchestrator({ quiet: true, skipLoad: true });
    const originalRunOptions = process.env.ZEROSHOT_RUN_OPTIONS;
    const originalCwd = process.env.ZEROSHOT_CWD;

    try {
      const modes = [
        {
          name: 'direct',
          buildOptions: (fixture) => ({
            cwd: fixture.sourceDir,
            worktree: true,
            prBase: 'dev',
          }),
        },
        {
          name: 'detached-derived',
          buildOptions: (fixture) => {
            process.env.ZEROSHOT_CWD = fixture.sourceDir;
            process.env.ZEROSHOT_RUN_OPTIONS = JSON.stringify({
              ship: true,
              prBase: 'dev',
            });
            return buildStartOptions({
              clusterId: 'detached-remote-pr-base',
              options: {},
              settings: {},
            });
          },
        },
      ];

      for (const mode of modes) {
        const fixture = createStaleRemoteBaseFixture(`zs-${mode.name}-remote-pr-base-`);
        const clusterId = `test-${mode.name}-remote-pr-base-${Date.now()}`;

        assert.notStrictEqual(fixture.localSha, fixture.remoteSha, 'local dev must be stale');

        let result;
        try {
          result = await orchestrator._initializeIsolation(
            mode.buildOptions(fixture),
            {},
            clusterId
          );
          const worktreeSha = runGit(['rev-parse', 'HEAD'], {
            cwd: result.worktreeInfo.path,
          }).trim();
          assert.strictEqual(
            worktreeSha,
            fixture.remoteSha,
            `${mode.name} worktree must start at the fetched origin/dev commit`
          );
          assert.strictEqual(result.worktreeInfo.baseRef, 'origin/dev');
          assert.strictEqual(result.worktreeInfo.baseSha, fixture.remoteSha);
          assert.deepStrictEqual(listTemporaryBaseRefs(fixture.sourceDir), []);
        } finally {
          if (result) {
            result.isolationManager.cleanupWorktreeIsolation(clusterId);
          }
          fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
        }
      }
    } finally {
      orchestrator.close();
      if (originalRunOptions === undefined) delete process.env.ZEROSHOT_RUN_OPTIONS;
      else process.env.ZEROSHOT_RUN_OPTIONS = originalRunOptions;
      if (originalCwd === undefined) delete process.env.ZEROSHOT_CWD;
      else process.env.ZEROSHOT_CWD = originalCwd;
    }
  });

  it('resolves a remote base through its full ref without updating the shared tracking ref', function () {
    const fixture = createStaleRemoteBaseFixture('zs-shadowed-pr-base-');
    const clusterId = `test-shadowed-remote-pr-base-${Date.now()}`;
    const remoteManager = new IsolationManager();

    try {
      runGit(['branch', 'origin/dev', fixture.localSha], { cwd: fixture.sourceDir });

      const info = remoteManager.createWorktreeIsolation(clusterId, fixture.sourceDir, {
        baseRef: 'origin/dev',
        requireFreshBase: true,
      });
      const worktreeSha = runGit(['rev-parse', 'HEAD'], { cwd: info.path }).trim();
      const localShadowSha = runGit(['rev-parse', 'refs/heads/origin/dev^{commit}'], {
        cwd: fixture.sourceDir,
      }).trim();
      const remoteTrackingSha = runGit(['rev-parse', 'refs/remotes/origin/dev^{commit}'], {
        cwd: fixture.sourceDir,
      }).trim();

      assert.strictEqual(localShadowSha, fixture.localSha);
      assert.strictEqual(remoteTrackingSha, fixture.localSha);
      assert.strictEqual(info.baseSha, fixture.remoteSha);
      assert.strictEqual(worktreeSha, fixture.remoteSha);
      assert.deepStrictEqual(listTemporaryBaseRefs(fixture.sourceDir), []);
    } finally {
      remoteManager.cleanupWorktreeIsolation(clusterId);
      fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when the requested remote base cannot be refreshed', function () {
    const fixture = createStaleRemoteBaseFixture('zs-unavailable-pr-base-');
    const clusterId = `test-unavailable-remote-pr-base-${Date.now()}`;
    const unavailableRemote = path.join(fixture.fixtureRoot, 'missing-origin.git');
    const remoteManager = new IsolationManager();

    try {
      runGit(['remote', 'set-url', 'origin', unavailableRemote], { cwd: fixture.sourceDir });
      assert.throws(
        () =>
          remoteManager.createWorktreeIsolation(clusterId, fixture.sourceDir, {
            baseRef: 'origin/dev',
            requireFreshBase: true,
          }),
        /Command git failed/,
        'an unavailable remote must not fall back to a stale origin/dev ref'
      );
      assert.deepStrictEqual(listTemporaryBaseRefs(fixture.sourceDir), []);
    } finally {
      remoteManager.cleanupWorktreeIsolation(clusterId);
      fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('uses a cached remote-tracking ref for offline repository worktree settings', function () {
    const fixture = createStaleRemoteBaseFixture('zs-offline-repo-base-');
    const clusterId = `test-offline-repo-base-${Date.now()}`;
    const unavailableRemote = path.join(fixture.fixtureRoot, 'missing-origin.git');
    const remoteManager = new IsolationManager();
    const settingsDir = path.join(fixture.sourceDir, '.zeroshot');

    try {
      fs.mkdirSync(settingsDir);
      fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({ worktree: { baseRef: 'origin/dev' } })
      );
      runGit(['add', '.zeroshot/settings.json'], { cwd: fixture.sourceDir });
      runGit(['commit', '-m', 'Add worktree base setting'], { cwd: fixture.sourceDir });
      runGit(['remote', 'set-url', 'origin', unavailableRemote], { cwd: fixture.sourceDir });

      const info = remoteManager.createWorktreeIsolation(clusterId, fixture.sourceDir);
      const worktreeSha = runGit(['rev-parse', 'HEAD'], { cwd: info.path }).trim();

      assert.strictEqual(info.baseRef, 'origin/dev');
      assert.strictEqual(info.baseSha, fixture.localSha);
      assert.strictEqual(worktreeSha, fixture.localSha);
      assert.deepStrictEqual(listTemporaryBaseRefs(fixture.sourceDir), []);
    } finally {
      remoteManager.cleanupWorktreeIsolation(clusterId);
      fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps the captured PR base when the shared remote-tracking ref changes', function () {
    if (process.platform === 'win32') {
      this.skip();
    }

    const fixture = createStaleRemoteBaseFixture('zs-concurrent-pr-base-');
    const clusterId = `test-concurrent-remote-pr-base-${Date.now()}`;
    const remoteManager = new IsolationManager();
    const originalPath = process.env.PATH;
    const treeSha = runGit(['rev-parse', `${fixture.localSha}^{tree}`], {
      cwd: fixture.sourceDir,
    }).trim();
    const interferenceSha = runGit(
      ['commit-tree', treeSha, '-p', fixture.localSha, '-m', 'Interference commit'],
      { cwd: fixture.sourceDir }
    ).trim();
    const shimDir = createGitInterventionShim(fixture.fixtureRoot, {
      repoDir: fixture.sourceDir,
      sharedRefSha: interferenceSha,
    });

    try {
      process.env.PATH = `${shimDir}${path.delimiter}${originalPath || ''}`;
      const info = remoteManager.createWorktreeIsolation(clusterId, fixture.sourceDir, {
        baseRef: 'origin/dev',
        requireFreshBase: true,
      });
      process.env.PATH = originalPath;

      const worktreeSha = runGit(['rev-parse', 'HEAD'], { cwd: info.path }).trim();
      const remoteTrackingSha = runGit(['rev-parse', 'refs/remotes/origin/dev^{commit}'], {
        cwd: fixture.sourceDir,
      }).trim();

      assert.strictEqual(remoteTrackingSha, interferenceSha);
      assert.strictEqual(info.baseSha, fixture.remoteSha);
      assert.strictEqual(worktreeSha, fixture.remoteSha);
      assert.deepStrictEqual(listTemporaryBaseRefs(fixture.sourceDir), []);
    } finally {
      process.env.PATH = originalPath;
      remoteManager.cleanupWorktreeIsolation(clusterId);
      fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('does not contend on the shared remote-tracking ref when refreshing a PR base', function () {
    if (process.platform === 'win32') {
      this.skip();
    }

    const fixture = createStaleRemoteBaseFixture('zs-locked-remote-pr-base-');
    const clusterId = `test-locked-remote-pr-base-${Date.now()}`;
    const remoteManager = new IsolationManager();
    const gitDirValue = runGit(['rev-parse', '--git-dir'], { cwd: fixture.sourceDir }).trim();
    const gitDir = path.resolve(fixture.sourceDir, gitDirValue);
    const sharedRefLock = path.join(gitDir, 'refs', 'remotes', 'origin', 'dev.lock');
    const fetchHeadPath = path.join(gitDir, 'FETCH_HEAD');
    const fetchHeadBefore = fs.existsSync(fetchHeadPath)
      ? fs.readFileSync(fetchHeadPath, 'utf8')
      : null;

    try {
      fs.writeFileSync(sharedRefLock, 'held by concurrent fetch\n');

      const info = remoteManager.createWorktreeIsolation(clusterId, fixture.sourceDir, {
        baseRef: 'origin/dev',
        requireFreshBase: true,
      });
      const worktreeSha = runGit(['rev-parse', 'HEAD'], { cwd: info.path }).trim();
      const remoteTrackingSha = runGit(['rev-parse', 'refs/remotes/origin/dev^{commit}'], {
        cwd: fixture.sourceDir,
      }).trim();
      const fetchHeadAfter = fs.existsSync(fetchHeadPath)
        ? fs.readFileSync(fetchHeadPath, 'utf8')
        : null;

      assert.strictEqual(remoteTrackingSha, fixture.localSha);
      assert.strictEqual(info.baseSha, fixture.remoteSha);
      assert.strictEqual(worktreeSha, fixture.remoteSha);
      assert.strictEqual(fetchHeadAfter, fetchHeadBefore);
      assert.deepStrictEqual(listTemporaryBaseRefs(fixture.sourceDir), []);
    } finally {
      fs.rmSync(sharedRefLock, { force: true });
      remoteManager.cleanupWorktreeIsolation(clusterId);
      fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('removes the temporary PR base ref when worktree creation fails', function () {
    if (process.platform === 'win32') {
      this.skip();
    }

    const fixture = createStaleRemoteBaseFixture('zs-failed-pr-base-');
    const clusterId = `test-failed-remote-pr-base-${Date.now()}`;
    const remoteManager = new IsolationManager();
    const originalPath = process.env.PATH;
    const shimDir = createGitInterventionShim(fixture.fixtureRoot, {
      repoDir: fixture.sourceDir,
      failWorktreeAdd: true,
    });
    const worktreePath = path.join(os.homedir(), '.zeroshot', 'worktrees', clusterId);

    try {
      process.env.PATH = `${shimDir}${path.delimiter}${originalPath || ''}`;
      assert.throws(
        () =>
          remoteManager.createWorktreeIsolation(clusterId, fixture.sourceDir, {
            baseRef: 'origin/dev',
            requireFreshBase: true,
          }),
        /injected worktree add failure/,
        'worktree creation should surface the original failure'
      );
      process.env.PATH = originalPath;

      assert.deepStrictEqual(listTemporaryBaseRefs(fixture.sourceDir), []);
      assert.strictEqual(fs.existsSync(worktreePath), false);
    } finally {
      process.env.PATH = originalPath;
      remoteManager.cleanupWorktreeIsolation(clusterId);
      fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });
}

function registerCleanupWorktreeIsolationTests() {
  describe('cleanupWorktreeIsolation()', function () {
    registerCleanupWorktreeDirectoryTest();
    registerCleanupWorktreeTrackingTest();
    registerCleanupWorktreeBranchTest();
    registerCleanupWorktreeIdempotentTest();
    registerCleanupWorktreeMissingTest();
  });
}

function registerCleanupWorktreeDirectoryTest() {
  it('should remove worktree directory', function () {
    const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);
    const worktreePath = info.path;

    assert(fs.existsSync(worktreePath), 'Worktree should exist before cleanup');

    manager.cleanupWorktreeIsolation(testClusterId);

    assert(!fs.existsSync(worktreePath), 'Worktree directory should be removed');
  });
}

function registerCleanupWorktreeTrackingTest() {
  it('should remove worktree from git tracking', function () {
    manager.createWorktreeIsolation(testClusterId, testRepoDir);

    const beforeList = runGit(['worktree', 'list'], { cwd: testRepoDir });
    assert(beforeList.includes(testClusterId), 'Worktree should be tracked before cleanup');

    manager.cleanupWorktreeIsolation(testClusterId);

    const afterList = runGit(['worktree', 'list'], { cwd: testRepoDir });
    assert(!afterList.includes(testClusterId), 'Worktree should not be tracked after cleanup');
  });
}

function registerCleanupWorktreeBranchTest() {
  it('should preserve branch by default', function () {
    const info = manager.createWorktreeIsolation(testClusterId, testRepoDir);
    const branchName = info.branch;

    manager.cleanupWorktreeIsolation(testClusterId);

    const branches = runGit(['branch', '--list'], { cwd: testRepoDir });
    assert(branches.includes(branchName), 'Branch should be preserved after cleanup');
  });
}

function registerCleanupWorktreeIdempotentTest() {
  it('should be idempotent (no error on double cleanup)', function () {
    manager.createWorktreeIsolation(testClusterId, testRepoDir);

    manager.cleanupWorktreeIsolation(testClusterId);

    manager.cleanupWorktreeIsolation(testClusterId);
  });
}

function registerCleanupWorktreeMissingTest() {
  it('should not error for non-existent worktree', function () {
    manager.cleanupWorktreeIsolation('non-existent-cluster-xyz');
  });
}

function registerGetWorktreeInfoTests() {
  describe('getWorktreeInfo()', function () {
    registerGetWorktreeInfoAfterCreateTest();
    registerGetWorktreeInfoMissingTest();
    registerGetWorktreeInfoAfterCleanupTest();
  });
}

function registerGetWorktreeInfoAfterCreateTest() {
  it('should return worktree info after creation', function () {
    manager.createWorktreeIsolation(testClusterId, testRepoDir);

    const info = manager.getWorktreeInfo(testClusterId);

    assert(info, 'Should return info');
    assert(info.path, 'Should have path');
    assert(info.branch, 'Should have branch');
    assert(info.repoRoot, 'Should have repoRoot');
  });
}

function registerGetWorktreeInfoMissingTest() {
  it('should return undefined for non-existent cluster', function () {
    const info = manager.getWorktreeInfo('non-existent-xyz');

    assert.strictEqual(info, undefined, 'Should return undefined');
  });
}

function registerGetWorktreeInfoAfterCleanupTest() {
  it('should return undefined after cleanup', function () {
    manager.createWorktreeIsolation(testClusterId, testRepoDir);
    manager.cleanupWorktreeIsolation(testClusterId);

    const info = manager.getWorktreeInfo(testClusterId);

    assert.strictEqual(info, undefined, 'Should return undefined after cleanup');
  });
}

function registerWorktreePerformanceTests() {
  describe('Performance', function () {
    it('should create worktree in under 1 second', function () {
      const startTime = Date.now();

      manager.createWorktreeIsolation(testClusterId, testRepoDir);

      const elapsed = Date.now() - startTime;

      assert(elapsed < 1000, `Worktree creation should be <1s, took ${elapsed}ms`);
    });
  });
}

describe('IsolationManager - Worktree Mode', function () {
  this.timeout(30000);

  registerRepositoryHooks();
  registerCreateWorktreeIsolationTests();
  registerCleanupWorktreeIsolationTests();
  registerGetWorktreeInfoTests();
  registerWorktreePerformanceTests();
});
