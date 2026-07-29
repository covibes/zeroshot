const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Issue #704: local/worktree workers on macOS inherit the host environment, so
// worker descendants (e.g. `claude doctor` probing Keychain writes through
// `security -i`) reach the logged-in user's GUI Keychain session and launch
// SecurityAgent dialogs from a supposedly non-interactive cluster.
//
// The boundary module is absent on unfixed builds; keep the require lazy so the
// remaining assertions can report the defect instead of crashing the file.
let boundary = null;
try {
  boundary = require('../../src/darwin-keychain-boundary');
} catch {
  // Missing module: worker spawn envs carry no Keychain boundary.
}

const executor = require('../../src/agent/agent-task-executor');
const ClaudeTaskRunner = require('../../src/claude-task-runner');

// The shim is a POSIX sh script; process-level tests cannot run on Windows.
const describeExec = process.platform === 'win32' ? describe.skip : describe;

function writeFakeRealSecurity(dir, { exitCode = 0, fileName = 'fake-real-security' } = {}) {
  const logFile = path.join(dir, 'real-security-invocations.log');
  const fakePath = path.join(dir, fileName);
  fs.writeFileSync(fakePath, `#!/bin/sh\necho "argv: $*" >> "${logFile}"\nexit ${exitCode}\n`, {
    mode: 0o755,
  });
  fs.chmodSync(fakePath, 0o755);
  return { fakePath, logFile };
}

describe('darwin worker Keychain boundary (issue #704)', function () {
  /** @type {string[]} */
  let tempDirs = [];
  let originalPath;

  function makeTempDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(function () {
    originalPath = process.env.PATH;
  });

  afterEach(function () {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ships a Keychain boundary module for darwin worker spawns', function () {
    assert.ok(
      boundary,
      'src/darwin-keychain-boundary is missing: local/worktree worker spawn envs have no ' +
        'Keychain boundary, so darwin worker descendants can open the interactive GUI ' +
        'Keychain session (SecurityAgent) via `security -i`'
    );
  });

  describe('applyDarwinKeychainBoundaryToEnv', function () {
    before(function () {
      if (!boundary) this.skip();
    });

    it('leaves non-darwin platforms untouched (no shim installed)', function () {
      const shimBaseDir = path.join(makeTempDir('zeroshot-keychain-shim-'), 'shim');
      const env = { PATH: `/usr/bin${path.delimiter}/bin` };

      const result = boundary.applyDarwinKeychainBoundaryToEnv(env, {
        platform: 'linux',
        shimBaseDir,
      });

      assert.strictEqual(result.PATH, `/usr/bin${path.delimiter}/bin`);
      assert.ok(!fs.existsSync(shimBaseDir), 'no shim directory may be created off darwin');
    });

    it('prepends the managed security shim to PATH for darwin spawn envs', function () {
      const shimBaseDir = path.join(makeTempDir('zeroshot-keychain-shim-'), 'shim');
      const env = { PATH: `/usr/bin${path.delimiter}/bin` };

      boundary.applyDarwinKeychainBoundaryToEnv(env, { platform: 'darwin', shimBaseDir });

      const entries = env.PATH.split(path.delimiter);
      assert.strictEqual(entries[0], shimBaseDir);
      assert.ok(entries.includes('/usr/bin'));

      const shimSecurity = path.join(shimBaseDir, 'security');
      assert.ok(fs.existsSync(shimSecurity), 'shim must provide a `security` executable');
      fs.accessSync(shimSecurity, fs.constants.X_OK);

      // Applying twice must not duplicate the PATH entry.
      boundary.applyDarwinKeychainBoundaryToEnv(env, { platform: 'darwin', shimBaseDir });
      const dedupedEntries = env.PATH.split(path.delimiter);
      assert.strictEqual(dedupedEntries.filter((entry) => entry === shimBaseDir).length, 1);
    });

    it('updates the exact PATH key when differently-cased keys coexist', function () {
      const shimBaseDir = path.join(makeTempDir('zeroshot-keychain-shim-'), 'shim');
      const env = {
        Path: `/unrelated${path.delimiter}/case-insensitive-only`,
        PATH: `/usr/bin${path.delimiter}/bin`,
      };

      boundary.applyDarwinKeychainBoundaryToEnv(env, { platform: 'darwin', shimBaseDir });

      assert.strictEqual(env.Path, `/unrelated${path.delimiter}/case-insensitive-only`);
      assert.deepStrictEqual(env.PATH.split(path.delimiter), [shimBaseDir, '/usr/bin', '/bin']);
    });

    it('preserves empty PATH components while removing only duplicate shim entries', function () {
      const shimBaseDir = path.join(makeTempDir('zeroshot-keychain-shim-'), 'shim');
      const env = {
        PATH: ['/usr/bin', '', shimBaseDir, '/bin', '', shimBaseDir].join(path.delimiter),
      };

      boundary.applyDarwinKeychainBoundaryToEnv(env, { platform: 'darwin', shimBaseDir });

      assert.deepStrictEqual(env.PATH.split(path.delimiter), [
        shimBaseDir,
        '/usr/bin',
        '',
        '/bin',
        '',
      ]);
    });

    it('distinguishes an unset PATH from an explicitly empty PATH', function () {
      const unsetShimDir = path.join(makeTempDir('zeroshot-keychain-shim-unset-'), 'shim');
      const emptyShimDir = path.join(makeTempDir('zeroshot-keychain-shim-empty-'), 'shim');
      const unsetEnv = {};
      const emptyEnv = { PATH: '' };

      boundary.applyDarwinKeychainBoundaryToEnv(unsetEnv, {
        platform: 'darwin',
        shimBaseDir: unsetShimDir,
      });
      boundary.applyDarwinKeychainBoundaryToEnv(emptyEnv, {
        platform: 'darwin',
        shimBaseDir: emptyShimDir,
      });

      assert.strictEqual(
        unsetEnv.PATH,
        [unsetShimDir, '/usr/bin', '/bin'].join(path.delimiter)
      );
      assert.strictEqual(emptyEnv.PATH, `${emptyShimDir}${path.delimiter}`);
    });

    it('honors the ZEROSHOT_ALLOW_INTERACTIVE_KEYCHAIN opt-out', function () {
      const shimBaseDir = path.join(makeTempDir('zeroshot-keychain-shim-'), 'shim');
      const env = {
        PATH: `/usr/bin${path.delimiter}/bin`,
        ZEROSHOT_ALLOW_INTERACTIVE_KEYCHAIN: '1',
      };

      boundary.applyDarwinKeychainBoundaryToEnv(env, { platform: 'darwin', shimBaseDir });

      assert.strictEqual(env.PATH, `/usr/bin${path.delimiter}/bin`);
      assert.ok(!fs.existsSync(shimBaseDir));
    });
  });

  describe('atomic shim publication', function () {
    before(function () {
      if (!boundary) this.skip();
    });

    it('keeps the live shim intact and cleans the temporary file when rename fails', function () {
      const shimBaseDir = path.join(makeTempDir('zeroshot-keychain-shim-atomic-'), 'shim');
      const shimPath = path.join(shimBaseDir, 'security');
      const existingScript = '#!/bin/sh\nexit 42\n';
      fs.mkdirSync(shimBaseDir, { recursive: true });
      fs.writeFileSync(shimPath, existingScript, { mode: 0o755 });

      const originalRenameSync = fs.renameSync;
      fs.renameSync = function failShimPublish(sourcePath, destinationPath) {
        if (destinationPath === shimPath) {
          throw new Error(`simulated atomic publish failure for ${path.basename(sourcePath)}`);
        }
        return originalRenameSync(sourcePath, destinationPath);
      };

      try {
        assert.throws(
          () =>
            boundary.ensureDarwinKeychainShimDir({
              shimBaseDir,
              realSecurityPath: '/different/security',
            }),
          /simulated atomic publish failure/
        );
      } finally {
        fs.renameSync = originalRenameSync;
      }

      assert.strictEqual(fs.readFileSync(shimPath, 'utf8'), existingScript);
      assert.deepStrictEqual(fs.readdirSync(shimBaseDir), ['security']);
    });
  });

  describeExec('security shim process behavior', function () {
    before(function () {
      if (!boundary) this.skip();
    });

    function installShim({ exitCode = 0 } = {}) {
      const base = makeTempDir('zeroshot-keychain-shim-');
      const { fakePath, logFile } = writeFakeRealSecurity(base, { exitCode });
      const shimBaseDir = path.join(base, 'shim');
      boundary.ensureDarwinKeychainShimDir({ shimBaseDir, realSecurityPath: fakePath });
      return { shimSecurity: path.join(shimBaseDir, 'security'), logFile };
    }

    it('fails closed on `security -i` without invoking the real binary', function () {
      const { shimSecurity, logFile } = installShim();

      const result = spawnSync(shimSecurity, ['-i'], {
        encoding: 'utf8',
        input:
          'add-generic-password -U -a "unknown" -s "Claude Code-doctor-probe" -X "70726f6265"\n',
      });

      assert.notStrictEqual(result.status, 0, 'interactive invocation must fail');
      assert.match(result.stderr, /non-interactive worker/);
      assert.match(result.stderr, /Docker isolation/);
      assert.ok(!fs.existsSync(logFile), 'the real security binary must never be invoked');
    });

    it('fails closed when invoked with no arguments (implicit interactive mode)', function () {
      const { shimSecurity, logFile } = installShim();

      const result = spawnSync(shimSecurity, [], { encoding: 'utf8', input: '' });

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /non-interactive worker/);
      assert.ok(!fs.existsSync(logFile));
    });

    it('fails closed on `-p` prompts and bundled interactive flags', function () {
      const { shimSecurity, logFile } = installShim();

      for (const argv of [['-p', 'custom prompt'], ['-qi']]) {
        const result = spawnSync(shimSecurity, argv, { encoding: 'utf8' });
        assert.notStrictEqual(result.status, 0, `argv ${argv.join(' ')} must fail`);
        assert.match(result.stderr, /non-interactive worker/);
      }
      assert.ok(!fs.existsSync(logFile));
    });

    it('transparently passes non-interactive subcommands to the real binary', function () {
      const { shimSecurity, logFile } = installShim();

      const result = spawnSync(
        shimSecurity,
        ['find-generic-password', '-s', 'zeroshot-test-service'],
        { encoding: 'utf8' }
      );

      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stderr, '');
      assert.match(
        fs.readFileSync(logFile, 'utf8'),
        /argv: find-generic-password -s zeroshot-test-service/
      );
    });

    it('stops flag scanning at the subcommand and preserves the exit code', function () {
      const { shimSecurity, logFile } = installShim({ exitCode: 3 });

      // `find-identity` contains the letter i and -p follows the subcommand;
      // neither may be mistaken for interactive mode.
      const result = spawnSync(shimSecurity, ['-q', 'find-identity', '-p', 'codesigning'], {
        encoding: 'utf8',
      });

      assert.strictEqual(result.status, 3, 'the real binary exit code must propagate');
      assert.match(fs.readFileSync(logFile, 'utf8'), /argv: -q find-identity -p codesigning/);
    });
  });

  describe('worker spawn env integration', function () {
    function createProductionFixture() {
      const worktreeRoot = makeTempDir('zeroshot-keychain-worktree-');
      const toolBinDir = path.join(worktreeRoot, '.zeroshot', 'bin');
      const fallbackBinDir = path.join(worktreeRoot, 'fallback-bin');
      const cwd = path.join(worktreeRoot, 'nested', 'cwd');
      const shimBaseDir = path.join(worktreeRoot, 'managed-keychain-shim');
      fs.mkdirSync(toolBinDir, { recursive: true });
      fs.mkdirSync(fallbackBinDir, { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(
        path.join(worktreeRoot, '.zeroshot', 'tooling-env.json'),
        JSON.stringify({ version: 1, worktreeRoot, toolBinDir }),
        'utf8'
      );
      fs.writeFileSync(path.join(worktreeRoot, '.git'), 'gitdir: test\n', 'utf8');
      const { fakePath, logFile } = writeFakeRealSecurity(fallbackBinDir, {
        fileName: 'security',
      });

      return {
        worktreeRoot,
        toolBinDir,
        fallbackBinDir,
        cwd,
        shimBaseDir,
        fakePath,
        logFile,
      };
    }

    function injectDarwinBoundary(fixture) {
      return (env) =>
        boundary.applyDarwinKeychainBoundaryToEnv(env, {
          platform: 'darwin',
          shimBaseDir: fixture.shimBaseDir,
          realSecurityPath: fixture.fakePath,
        });
    }

    function runPathResolvedInteractiveSecurityGrandchild(spawnEnv) {
      const workerScript = `
        const { spawnSync } = require('child_process');
        const result = spawnSync('security', ['-i'], { encoding: 'utf8' });
        process.stdout.write(JSON.stringify({
          status: result.status,
          stderr: result.stderr,
          errorCode: result.error ? result.error.code : null,
        }));
      `;
      const worker = spawnSync(process.execPath, ['-e', workerScript], {
        encoding: 'utf8',
        env: spawnEnv,
      });

      assert.strictEqual(worker.status, 0, worker.stderr);
      return JSON.parse(worker.stdout);
    }

    function assertProductionBoundary(spawnEnv, fixture) {
      const grandchild = runPathResolvedInteractiveSecurityGrandchild(spawnEnv);
      assert.strictEqual(grandchild.errorCode, null);
      assert.strictEqual(grandchild.status, 1);
      assert.match(grandchild.stderr, /blocked interactive 'security' invocation/);
      assert.ok(
        !fs.existsSync(fixture.logFile),
        'PATH resolution must reach the blocking shim, not the fallback security executable'
      );

      assert.deepStrictEqual(spawnEnv.PATH.split(path.delimiter).slice(0, 3), [
        fixture.toolBinDir,
        fixture.shimBaseDir,
        fixture.fallbackBinDir,
      ]);
    }

    // Docker isolation is unaffected by design: spawnClaudeTask returns through
    // spawnClaudeTaskIsolated before buildSpawnEnv runs, so the shim only ever
    // reaches local/worktree workers.
    it('buildSpawnEnv enforces the darwin boundary through the real worktree PATH', function () {
      assert.strictEqual(
        typeof executor.buildSpawnEnv,
        'function',
        'agent-task-executor must expose buildSpawnEnv with the darwin Keychain boundary; ' +
          'without it, darwin local/worktree worker spawn envs resolve `security` straight to ' +
          '/usr/bin/security and interactive `security -i` descendants are not intercepted'
      );

      const fixture = createProductionFixture();
      process.env.PATH = fixture.fallbackBinDir;
      const spawnEnv = executor.buildSpawnEnv(
        {
          config: { cwd: fixture.cwd },
          worktree: { enabled: true, path: fixture.worktreeRoot },
        },
        'codex',
        { model: 'gpt-5-codex' },
        { applyDarwinKeychainBoundary: injectDarwinBoundary(fixture) }
      );

      assertProductionBoundary(spawnEnv, fixture);
    });

    it('ClaudeTaskRunner._buildSpawnEnv enforces the same production boundary', function () {
      const fixture = createProductionFixture();
      process.env.PATH = fixture.fallbackBinDir;
      const runner = new ClaudeTaskRunner({
        quiet: true,
        applyDarwinKeychainBoundary: injectDarwinBoundary(fixture),
      });
      const spawnEnv = runner._buildSpawnEnv('codex', null, {
        cwd: fixture.cwd,
        worktreePath: fixture.worktreeRoot,
      });

      assertProductionBoundary(spawnEnv, fixture);
    });
  });
});
