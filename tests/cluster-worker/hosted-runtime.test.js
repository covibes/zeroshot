'use strict';

const assert = require('assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  LOOPBACK_BOOTSTRAP_MODE,
  installRuntimeCapability,
  provisionRuntimeCapability,
} = require('../../zeroshot-rust/hosted-node/runtime-capability');

const ROOT = path.resolve(__dirname, '..', '..');

function sendCapability(address, capability) {
  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const socket = net.createConnection({ host: address.address, port: address.port }, () =>
      socket.end(capability)
    );
    socket.on('data', (chunk) => {
      response = Buffer.concat([response, chunk]);
    });
    socket.once('end', () => resolve(response.toString('ascii')));
    socket.once('error', reject);
  });
}

function createBootstrapFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-runtime-bootstrap-'));
  const capabilityFile = path.join(directory, 'capability');
  return {
    capabilityFile,
    directory,
    environment: {
      ZEROSHOT_OECP_CAPABILITY_BOOTSTRAP: LOOPBACK_BOOTSTRAP_MODE,
      ZEROSHOT_OECP_CAPABILITY_FILE: capabilityFile,
    },
  };
}

async function assertRejectedFirstPayload(payload) {
  const { capabilityFile, directory, environment } = createBootstrapFixture();
  const capability = 'c'.repeat(64);
  let address;
  let delivery;
  try {
    await assert.rejects(
      provisionRuntimeCapability(environment, {
        port: 0,
        timeoutMs: 500,
        onListening(listeningAddress) {
          address = listeningAddress;
          delivery = sendCapability(listeningAddress, payload);
        },
      }),
      /bootstrap failed/
    );
    await Promise.allSettled([delivery]);
    assert.strictEqual(fs.existsSync(capabilityFile), false);
    await assert.rejects(sendCapability(address, capability), /ECONNREFUSED/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe('private hosted worker runtime', () => {
  it('materializes and removes the one-time task capability', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-runtime-capability-'));
    const capabilityFile = path.join(directory, 'capability');
    const environment = {
      ZEROSHOT_OECP_RUNTIME_CAPABILITY: 'a'.repeat(64),
      ZEROSHOT_OECP_CAPABILITY_FILE: capabilityFile,
    };
    try {
      installRuntimeCapability(environment);
      assert.strictEqual(environment.ZEROSHOT_OECP_RUNTIME_CAPABILITY, undefined);
      assert.strictEqual(fs.readFileSync(capabilityFile, 'ascii'), 'a'.repeat(64));
      assert.strictEqual(fs.statSync(capabilityFile).mode & 0o777, 0o400);
      environment.ZEROSHOT_OECP_RUNTIME_CAPABILITY = 'b'.repeat(64);
      assert.throws(() => installRuntimeCapability(environment), /EEXIST/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts one bounded task-local bootstrap and then closes the listener', async () => {
    const { capabilityFile, directory, environment } = createBootstrapFixture();
    const capability = 'b'.repeat(64);
    let address;
    let exchange;
    try {
      await provisionRuntimeCapability(environment, {
        port: 0,
        timeoutMs: 500,
        onListening(listeningAddress) {
          address = listeningAddress;
          exchange = sendCapability(listeningAddress, capability);
        },
      });
      assert.strictEqual(await exchange, 'OK\n');
      assert.strictEqual(environment.ZEROSHOT_OECP_CAPABILITY_BOOTSTRAP, undefined);
      assert.strictEqual(fs.readFileSync(capabilityFile, 'ascii'), capability);
      assert.strictEqual(fs.statSync(capabilityFile).mode & 0o777, 0o400);
      await assert.rejects(sendCapability(address, capability), /ECONNREFUSED/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('private hosted capability failure handling', () => {
  it('rejects malformed first input and refuses a second connection', async () => {
    await assertRejectedFirstPayload('not-a-capability');
  });

  it('rejects an overlong first input and refuses a second connection', async () => {
    await assertRejectedFirstPayload('d'.repeat(65));
  });

  it('treats an idle first connection timeout as terminal', async () => {
    const { capabilityFile, directory, environment } = createBootstrapFixture();
    const capability = 'e'.repeat(64);
    let address;
    let idleSocket;
    try {
      await assert.rejects(
        provisionRuntimeCapability(environment, {
          port: 0,
          timeoutMs: 1000,
          connectionTimeoutMs: 50,
          onListening(listeningAddress) {
            address = listeningAddress;
            idleSocket = net.createConnection({
              host: listeningAddress.address,
              port: listeningAddress.port,
            });
            idleSocket.on('error', () => {});
          },
        }),
        /bootstrap failed/
      );
      assert.strictEqual(fs.existsSync(capabilityFile), false);
      await assert.rejects(sendCapability(address, capability), /ECONNREFUSED/);
    } finally {
      idleSocket?.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('cannot write after the bootstrap deadline becomes terminal', async () => {
    const { capabilityFile, directory, environment } = createBootstrapFixture();
    let lateSocket;
    try {
      await assert.rejects(
        provisionRuntimeCapability(environment, {
          port: 0,
          timeoutMs: 30,
          connectionTimeoutMs: 500,
          onListening(address) {
            lateSocket = net.createConnection({
              host: address.address,
              port: address.port,
            });
            lateSocket.once('connect', () => {
              setTimeout(() => lateSocket.end('d'.repeat(64)), 60);
            });
            lateSocket.on('error', () => {});
          },
        }),
        /bootstrap failed/
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.strictEqual(fs.existsSync(capabilityFile), false);
    } finally {
      lateSocket?.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous capability delivery modes', async () => {
    await assert.rejects(
      provisionRuntimeCapability({
        ZEROSHOT_OECP_RUNTIME_CAPABILITY: 'c'.repeat(64),
        ZEROSHOT_OECP_CAPABILITY_BOOTSTRAP: LOOPBACK_BOOTSTRAP_MODE,
        ZEROSHOT_OECP_CAPABILITY_FILE: '/unused',
      }),
      /configuration is invalid/
    );
  });
});

describe('private hosted worker boundaries', () => {
  it('loads an injected adapter without loading the production engine', () => {
    const probe = [
      "const Module = require('module');",
      'const load = Module._load;',
      'Module._load = function(request, ...args) {',
      "  if (request.endsWith('/engine-adapter') || request === './engine-adapter') throw new Error('production engine loaded');",
      '  return load.call(this, request, ...args);',
      '};',
      "const { createLegacyClusterWorker } = require('./lib/cluster-worker');",
      'createLegacyClusterWorker({',
      '  profileRegistry: {}, artifactResolver: {},',
      '  engineAdapter: {}, cleanupFailureReporter() {}',
      '});',
    ].join('\n');
    const result = spawnSync(process.execPath, ['-e', probe], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0, result.stderr);
  });

  it('refuses to launch outside the fixed prepared workspace', () => {
    const codexConfig = '/tmp/zeroshot-oecp/.codex/config.toml';
    fs.rmSync(codexConfig, { force: true });
    try {
      const result = spawnSync(process.execPath, ['zeroshot-rust/hosted-node/worker-launcher.js'], {
        cwd: ROOT,
        env: {
          HOME: '/tmp/zeroshot-oecp',
          LANG: 'C.UTF-8',
          NODE_ENV: 'production',
          PATH: process.env.PATH,
          ZEROSHOT_HOSTED_CREDENTIALS_JSON: JSON.stringify({
            GH_TOKEN: 'git-canary',
            OPENAI_API_KEY: 'provider-canary',
          }),
          ZEROSHOT_HOSTED_REPOSITORY: 'the-open-engine/zeroshot',
          ZEROSHOT_HOSTED_BASE_REVISION: 'a'.repeat(40),
          ZEROSHOT_HOSTED_PROVIDER: 'codex',
          ZEROSHOT_HOSTED_MODEL_LEVEL: 'level2',
          OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
          ZEROSHOT_ISOLATION_PROFILE: 'isolation.prepared-worktree@1',
          ZEROSHOT_PROVIDER_PROFILE: 'provider.hosted-direct@1',
        },
        encoding: 'utf8',
      });
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Invalid fixed capsule workspace/);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /git-canary|provider-canary/);
      assert.strictEqual(
        fs.readFileSync(codexConfig, 'utf8'),
        [
          'model_provider = "zeroshot_hosted"',
          '[model_providers.zeroshot_hosted]',
          'name = "Zeroshot Hosted"',
          'base_url = "https://openrouter.ai/api/v1"',
          'env_key = "OPENAI_API_KEY"',
          'wire_api = "responses"',
          'requires_openai_auth = false',
          'supports_websockets = false',
          '[shell_environment_policy]',
          'inherit = "core"',
          'ignore_default_excludes = false',
          '',
        ].join('\n')
      );
      assert.strictEqual(fs.statSync(codexConfig).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(codexConfig, { force: true });
    }
  });
});
