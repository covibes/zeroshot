import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
// Hosted target/capsule commands are no longer registered on the production CLI.
// Exercise the single internal parser-construction boundary through a test-only CLI.
const CLI_PATH = path.resolve(process.cwd(), 'tests/target/fixtures/hosted-commands-cli.js');
// `settings` command coverage below still needs the real production CLI.
const PROD_CLI_PATH = path.resolve(process.cwd(), 'cli/index.js');

let tmpDir: string;
let settingsFile: string;

function execCli(
  cliPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      ZEROSHOT_SETTINGS_FILE: settingsFile,
      NODE_NO_WARNINGS: '1',
    },
    timeout: 30_000,
  });
}

function execCliSafe(
  cliPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: error ? (error as NodeJS.ErrnoException & { code?: number }).code ? 1 : 1 : 0,
        });
      },
    );
  });
}

function cli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execCli(CLI_PATH, args);
}

function cliSafe(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return execCliSafe(CLI_PATH, args);
}

function prodCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execCli(PROD_CLI_PATH, args);
}

function prodCliSafe(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return execCliSafe(PROD_CLI_PATH, args);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-target-test-'));
  settingsFile = path.join(tmpDir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('internal hosted parser boundary', () => {
  it('constructs the unpublished target command tree for direct handler tests', async () => {
    const { stdout } = await cli('target', '--help');
    for (const command of ['add', 'login', 'list', 'remove']) {
      assert.match(stdout, new RegExp(`\\b${command}\\b`));
    }
  });
});

describe('target add', () => {
  it('creates a target in settings', async () => {
    const { stdout } = await cli('target', 'add', 'staging', '--url', 'https://api.example.com');
    assert.ok(stdout.includes('staging'));
    assert.ok(stdout.includes('api.example.com'));

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.ok(settings._targets?.staging);
    assert.equal(settings._targets.staging.url, 'https://api.example.com');
  });

  it('rejects invalid target name', async () => {
    const result = await cliSafe('target', 'add', 'bad name!', '--url', 'https://api.example.com');
    assert.ok(result.stderr.includes('Invalid target name'));
  });

  it('rejects invalid URL', async () => {
    const result = await cliSafe('target', 'add', 'staging', '--url', 'http://remote.example.com');
    assert.ok(result.stderr.includes('HTTPS required'));
  });

  it('rejects duplicate name', async () => {
    await cli('target', 'add', 'staging', '--url', 'https://api.example.com');
    const result = await cliSafe('target', 'add', 'staging', '--url', 'https://other.example.com');
    assert.ok(result.stderr.includes('already exists'));
  });
});

describe('target list', () => {
  it('shows empty message when no targets', async () => {
    const { stdout } = await cli('target', 'list');
    assert.ok(stdout.includes('No targets'));
  });

  it('lists targets after adding', async () => {
    await cli('target', 'add', 'staging', '--url', 'https://staging.example.com');
    await cli('target', 'add', 'prod', '--url', 'https://prod.example.com');
    const { stdout } = await cli('target', 'list');
    assert.ok(stdout.includes('staging'));
    assert.ok(stdout.includes('prod'));
  });

  it('outputs JSON with --json flag', async () => {
    await cli('target', 'add', 'staging', '--url', 'https://staging.example.com');
    const { stdout } = await cli('target', 'list', '--json');
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, 'staging');
    assert.equal(parsed[0].url, 'https://staging.example.com');
    assert.ok('loggedIn' in parsed[0]);
    // Never includes secrets
    assert.equal(parsed[0].refresh_token, undefined);
    assert.equal(parsed[0].access_token, undefined);
    assert.equal(parsed[0].deviceToken, undefined);
  });
});

describe('target remove', () => {
  it('removes an existing target', async () => {
    await cli('target', 'add', 'staging', '--url', 'https://api.example.com');
    const { stdout } = await cli('target', 'remove', 'staging', '--force');
    assert.ok(stdout.includes('removed'));

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(settings._targets?.staging, undefined);
  });

  it('fails for nonexistent target', async () => {
    const result = await cliSafe('target', 'remove', 'nope', '--force');
    assert.ok(result.stderr.includes('not found'));
  });
});

describe('settings isolation', () => {
  it('settings list does not expose _targets', async () => {
    await cli('target', 'add', 'staging', '--url', 'https://api.example.com');
    const { stdout } = await prodCli('settings');
    assert.ok(!stdout.includes('_targets'));
    assert.ok(!stdout.includes('staging'));
  });

  it('settings get _targets is rejected', async () => {
    await cli('target', 'add', 'staging', '--url', 'https://api.example.com');
    const result = await prodCliSafe('settings', 'get', '_targets');
    assert.ok(result.stderr.includes('not found') || result.stderr.includes('Unknown'));
  });

  it('settings set _targets is rejected', async () => {
    const result = await prodCliSafe('settings', 'set', '_targets', '{}');
    assert.ok(result.stderr.includes('Unknown'));
  });

  it('settings reset preserves _targets', async () => {
    await cli('target', 'add', 'staging', '--url', 'https://api.example.com');
    await prodCli('settings', 'reset', '--yes');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.ok(settings._targets?.staging, '_targets should survive reset');
    assert.equal(settings._targets.staging.url, 'https://api.example.com');
  });
});
