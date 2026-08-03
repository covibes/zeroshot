const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const storeUrl = pathToFileURL(path.resolve(__dirname, '../task-lib/store.js')).href;
const legacyTaskSchema = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT,
    full_prompt TEXT,
    cwd TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    pid INTEGER,
    session_id TEXT,
    session_id_conflict INTEGER NOT NULL DEFAULT 0,
    requested_resume_session_id TEXT,
    resume_identity_verified INTEGER NOT NULL DEFAULT 0,
    log_file TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    exit_code INTEGER,
    error TEXT,
    provider TEXT,
    model TEXT,
    schedule_id TEXT,
    socket_path TEXT,
    attachable INTEGER DEFAULT 0,
    process_group_id INTEGER,
    termination_strategy TEXT,
    command_cleanup TEXT,
    cancel_requested INTEGER DEFAULT 0,
    spawn_ownership_token TEXT
  )
`;

async function runStoreScript(home, source) {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, HOME: home, ZEROSHOT_HOME: home },
  });
  return stdout ? JSON.parse(stdout) : null;
}

describe('Task store SDK persistence', function () {
  this.timeout(20000);

  it('reloads canonical SDK results and evidence without semantic or credential inputs', async function () {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-sdk-task-store-'));
    const inputDigest = {
      algorithm: 'sha256',
      value: '37e68b15f7939da62532a30ad14011867a20a25b86d46ff9ea183f8be3e4b414',
    };
    const invoke = {
      lane: 'spawn',
      parser: 'omp-sdk-ndjson',
      ptyEligible: false,
    };
    const executionIdentity = {
      backend: 'omp-sdk',
      backendVersion: '17.2.1',
      runtime: { name: 'bun', version: '1.3.14' },
    };
    const semanticIdentity = {
      modelSelector: 'amazon-bedrock/openai.gpt-5.6-sol',
      reasoningEffort: 'max',
    };
    const containmentRequirement = {
      kind: 'contained-process',
      privateRequestFile: true,
    };
    const parsedResult = {
      answer: { accepted: true, changes: ['task-lib/store.js'] },
      summary: 'canonical terminal value',
    };
    const sdkEvidence = {
      protocolVersion: 1,
      runId: 'run-sdk-store-1',
      terminalType: 'result',
      invocation: {
        requestedModel: 'amazon-bedrock/openai.gpt-5.6-sol',
        reasoningEffort: 'max',
      },
      backend: { id: 'omp-sdk', version: '17.2.1' },
      runtime: { name: 'bun', version: '1.3.14' },
      resolvedModel: 'amazon-bedrock/openai.gpt-5.6-sol',
      fallback: false,
      usage: {
        inputTokens: 19,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 26,
        requests: 1,
        durationMs: 120,
        costUsd: 0.003,
      },
    };
    const cleanupAttestation = {
      mode: 'contained-process',
      terminalBuffered: true,
      descendantsReaped: true,
      clean: true,
    };
    const markers = {
      initialPrompt: 'SDK_RAW_PROMPT_MUST_NOT_PERSIST',
      updatedPrompt: 'SDK_UPDATED_PROMPT_MUST_NOT_PERSIST',
      request: 'SDK_REQUEST_MUST_NOT_PERSIST',
      credential: 'SDK_CREDENTIAL_MUST_NOT_PERSIST',
      context: 'SDK_CONTEXT_MUST_NOT_PERSIST',
    };

    const writer = `
      const { addTask, updateTask, withTasksLock } = await import(${JSON.stringify(storeUrl)});
      const added = addTask({
        id: 'sdk-task',
        status: 'running',
        provider: 'omp',
        prompt: ${JSON.stringify(markers.initialPrompt)},
        fullPrompt: ${JSON.stringify(`${markers.initialPrompt} full`)},
        request: { prompt: ${JSON.stringify(markers.request)} },
        credentials: { token: ${JSON.stringify(markers.credential)} },
        credentialNames: ['OMP_SECRET_TOKEN'],
        environmentPolicy: { value: ${JSON.stringify(markers.credential)} },
        privateArtifacts: [${JSON.stringify(markers.request)}],
        commandSpec: { argv: [${JSON.stringify(markers.request)}] },
        context: ${JSON.stringify(markers.context)},
        inputDigest: ${JSON.stringify(inputDigest)},
        inputSizeBytes: 37,
        invoke: ${JSON.stringify(invoke)},
        executionIdentity: ${JSON.stringify(executionIdentity)},
        semanticIdentity: ${JSON.stringify(semanticIdentity)},
        containmentRequirement: ${JSON.stringify(containmentRequirement)}
      });
      const updated = updateTask('sdk-task', {
        status: 'completed',
        prompt: ${JSON.stringify(markers.updatedPrompt)},
        fullPrompt: ${JSON.stringify(`${markers.updatedPrompt} full`)},
        request: { prompt: ${JSON.stringify(markers.request)} },
        credentials: { token: ${JSON.stringify(markers.credential)} },
        parsedResult: ${JSON.stringify(parsedResult)},
        sdkEvidence: ${JSON.stringify(sdkEvidence)},
        cleanupAttestation: ${JSON.stringify(cleanupAttestation)}
      });
      withTasksLock((tasks) => tasks);
      process.stdout.write(JSON.stringify({ added, updated }));
    `;
    const reader = `
      const path = await import('path');
      const Database = (await import('better-sqlite3')).default;
      const { getTask } = await import(${JSON.stringify(storeUrl)});
      const reloaded = getTask('sdk-task');
      const database = new Database(path.join(process.env.ZEROSHOT_HOME, '.claude-zeroshot', 'store.db'), { readonly: true });
      const row = database.prepare('SELECT * FROM tasks WHERE id = ?').get('sdk-task');
      database.close();
      process.stdout.write(JSON.stringify({ reloaded, row }));
    `;

    try {
      const written = await runStoreScript(home, writer);
      const { reloaded, row } = await runStoreScript(home, reader);

      for (const task of [written.added, written.updated, reloaded]) {
        assert.strictEqual(task.prompt, null);
        assert.strictEqual(task.fullPrompt, null);
        for (const field of [
          'request',
          'credentials',
          'credentialNames',
          'environmentPolicy',
          'privateArtifacts',
          'commandSpec',
          'context',
        ]) {
          assert.strictEqual(Object.prototype.hasOwnProperty.call(task, field), false);
        }
      }
      assert.deepStrictEqual(reloaded.inputDigest, inputDigest);
      assert.strictEqual(reloaded.inputSizeBytes, 37);
      assert.deepStrictEqual(reloaded.invoke, invoke);
      assert.deepStrictEqual(reloaded.executionIdentity, executionIdentity);
      assert.deepStrictEqual(reloaded.semanticIdentity, semanticIdentity);
      assert.deepStrictEqual(reloaded.containmentRequirement, containmentRequirement);
      assert.deepStrictEqual(reloaded.parsedResult, parsedResult);
      assert.deepStrictEqual(reloaded.sdkEvidence, sdkEvidence);
      assert.deepStrictEqual(reloaded.cleanupAttestation, cleanupAttestation);

      const persistedBytes = JSON.stringify(row);
      for (const marker of Object.values(markers)) {
        assert.doesNotMatch(persistedBytes, new RegExp(marker));
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('round-trips legacy tasks without adding SDK record fields', async function () {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-legacy-task-store-'));
    const writer = `
      const { addTask, updateTask, withTasksLock } = await import(${JSON.stringify(storeUrl)});
      addTask({
        id: 'legacy-task',
        prompt: 'legacy prompt',
        fullPrompt: 'legacy full prompt',
        cwd: '/tmp/legacy-workspace',
        status: 'running',
        provider: 'claude',
        model: 'sonnet',
        pid: 4242,
        commandCleanup: { cleanup: ['/tmp/legacy-cleanup'] }
      });
      updateTask('legacy-task', { status: 'completed', exitCode: 0 });
      withTasksLock((tasks) => tasks);
    `;
    const reader = `
      const { getTask } = await import(${JSON.stringify(storeUrl)});
      process.stdout.write(JSON.stringify(getTask('legacy-task')));
    `;

    try {
      await runStoreScript(home, writer);
      const legacy = await runStoreScript(home, reader);
      assert.strictEqual(legacy.prompt, 'legacy prompt');
      assert.strictEqual(legacy.fullPrompt, 'legacy full prompt');
      assert.strictEqual(legacy.cwd, '/tmp/legacy-workspace');
      assert.strictEqual(legacy.status, 'completed');
      assert.strictEqual(legacy.provider, 'claude');
      assert.strictEqual(legacy.model, 'sonnet');
      assert.strictEqual(legacy.pid, 4242);
      assert.strictEqual(legacy.exitCode, 0);
      assert.deepStrictEqual(legacy.commandCleanup, { cleanup: ['/tmp/legacy-cleanup'] });
      for (const field of [
        'inputDigest',
        'inputSizeBytes',
        'invoke',
        'executionIdentity',
        'semanticIdentity',
        'containmentRequirement',
        'parsedResult',
        'sdkEvidence',
        'cleanupAttestation',
      ]) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(legacy, field), false);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('migrates and updates a pre-SDK legacy row without changing its record shape', async function () {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-v4-task-store-'));
    const script = `
      const fs = await import('fs');
      const path = await import('path');
      const Database = (await import('better-sqlite3')).default;
      const storeDirectory = path.join(process.env.ZEROSHOT_HOME, '.claude-zeroshot');
      fs.mkdirSync(storeDirectory, { recursive: true });
      const database = new Database(path.join(storeDirectory, 'store.db'));
      database.exec(${JSON.stringify(legacyTaskSchema)});
      database.prepare(
        'INSERT INTO tasks (id, prompt, full_prompt, cwd, status, created_at, updated_at, provider, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        'legacy-v4-task',
        'pre-SDK prompt',
        'pre-SDK full prompt',
        '/tmp/pre-sdk-workspace',
        'running',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        'codex',
        'gpt-5'
      );
      database.pragma('user_version = 4');
      database.close();

      const { getTask, updateTask, TASK_STORE_SCHEMA_VERSION } = await import(${JSON.stringify(storeUrl)});
      const before = getTask('legacy-v4-task');
      const after = updateTask('legacy-v4-task', { status: 'completed', exitCode: 0 });
      process.stdout.write(JSON.stringify({ before, after, schemaVersion: TASK_STORE_SCHEMA_VERSION }));
    `;

    try {
      const { before, after, schemaVersion } = await runStoreScript(home, script);
      assert.strictEqual(schemaVersion, 5);
      assert.strictEqual(before.prompt, 'pre-SDK prompt');
      assert.strictEqual(before.fullPrompt, 'pre-SDK full prompt');
      assert.strictEqual(before.status, 'running');
      assert.strictEqual(after.prompt, 'pre-SDK prompt');
      assert.strictEqual(after.fullPrompt, 'pre-SDK full prompt');
      assert.strictEqual(after.status, 'completed');
      assert.strictEqual(after.exitCode, 0);
      for (const task of [before, after]) {
        for (const field of [
          'inputDigest',
          'inputSizeBytes',
          'invoke',
          'executionIdentity',
          'semanticIdentity',
          'containmentRequirement',
          'parsedResult',
          'sdkEvidence',
          'cleanupAttestation',
        ]) {
          assert.strictEqual(Object.prototype.hasOwnProperty.call(task, field), false);
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects partial SDK lane identity instead of persisting it as a legacy task', async function () {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-partial-sdk-task-store-'));
    const script = `
      const { addTask, getTask } = await import(${JSON.stringify(storeUrl)});
      let message = null;
      try {
        addTask({
          id: 'partial-sdk-task',
          prompt: 'must not be downgraded',
          executionIdentity: { backend: 'omp-sdk' }
        });
      } catch (error) {
        message = error.message;
      }
      process.stdout.write(JSON.stringify({ message, task: getTask('partial-sdk-task') }));
    `;

    try {
      const result = await runStoreScript(home, script);
      assert.match(result.message, /requires both executionIdentity\.backend/);
      assert.strictEqual(result.task, null);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
