/**
 * Detached OMP rpc-stdio watcher (task-lib/rpc-watcher.js) end-to-end.
 *
 * Forks the real watcher against the fake `omp --mode rpc` executable
 * (tests/helpers/fake-omp-rpc.js), the same fixture the foreground driver tests use, so
 * foreground (contract-invoke.ts) and detached (this file) exercise identical result
 * semantics per issue #900. Covers: spawn-evidence persistence, pre-spawn cancellation,
 * spawn failure, a mid-turn provider crash, overlay cleanup across every outcome, an unsafe
 * cleanup staying durably retryable, and sentinel-free log output.
 *
 * Every task-lib/store.js read/write below runs in its own short-lived child process (like
 * tests/task-termination-recovery.test.js's ownership-persistence test), not via a direct
 * `import()` in this file. task-lib/store.js resolves its DB path from `ZEROSHOT_HOME` at ESM
 * module-load time and caches that per process; under `mocha --parallel`, some other test file
 * sharing this worker process can import it first under a different HOME, and a direct import
 * here would then silently read/write the wrong database instead of this suite's isolated one.
 */

const assert = require('assert');
const { execFile, fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const zeroshotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-omp-rpc-watcher-home-'));
const storeUrl = pathToFileURL(path.resolve(__dirname, '../task-lib/store.js')).href;

const FAKE_OMP_RPC_PATH = path.join(__dirname, 'helpers', 'fake-omp-rpc.js');
const RPC_WATCHER_PATH = path.join(__dirname, '..', 'task-lib', 'rpc-watcher.js');
const SENTINEL_PROMPT = 'ZS_SENTINEL_PROMPT_MARKER_DO_NOT_LOG_8f21c3';
const {
  SENTINEL_SYSTEM,
  SENTINEL_MESSAGE,
  SENTINEL_CONTROL,
} = require('./helpers/omp-rpc-sentinels');

async function runStoreScript(script) {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ZEROSHOT_HOME: zeroshotHome },
  });
  return stdout;
}

async function storeAddTask(task) {
  await runStoreScript(`
    const { addTask } = await import(${JSON.stringify(storeUrl)});
    addTask(${JSON.stringify(task)});
  `);
}

async function storeGetTask(id) {
  const stdout = await runStoreScript(`
    const { getTask } = await import(${JSON.stringify(storeUrl)});
    process.stdout.write(JSON.stringify(getTask(${JSON.stringify(id)})));
  `);
  return JSON.parse(stdout);
}

async function storeRequestCancellation(id) {
  await runStoreScript(`
    const { requestTaskCancellation } = await import(${JSON.stringify(storeUrl)});
    requestTaskCancellation(${JSON.stringify(id)});
  `);
}

let idCounter = 0;
function nextTaskId(label) {
  idCounter += 1;
  return `omp-rpc-watcher-${label}-${idCounter}`;
}

function buildCommandSpec(overlay, overrides = {}) {
  return {
    binary: process.execPath,
    args: [FAKE_OMP_RPC_PATH],
    env: {},
    cwd: process.cwd(),
    cleanup: [overlay.dir],
    cleanupMetadata: [
      { kind: 'temp-directory', provider: 'omp', path: overlay.dir, reason: 'isolated-config' },
    ],
    ...overrides,
  };
}

function runWatcher({ id, commandSpec, scenario, prompt = SENTINEL_PROMPT, env = {} }) {
  const logFile = path.join(zeroshotHome, `${id}.log`);
  fs.writeFileSync(logFile, '');
  return new Promise((resolve, reject) => {
    const child = fork(
      RPC_WATCHER_PATH,
      [id, commandSpec.cwd, logFile, '[]', JSON.stringify({ commandSpec, prompt })],
      {
        env: {
          ...process.env,
          ZEROSHOT_HOME: zeroshotHome,
          OMP_FAKE_RPC_SCENARIO: scenario,
          ...env,
        },
        stdio: 'ignore',
      }
    );
    child.on('exit', (code) => resolve({ code, logFile }));
    child.on('error', reject);
  });
}

describe('OMP RPC watcher (detached rpc-stdio lane)', function () {
  this.timeout(20000);

  const { createOmpConfigOverlay } = require('../src/omp-config-overlay');

  async function seedTask(id, commandSpec, overrides = {}) {
    await storeAddTask({
      id,
      status: 'running',
      provider: 'omp',
      cwd: commandSpec.cwd,
      logFile: path.join(zeroshotHome, `${id}.log`),
      commandCleanup: {
        cleanup: commandSpec.cleanup,
        cleanupMetadata: commandSpec.cleanupMetadata,
      },
      ...overrides,
    });
  }

  it('completes a detached task, cleans up the overlay, and logs only normalized events', async function () {
    const id = nextTaskId('happy');
    const overlay = createOmpConfigOverlay();
    const commandSpec = buildCommandSpec(overlay);
    await seedTask(id, commandSpec);

    const { code, logFile } = await runWatcher({ id, commandSpec, scenario: 'happy' });
    assert.strictEqual(code, 0);

    const task = await storeGetTask(id);
    assert.strictEqual(task.status, 'completed');
    assert.strictEqual(task.exitCode, 0);
    assert.strictEqual(task.pid, null);
    assert.strictEqual(
      task.commandCleanup,
      null,
      'successful cleanup clears the retryable receipt'
    );
    assert.strictEqual(fs.existsSync(overlay.dir), false, 'overlay directory must be removed');

    const log = fs.readFileSync(logFile, 'utf8');
    assert.match(log, /"type":"text"/);
    assert.match(log, /"type":"tool_call"/);
    assert.match(log, /"type":"result"/);
    assert.ok(!log.includes(SENTINEL_PROMPT), 'prompt text must never be logged');
    assert.ok(!log.includes('"type":"ready"'), 'raw RPC frames must never be logged');
  });

  it('never logs sentinel prompt, system, message, or control payloads, only normalized events', async function () {
    const id = nextTaskId('sentinel-free');
    const overlay = createOmpConfigOverlay();
    const commandSpec = buildCommandSpec(overlay);
    await seedTask(id, commandSpec);

    const { code, logFile } = await runWatcher({
      id,
      commandSpec,
      scenario: 'happy',
      env: { OMP_FAKE_RPC_INJECT_SENTINELS: '1' },
    });
    assert.strictEqual(code, 0);

    const task = await storeGetTask(id);
    assert.strictEqual(task.status, 'completed');

    const log = fs.readFileSync(logFile, 'utf8');
    // Normalized events remain visible...
    assert.match(log, /"type":"text"/);
    assert.match(log, /"type":"tool_call"/);
    assert.match(log, /"type":"result"/);
    // ...but none of the sentinel payloads injected into raw, non-normalized protocol fields
    // (the ready frame's system field, message_start/message_end's message field, and the
    // negotiate_protocol response's control field) ever reach the log.
    assert.ok(!log.includes(SENTINEL_PROMPT), 'sentinel prompt payload must never be logged');
    assert.ok(!log.includes(SENTINEL_SYSTEM), 'sentinel system payload must never be logged');
    assert.ok(!log.includes(SENTINEL_MESSAGE), 'sentinel message payload must never be logged');
    assert.ok(!log.includes(SENTINEL_CONTROL), 'sentinel control payload must never be logged');
  });

  it('completes and cleans up even when the final output does not conform to the requested schema', async function () {
    // OMP has no provider-native JSON schema support (jsonSchema:false): buildOmpPrompt appends
    // schema instructions to the prompt for the model to follow, and any conformance check is a
    // caller concern above this contract, not something rpc-watcher.js/the RPC driver enforce.
    // A "schema failure" (the model's final text isn't valid JSON matching the schema) must
    // therefore behave exactly like any other normal completion here: the turn still completes,
    // and cleanup still runs the same way, instead of leaving the overlay or task stuck.
    const id = nextTaskId('schema-failure');
    const overlay = createOmpConfigOverlay();
    const commandSpec = buildCommandSpec(overlay);
    await seedTask(id, commandSpec);

    const schemaPrompt = [
      'Reply with structured output.',
      '',
      '## OUTPUT FORMAT (CRITICAL - REQUIRED)',
      '',
      'You MUST respond with a JSON object that exactly matches this schema.',
      '',
      'Schema:',
      '```json',
      '{"type":"object","properties":{"ok":{"type":"boolean"}}}',
      '```',
    ].join('\n');

    // The 'happy' scenario's final assistant text is "hello world" — not valid JSON, so this
    // exercises exactly the non-conforming-output path while reusing the same deterministic fake.
    const { code, logFile } = await runWatcher({
      id,
      commandSpec,
      scenario: 'happy',
      prompt: schemaPrompt,
    });
    assert.strictEqual(code, 0);

    const task = await storeGetTask(id);
    assert.strictEqual(task.status, 'completed');
    assert.strictEqual(task.commandCleanup, null, 'cleanup must still run for a schema failure');
    assert.strictEqual(fs.existsSync(overlay.dir), false, 'overlay directory must be removed');

    const log = fs.readFileSync(logFile, 'utf8');
    assert.match(log, /"type":"text"/);
    assert.ok(!log.includes(schemaPrompt), 'the schema-appended prompt text must never be logged');
  });

  it('reports a local-only failure when OMP resolves the prompt without invoking the agent', async function () {
    const id = nextTaskId('local-only');
    const overlay = createOmpConfigOverlay();
    const commandSpec = buildCommandSpec(overlay);
    await seedTask(id, commandSpec);

    const { code } = await runWatcher({ id, commandSpec, scenario: 'local-only' });
    assert.strictEqual(code, 0);

    const task = await storeGetTask(id);
    assert.strictEqual(task.status, 'failed');
    assert.strictEqual(task.commandCleanup, null);
    assert.strictEqual(fs.existsSync(overlay.dir), false);
  });

  it('short-circuits a cancellation requested before the provider ever spawns, and still cleans up', async function () {
    const id = nextTaskId('cancel-before-spawn');
    const overlay = createOmpConfigOverlay();
    const commandSpec = buildCommandSpec(overlay);
    await seedTask(id, commandSpec);
    await storeRequestCancellation(id);
    assert.strictEqual((await storeGetTask(id)).cancelRequested, true);

    const { code } = await runWatcher({ id, commandSpec, scenario: 'happy' });
    assert.strictEqual(code, 0);

    const task = await storeGetTask(id);
    assert.strictEqual(task.status, 'killed');
    assert.strictEqual(task.exitCode, 143);
    assert.strictEqual(task.commandCleanup, null);
    assert.strictEqual(fs.existsSync(overlay.dir), false);
  });

  it('fails permanently on spawn failure (missing binary) and still cleans up the overlay', async function () {
    const id = nextTaskId('spawn-failure');
    const overlay = createOmpConfigOverlay();
    const commandSpec = buildCommandSpec(overlay, {
      binary: path.join(os.tmpdir(), 'zeroshot-omp-binary-does-not-exist'),
      args: [],
    });
    await seedTask(id, commandSpec);

    const { code } = await runWatcher({ id, commandSpec, scenario: 'happy' });
    assert.strictEqual(code, 1);

    const task = await storeGetTask(id);
    assert.strictEqual(task.status, 'failed');
    assert.match(task.error, /^run:/);
    assert.strictEqual(task.commandCleanup, null);
    assert.strictEqual(fs.existsSync(overlay.dir), false);
  });

  it('fails permanently when the provider crashes mid-turn, and still cleans up', async function () {
    const id = nextTaskId('crash-mid-turn');
    const overlay = createOmpConfigOverlay();
    const commandSpec = buildCommandSpec(overlay);
    await seedTask(id, commandSpec);

    const { code, logFile } = await runWatcher({ id, commandSpec, scenario: 'crash' });
    assert.strictEqual(
      code,
      0,
      'the watcher process itself exits cleanly even though the task fails'
    );

    const task = await storeGetTask(id);
    assert.strictEqual(task.status, 'failed');
    assert.strictEqual(task.commandCleanup, null);
    assert.strictEqual(fs.existsSync(overlay.dir), false);

    const log = fs.readFileSync(logFile, 'utf8');
    assert.ok(!log.includes(SENTINEL_PROMPT));
  });

  it('leaves an unsafe cleanup durably retryable instead of silently discarding it', async function () {
    const id = nextTaskId('unsafe-cleanup');
    const overlay = createOmpConfigOverlay();
    fs.chmodSync(overlay.dir, 0o755); // violates the pinned 0700 ownership guarantee
    const commandSpec = buildCommandSpec(overlay);
    const commandCleanup = {
      cleanup: commandSpec.cleanup,
      cleanupMetadata: commandSpec.cleanupMetadata,
    };
    await seedTask(id, commandSpec, { commandCleanup });

    try {
      const { code } = await runWatcher({ id, commandSpec, scenario: 'happy' });
      assert.strictEqual(code, 0);

      const task = await storeGetTask(id);
      assert.strictEqual(task.status, 'completed');
      assert.ok(fs.existsSync(overlay.dir), 'unsafe cleanup must not remove the directory');
      assert.deepStrictEqual(
        task.commandCleanup,
        commandCleanup,
        'failed cleanup must remain a retryable receipt'
      );
    } finally {
      fs.chmodSync(overlay.dir, 0o700);
      fs.rmSync(overlay.dir, { recursive: true, force: true });
    }
  });
});
