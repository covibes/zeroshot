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

function assertClustersRegistryOutput() {
  const registryPath = path.join(repoRoot, 'lib/clusters-registry.js');
  assert.ok(
    fs.existsSync(registryPath),
    'legacy TypeScript build must emit lib/clusters-registry.js'
  );
  const registry = require(registryPath);
  assert.deepStrictEqual(Reflect.ownKeys(registry), [
    'clustersFilePath',
    'readClustersFileSync',
    'writeClustersFileAtomic',
  ]);
  assert.strictEqual(registry.clustersFilePath('/tmp/zeroshot'), '/tmp/zeroshot/clusters.json');
}

function assertIdDetectorOutput() {
  const detectorPath = path.join(repoRoot, 'lib/id-detector.js');
  assert.ok(fs.existsSync(detectorPath), 'legacy TypeScript build must emit lib/id-detector.js');
  const detector = require(detectorPath);
  assert.deepStrictEqual(Reflect.ownKeys(detector), ['detectIdType']);
  assert.strictEqual(detector.detectIdType.length, 1);
}

function assertStreamJsonParserOutput() {
  const parserPath = path.join(repoRoot, 'lib/stream-json-parser.js');
  assert.ok(
    fs.existsSync(parserPath),
    'legacy TypeScript build must emit lib/stream-json-parser.js'
  );
  const parser = require(parserPath);
  assert.deepStrictEqual(Reflect.ownKeys(parser), ['parseEvent', 'parseChunk']);
  assert.deepStrictEqual(
    Object.values(parser).map((value) => value.length),
    [1, 1]
  );
}

function assertProviderDetectionOutput() {
  const detectionPath = path.join(repoRoot, 'lib/provider-detection.js');
  assert.ok(
    fs.existsSync(detectionPath),
    'legacy TypeScript build must emit lib/provider-detection.js'
  );
  const detection = require(detectionPath);
  assert.deepStrictEqual(Reflect.ownKeys(detection), [
    'commandExists',
    'getCommandPath',
    'getHelpOutput',
    'getVersionOutput',
  ]);
  assert.deepStrictEqual(
    Object.values(detection).map((value) => value.length),
    [1, 1, 1, 1]
  );
}

function assertProviderDefaultsOutput() {
  const defaultsPath = path.join(repoRoot, 'lib/provider-defaults.js');
  assert.ok(
    fs.existsSync(defaultsPath),
    'legacy TypeScript build must emit lib/provider-defaults.js'
  );
  const defaults = require(defaultsPath);
  assert.deepStrictEqual(Reflect.ownKeys(defaults), [
    'getProviderDefaults',
    'clearProviderDefaultsCache',
  ]);
  assert.deepStrictEqual(
    Object.values(defaults).map((value) => value.length),
    [0, 0]
  );
}

function assertProviderNamesOutput() {
  const namesPath = path.join(repoRoot, 'lib/provider-names.js');
  assert.ok(fs.existsSync(namesPath), 'legacy TypeScript build must emit lib/provider-names.js');
  const names = require(namesPath);
  assert.deepStrictEqual(Reflect.ownKeys(names), [
    'KNOWN_PROVIDER_NAMES',
    'PROVIDER_ALIASES',
    'PROVIDER_CAPABILITIES',
    'VALID_PROVIDERS',
    'getDefaultProviderId',
    'getProviderMetadata',
    'listProviderMetadata',
    'normalizeProviderName',
    'normalizeProviderSettings',
    'providerSupportsCapability',
    'providerSupportsOutputReformatting',
    'resolveProviderCommand',
  ]);
  assert.strictEqual(names.normalizeProviderName('openai'), 'codex');
}

function assertRepoSettingsOutput() {
  const settingsPath = path.join(repoRoot, 'lib/repo-settings.js');
  assert.ok(fs.existsSync(settingsPath), 'legacy TypeScript build must emit lib/repo-settings.js');
  const settings = require(settingsPath);
  assert.deepStrictEqual(Reflect.ownKeys(settings), ['readRepoSettings', 'writeRepoSettings']);
  assert.deepStrictEqual(
    Object.values(settings).map((value) => value.length),
    [1, 2]
  );
}

function assertClaudeAuthOutput() {
  const authPath = path.join(repoRoot, 'lib/settings/claude-auth.js');
  assert.ok(
    fs.existsSync(authPath),
    'legacy TypeScript build must emit lib/settings/claude-auth.js'
  );
  const auth = require(authPath);
  assert.deepStrictEqual(Reflect.ownKeys(auth), [
    'ANTHROPIC_KEY_PREFIX',
    'CLAUDE_AUTH_ENV_VARS',
    'isValidAnthropicKey',
    'isBedrockMode',
    'resolveClaudeAuth',
  ]);
}

function assertLegacyTypeScriptOutputs() {
  const pathCheckPath = path.join(repoRoot, 'lib/path-check.js');
  assert.ok(fs.existsSync(pathCheckPath), 'legacy TypeScript build must emit lib/path-check.js');
  const pathCheck = require(pathCheckPath);
  assert.deepStrictEqual(Reflect.ownKeys(pathCheck), [
    'getGlobalBinDir',
    'isDirOnPath',
    'getPathExportLine',
    'checkBinDirOnPath',
    'printPathWarning',
  ]);
  assert.strictEqual(
    pathCheck.getPathExportLine('/tmp/zeroshot-bin'),
    'export PATH="/tmp/zeroshot-bin:$PATH"'
  );

  const processLivenessPath = path.join(repoRoot, 'lib/process-liveness.js');
  assert.ok(
    fs.existsSync(processLivenessPath),
    'legacy TypeScript build must emit lib/process-liveness.js'
  );
  const processLiveness = require(processLivenessPath);
  assert.deepStrictEqual(Reflect.ownKeys(processLiveness), ['isProcessRunning']);
  assert.strictEqual(processLiveness.isProcessRunning(process.pid), true);

  const runPlanPath = path.join(repoRoot, 'lib/run-plan.js');
  assert.ok(fs.existsSync(runPlanPath), 'legacy TypeScript build must emit lib/run-plan.js');
  const runPlan = require(runPlanPath);
  assert.deepStrictEqual(Reflect.ownKeys(runPlan), ['resolveRunPlan']);
  assert.deepStrictEqual(runPlan.resolveRunPlan({ ship: true }), {
    isolation: 'worktree',
    delivery: 'ship',
    autoMerge: true,
  });
  assert.strictEqual(Object.isFrozen(runPlan.resolveRunPlan({})), true);

  const runModePath = path.join(repoRoot, 'lib/run-mode.js');
  assert.ok(fs.existsSync(runModePath), 'legacy TypeScript build must emit lib/run-mode.js');
  const runMode = require(runModePath);
  assert.deepStrictEqual(Reflect.ownKeys(runMode), [
    'resolveRunMode',
    'runModeFromPlan',
    'describeRunMode',
  ]);
  assert.strictEqual(runMode.resolveRunMode({ pr: true, docker: true }), 'pr+docker');

  const credentialPath = require(path.join(repoRoot, 'lib/provider-credential-path.js'));
  assert.deepStrictEqual(Reflect.ownKeys(credentialPath), [
    'expandProviderCredentialPath',
    'resolveProviderCredentialPaths',
  ]);
  assert.strictEqual(
    credentialPath.expandProviderCredentialPath('$CREDENTIAL_ROOT/auth.json', {
      CREDENTIAL_ROOT: '/tmp/provider',
    }),
    '/tmp/provider/auth.json'
  );
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

    assertClustersRegistryOutput();
    assertIdDetectorOutput();
    assertStreamJsonParserOutput();
    assertProviderDetectionOutput();
    assertProviderDefaultsOutput();
    assertProviderNamesOutput();
    assertRepoSettingsOutput();
    assertClaudeAuthOutput();
    assertLegacyTypeScriptOutputs();

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
