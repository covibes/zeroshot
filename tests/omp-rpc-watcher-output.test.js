const {
  SENTINEL_CONTROL,
  SENTINEL_MESSAGE,
  SENTINEL_PROMPT,
  SENTINEL_SYSTEM,
  assert,
  buildCommandSpec,
  createOmpConfigOverlay,
  fs,
  nextTaskId,
  runWatcher,
  seedTask,
  storeGetTask,
} = require('./helpers/omp-rpc-watcher-harness');

describe('OMP RPC watcher: output handling', function () {
  this.timeout(20000);

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
});
