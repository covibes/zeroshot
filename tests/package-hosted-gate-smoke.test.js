/**
 * Packaging smoke test: proves the hosted target/capsule gate holds on the
 * actually-published npm artifact, not just the source tree (issue #919, AC5).
 *
 * Packs a real tarball, installs it into a scratch directory, and exercises
 * the installed CLI exactly as a consumer would.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const repoRoot = path.join(__dirname, '..');

function execute(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function packAndInstall() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-hosted-gate-package-'));
  const output = execute(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', directory],
    repoRoot
  );
  const [{ filename }] = JSON.parse(output);
  const tarball = path.join(directory, filename);
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ private: true }));
  execute(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--omit=optional',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      tarball,
    ],
    directory
  );
  return directory;
}

function installedCliPath(directory) {
  return path.join(directory, 'node_modules', '@the-open-engine', 'zeroshot', 'cli', 'index.js');
}

function assertPackageSubpathUnavailable(directory, subpath) {
  try {
    execute(process.execPath, ['-e', `require.resolve(${JSON.stringify(subpath)})`], directory);
    assert.fail(`packed internal hosted subpath resolved: ${subpath}`);
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION') throw error;
    const detail = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
    assert.match(detail, /MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find module/);
  }
}

function runCli(cliPath, args, settingsFile) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      {
        env: {
          ...process.env,
          ZEROSHOT_SETTINGS_FILE: settingsFile,
          NODE_NO_WARNINGS: '1',
        },
        timeout: 15_000,
      },
      (error, stdout, stderr) => {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: error ? 1 : 0 });
      }
    );
  });
}

const HOSTED_GATE_REJECTED_INVOCATIONS = [
  { args: ['target'], error: /unknown command/i },
  {
    args: ['target', 'add', 'staging', '--url', 'https://api.example.com'],
    error: /unknown command/i,
  },
  { args: ['capsule'], error: /unknown command/i },
  { args: ['capsule', 'list', '--json'], error: /unknown command/i },
  { args: ['run', '123', '--target', 'staging'], error: /unknown option/i },
  { args: ['--all-targets'], error: /unknown option/i },
];

async function assertHostedInvocationRejected(cliPath, settingsFile, args, error) {
  const result = await runCli(cliPath, args, settingsFile);
  assert.notStrictEqual(result.exitCode, 0, `zeroshot ${args.join(' ')} unexpectedly passed`);
  assert.match(result.stderr, error);
  assert.strictEqual(
    fs.existsSync(settingsFile),
    false,
    `zeroshot ${args.join(' ')} mutated settings`
  );
}

describe('packed CLI hosted target/capsule gate', function () {
  this.timeout(180_000);

  let packageDirectory;
  let cliPath;
  let settingsDirectory;
  let settingsFile;

  before(function () {
    packageDirectory = packAndInstall();
    cliPath = installedCliPath(packageDirectory);
    assert.ok(fs.existsSync(cliPath), `packed CLI entrypoint missing at ${cliPath}`);
  });

  after(function () {
    if (packageDirectory) {
      fs.rmSync(packageDirectory, { recursive: true, force: true });
    }
  });

  beforeEach(function () {
    settingsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-hosted-gate-settings-'));
    settingsFile = path.join(settingsDirectory, 'settings.json');
  });

  afterEach(function () {
    fs.rmSync(settingsDirectory, { recursive: true, force: true });
  });

  it('does not publish the internal hosted command constructor', function () {
    assertPackageSubpathUnavailable(
      packageDirectory,
      '@the-open-engine/zeroshot/lib/target/register-hosted-commands.js'
    );
    assertPackageSubpathUnavailable(
      packageDirectory,
      '@the-open-engine/zeroshot/src/target/register-hosted-commands.ts'
    );
  });

  it('excludes target/capsule/--target/--all-targets from --help', async function () {
    const result = await runCli(cliPath, ['--help'], settingsFile);
    assert.strictEqual(result.exitCode, 0, result.stderr);
    // Lowercase-only: "Target branch for PRs" (--pr-base's description) is a
    // legitimate, unrelated pre-existing string and must not be flagged.
    assert.ok(
      !/\btarget\b/.test(result.stdout),
      `hosted "target" surface leaked:\n${result.stdout}`
    );
    assert.ok(
      !/capsule/i.test(result.stdout),
      `hosted "capsule" surface leaked:\n${result.stdout}`
    );
    assert.ok(!result.stdout.includes('--target'), `--target flag leaked:\n${result.stdout}`);
    assert.ok(
      !result.stdout.includes('--all-targets'),
      `--all-targets flag leaked:\n${result.stdout}`
    );
  });

  it('rejects packed hosted commands and remote-only flags before settings mutation', async function () {
    for (const { args, error } of HOSTED_GATE_REJECTED_INVOCATIONS) {
      await assertHostedInvocationRejected(cliPath, settingsFile, args, error);
    }
  });
});
