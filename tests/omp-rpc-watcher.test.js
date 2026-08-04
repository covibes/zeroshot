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

const {
  SENTINEL_PROMPT,
  assert,
  buildCommandSpec,
  createOmpConfigOverlay,
  fs,
  nextTaskId,
  path,
  runWatcher,
  seedTask,
  storeGetTask,
  zeroshotHome,
  RPC_WATCHER_PATH,
  execFileAsync,
} = require('./helpers/omp-rpc-watcher-harness');

describe('OMP RPC watcher: prompt transport', function () {
  this.timeout(20000);

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
});
