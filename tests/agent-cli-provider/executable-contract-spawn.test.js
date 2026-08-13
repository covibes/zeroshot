const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

async function createSigtermReadyServer() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const ready = new Promise((resolve, reject) => {
    server.once('connection', (socket) => {
      socket.setEncoding('utf8');
      let message = '';
      socket.on('data', (chunk) => {
        message += chunk;
      });
      socket.once('end', () => {
        if (message === 'ready\n') {
          resolve();
        } else {
          reject(new Error(`Unexpected child readiness message: ${JSON.stringify(message)}`));
        }
      });
    });
  });

  return {
    port: address.port,
    ready,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

test('spawnProcessRunner strips inherited process-control env before spawn', async () => {
  const { spawnProcessRunner } = require('../../lib/agent-cli-provider');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-provider-env-'));
  const preloadPath = path.join(tempDir, 'preload.cjs');
  const markerPath = path.join(tempDir, 'marker');
  const previousNodeOptions = process.env.NODE_OPTIONS;

  fs.writeFileSync(
    preloadPath,
    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'pwned');\n`
  );
  process.env.NODE_OPTIONS = `--require ${preloadPath}`;

  try {
    const result = await spawnProcessRunner()({
      binary: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
      env: {},
      cleanupMetadata: [],
      warnings: [],
      redactions: [],
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'ok');
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    if (previousNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = previousNodeOptions;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('spawnProcessRunner strips command spec process-control env before spawn', async () => {
  const { spawnProcessRunner } = require('../../lib/agent-cli-provider');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-provider-env-'));
  const preloadPath = path.join(tempDir, 'preload.cjs');
  const markerPath = path.join(tempDir, 'marker');

  fs.writeFileSync(
    preloadPath,
    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'pwned');\n`
  );

  try {
    const result = await spawnProcessRunner()({
      binary: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
      env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
      },
      cleanupMetadata: [],
      warnings: [],
      redactions: [],
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'ok');
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('spawnProcessRunner escalates timed-out providers and reports timeout evidence', async (t) => {
  const { spawnProcessRunner } = require('../../lib/agent-cli-provider');
  const readiness = await createSigtermReadyServer();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const startedAt = Date.now();

  try {
    const resultPromise = spawnProcessRunner()(
      {
        binary: process.execPath,
        args: [
          '-e',
          [
            'const net = require("node:net");',
            'process.on("SIGTERM", () => {});',
            `const socket = net.createConnection(${readiness.port}, "127.0.0.1", () => socket.end("ready\\n"));`,
            'setInterval(() => {}, 1000);',
          ].join(' '),
        ],
        env: {},
        cleanupMetadata: [],
        warnings: [],
        redactions: [],
      },
      { timeoutMs: 50 }
    );

    await readiness.ready;
    t.mock.timers.tick(50);
    t.mock.timers.tick(100);
    const result = await resultPromise;

    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(result.timeoutMs, 50);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    t.mock.timers.reset();
    await readiness.close();
  }
});

test('spawnProcessRunner closes provider stdin for noninteractive invocations', async () => {
  const { spawnProcessRunner } = require('../../lib/agent-cli-provider');

  const result = await spawnProcessRunner()(
    {
      binary: process.execPath,
      args: [
        '-e',
        [
          'process.stdin.setEncoding("utf8");',
          'process.stdin.on("data", () => {});',
          'process.stdin.on("end", () => { process.stdout.write("stdin closed"); });',
          'process.stdin.resume();',
        ].join(' '),
      ],
      env: {},
      cleanupMetadata: [],
      warnings: [],
      redactions: [],
    },
    { timeoutMs: 300 }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'stdin closed');
});

test('Codex adapter auth survives inherited-provider-env stripping', async () => {
  const { getProviderAdapter, spawnProcessRunner } = require('../../lib/agent-cli-provider');
  const secret = 'codex-spawn-secret';
  const commandSpec = getProviderAdapter('codex').buildCommand('Authenticate.', {
    authEnv: { OPENAI_API_KEY: secret },
  });

  assert.equal(commandSpec.env.OPENAI_API_KEY, undefined);
  assert.equal(commandSpec.env.CODEX_API_KEY, secret);
  const result = await spawnProcessRunner()({
    ...commandSpec,
    binary: process.execPath,
    args: [
      '-e',
      `process.stdout.write(process.env.CODEX_API_KEY === ${JSON.stringify(secret)} ? "AUTH_OK" : "AUTH_MISSING")`,
    ],
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'AUTH_OK');
});

test('Codex adapter prefers an explicit per-exec credential', () => {
  const { getProviderAdapter } = require('../../lib/agent-cli-provider');
  const commandSpec = getProviderAdapter('codex').buildCommand('Authenticate.', {
    authEnv: {
      OPENAI_API_KEY: 'fallback-secret',
      CODEX_API_KEY: 'explicit-secret',
    },
  });

  assert.equal(commandSpec.env.OPENAI_API_KEY, undefined);
  assert.equal(commandSpec.env.CODEX_API_KEY, 'explicit-secret');
});
