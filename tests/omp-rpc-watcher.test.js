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

async function writeProvisionalOwnershipFor(id, { partitionId, storageRoot, cwd, owner }) {
  const stdout = await runStoreScript(`
    const { updateTask } = await import(${JSON.stringify(storeUrl)});
    const { writeProvisionalOwnership } = await import(${JSON.stringify(ownershipUrl)});
    const record = writeProvisionalOwnership({
      partitionId: ${JSON.stringify(partitionId)},
      storageRoot: ${JSON.stringify(storageRoot)},
      canonicalWorkspace: ${JSON.stringify(cwd)},
      owner: ${JSON.stringify(owner)},
    });
    updateTask(${JSON.stringify(id)}, { ompSessionOwnership: record });
    process.stdout.write(JSON.stringify(record));
  `);
  return JSON.parse(stdout);
}

/** Advance a seeded provisional row straight to committed, standing in for a prior successful
 * turn's terminal boundary so a resume has a real committed lineage to transfer from. */
async function commitOwnershipFor(id, evidence) {
  const stdout = await runStoreScript(`
    const { commitOwnership } = await import(${JSON.stringify(ownershipUrl)});
    process.stdout.write(JSON.stringify(commitOwnership({
      taskId: ${JSON.stringify(id)},
      selectedProvider: 'anthropic',
      selectedModel: '@default',
      ...${JSON.stringify(evidence)},
    })));
  `);
  return JSON.parse(stdout);
}

/** Release a row's ownership out of band, modelling another process having already claimed or
 * cleared the lineage before this watcher reaches its transfer point. */
async function clearOwnershipFor(id) {
  await runStoreScript(`
    const { updateTask } = await import(${JSON.stringify(storeUrl)});
    updateTask(${JSON.stringify(id)}, { ompSessionOwnership: null });
  `);
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

  /**
   * OMP session ownership end to end through the real detached watcher (issue #866).
   *
   * The fake `omp --mode rpc` here is driven with real `--session-dir` / `--resume` argv and
   * materializes a real session transcript whose first record is OMP's session header, so these
   * exercise the actual two-phase contract rather than a stub: verify-before-spawn,
   * re-verify-and-transfer-before-prompt, and descriptor/header/tree verification after terminal
   * materialization.
   */
  describe('OMP session ownership (fresh/resume, two-phase verification)', function () {
    const {
      makeBlobStore,
      makeSessionPartition,
    } = require('./helpers/omp-session-fixtures');
    const { verifyExistingOmpPartition } = require('../src/omp-session-verifier');
    const { computeOmpExecutionFingerprint } = require('../src/omp-execution-fingerprint');
    const {
      generateOmpPartitionId,
      partitionPathFor,
      createOmpSessionPartitionDirectory,
    } = require('../src/omp-session-partition');
    const { OMP_SUPPORTED_VERSION } = require('../lib/agent-cli-provider/omp-release.js');


    /**
     * A pre-prompt failure raised from the driver's `ready` hook can terminate the watcher through
     * either of two legitimate paths depending on scheduling: the driver may convert it into a
     * failed terminal result (exit 0, task marked failed by completeWatcherTask) or it may reject
     * out of runOmpRpcTask into the crash handler (exit 1). Both are correct, and which one wins is
     * a timing race under load — so these assertions pin the durable outcome that actually matters
     * instead of the exit code that does not.
     */
    function assertFailedBeforePrompt({ code, task, promptSink, errorPattern }) {
      assert.ok(code === 0 || code === 1, `watcher must terminate, got exit ${code}`);
      assert.strictEqual(task.status, 'failed');
      assert.match(task.error, errorPattern);
      assert.strictEqual(task.ompSessionOwnership.state, 'cleanup-required');
      if (promptSink !== undefined) {
        assert.strictEqual(
          fs.existsSync(promptSink),
          false,
          'OMP must never receive the prompt once the pre-prompt checks have failed'
        );
      }
    }

    function freshCommandSpec(overlay, partitionPath, cwd) {
      return buildCommandSpec(overlay, {
        args: [
          FAKE_OMP_RPC_PATH,
          '--mode',
          'rpc',
          '--session-dir',
          partitionPath,
          '--model',
          '@default',
          '--thinking',
          'medium',
          '--approval-mode',
          'yolo',
        ],
        ...(cwd ? { cwd } : {}),
      });
    }

    function resumeCommandSpec(overlay, partitionPath, sessionFilePath, cwd) {
      return buildCommandSpec(overlay, {
        args: [
          FAKE_OMP_RPC_PATH,
          '--mode',
          'rpc',
          '--session-dir',
          partitionPath,
          '--resume',
          sessionFilePath,
          '--model',
          '@default',
          '--thinking',
          'medium',
          '--approval-mode',
          'yolo',
        ],
        ...(cwd ? { cwd } : {}),
      });
    }

    function fingerprintFor(commandSpec, evidence = {}) {
      return computeOmpExecutionFingerprint({
        expectedVersion: OMP_SUPPORTED_VERSION,
        commandSpec,
        evidence: {
          selectedProvider: 'anthropic',
          selectedModel: '@default',
          thinkingLevel: 'medium',
          ...evidence,
        },
      });
    }

    /** Seed the row + provisional ownership for a fresh turn and return the allocated partition. */
    async function seedFreshOwner(id, { storageRoot, cwd, owner, commandSpec }) {
      const partitionId = generateOmpPartitionId();
      const partitionPath = partitionPathFor(storageRoot, partitionId);
      createOmpSessionPartitionDirectory(partitionPath);
      await seedTask(id, commandSpec);
      await writeProvisionalOwnershipFor(id, { partitionId, storageRoot, cwd, owner });
      return { partitionId, partitionPath };
    }

    /**
     * Seed a *prior* committed owner over a materialized partition, plus the resumed task's own
     * provisional row, and return the complete resume expectation the watcher receives — exactly
     * what task-lib/runner.js#resolveOmpResumeExpectation derives from the persisted record.
     */
    async function seedResumeLineage({
      priorId,
      resumedId,
      storageRoot,
      cwd,
      commandSpec,
      partition,
      owner = (taskId) => ({ kind: 'standalone', clusterId: null, agentId: null, taskId }),
      expectationOverrides = {},
    }) {
      const verified = verifyExistingOmpPartition(
        partition.partitionPath,
        partition.sessionFileName
      );
      const executionFingerprint = fingerprintFor(commandSpec);

      await seedTask(priorId, commandSpec);
      await writeProvisionalOwnershipFor(priorId, {
        partitionId: partition.partitionId,
        storageRoot,
        cwd,
        owner: owner(priorId),
      });
      await commitOwnershipFor(priorId, {
        sessionId: partition.sessionId,
        sessionFilePath: partition.sessionFilePath,
        artifactManifestDigest: verified.artifactManifestDigest,
        executionFingerprint,
      });

      await seedTask(resumedId, commandSpec);
      await writeProvisionalOwnershipFor(resumedId, {
        partitionId: partition.partitionId,
        storageRoot,
        cwd,
        owner: owner(resumedId),
      });

      return {
        verified,
        expectation: {
          priorOwnerTaskId: priorId,
          partitionId: partition.partitionId,
          partitionPath: partition.partitionPath,
          canonicalWorkspace: cwd,
          sessionFileName: partition.sessionFileName,
          sessionFilePath: partition.sessionFilePath,
          expectedSessionId: partition.sessionId,
          expectedPartitionIdentity: verified.partitionIdentity,
          expectedSessionFileIdentity: verified.sessionFileIdentity,
          expectedArtifactManifestDigest: verified.artifactManifestDigest,
          expectedExecutionFingerprint: executionFingerprint,
          expectedSelectedProvider: 'anthropic',
          expectedSelectedModel: '@default',
          ...expectationOverrides,
        },
      };
    }

    describe('fresh sessions', function () {
      it('host: commits a standalone owner after descriptor/header/tree verification', async function () {
        const id = nextTaskId('fresh-standalone');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const partitionId = generateOmpPartitionId();
        const partitionPath = partitionPathFor(storageRoot, partitionId);
        createOmpSessionPartitionDirectory(partitionPath);
        const commandSpec = freshCommandSpec(overlay, partitionPath);

        await seedTask(id, commandSpec);
        await writeProvisionalOwnershipFor(id, {
          partitionId,
          storageRoot,
          cwd: commandSpec.cwd,
          owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: id },
        });

        const { code } = await runWatcher({
          id,
          commandSpec,
          scenario: 'happy',
          ompSession: { kind: 'fresh', partition: { path: partitionPath } },
          env: {
            OMP_FAKE_RPC_MINT_SESSION_ID: 'fresh-standalone-session',
            OMP_FAKE_RPC_SESSION_CWD: commandSpec.cwd,
            OMP_FAKE_RPC_ARTIFACT_DIR: '1',
          },
        });
        assert.strictEqual(code, 0);

        const task = await storeGetTask(id);
        assert.strictEqual(task.status, 'completed');
        const ownership = task.ompSessionOwnership;
        assert.strictEqual(ownership.state, 'committed');
        assert.strictEqual(ownership.session.sessionId, 'fresh-standalone-session');
        assert.match(ownership.session.fileName, /^.*_fresh-standalone-session\.jsonl$/);
        assert.match(ownership.session.artifactManifestDigest, /^sha256:[a-f0-9]{64}$/);
        assert.strictEqual(ownership.session.executionFingerprint, fingerprintFor(commandSpec));
        assert.strictEqual(ownership.session.selectedProvider, 'anthropic');
        assert.strictEqual(ownership.session.selectedModel, '@default');
        assert.ok(ownership.partitionIdentity, 'the verified partition identity is recorded');

        // The manifest the watcher committed is exactly what the verifier computes for the tree
        // OMP actually left behind, including the sibling artifacts directory.
        const reverified = verifyExistingOmpPartition(partitionPath, ownership.session.fileName);
        assert.strictEqual(
          reverified.artifactManifestDigest,
          ownership.session.artifactManifestDigest
        );
        assert.ok(fs.existsSync(path.join(partitionPath, ownership.session.fileName.slice(0, -6))));
      });

      it('worktree: commits under a cwd that is not the storage root', async function () {
        const id = nextTaskId('fresh-worktree');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const worktree = fs.mkdtempSync(path.join(zeroshotHome, 'omp-worktree-'));
        const partitionId = generateOmpPartitionId();
        const partitionPath = partitionPathFor(storageRoot, partitionId);
        createOmpSessionPartitionDirectory(partitionPath);
        const commandSpec = freshCommandSpec(overlay, partitionPath, worktree);

        await seedTask(id, commandSpec);
        await writeProvisionalOwnershipFor(id, {
          partitionId,
          storageRoot,
          cwd: worktree,
          owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: id },
        });

        const { code } = await runWatcher({
          id,
          commandSpec,
          scenario: 'happy',
          ompSession: { kind: 'fresh', partition: { path: partitionPath } },
          env: {
            OMP_FAKE_RPC_MINT_SESSION_ID: 'worktree-session',
            OMP_FAKE_RPC_SESSION_CWD: worktree,
          },
        });
        assert.strictEqual(code, 0);
        const task = await storeGetTask(id);
        assert.strictEqual(task.ompSessionOwnership.state, 'committed');
        assert.strictEqual(task.ompSessionOwnership.canonicalWorkspace, worktree);
      });

      it('detached cluster-agent: records verified evidence but leaves commit to the parent boundary', async function () {
        const id = nextTaskId('fresh-cluster-agent');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-cluster-storage-'));
        const partitionId = generateOmpPartitionId();
        const partitionPath = partitionPathFor(storageRoot, partitionId);
        createOmpSessionPartitionDirectory(partitionPath);
        const commandSpec = freshCommandSpec(overlay, partitionPath);

        await seedTask(id, commandSpec);
        await writeProvisionalOwnershipFor(id, {
          partitionId,
          storageRoot,
          cwd: commandSpec.cwd,
          owner: { kind: 'cluster-agent', clusterId: 'cluster-1', agentId: 'worker-1', taskId: id },
        });

        const { code } = await runWatcher({
          id,
          commandSpec,
          scenario: 'happy',
          ompSession: { kind: 'fresh', partition: { path: partitionPath } },
          env: {
            OMP_FAKE_RPC_MINT_SESSION_ID: 'cluster-agent-session',
            OMP_FAKE_RPC_SESSION_CWD: commandSpec.cwd,
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
        assert.strictEqual(task.ompSessionOwnership.session.sessionId, 'cluster-agent-session');
        assert.ok(task.ompSessionOwnership.partitionIdentity);

        const { committed, task: afterCommit } = await commitRecordedOwnershipFor(id);
        assert.strictEqual(committed, true);
        assert.strictEqual(afterCommit.ompSessionOwnership.state, 'committed');
        assert.strictEqual(
          afterCommit.ompSessionOwnership.session.sessionId,
          'cluster-agent-session'
        );
      });

      it('marks cleanup-required instead of committing when the provider crashes mid-turn', async function () {
        const id = nextTaskId('fresh-crash');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const { partitionPath } = await seedFreshOwner(id, {
          storageRoot,
          cwd: buildCommandSpec(overlay).cwd,
          owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: id },
          commandSpec: buildCommandSpec(overlay),
        });

        const { code } = await runWatcher({
          id,
          commandSpec: freshCommandSpec(overlay, partitionPath),
          scenario: 'crash',
          ompSession: { kind: 'fresh', partition: { path: partitionPath } },
        });
        assert.strictEqual(code, 0);

        const task = await storeGetTask(id);
        assert.strictEqual(task.status, 'failed');
        assert.strictEqual(task.ompSessionOwnership.state, 'cleanup-required');
      });

      it('refuses to claim a session OMP wrote outside this task s partition', async function () {
        const id = nextTaskId('fresh-outside-partition');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const partitionId = generateOmpPartitionId();
        const partitionPath = partitionPathFor(storageRoot, partitionId);
        createOmpSessionPartitionDirectory(partitionPath);
        const commandSpec = freshCommandSpec(overlay, partitionPath);
        const elsewhere = path.join(zeroshotHome, `${id}-elsewhere.jsonl`);
        fs.writeFileSync(elsewhere, '{"type":"session","id":"elsewhere"}\n');

        await seedTask(id, commandSpec);
        await writeProvisionalOwnershipFor(id, {
          partitionId,
          storageRoot,
          cwd: commandSpec.cwd,
          owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: id },
        });

        const { code } = await runWatcher({
          id,
          commandSpec,
          scenario: 'happy',
          ompSession: { kind: 'fresh', partition: { path: partitionPath } },
          env: {
            OMP_FAKE_RPC_MINT_SESSION_ID: 'in-partition',
            OMP_FAKE_RPC_SESSION_FILE: elsewhere,
            OMP_FAKE_RPC_SESSION_ID: 'elsewhere',
          },
        });
        assert.strictEqual(code, 0);
        const task = await storeGetTask(id);
        assert.strictEqual(task.ompSessionOwnership.state, 'cleanup-required');
      });

      it('refuses a materialized header whose recorded cwd is not this task s workspace', async function () {
        const id = nextTaskId('fresh-wrong-cwd');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const partitionId = generateOmpPartitionId();
        const partitionPath = partitionPathFor(storageRoot, partitionId);
        createOmpSessionPartitionDirectory(partitionPath);
        const commandSpec = freshCommandSpec(overlay, partitionPath);

        await seedTask(id, commandSpec);
        await writeProvisionalOwnershipFor(id, {
          partitionId,
          storageRoot,
          cwd: commandSpec.cwd,
          owner: { kind: 'standalone', clusterId: null, agentId: null, taskId: id },
        });

        const { code } = await runWatcher({
          id,
          commandSpec,
          scenario: 'happy',
          ompSession: { kind: 'fresh', partition: { path: partitionPath } },
          env: {
            OMP_FAKE_RPC_MINT_SESSION_ID: 'wrong-cwd-session',
            OMP_FAKE_RPC_SESSION_CWD: '/somewhere/else/entirely',
          },
        });
        assert.strictEqual(code, 0);
        const task = await storeGetTask(id);
        assert.strictEqual(task.ompSessionOwnership.state, 'cleanup-required');
      });
    });

    describe('verified resume', function () {
      it('transfers ownership before the prompt and commits the new evidence on success', async function () {
        const priorId = nextTaskId('resume-prior');
        const resumedId = nextTaskId('resume-new');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const partition = makeSessionPartition({ storageRoot, cwd });
        const commandSpec = resumeCommandSpec(
          overlay,
          partition.partitionPath,
          partition.sessionFilePath,
          cwd
        );
        const { expectation } = await seedResumeLineage({
          priorId,
          resumedId,
          storageRoot,
          cwd,
          commandSpec,
          partition,
        });
        const promptSink = path.join(zeroshotHome, `${resumedId}-prompt.json`);

        const { code } = await runWatcher({
          id: resumedId,
          commandSpec,
          scenario: 'happy',
          ompSession: {
            kind: 'resume',
            partition: { path: partition.partitionPath },
            file: { path: partition.sessionFilePath },
          },
          ompResumeExpectation: expectation,
          env: { OMP_FAKE_RPC_PROMPT_SINK: promptSink },
        });
        assert.strictEqual(code, 0);

        const resumed = await storeGetTask(resumedId);
        assert.strictEqual(resumed.status, 'completed');
        assert.strictEqual(resumed.ompSessionOwnership.state, 'committed');
        assert.strictEqual(resumed.ompSessionOwnership.session.sessionId, partition.sessionId);
        assert.strictEqual(resumed.ompSessionOwnership.partitionId, partition.partitionId);
        assert.strictEqual(resumed.ompSessionOwnership.owner.taskId, resumedId);

        const prior = await storeGetTask(priorId);
        assert.strictEqual(
          prior.ompSessionOwnership,
          null,
          'the prior owner is released atomically, so exactly one row holds the lineage'
        );
        assert.ok(fs.existsSync(promptSink), 'the prompt is written only after the transfer');
      });

      it('never prompts and never transfers when the echoed session ID differs from the recorded one', async function () {
        const priorId = nextTaskId('resume-id-drift-prior');
        const resumedId = nextTaskId('resume-id-drift');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const partition = makeSessionPartition({ storageRoot, cwd });
        const commandSpec = resumeCommandSpec(
          overlay,
          partition.partitionPath,
          partition.sessionFilePath,
          cwd
        );
        const { expectation } = await seedResumeLineage({
          priorId,
          resumedId,
          storageRoot,
          cwd,
          commandSpec,
          partition,
        });
        const promptSink = path.join(zeroshotHome, `${resumedId}-prompt.json`);

        const { code } = await runWatcher({
          id: resumedId,
          commandSpec,
          scenario: 'happy',
          ompSession: {
            kind: 'resume',
            partition: { path: partition.partitionPath },
            file: { path: partition.sessionFilePath },
          },
          ompResumeExpectation: expectation,
          env: {
            OMP_FAKE_RPC_SESSION_ID: `${partition.sessionId}-and-more`,
            OMP_FAKE_RPC_PROMPT_SINK: promptSink,
          },
        });
        const resumed = await storeGetTask(resumedId);
        assertFailedBeforePrompt({
          code,
          task: resumed,
          promptSink,
          errorPattern: /echoed sessionId/,
        });

        const prior = await storeGetTask(priorId);
        assert.strictEqual(
          prior.ompSessionOwnership.state,
          'committed',
          'a refused resume leaves the prior owner intact'
        );
      });

      it('rejects a returned session file that only shares the requested basename', async function () {
        const priorId = nextTaskId('resume-basename-prior');
        const resumedId = nextTaskId('resume-basename');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const partition = makeSessionPartition({ storageRoot, cwd });
        const commandSpec = resumeCommandSpec(
          overlay,
          partition.partitionPath,
          partition.sessionFilePath,
          cwd
        );
        const { expectation } = await seedResumeLineage({
          priorId,
          resumedId,
          storageRoot,
          cwd,
          commandSpec,
          partition,
        });

        // A different directory holding a file with the *same basename* — the exact case a
        // basename-only comparison would wave through.
        const decoyDir = fs.mkdtempSync(path.join(zeroshotHome, 'omp-decoy-'));
        const decoy = path.join(decoyDir, partition.sessionFileName);
        fs.copyFileSync(partition.sessionFilePath, decoy);
        const promptSink = path.join(zeroshotHome, `${resumedId}-prompt.json`);

        const { code } = await runWatcher({
          id: resumedId,
          commandSpec,
          scenario: 'happy',
          ompSession: {
            kind: 'resume',
            partition: { path: partition.partitionPath },
            file: { path: partition.sessionFilePath },
          },
          ompResumeExpectation: expectation,
          env: { OMP_FAKE_RPC_SESSION_FILE: decoy, OMP_FAKE_RPC_PROMPT_SINK: promptSink },
        });
        assertFailedBeforePrompt({
          code,
          task: await storeGetTask(resumedId),
          promptSink,
          errorPattern: /echoed sessionFile/,
        });
      });

      it('fails closed on selected concrete-model drift', async function () {
        const priorId = nextTaskId('resume-model-drift-prior');
        const resumedId = nextTaskId('resume-model-drift');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const partition = makeSessionPartition({ storageRoot, cwd });
        const commandSpec = resumeCommandSpec(
          overlay,
          partition.partitionPath,
          partition.sessionFilePath,
          cwd
        );
        const { expectation } = await seedResumeLineage({
          priorId,
          resumedId,
          storageRoot,
          cwd,
          commandSpec,
          partition,
        });
        const promptSink = path.join(zeroshotHome, `${resumedId}-prompt.json`);

        const { code } = await runWatcher({
          id: resumedId,
          commandSpec,
          scenario: 'happy',
          ompSession: {
            kind: 'resume',
            partition: { path: partition.partitionPath },
            file: { path: partition.sessionFilePath },
          },
          ompResumeExpectation: expectation,
          env: {
            OMP_FAKE_RPC_SELECTED_MODEL: 'claude-some-other-concrete-model',
            OMP_FAKE_RPC_PROMPT_SINK: promptSink,
          },
        });
        assertFailedBeforePrompt({
          code,
          task: await storeGetTask(resumedId),
          promptSink,
          errorPattern: /selectedModel/,
        });
      });

      it('fails closed on thinking-level execution drift even when the model is unchanged', async function () {
        const priorId = nextTaskId('resume-thinking-drift-prior');
        const resumedId = nextTaskId('resume-thinking-drift');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const partition = makeSessionPartition({ storageRoot, cwd });
        const commandSpec = resumeCommandSpec(
          overlay,
          partition.partitionPath,
          partition.sessionFilePath,
          cwd
        );
        const { expectation } = await seedResumeLineage({
          priorId,
          resumedId,
          storageRoot,
          cwd,
          commandSpec,
          partition,
        });
        const promptSink = path.join(zeroshotHome, `${resumedId}-prompt.json`);

        const { code } = await runWatcher({
          id: resumedId,
          commandSpec,
          scenario: 'happy',
          ompSession: {
            kind: 'resume',
            partition: { path: partition.partitionPath },
            file: { path: partition.sessionFilePath },
          },
          ompResumeExpectation: expectation,
          env: {
            OMP_FAKE_RPC_THINKING_LEVEL: 'xhigh',
            OMP_FAKE_RPC_PROMPT_SINK: promptSink,
          },
        });
        assertFailedBeforePrompt({
          code,
          task: await storeGetTask(resumedId),
          promptSink,
          errorPattern: /executionFingerprint/,
        });
      });

      it('fails closed on Zeroshot selector / overlay / version drift recorded in the fingerprint', async function () {
        const priorId = nextTaskId('resume-selector-drift-prior');
        const resumedId = nextTaskId('resume-selector-drift');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const partition = makeSessionPartition({ storageRoot, cwd });
        const commandSpec = resumeCommandSpec(
          overlay,
          partition.partitionPath,
          partition.sessionFilePath,
          cwd
        );
        const { expectation } = await seedResumeLineage({
          priorId,
          resumedId,
          storageRoot,
          cwd,
          commandSpec,
          partition,
          // The owner was recorded under a different Zeroshot execution contract.
          expectationOverrides: { expectedExecutionFingerprint: `sha256:${'9'.repeat(64)}` },
        });
        const promptSink = path.join(zeroshotHome, `${resumedId}-prompt.json`);

        const { code } = await runWatcher({
          id: resumedId,
          commandSpec,
          scenario: 'happy',
          ompSession: {
            kind: 'resume',
            partition: { path: partition.partitionPath },
            file: { path: partition.sessionFilePath },
          },
          ompResumeExpectation: expectation,
          env: { OMP_FAKE_RPC_PROMPT_SINK: promptSink },
        });
        assertFailedBeforePrompt({
          code,
          task: await storeGetTask(resumedId),
          promptSink,
          errorPattern: /executionFingerprint/,
        });
      });

      it('fails closed before spawn on artifact-tree drift', async function () {
        const priorId = nextTaskId('resume-manifest-drift-prior');
        const resumedId = nextTaskId('resume-manifest-drift');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const partition = makeSessionPartition({ storageRoot, cwd, artifacts: ['a.txt'] });
        const commandSpec = resumeCommandSpec(
          overlay,
          partition.partitionPath,
          partition.sessionFilePath,
          cwd
        );
        const { expectation } = await seedResumeLineage({
          priorId,
          resumedId,
          storageRoot,
          cwd,
          commandSpec,
          partition,
        });

        // Someone edited the artifact tree between the recorded turn and this resume.
        fs.appendFileSync(path.join(partition.artifactsDir, 'a.txt'), 'tampered');

        const { code } = await runWatcher({
          id: resumedId,
          commandSpec,
          scenario: 'happy',
          ompSession: {
            kind: 'resume',
            partition: { path: partition.partitionPath },
            file: { path: partition.sessionFilePath },
          },
          ompResumeExpectation: expectation,
        });
        assert.strictEqual(code, 1, 'the pre-spawn check fails the watcher outright');

        const resumed = await storeGetTask(resumedId);
        assert.strictEqual(resumed.status, 'failed');
        assert.match(resumed.error, /artifactManifestDigest/);
        assert.strictEqual(resumed.ompSessionOwnership.state, 'cleanup-required');
      });

      it('fails closed before spawn when the session file inode has been substituted', async function () {
        const priorId = nextTaskId('resume-inode-prior');
        const resumedId = nextTaskId('resume-inode');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const partition = makeSessionPartition({ storageRoot, cwd });
        const commandSpec = resumeCommandSpec(
          overlay,
          partition.partitionPath,
          partition.sessionFilePath,
          cwd
        );
        const { expectation } = await seedResumeLineage({
          priorId,
          resumedId,
          storageRoot,
          cwd,
          commandSpec,
          partition,
        });

        // Byte-identical replacement: only the inode changes, so nothing but the pinned identity
        // can catch it.
        const contents = fs.readFileSync(partition.sessionFilePath);
        const staging = path.join(storageRoot, 'replacement.jsonl');
        fs.writeFileSync(staging, contents);
        fs.renameSync(staging, partition.sessionFilePath);

        const { code } = await runWatcher({
          id: resumedId,
          commandSpec,
          scenario: 'happy',
          ompSession: {
            kind: 'resume',
            partition: { path: partition.partitionPath },
            file: { path: partition.sessionFilePath },
          },
          ompResumeExpectation: expectation,
        });
        assert.strictEqual(code, 1);

        const resumed = await storeGetTask(resumedId);
        assert.strictEqual(resumed.status, 'failed');
        assert.match(resumed.error, /sessionFileIdentity/);
        assert.strictEqual(resumed.ompSessionOwnership.state, 'cleanup-required');
      });

      it('fails closed before spawn when the resume file has been substituted for a symlink', async function () {
        const priorId = nextTaskId('resume-symlink-prior');
        const resumedId = nextTaskId('resume-symlink');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const partition = makeSessionPartition({ storageRoot, cwd });
        const commandSpec = resumeCommandSpec(
          overlay,
          partition.partitionPath,
          partition.sessionFilePath,
          cwd
        );
        const { expectation } = await seedResumeLineage({
          priorId,
          resumedId,
          storageRoot,
          cwd,
          commandSpec,
          partition,
        });

        const outsideTarget = path.join(zeroshotHome, `${resumedId}-outside.jsonl`);
        fs.copyFileSync(partition.sessionFilePath, outsideTarget);
        fs.rmSync(partition.sessionFilePath);
        fs.symlinkSync(outsideTarget, partition.sessionFilePath);

        const { code } = await runWatcher({
          id: resumedId,
          commandSpec,
          scenario: 'happy',
          ompSession: {
            kind: 'resume',
            partition: { path: partition.partitionPath },
            file: { path: partition.sessionFilePath },
          },
          ompResumeExpectation: expectation,
        });
        assert.strictEqual(code, 1);

        const resumed = await storeGetTask(resumedId);
        assert.strictEqual(resumed.status, 'failed');
        assert.match(resumed.error, /symlink/);
        assert.strictEqual(resumed.ompSessionOwnership.state, 'cleanup-required');
      });

      it('fails closed before spawn when the partition identity no longer matches', async function () {
        const priorId = nextTaskId('resume-partition-identity-prior');
        const resumedId = nextTaskId('resume-partition-identity');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const partition = makeSessionPartition({ storageRoot, cwd });
        const commandSpec = resumeCommandSpec(
          overlay,
          partition.partitionPath,
          partition.sessionFilePath,
          cwd
        );
        const { expectation } = await seedResumeLineage({
          priorId,
          resumedId,
          storageRoot,
          cwd,
          commandSpec,
          partition,
          expectationOverrides: {
            expectedPartitionIdentity: { device: '1', inode: '999999999' },
          },
        });

        const { code } = await runWatcher({
          id: resumedId,
          commandSpec,
          scenario: 'happy',
          ompSession: {
            kind: 'resume',
            partition: { path: partition.partitionPath },
            file: { path: partition.sessionFilePath },
          },
          ompResumeExpectation: expectation,
        });
        assert.strictEqual(code, 1);

        const resumed = await storeGetTask(resumedId);
        assert.strictEqual(resumed.status, 'failed');
        assert.match(resumed.error, /identity .* does not match the recorded owner/);
        assert.strictEqual(resumed.ompSessionOwnership.state, 'cleanup-required');
      });

      it('fails closed before spawn when a referenced shared CAS blob is missing', async function () {
        const priorId = nextTaskId('resume-blob-prior');
        const resumedId = nextTaskId('resume-blob');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const blobs = makeBlobStore('omp-watcher-blobs-');
        const ref = blobs.put('externalized-image-bytes');
        const partition = makeSessionPartition({
          storageRoot,
          cwd,
          records: [{ type: 'message', content: [{ type: 'image', data: ref }] }],
        });
        const commandSpec = resumeCommandSpec(
          overlay,
          partition.partitionPath,
          partition.sessionFilePath,
          cwd
        );

        // The lineage must be recorded while the blob still resolves, i.e. under the same shared
        // root the watcher will use.
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = blobs.blobRoot;
        let expectation;
        try {
          ({ expectation } = await seedResumeLineage({
            priorId,
            resumedId,
            storageRoot,
            cwd,
            commandSpec,
            partition,
          }));
        } finally {
          if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }

        const blobPath = path.join(blobs.blobsDir, ref.slice('blob:sha256:'.length));
        fs.rmSync(blobPath);

        const { code } = await runWatcher({
          id: resumedId,
          commandSpec,
          scenario: 'happy',
          ompSession: {
            kind: 'resume',
            partition: { path: partition.partitionPath },
            file: { path: partition.sessionFilePath },
          },
          ompResumeExpectation: expectation,
          env: { PI_CODING_AGENT_DIR: blobs.blobRoot },
        });
        assert.strictEqual(code, 1);

        const resumed = await storeGetTask(resumedId);
        assert.strictEqual(resumed.status, 'failed');
        assert.match(resumed.error, /blob/);
        assert.strictEqual(resumed.ompSessionOwnership.state, 'cleanup-required');
        assert.ok(fs.existsSync(blobs.blobsDir), 'the shared blob root itself is untouched');
      });

      it('tolerates a mid-turn session_info_update that grew the transcript, and still catches one that switches session', async function () {
        // `session_info_update` re-fires the driver's `ready` hook *after* the prompt, by which
        // point the transcript has legitimately grown. Re-running the structural manifest/inode
        // comparison there would reject a healthy turn; only what OMP reports about the session it
        // has open is still meaningful, so that is all the post-prompt pass may check.
        const healthyPriorId = nextTaskId('resume-info-update-prior');
        const healthyResumedId = nextTaskId('resume-info-update');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const partition = makeSessionPartition({ storageRoot, cwd });
        const commandSpec = resumeCommandSpec(
          overlay,
          partition.partitionPath,
          partition.sessionFilePath,
          cwd
        );
        const { expectation } = await seedResumeLineage({
          priorId: healthyPriorId,
          resumedId: healthyResumedId,
          storageRoot,
          cwd,
          commandSpec,
          partition,
        });

        const before = fs.statSync(partition.sessionFilePath).size;
        const { code } = await runWatcher({
          id: healthyResumedId,
          commandSpec,
          scenario: 'session-info-update',
          ompSession: {
            kind: 'resume',
            partition: { path: partition.partitionPath },
            file: { path: partition.sessionFilePath },
          },
          ompResumeExpectation: expectation,
          env: {
            OMP_FAKE_RPC_APPEND_ON_UPDATE: '1',
            OMP_FAKE_RPC_UPDATED_SESSION_ID: partition.sessionId,
            OMP_FAKE_RPC_UPDATED_SESSION_FILE: partition.sessionFilePath,
          },
        });
        assert.strictEqual(code, 0);
        assert.ok(
          fs.statSync(partition.sessionFilePath).size > before,
          'the transcript really did grow mid-turn'
        );
        const healthy = await storeGetTask(healthyResumedId);
        assert.strictEqual(healthy.status, 'completed');
        assert.strictEqual(healthy.ompSessionOwnership.state, 'committed');

        // Same frame, but now naming a different session: that IS drift and must fail.
        const driftPriorId = nextTaskId('resume-info-update-switch-prior');
        const driftResumedId = nextTaskId('resume-info-update-switch');
        const driftStorage = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const driftCwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const driftPartition = makeSessionPartition({ storageRoot: driftStorage, cwd: driftCwd });
        const driftCommandSpec = resumeCommandSpec(
          overlay,
          driftPartition.partitionPath,
          driftPartition.sessionFilePath,
          driftCwd
        );
        const { expectation: driftExpectation } = await seedResumeLineage({
          priorId: driftPriorId,
          resumedId: driftResumedId,
          storageRoot: driftStorage,
          cwd: driftCwd,
          commandSpec: driftCommandSpec,
          partition: driftPartition,
        });

        const drifted = await runWatcher({
          id: driftResumedId,
          commandSpec: driftCommandSpec,
          scenario: 'session-info-update',
          ompSession: {
            kind: 'resume',
            partition: { path: driftPartition.partitionPath },
            file: { path: driftPartition.sessionFilePath },
          },
          ompResumeExpectation: driftExpectation,
          env: {
            OMP_FAKE_RPC_UPDATED_SESSION_ID: 'a-completely-different-session',
            OMP_FAKE_RPC_UPDATED_SESSION_FILE: driftPartition.sessionFilePath,
          },
        });
        const driftTask = await storeGetTask(driftResumedId);
        assertFailedBeforePrompt({
          code: drifted.code,
          task: driftTask,
          errorPattern: /echoed sessionId/,
        });
      });

      it('fails closed when the prior owner is no longer committed (transfer cannot apply)', async function () {
        const priorId = nextTaskId('resume-transfer-lost-prior');
        const resumedId = nextTaskId('resume-transfer-lost');
        const overlay = createOmpConfigOverlay();
        const storageRoot = fs.mkdtempSync(path.join(zeroshotHome, 'omp-storage-'));
        const cwd = fs.mkdtempSync(path.join(zeroshotHome, 'omp-workspace-'));
        const partition = makeSessionPartition({ storageRoot, cwd });
        const commandSpec = resumeCommandSpec(
          overlay,
          partition.partitionPath,
          partition.sessionFilePath,
          cwd
        );
        const { expectation } = await seedResumeLineage({
          priorId,
          resumedId,
          storageRoot,
          cwd,
          commandSpec,
          partition,
        });

        // Another process already claimed the lineage (or the row was cleared) before this
        // watcher reached its transfer point.
        await clearOwnershipFor(priorId);
        const promptSink = path.join(zeroshotHome, `${resumedId}-prompt.json`);

        const { code } = await runWatcher({
          id: resumedId,
          commandSpec,
          scenario: 'happy',
          ompSession: {
            kind: 'resume',
            partition: { path: partition.partitionPath },
            file: { path: partition.sessionFilePath },
          },
          ompResumeExpectation: expectation,
          env: { OMP_FAKE_RPC_PROMPT_SINK: promptSink },
        });
        assertFailedBeforePrompt({
          code,
          task: await storeGetTask(resumedId),
          promptSink,
          errorPattern: /transfer ownership/,
        });
      });
    });
  });
});
