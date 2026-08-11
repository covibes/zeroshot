/**
 * Packaging smoke tests for the npm artifact.
 *
 * These run `npm pack --dry-run --json` so they validate the publish file list
 * without relying on the network or installing dependencies.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertLegacyTypeScriptPackage } = require('./helpers/legacy-typescript-package-assertions');

const repoRoot = path.join(__dirname, '..');

function runNpmPackDryRun() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_loglevel: 'silent',
    },
  });

  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed) && parsed.length === 1, 'expected one packed artifact entry');
  return parsed[0];
}

describe('npm package smoke', function () {
  this.timeout(60000);

  it('publishes the CLI setup, auth, and runtime support files', function () {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const pack = runNpmPackDryRun();
    const files = new Set(pack.files.map((file) => file.path));

    assert.strictEqual(pkg.bin.zeroshot, './cli/index.js');
    assert.strictEqual(
      pkg.bin['zeroshot-agent-provider'],
      './lib/agent-cli-provider/executable.js'
    );
    assert.strictEqual(pkg.bin['zeroshot-cluster-worker'], './bin/zeroshot-cluster-worker.js');

    assertLegacyTypeScriptPackage();

    for (const requiredFile of [
      'cli/index.js',
      'bin/zeroshot-cluster-worker.js',
      'lib/cluster-worker/index.js',
      'lib/clusters-registry.js',
      'lib/id-detector.js',
      'lib/stream-json-parser.js',
      'lib/provider-detection.js',
      'lib/provider-defaults.js',
      'lib/provider-names.js',
      'lib/repo-settings.js',
      'lib/settings/claude-auth.js',
      'lib/compose-utils.js',
      'lib/completion.js',
      'lib/git-remote-utils.js',
      'lib/detached-startup.js',
      'lib/docker-config.js',
      'lib/setup-journal.js',
      'lib/setup-undo.js',
      'lib/setup-plan.js',
      'lib/setup-apply.js',
      'lib/cluster-worker/index.d.ts',
      'lib/cluster-worker/executable.js',
      'lib/cluster-worker/terminal-normalizer.js',
      'lib/cluster-worker/process-stdio.js',
      'lib/cluster-worker/runtime-support.js',
      'protocol/openengine-cluster/v1/worker.schema.json',
      'docs/openengine-cluster-protocol/v1/legacy-worker.md',
      'lib/start-cluster.js',
      'lib/path-check.js',
      'lib/process-liveness.js',
      'lib/run-plan.js',
      'lib/run-mode.js',
      'lib/provider-credential-path.js',
      'scripts/check-path.js',
      'scripts/postinstall.js',
      'cli/lib/setup-wizard.js',
      'cli/lib/setup-provider-readiness.js',
      'cli/lib/setup-scanner-worker.js',
      'cli/lib/setup-scanner.js',
      'cli/lib/setup-wizard-input.js',
      'cli/lib/setup-wizard-model.js',
      'cli/lib/setup-wizard-plan-view.js',
      'cli/lib/setup-wizard-scan-view.js',
      'cli/lib/setup-wizard-terminal.js',
      'cli/lib/setup-wizard-view.js',
      'src/claude-credentials.js',
      'src/worktree-claude-config.js',
      'src/agent/pr-verification.js',
      'src/agents/git-pusher-template.js',
      'src/guidance-topics.js',
      'cluster-hooks/block-ask-user-question.py',
      'cluster-hooks/block-dangerous-git.py',
    ]) {
      assert.ok(files.has(requiredFile), `npm package must include ${requiredFile}`);
    }

    for (const file of files) {
      assert.ok(
        !file.startsWith('docker/zeroshot-oecp/') &&
          !file.startsWith('scripts/hosted-oecp-') &&
          !file.startsWith('zeroshot-rust/'),
        `npm package must not expose the private hosted runtime: ${file}`
      );
    }
  });
});
