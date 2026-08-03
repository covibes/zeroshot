import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(process.cwd(), 'cli/index.js');

let tmpDir: string;
let settingsFile: string;

function cli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [CLI_PATH, ...args], {
    env: {
      ...process.env,
      ZEROSHOT_SETTINGS_FILE: settingsFile,
      NODE_NO_WARNINGS: '1',
    },
    timeout: 10_000,
  });
}

function cliSafe(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: error ? (error as NodeJS.ErrnoException & { code?: number }).code ? 1 : 1 : 0,
        });
      },
    );
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-target-test-'));
  settingsFile = path.join(tmpDir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
    await cli('target', 'add', 'staging', '