const {
  SENTINEL_PROMPT,
  assert,
  buildCommandSpec,
  createOmpConfigOverlay,
  fs,
  nextTaskId,
  os,
  path,
  runWatcher,
  seedTask,
  storeGetTask,
  storeRequestCancellation,
} = require('./helpers/omp-rpc-watcher-harness');

describe('OMP RPC watcher: failure handling', function () {
  this.timeout(20000);

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
