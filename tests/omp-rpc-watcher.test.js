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
const ownershipUrl = pathToFileURL(
  path.resolve(__dirname, '../task-lib/omp-session-ownership.js')
).href;
const { allocateOmpSessionPartition } = require('../src/omp-session-partition');

const FAKE_OMP_RPC_PATH = path.join(__dirname, 'helpers', 'fake-omp-rpc.js');
const RPC_WATCHER_PATH = path.join(__dirname, '..', 'task-lib', 'rpc-watcher.js');
const SENTINEL_PROMPT = 'ZS_SENTINEL_PROMPT_MARKER_DO_NOT_LOG_8f21c3';
const {
  SENTINEL_SYSTEM,
  SENTINEL_MESSAGE,
  SENTINEL_CONTROL,
} = require('./helpers/omp-rpc-sentinels');
const { encodeWatcherPromptFrame, sendWatcherPrompt } = require('../src/watcher-prompt-channel');

/**
 * Read a live process's command line the way any local user could: /proc on Linux, `ps` elsewhere.
 * Returns null when the process is already gone or the platform exposes neither.
 */
function readProcessCommandLine(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').join(' ');
  } catch {
    // Not Linux (or the process exited); fall through to ps.
  }
  try {
    return require('child_process')
      .execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' })
      .trim();
  } catch {
    return null;
  }
}

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

async function writeProvisionalOwnershipFor(
  id,
  { partitionId, storageRoot, partitionPath, cwd, owner }
) {
  const stdout = await runStoreScript(`
    const { updateTask } = await import(${JSON.stringify(storeUrl)});
    const { writeProvisionalOwnership } = await import(${JSON.stringify(ownershipUrl)});
    const record = writeProvisionalOwnership({
      partitionId: ${JSON.stringify(partitionId)},
      storageRoot: ${JSON.stringify(storageRoot)},
      partitionPath: ${JSON.stringify(partitionPath)},
      canonicalWorkspace: ${JSON.stringify(cwd)},
      owner: ${JSON.stringify(owner)},
    });
    updateTask(${JSON.stringify(id)}, { ompSessionOwnership: record });
    process.stdout.write(JSON.stringify(record));
  `);
  return JSON.parse(stdout);
}

// Simulates the parent agent process's post-hook success boundary (agent-lifecycle.js), which is
// the only caller ever allowed to advance a cluster-agent owner from 'provisional' to 'committed'.
async function commitRecordedOwnershipFor(id) {
  const stdout = await runStoreScript(`
    const { commitRecordedOwnership } = await import(${JSON.stringify(ownershipUrl)});
    const { getTask } = await import(${JSON.stringify(storeUrl)});
    const committed = commitRecordedOwnership(${JSON.stringify(id)});
    process.stdout.write(JSON.stringify({ committed, task: getTask(${JSON.stringify(id)}) }));
  `);
  return JSON.parse(stdout);
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

/**
 * Fork the real watcher exactly the way task-lib/runner.js#spawnWatcher does: the prompt travels
 * over the private stdin pipe, and argv carries only the id/cwd/logFile/args/config quintuple.
 *
 * `promptFrame` overrides the framed bytes written to that pipe (used to prove the fail-closed
 * paths); `sendPrompt: false` attaches no pipe at all, i.e. an absent channel.
 */
function runWatcher({
  id,
  commandSpec,
  scenario,
  prompt = SENTINEL_PROMPT,
  env = {},
  promptFrame = null,
  sendPrompt = true,
  ompSession = null,
  ompResumeExpectation = null,
}) {
  const logFile = path.join(zeroshotHome, `${id}.log`);
  fs.writeFileSync(logFile, '');
  const argv = [
    id,
    commandSpec.cwd,
    logFile,
    '[]',
    JSON.stringify({
      commandSpec,
      ...(ompSession ? { ompSession } : {}),
      ...(ompResumeExpectation ? { ompResumeExpectation } : {}),
    }),
  ];
  return new Promise((resolve, reject) => {
    const child = fork(RPC_WATCHER_PATH, argv, {
      env: {
        ...process.env,
        ZEROSHOT_HOME: zeroshotHome,
        OMP_FAKE_RPC_SCENARIO: scenario,
        ...env,
      },
      stdio: sendPrompt ? ['pipe', 'ignore', 'ignore', 'ipc'] : 'ignore',
    });

    // Sampled synchronously here because uv_spawn has already fork+exec'd by the time fork()
    // returns, so /proc/<pid>/cmdline is populated and the watcher cannot yet have exited.
    const cmdline = readProcessCommandLine(child.pid);

    if (sendPrompt) {
      if (promptFrame === null) sendWatcherPrompt(child.stdin, prompt);
      else {
        child.stdin.on('error', () => {});
        child.stdin.end(promptFrame);
      }
    }

    child.on('exit', (code) => resolve({ code, logFile, argv, cmdline }));
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

  it('keeps the prompt out of watcher argv/process inspection yet delivers it verbatim to OMP', async function () {
    // Regression for the argv-exposure finding on PR #907: buildWatcherConfig used to embed the
    // whole OMP prompt in the JSON blob serialized into the detached watcher's argv, where any
    // local user could read it out of `ps` / /proc/<pid>/cmdline for the watcher's whole lifetime.
    const id = nextTaskId('prompt-channel');
    const overlay = createOmpConfigOverlay();
    const promptSink = path.join(zeroshotHome, `${id}-prompt.json`);
    const commandSpec = buildCommandSpec(overlay);
    await seedTask(id, commandSpec);

    const { code, logFile, argv, cmdline } = await runWatcher({
      id,
      commandSpec,
      scenario: 'happy',
      env: { OMP_FAKE_RPC_PROMPT_SINK: promptSink },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual((await storeGetTask(id)).status, 'completed');

    // ...absent from argv, and from the live process as a local observer would see it...
    assert.ok(
      !JSON.stringify(argv).includes(SENTINEL_PROMPT),
      'prompt bytes must never be serialized into watcher argv'
    );
    assert.ok(cmdline, 'the running watcher command line must be observable for this assertion');
    assert.ok(
      !cmdline.includes(SENTINEL_PROMPT),
      `prompt bytes must never be visible in process inspection: ${cmdline}`
    );
    assert.ok(!fs.readFileSync(logFile, 'utf8').includes(SENTINEL_PROMPT));

    // ...yet arrives byte-for-byte at the fake OMP's RPC `prompt` command.
    assert.strictEqual(
      JSON.parse(fs.readFileSync(promptSink, 'utf8')).message,
      SENTINEL_PROMPT,
      'the private pipe must deliver exactly the prompt that was sent'
    );
  });

  it('delivers a prompt larger than the pipe buffer in full after the spawning parent has exited', async function () {
    // The spawning process must outlive the write but not the task: a prompt past the ~64 KiB
    // kernel pipe buffer cannot be flushed in one go, so this proves the handoff completes without
    // the parent ever waiting on the detached watcher.
    const id = nextTaskId('large-prompt-parent-exit');
    const overlay = createOmpConfigOverlay();
    const promptSink = path.join(zeroshotHome, `${id}-prompt.json`);
    const commandSpec = buildCommandSpec(overlay);
    await seedTask(id, commandSpec);

    const largePrompt = `${SENTINEL_PROMPT}${'x'.repeat(256 * 1024)}${SENTINEL_PROMPT}`;
    const promptFile = path.join(zeroshotHome, `${id}-prompt-input.txt`);
    fs.writeFileSync(promptFile, largePrompt);
    const logFile = path.join(zeroshotHome, `${id}.log`);
    fs.writeFileSync(logFile, '');
    const argv = [id, commandSpec.cwd, logFile, '[]', JSON.stringify({ commandSpec })];

    // A standalone parent that mirrors spawnWatcher(): fork detached, hand over the prompt, unref,
    // disconnect, and return. It must exit on its own rather than being killed here.
    const spawnerPath = path.join(zeroshotHome, `${id}-spawner.cjs`);
    fs.writeFileSync(
      spawnerPath,
      `const fs = require('fs');
const { fork } = require('child_process');
const { sendWatcherPrompt } = require(${JSON.stringify(
        require.resolve('../src/watcher-prompt-channel')
      )});
const watcher = fork(${JSON.stringify(RPC_WATCHER_PATH)}, ${JSON.stringify(argv)}, {
  detached: true,
  stdio: ['pipe', 'ignore', 'ignore', 'ipc'],
  env: {
    ...process.env,
    ZEROSHOT_HOME: ${JSON.stringify(zeroshotHome)},
    OMP_FAKE_RPC_SCENARIO: 'happy',
    OMP_FAKE_RPC_PROMPT_SINK: ${JSON.stringify(promptSink)},
  },
});
sendWatcherPrompt(watcher.stdin, fs.readFileSync(${JSON.stringify(promptFile)}, 'utf8'));
watcher.unref();
watcher.disconnect();
`
    );

    await execFileAsync(process.execPath, [spawnerPath]);

    const deadline = Date.now() + 15000;
    let task = await storeGetTask(id);
    while (task.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      task = await storeGetTask(id);
    }

    assert.strictEqual(task.status, 'completed', `task did not complete: ${JSON.stringify(task)}`);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(promptSink, 'utf8')).message,
      largePrompt,
      'the whole prompt must survive the parent exiting mid-handoff'
    );
    assert.ok(!fs.readFileSync(logFile, 'utf8').includes(SENTINEL_PROMPT));
  });

  it('fails closed without spawning OMP when the prompt channel is absent, truncated, or over the 1 MiB contract', async function () {
    const oversizedHeader = `${JSON.stringify({
      kind: 'zeroshot-watcher-prompt-v1',
      promptBytes: 1024 * 1024 + 1,
    })}\n`;
    const completeFrame = encodeWatcherPromptFrame(SENTINEL_PROMPT);
    const cases = [
      { label: 'absent', sendPrompt: false, expected: /prompt-channel: .*closed before/ },
      {
        label: 'truncated',
        promptFrame: completeFrame.subarray(0, completeFrame.byteLength - 5),
        expected: /prompt-channel: .*closed after \d+ of \d+ declared bytes/,
      },
      {
        label: 'over-contract',
        promptFrame: Buffer.from(oversizedHeader, 'utf8'),
        expected: /prompt-channel: .*above the 1048576-byte contract/,
      },
      {
        label: 'header-only-then-close',
        promptFrame: Buffer.from(
          `${JSON.stringify({ kind: 'zeroshot-watcher-prompt-v1', promptBytes: 32 })}\n`,
          'utf8'
        ),
        expected: /prompt-channel: .*closed after 0 of 32 declared bytes/,
      },
    ];

    for (const { label, expected, ...channel } of cases) {
      const id = nextTaskId(`prompt-channel-${label}`);
      const overlay = createOmpConfigOverlay();
      const promptSink = path.join(zeroshotHome, `${id}-prompt.json`);
      const commandSpec = buildCommandSpec(overlay);
      await seedTask(id, commandSpec);

      const { code } = await runWatcher({
        id,
        commandSpec,
        scenario: 'happy',
        env: { OMP_FAKE_RPC_PROMPT_SINK: promptSink },
        ...channel,
      });

      assert.strictEqual(code, 1, `${label}: watcher must exit non-zero`);
      const task = await storeGetTask(id);
      assert.strictEqual(task.status, 'failed', `${label}: task must fail closed`);
      assert.match(task.error, expected, `${label}: error must name the prompt channel`);
      // Fail-closed means OMP was never prompted, and ownership-aware cleanup still ran.
      assert.strictEqual(fs.existsSync(promptSink), false, `${label}: OMP must never be prompted`);
      assert.strictEqual(task.commandCleanup, null, `${label}: cleanup receipt must be cleared`);
      assert.strictEqual(fs.existsSync(overlay.dir), false, `${label}: overlay must be removed`);
    }
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

  describe('OMP session ownership (fresh/resume, two-phase verification)', function () {
    it('commits ownership after a fresh session terminates with a materialized, verifiable session file', async function () {
      const id = nextTaskId('omp-fresh-commit');
      const overlay = createOmpConfigOverlay();
      const commandSpec = buildCommandSpec(overlay);
      const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
      const { partitionId, path: partitionPath } = allocateOmpSessionPartition(storageRoot);
      const sessionFile = path.join(partitionPath, `${id}.jsonl`);
      fs.writeFileSync(sessionFile, '{"hello":"world"}\n');

      await seedTask(id, commandSpec);
      await writeProvisionalOwnershipFor(id, {
        partitionId,
        storageRoot,
        partitionPath,
        cwd: commandSpec.cwd,
        owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: id },
      });

      const { code } = await runWatcher({
        id,
        commandSpec,
        scenario: 'happy',
        ompSession: { kind: 'fresh', partition: { path: partitionPath } },
        env: {
          OMP_FAKE_RPC_SESSION_ID: 'fresh-sess-1',
          OMP_FAKE_RPC_SESSION_FILE: sessionFile,
        },
      });
      assert.strictEqual(code, 0);

      const task = await storeGetTask(id);
      assert.strictEqual(task.status, 'completed');
      assert.strictEqual(task.ompSessionOwnership.state, 'committed');
      assert.strictEqual(task.ompSessionOwnership.session.sessionId, 'fresh-sess-1');
      assert.strictEqual(task.ompSessionOwnership.session.fileName, `${id}.jsonl`);
      assert.match(
        task.ompSessionOwnership.session.artifactManifestDigest,
        /^sha256:[a-f0-9]{64}$/
      );
    });

    it('records verified evidence but never commits a cluster-agent owner — commit stays the parent post-hook boundary', async function () {
      // A cluster-agent owner's turn is not durable until the spawning agent process validates
      // logical/schema output and its onComplete hook succeeds (agent-lifecycle.js) — a boundary
      // this detached watcher process cannot observe. The watcher must only persist the owner-fenced
      // verified evidence and leave 'committed' to that later, separate-process boundary.
      const id = nextTaskId('omp-fresh-cluster-agent-defers-commit');
      const overlay = createOmpConfigOverlay();
      const commandSpec = buildCommandSpec(overlay);
      const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
      const { partitionId, path: partitionPath } = allocateOmpSessionPartition(storageRoot);
      const sessionFile = path.join(partitionPath, `${id}.jsonl`);
      fs.writeFileSync(sessionFile, '{"hello":"world"}\n');

      await seedTask(id, commandSpec);
      await writeProvisionalOwnershipFor(id, {
        partitionId,
        storageRoot,
        partitionPath,
        cwd: commandSpec.cwd,
        owner: { kind: 'cluster-agent', clusterId: 'cluster-1', agentId: 'worker-1', taskId: id },
      });

      const { code } = await runWatcher({
        id,
        commandSpec,
        scenario: 'happy',
        ompSession: { kind: 'fresh', partition: { path: partitionPath } },
        env: {
          OMP_FAKE_RPC_SESSION_ID: 'fresh-sess-cluster-agent',
          OMP_FAKE_RPC_SESSION_FILE: sessionFile,
        },
      });
      assert.strictEqual(code, 0);

      const task = await storeGetTask(id);
      assert.strictEqual(task.status, 'completed', 'the turn itself still completed');
      assert.strictEqual(
        task.ompSessionOwnership.state,
        'provisional',
        'a cluster-agent owner must not be committed by the watcher'
      );
      assert.strictEqual(task.ompSessionOwnership.session.sessionId, 'fresh-sess-cluster-agent');
      assert.ok(
        task.ompSessionOwnership.partitionIdentity,
        'verified evidence must still be recorded'
      );

      // Only after this succeeds — mirroring agent-lifecycle.js's post-hook success boundary —
      // does the record advance to 'committed', reusing the evidence above without re-verifying.
      const { committed, task: afterCommit } = await commitRecordedOwnershipFor(id);
      assert.strictEqual(committed, true);
      assert.strictEqual(afterCommit.ompSessionOwnership.state, 'committed');
      assert.strictEqual(
        afterCommit.ompSessionOwnership.session.sessionId,
        'fresh-sess-cluster-agent'
      );
    });

    it('marks cleanup-required instead of committing when the provider crashes mid-turn', async function () {
      const id = nextTaskId('omp-fresh-crash');
      const overlay = createOmpConfigOverlay();
      const commandSpec = buildCommandSpec(overlay);
      const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
      const { partitionId, path: partitionPath } = allocateOmpSessionPartition(storageRoot);

      await seedTask(id, commandSpec);
      await writeProvisionalOwnershipFor(id, {
        partitionId,
        storageRoot,
        partitionPath,
        cwd: commandSpec.cwd,
        owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: id },
      });

      const { code } = await runWatcher({
        id,
        commandSpec,
        scenario: 'crash',
        ompSession: { kind: 'fresh', partition: { path: partitionPath } },
      });
      assert.strictEqual(code, 0);

      const task = await storeGetTask(id);
      assert.strictEqual(task.status, 'failed');
      assert.strictEqual(task.ompSessionOwnership.state, 'cleanup-required');
    });

    it('resumes successfully when the observed session matches the recorded owner exactly', async function () {
      const id = nextTaskId('omp-resume-match');
      const overlay = createOmpConfigOverlay();
      const commandSpec = buildCommandSpec(overlay);
      const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
      const { partitionId, path: partitionPath } = allocateOmpSessionPartition(storageRoot);
      const sessionFileName = 'prior-session.jsonl';
      const sessionFile = path.join(partitionPath, sessionFileName);
      fs.writeFileSync(sessionFile, '{"turn":1}\n');
      const stat = fs.statSync(sessionFile);

      await seedTask(id, commandSpec);
      await writeProvisionalOwnershipFor(id, {
        partitionId,
        storageRoot,
        partitionPath,
        cwd: commandSpec.cwd,
        owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: id },
      });

      // The pre-resume manifest digest is whatever the (real) verifier would compute for this
      // exact file tree — recomputed here via the same module the watcher itself uses.
      const { verifyExistingOmpPartition } = require('../src/omp-session-verifier');
      const preVerify = verifyExistingOmpPartition(partitionPath, sessionFileName);

      const { code } = await runWatcher({
        id,
        commandSpec,
        scenario: 'happy',
        ompSession: {
          kind: 'resume',
          partition: { path: partitionPath },
          file: { path: sessionFile },
        },
        ompResumeExpectation: {
          expectedSessionFileIdentity: { device: String(stat.dev), inode: String(stat.ino) },
          expectedArtifactManifestDigest: preVerify.artifactManifestDigest,
          expectedSelectedProvider: 'anthropic',
          expectedSelectedModel: '@default',
        },
        env: {
          OMP_FAKE_RPC_SESSION_ID: 'resumed-sess',
          OMP_FAKE_RPC_SESSION_FILE: sessionFile,
        },
      });
      assert.strictEqual(code, 0);

      const task = await storeGetTask(id);
      assert.strictEqual(task.status, 'completed');
      assert.strictEqual(task.ompSessionOwnership.state, 'committed');
      assert.strictEqual(task.ompSessionOwnership.session.sessionId, 'resumed-sess');
    });

    it('fails closed before the prompt when the resumed selector drifts from the recorded owner', async function () {
      const id = nextTaskId('omp-resume-selector-drift');
      const overlay = createOmpConfigOverlay();
      const commandSpec = buildCommandSpec(overlay);
      const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
      const { partitionId, path: partitionPath } = allocateOmpSessionPartition(storageRoot);
      const sessionFileName = 'prior-session.jsonl';
      const sessionFile = path.join(partitionPath, sessionFileName);
      fs.writeFileSync(sessionFile, '{"turn":1}\n');
      const stat = fs.statSync(sessionFile);

      await seedTask(id, commandSpec);
      await writeProvisionalOwnershipFor(id, {
        partitionId,
        storageRoot,
        partitionPath,
        cwd: commandSpec.cwd,
        owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: id },
      });

      const { verifyExistingOmpPartition } = require('../src/omp-session-verifier');
      const preVerify = verifyExistingOmpPartition(partitionPath, sessionFileName);
      const promptSink = path.join(zeroshotHome, `${id}-prompt.json`);

      const { code } = await runWatcher({
        id,
        commandSpec,
        scenario: 'happy',
        ompSession: {
          kind: 'resume',
          partition: { path: partitionPath },
          file: { path: sessionFile },
        },
        ompResumeExpectation: {
          expectedSessionFileIdentity: { device: String(stat.dev), inode: String(stat.ino) },
          expectedArtifactManifestDigest: preVerify.artifactManifestDigest,
          // The recorded owner expects a different provider/model than what get_state reports.
          expectedSelectedProvider: 'openai',
          expectedSelectedModel: '@other',
        },
        env: {
          OMP_FAKE_RPC_SESSION_ID: 'resumed-sess',
          OMP_FAKE_RPC_SESSION_FILE: sessionFile,
          OMP_FAKE_RPC_PROMPT_SINK: promptSink,
        },
      });
      assert.strictEqual(
        code,
        0,
        'the watcher process itself exits cleanly even though the task fails'
      );

      const task = await storeGetTask(id);
      assert.strictEqual(task.status, 'failed');
      assert.match(task.error, /selector/);
      assert.strictEqual(task.ompSessionOwnership.state, 'cleanup-required');
      assert.strictEqual(
        fs.existsSync(promptSink),
        false,
        'OMP must never receive the prompt on drift'
      );
    });

    it('fails closed before spawn when the resume file has been substituted for a symlink', async function () {
      const id = nextTaskId('omp-resume-symlink-substitution');
      const overlay = createOmpConfigOverlay();
      const commandSpec = buildCommandSpec(overlay);
      const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
      const { partitionId, path: partitionPath } = allocateOmpSessionPartition(storageRoot);
      const sessionFileName = 'prior-session.jsonl';
      const sessionFile = path.join(partitionPath, sessionFileName);
      const outsideTarget = path.join(zeroshotHome, `${id}-outside.jsonl`);
      fs.writeFileSync(outsideTarget, '{"turn":1}\n');
      fs.symlinkSync(outsideTarget, sessionFile);

      await seedTask(id, commandSpec);
      await writeProvisionalOwnershipFor(id, {
        partitionId,
        storageRoot,
        partitionPath,
        cwd: commandSpec.cwd,
        owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: id },
      });

      const { code } = await runWatcher({
        id,
        commandSpec,
        scenario: 'happy',
        ompSession: {
          kind: 'resume',
          partition: { path: partitionPath },
          file: { path: sessionFile },
        },
        sendPrompt: true,
      });
      assert.strictEqual(code, 1);

      const task = await storeGetTask(id);
      assert.strictEqual(task.status, 'failed');
      assert.match(task.error, /symlink/);
      assert.strictEqual(task.ompSessionOwnership.state, 'cleanup-required');
    });
  });
});
