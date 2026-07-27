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

const SHIM_DIR_SUFFIX = path.join('.zeroshot', 'keychain-shim');

// The shim is a POSIX sh script; process-level tests cannot run on Windows.
const describeExec = process.platform === 'win32' ? describe.skip : describe;

function writeFakeRealSecurity(dir, { exitCode = 0 } = {}) {
  const logFile = path.join(dir, 'real-security-invocations.log');
  const fakePath = path.join(dir, 'fake-real-security');
  fs.writeFileSync(fakePath, `#!/bin/sh\necho "argv: $*" >> "${logFile}"\nexit ${exitCode}\n`, {
    mode: 0o755,
  });
  fs.chmodSync(fakePath, 0o755);
  return { fakePath, logFile };
}

describe('darwin worker Keychain boundary (issue #704)', function () {
  /** @type {string[]} */
  let tempDirs = [];

  function makeTempDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(function () {
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
    // Docker isolation is unaffected by design: spawnClaudeTask returns through
    // spawnClaudeTaskIsolated before buildSpawnEnv runs, so the shim only ever
    // reaches local/worktree workers.
    it('buildSpawnEnv installs the boundary for darwin local/worktree workers only', function () {
      assert.strictEqual(
        typeof executor.buildSpawnEnv,
        'function',
        'agent-task-executor must expose buildSpawnEnv with the darwin Keychain boundary; ' +
          'without it, darwin local/worktree worker spawn envs resolve `security` straight to ' +
          '/usr/bin/security and interactive `security -i` descendants are not intercepted'
      );

      const cwd = makeTempDir('zeroshot-keychain-agent-cwd-');
      const spawnEnv = executor.buildSpawnEnv({ config: { cwd } }, 'codex', {
        model: 'gpt-5-codex',
      });

      const entries = (spawnEnv.PATH || '').split(path.delimiter);
      const shimIndex = entries.findIndex((entry) => entry.endsWith(SHIM_DIR_SUFFIX));

      if (process.platform === 'darwin') {
        assert.notStrictEqual(shimIndex, -1, 'darwin spawn env must contain the security shim');
        assert.ok(fs.existsSync(path.join(entries[shimIndex], 'security')));
        const usrBinIndex = entries.indexOf('/usr/bin');
        if (usrBinIndex !== -1) {
          assert.ok(
            shimIndex < usrBinIndex,
            'the shim must shadow /usr/bin/security in PATH resolution'
          );
        }
      } else {
        assert.strictEqual(shimIndex, -1, 'non-darwin spawn envs must not contain the shim');
      }
    });

    it('ClaudeTaskRunner._buildSpawnEnv applies the same boundary', function () {
      const cwd = makeTempDir('zeroshot-keychain-runner-cwd-');
      const runner = new ClaudeTaskRunner({ quiet: true });
      const spawnEnv = runner._buildSpawnEnv('codex', null, { cwd });

      const entries = (spawnEnv.PATH || '').split(path.delimiter);
      const shimIndex = entries.findIndex((entry) => entry.endsWith(SHIM_DIR_SUFFIX));

      if (process.platform === 'darwin') {
        assert.notStrictEqual(shimIndex, -1);
      } else {
        assert.strictEqual(shimIndex, -1);
      }
    });
  });
});
