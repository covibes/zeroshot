const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function schemaMetadata(schemaPath, overrides = {}) {
  return {
    kind: 'temp-file',
    provider: 'codex',
    path: schemaPath,
    reason: 'output-schema',
    ...overrides,
  };
}

function overlayMetadata(overlayPath) {
  return {
    kind: 'temp-directory',
    provider: 'claude',
    path: overlayPath,
    reason: 'settings-overlay',
  };
}

function opencodeConfigMetadata(configPath, overrides = {}) {
  return {
    kind: 'temp-directory',
    provider: 'opencode',
    path: configPath,
    reason: 'isolated-config',
    ...overrides,
  };
}

function createSchemaFile() {
  const schemaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-schema-'));
  const schemaPath = path.join(schemaRoot, `${randomUUID()}.json`);
  fs.writeFileSync(schemaPath, '{}\n', { mode: 0o600 });
  return { schemaRoot, schemaPath };
}

function policyMetadata(policyPath, overrides = {}) {
  return {
    kind: 'temp-file',
    provider: 'gemini',
    path: policyPath,
    reason: 'admin-policy',
    ...overrides,
  };
}

function createPolicyFile() {
  const policyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-gemini-policy-'));
  const policyPath = path.join(policyRoot, `${randomUUID()}.toml`);
  fs.writeFileSync(policyPath, '[[rule]]\ndecision = "deny"\n', { mode: 0o600 });
  return { policyRoot, policyPath };
}

describe('Command spec cleanup safety', function () {
  const cleanupRoots = [];

  afterEach(function () {
    for (const cleanupRoot of cleanupRoots.splice(0)) {
      fs.rmSync(cleanupRoot, { recursive: true, force: true });
    }
  });

  it('removes the exact regular Codex schema file from its canonical temp directory', async function () {
    const { createCommandSpecCleanup } = await import('../../task-lib/command-spec-cleanup.js');
    const { schemaRoot, schemaPath } = createSchemaFile();
    cleanupRoots.push(schemaRoot);
    const failures = [];
    const cleanup = createCommandSpecCleanup(
      {
        cleanup: [schemaPath],
        cleanupMetadata: [schemaMetadata(schemaPath)],
      },
      (cleanupPath, error) => failures.push({ cleanupPath, error })
    );

    assert.strictEqual(await cleanup.run(), true);
    assert.strictEqual(fs.existsSync(schemaPath), false);
    assert.deepStrictEqual(failures, []);
  });

  it('removes the exact regular Gemini policy file from its canonical temp directory', async function () {
    const { createCommandSpecCleanup } = await import('../../task-lib/command-spec-cleanup.js');
    const { policyRoot, policyPath } = createPolicyFile();
    cleanupRoots.push(policyRoot);
    const failures = [];
    const cleanup = createCommandSpecCleanup(
      {
        cleanup: [policyPath],
        cleanupMetadata: [policyMetadata(policyPath)],
      },
      (cleanupPath, error) => failures.push({ cleanupPath, error })
    );

    assert.strictEqual(await cleanup.run(), true);
    assert.strictEqual(fs.existsSync(policyPath), false);
    assert.deepStrictEqual(failures, []);
  });

  it('removes an exact OpenCode isolated config directory', async function () {
    const { createCommandSpecCleanup } = await import('../../task-lib/command-spec-cleanup.js');
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-opencode-config-'));
    cleanupRoots.push(configRoot);
    fs.writeFileSync(path.join(configRoot, 'config.json'), '{}\n');
    const failures = [];
    const cleanup = createCommandSpecCleanup(
      {
        cleanup: [configRoot],
        cleanupMetadata: [opencodeConfigMetadata(configRoot)],
      },
      (cleanupPath, error) => failures.push({ cleanupPath, error })
    );

    assert.strictEqual(await cleanup.run(), true);
    assert.strictEqual(fs.existsSync(configRoot), false);
    assert.deepStrictEqual(failures, []);
  });

  it('refuses an OpenCode config directory outside its owned namespace', async function () {
    const { createCommandSpecCleanup } = await import('../../task-lib/command-spec-cleanup.js');
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-user-config-'));
    cleanupRoots.push(configRoot);
    const failures = [];
    const cleanup = createCommandSpecCleanup(
      {
        cleanup: [configRoot],
        cleanupMetadata: [opencodeConfigMetadata(configRoot)],
      },
      (cleanupPath, error) => failures.push({ cleanupPath, error })
    );

    assert.strictEqual(await cleanup.run(), false);
    assert.strictEqual(fs.existsSync(configRoot), true);
    assert.strictEqual(failures.length, 1);
  });

  it('refuses a Gemini policy symlink and preserves its target', async function () {
    const { createCommandSpecCleanup } = await import('../../task-lib/command-spec-cleanup.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-user-file-'));
    const victim = path.join(root, 'victim.toml');
    fs.writeFileSync(victim, 'user policy\n');
    const policy = createPolicyFile();
    fs.rmSync(policy.policyPath);
    fs.symlinkSync(victim, policy.policyPath);
    cleanupRoots.push(root, policy.policyRoot);
    const failures = [];
    const cleanup = createCommandSpecCleanup(
      {
        cleanup: [policy.policyPath],
        cleanupMetadata: [policyMetadata(policy.policyPath)],
      },
      (cleanupPath, error) => failures.push({ cleanupPath, error })
    );

    assert.strictEqual(await cleanup.run(), false);
    assert.strictEqual(fs.existsSync(victim), true);
    assert.strictEqual(failures.length, 1);
  });

  for (const scenario of [
    {
      name: 'arbitrary regular file',
      build() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-user-file-'));
        const target = path.join(root, `${randomUUID()}.json`);
        fs.writeFileSync(target, '{}\n');
        return { roots: [root], target, metadata: schemaMetadata(target) };
      },
    },
    {
      name: 'schema symlink',
      build() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-user-file-'));
        const victim = path.join(root, 'victim.json');
        fs.writeFileSync(victim, '{}\n');
        const schema = createSchemaFile();
        fs.rmSync(schema.schemaPath);
        fs.symlinkSync(victim, schema.schemaPath);
        return {
          roots: [root, schema.schemaRoot],
          target: schema.schemaPath,
          victim,
          metadata: schemaMetadata(schema.schemaPath),
        };
      },
    },
    {
      name: 'path escape',
      build() {
        const schema = createSchemaFile();
        const victim = path.join(os.tmpdir(), `${randomUUID()}.json`);
        fs.writeFileSync(victim, '{}\n');
        const escaped = path.join(schema.schemaRoot, '..', path.basename(victim));
        return {
          roots: [schema.schemaRoot, victim],
          target: escaped,
          victim,
          metadata: schemaMetadata(escaped),
        };
      },
    },
    {
      name: 'wrong provider',
      build() {
        const schema = createSchemaFile();
        return {
          roots: [schema.schemaRoot],
          target: schema.schemaPath,
          metadata: schemaMetadata(schema.schemaPath, { provider: 'claude' }),
        };
      },
    },
    {
      name: 'wrong reason',
      build() {
        const schema = createSchemaFile();
        return {
          roots: [schema.schemaRoot],
          target: schema.schemaPath,
          metadata: schemaMetadata(schema.schemaPath, { reason: 'settings-overlay' }),
        };
      },
    },
    {
      name: 'mismatched metadata path',
      build() {
        const schema = createSchemaFile();
        return {
          roots: [schema.schemaRoot],
          target: schema.schemaPath,
          metadata: schemaMetadata(`${schema.schemaPath}.other`),
        };
      },
    },
    {
      name: 'open metadata shape',
      build() {
        const schema = createSchemaFile();
        return {
          roots: [schema.schemaRoot],
          target: schema.schemaPath,
          metadata: schemaMetadata(schema.schemaPath, { extra: true }),
        };
      },
    },
  ]) {
    it(`refuses ${scenario.name}`, async function () {
      const { createCommandSpecCleanup } = await import('../../task-lib/command-spec-cleanup.js');
      const fixture = scenario.build();
      cleanupRoots.push(...fixture.roots);
      const failures = [];
      const cleanup = createCommandSpecCleanup(
        {
          cleanup: [fixture.target],
          cleanupMetadata: [fixture.metadata],
        },
        (cleanupPath, error) => failures.push({ cleanupPath, error })
      );

      assert.strictEqual(await cleanup.run(), false);
      assert.strictEqual(fs.existsSync(fixture.target), true);
      if (fixture.victim) assert.strictEqual(fs.existsSync(fixture.victim), true);
      assert.strictEqual(failures.length, 1);
    });
  }

  it('recovers a deleted canonical overlay after receipt persistence fails', async function () {
    const { createCommandSpecCleanup } = await import('../../task-lib/command-spec-cleanup.js');
    const { killTaskCommand } = await import('../../task-lib/commands/kill.js');
    const { addTask, getTask, removeTask } = await import('../../task-lib/store.js');
    const { prepareClaudeSettingsOverlay } = require('../../src/worktree-claude-config');
    const settingsPath = prepareClaudeSettingsOverlay();
    const overlayPath = path.dirname(settingsPath);
    const taskId = `missing-overlay-${randomUUID()}`;
    const receipt = {
      cleanup: [overlayPath],
      cleanupMetadata: [overlayMetadata(overlayPath)],
    };
    addTask({ id: taskId, status: 'failed', pid: null, commandCleanup: receipt });

    try {
      const firstCleanup = createCommandSpecCleanup(receipt, () => {});
      assert.strictEqual(await firstCleanup.run(), true);
      assert.strictEqual(fs.existsSync(overlayPath), false);
      assert.notStrictEqual(getTask(taskId).commandCleanup, null);

      await killTaskCommand(taskId);
      assert.strictEqual(getTask(taskId).commandCleanup, null);
    } finally {
      removeTask(taskId);
      fs.rmSync(overlayPath, { recursive: true, force: true });
    }
  });

  it('rejects a missing noncanonical overlay path', async function () {
    const { createCommandSpecCleanup } = await import('../../task-lib/command-spec-cleanup.js');
    const unsafePath = path.join(os.tmpdir(), `unsafe-missing-overlay-${randomUUID()}`);
    const failures = [];
    const cleanup = createCommandSpecCleanup(
      {
        cleanup: [unsafePath],
        cleanupMetadata: [overlayMetadata(unsafePath)],
      },
      (cleanupPath, error) => failures.push({ cleanupPath, error })
    );

    assert.strictEqual(await cleanup.run(), false);
    assert.strictEqual(fs.existsSync(unsafePath), false);
    assert.strictEqual(failures.length, 1);
  });
});
