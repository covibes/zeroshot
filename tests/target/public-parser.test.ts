import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const CLI = resolve('cli/index.js');

describe('stable public parser hosted-command gate', () => {
  it('does not register hosted syntax in help or unknown-command parsing', () => {
    const home = mkdtempSync(join(tmpdir(), 'zeroshot-parser-gate-'));
    try {
      const env = { ...process.env, HOME: home, ZEROSHOT_HOME: join(home, '.zeroshot') };
      const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', env });
      assert.equal(help.status, 0, help.stderr);
      const helpText = `${help.stdout}\n${help.stderr}`;
      assert.doesNotMatch(helpText, /^\s+target(?:\s|$)/m);
      assert.doesNotMatch(helpText, /^\s+capsule(?:\s|$)/m);
      assert.doesNotMatch(helpText, /--target(?:\s|,|$)/);
      assert.doesNotMatch(helpText, /--all-targets(?:\s|,|$)/);

      const defaultRun = spawnSync(process.execPath, [CLI, 'target', '--help'], {
        encoding: 'utf8',
        env,
      });
      assert.equal(defaultRun.status, 0, defaultRun.stderr);
      const defaultRunText = `${defaultRun.stdout}\n${defaultRun.stderr}`;
      assert.match(defaultRunText, /^Usage: zeroshot run /m);
      assert.doesNotMatch(
        defaultRunText,
        /Manage named remote targets|target add <name>|target login <name>/i,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
