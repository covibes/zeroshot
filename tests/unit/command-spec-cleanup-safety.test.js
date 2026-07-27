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

function createSchemaFile() {
  const schemaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-schema-'));
  const schemaPath = path.join(schemaRoot, `${randomUUID()}.json`);
  fs.writeFileSync(schemaPath, '{}\n', { mode: 0o600 });
  return { schemaRoot, schemaPath };
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
});
