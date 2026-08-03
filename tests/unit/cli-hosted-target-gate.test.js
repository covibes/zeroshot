/**
 * Test: hosted target/capsule commands are gated out of the production CLI
 *
 * Issue #919 — the public CLI must not expose target/capsule commands or
 * flags until an explicit MVP cutover registers them. This covers:
 *   - no `target`/`capsule`/`--target`/`--all-targets` surface in any help output
 *   - unknown-command/unknown-option rejection before any side effect
 *   - the default-command rewrite no longer silently turns `zeroshot target`
 *     into a real `run` invocation
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CLI_PATH = path.resolve(__dirname, '..', '..', 'cli', 'index.js');
const HOSTED_REGISTRATION_PATH = require.resolve('../../lib/target/register-hosted-commands');
const { program: productionProgram } = require('commander');
require('../../cli/index.js');

function collectCommandTree(command, pathParts = []) {
  const currentPath = [...pathParts, command.name()].filter(Boolean);
  return [
    { command, path: currentPath.join(' ') || '<root>' },
    ...command.commands.flatMap((child) => collectCommandTree(child, currentPath)),
  ];
}

const productionCommands = collectCommandTree(productionProgram);
let tmpDir;
let settingsFile;

beforeEach(function () {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-hosted-gate-'));
  settingsFile = path.join(tmpDir, 'settings.json');
});

afterEach(function () {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function cli(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_PATH, ...args],
      {
        env: {
          ...process.env,
          ZEROSHOT_SETTINGS_FILE: settingsFile,
          NODE_NO_WARNINGS: '1',
        },
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: error ? 1 : 0 });
      }
    );
  });
}

function assertNoHostedSurface(stdout) {
  // Lowercase-only: "Target branch for PRs" (capitalized, --pr-base's description)
  // is a legitimate, unrelated pre-existing string and must not be flagged.
  assert.ok(!/\btarget\b/.test(stdout), `hosted "target" surface leaked:\n${stdout}`);
  assert.ok(!/capsule/i.test(stdout), `hosted "capsule" surface leaked:\n${stdout}`);
  assert.ok(!stdout.includes('--target'), `--target flag leaked:\n${stdout}`);
  assert.ok(!stdout.includes('--all-targets'), `--all-targets flag leaked:\n${stdout}`);
}

describe('CLI hosted target/capsule gate: parser and help surface', function () {
  describe('production parser construction', function () {
    it('does not load the internal hosted command registry', function () {
      assert.strictEqual(require.cache[HOSTED_REGISTRATION_PATH], undefined);
    });

    it('contains no hosted command, alias, or remote-only option', function () {
      const hostedCommandNames = new Set(['target', 'capsule']);

      for (const { command, path: commandPath } of productionCommands) {
        for (const name of [command.name(), ...command.aliases()]) {
          assert.ok(!hostedCommandNames.has(name), `${commandPath} exposed hosted name "${name}"`);
        }

        for (const option of command.options) {
          assert.notStrictEqual(option.long, '--target', `${commandPath} registered --target`);
          assert.notStrictEqual(
            option.long,
            '--all-targets',
            `${commandPath} registered --all-targets`
          );
        }
      }
    });
  });

  describe('help output excludes hosted surface', function () {
    for (const { command, path: commandPath } of productionCommands) {
      it(`${commandPath} help has no target/capsule surface`, function () {
        assertNoHostedSurface(command.helpInformation());
      });
    }
  });
});

describe('CLI hosted target/capsule gate: side-effect rejection', function () {
  this.timeout(20_000);

  describe('unknown hosted commands are rejected before any side effect', function () {
    it('rejects bare "target" as an unknown command', async function () {
      const result = await cli(['target']);
      assert.notStrictEqual(result.exitCode, 0);
      assert.match(result.stderr, /unknown command/i);
      assert.strictEqual(fs.existsSync(settingsFile), false);
    });

    it('rejects bare "capsule" as an unknown command', async function () {
      const result = await cli(['capsule']);
      assert.notStrictEqual(result.exitCode, 0);
      assert.match(result.stderr, /unknown command/i);
      assert.strictEqual(fs.existsSync(settingsFile), false);
    });

    it('rejects "target add" with no settings mutation', async function () {
      const result = await cli(['target', 'add', 'x', '--url', 'https://y']);
      assert.notStrictEqual(result.exitCode, 0);
      assert.match(result.stderr, /unknown command/i);
      assert.strictEqual(fs.existsSync(settingsFile), false);
    });

    it('rejects "capsule list --json" with no settings mutation', async function () {
      const result = await cli(['capsule', 'list', '--json']);
      assert.notStrictEqual(result.exitCode, 0);
      assert.match(result.stderr, /unknown command/i);
      assert.strictEqual(fs.existsSync(settingsFile), false);
    });
  });

  describe('remote-only flags are rejected as unknown options', function () {
    it('rejects "run 123 --target foo"', async function () {
      const result = await cli(['run', '123', '--target', 'foo']);
      assert.notStrictEqual(result.exitCode, 0);
      assert.match(result.stderr, /unknown option/i);
      assert.strictEqual(fs.existsSync(settingsFile), false);
    });

    it('rejects "--all-targets"', async function () {
      const result = await cli(['--all-targets']);
      assert.notStrictEqual(result.exitCode, 0);
      assert.match(result.stderr, /unknown option/i);
      assert.strictEqual(fs.existsSync(settingsFile), false);
    });
  });
});
