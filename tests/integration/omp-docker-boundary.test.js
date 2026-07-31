/**
 * Focused Docker-isolation proof for OMP.
 *
 * The heavyweight `zeroshot run --docker --provider omp` path needs the real
 * `zeroshot-cluster-base-omp-*` image (Bun + @oh-my-pi/pi-coding-agent installed) plus live OMP
 * credentials — none are available offline. This proves the Docker-specific contract instead:
 * the real omp argv built on the host survives the container boundary intact, lands in
 * `/workspace`, and only declared credential env names cross into the container.
 *
 * It builds the REAL omp argv on the host with the compiled adapter (exactly as the agent spawn
 * path does), then delivers it into a container via `docker exec -i <container> <command>` — the
 * exact mechanism IsolationManager.spawnInContainer uses. A fake `omp` inside the container
 * records the argv, cwd, and credential-shaped env var names it received; the host asserts the
 * argv arrived unchanged, cwd is `/workspace`, and no undeclared secret crossed the boundary.
 *
 * Fully offline: no zeroshot-cluster-base image, no real credentials, no OMP API call.
 *
 * REQUIRES: Docker installed and running, and the node:20-slim image already pulled. SKIPS
 * otherwise (or under CI) — the base image pull is left to the environment to avoid slow network
 * pulls inside a test hook.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const IsolationManager = require('../../src/isolation-manager');
const { getProviderMetadata } = require('../../lib/provider-names');
const { prepareSingleAgentProviderCommand } = require('../../task-lib/provider-helper-runtime.js');

const IMAGE = 'node:20-slim';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FAKE_OMP = path.join(REPO_ROOT, 'tests', 'e2e', 'fixtures', 'fake-omp.js');
const SENTINEL_KEY = 'ZEROSHOT_UNDECLARED_SECRET';
const DECLARED_ENV_UNION = new Set([
  ...getProviderMetadata('omp').docker.envPassthrough,
  ...getProviderMetadata('claude').docker.envPassthrough,
]);

function dockerCli(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...opts });
}

function imagePresent(image) {
  return dockerCli(['image', 'inspect', image]).status === 0;
}

function envFlagsFromDockerArgs(args) {
  const flags = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e') flags.push('-e', args[i + 1]);
  }
  return flags;
}

describe('omp Docker isolation boundary', function () {
  this.timeout(120000);

  const manager = new IsolationManager();
  let ctxDir;
  let container;
  let hostArgs;
  let credentialEnvFlags;
  let savedEnv;

  before(function () {
    if (process.env.CI || !IsolationManager.isDockerAvailable() || !imagePresent(IMAGE)) {
      this.skip();
    }
  });

  beforeEach(function () {
    ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-docker-'));
    fs.copyFileSync(FAKE_OMP, path.join(ctxDir, 'fake-omp.js'));
    const shim = path.join(ctxDir, 'omp');
    fs.writeFileSync(shim, '#!/bin/sh\nexec node "$(dirname "$0")/fake-omp.js" "$@"\n', {
      mode: 0o755,
    });
    fs.chmodSync(shim, 0o755);

    // Exercise the REAL credential-forwarding path (IsolationManager._applyCredentialMounts):
    // one declared credential var plus one undeclared sentinel on the host env. The production
    // code must build docker args that carry the former and never the latter.
    savedEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      [SENTINEL_KEY]: process.env[SENTINEL_KEY],
    };
    process.env.ANTHROPIC_API_KEY = 'fake-sentinel';
    process.env[SENTINEL_KEY] = 'nope';
    const dockerArgs = [];
    manager._applyCredentialMounts(
      dockerArgs,
      {},
      { dockerMounts: [], dockerEnvPassthrough: [] },
      '/root',
      'omp'
    );
    credentialEnvFlags = envFlagsFromDockerArgs(dockerArgs);
    assert.ok(
      !credentialEnvFlags.includes(`${SENTINEL_KEY}=nope`),
      'production code forwarded an undeclared sentinel env var'
    );

    const prepared = prepareSingleAgentProviderCommand({
      provider: 'omp',
      context: 'do the work',
      options: {
        autoApprove: true,
        outputFormat: 'json',
        cwd: '/workspace',
        cliFeatures: {
          supportsModeJson: true,
          supportsPrint: true,
          supportsCwd: true,
          supportsAutoApprove: true,
          supportsModel: true,
          supportsThinking: true,
          supportsNoExtensions: true,
          supportsNoSkills: true,
          supportsNoRules: true,
          supportsNoTitle: true,
        },
      },
    });
    hostArgs = prepared.commandSpec.args;
    container = null;
  });

  afterEach(function () {
    if (container) {
      dockerCli(['rm', '-f', container], { stdio: 'pipe' });
      container = null;
    }
    if (ctxDir) {
      fs.rmSync(ctxDir, { recursive: true, force: true });
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('delivers the host-built omp argv into /workspace with only declared credential env names', function () {
    // Sanity: the host-built argv must carry the required non-interactive flags (else the
    // container proof is vacuous).
    assert.deepStrictEqual(hostArgs.slice(0, 3), ['--mode', 'json', '-p']);
    assert.ok(
      hostArgs.includes('--cwd') && hostArgs[hostArgs.indexOf('--cwd') + 1] === '/workspace'
    );
    assert.ok(hostArgs.includes('--auto-approve'));

    const run = dockerCli(['run', '-d', IMAGE, 'tail', '-f', '/dev/null']);
    assert.strictEqual(run.status, 0, `docker run failed: ${run.stderr}`);
    container = run.stdout.trim();

    assert.strictEqual(dockerCli(['exec', container, 'mkdir', '-p', '/workspace']).status, 0);
    const cp = dockerCli(['cp', `${ctxDir}/.`, `${container}:/workspace`]);
    assert.strictEqual(cp.status, 0, `docker cp failed: ${cp.stderr}`);
    dockerCli(['exec', container, 'chmod', '+x', '/workspace/omp']);

    // Mirror IsolationManager.spawnInContainer: `docker exec -i <container> <command>`, with the
    // -e flags computed above by the real _applyCredentialMounts (declared vars only).
    const exec = dockerCli([
      'exec',
      '-i',
      '-w',
      '/workspace',
      '-e',
      'PATH=/workspace:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ...credentialEnvFlags,
      container,
      'omp',
      ...hostArgs,
    ]);
    assert.strictEqual(
      exec.status,
      0,
      `omp failed inside container:\nSTDOUT:\n${exec.stdout}\nSTDERR:\n${exec.stderr}`
    );

    const out = dockerCli(['exec', container, 'cat', '/workspace/omp-received.json']);
    assert.strictEqual(out.status, 0, `could not read recorded state: ${out.stderr}`);
    const received = JSON.parse(out.stdout);

    assert.strictEqual(received.cwd, '/workspace');
    assert.deepStrictEqual(received.argv, hostArgs, 'argv mutated crossing the container boundary');

    for (const name of received.env) {
      assert.ok(
        DECLARED_ENV_UNION.has(name),
        `container-visible credential env ${name} is not in the omp+claude declared union`
      );
    }
    assert.ok(!received.env.includes(SENTINEL_KEY), 'undeclared sentinel reached the container');
  });
});
