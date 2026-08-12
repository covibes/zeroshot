const assert = require('node:assert/strict');

describe('Detached task JSON Schema boundary', function () {
  it('parses the cluster child CLI schema before provider preparation', async function () {
    const { prepareTaskProviderCommand } = await import('../task-lib/runner.js');
    const schema = {
      type: 'object',
      properties: { approved: { type: 'boolean' } },
      required: ['approved'],
    };

    const prepared = prepareTaskProviderCommand('validate the work', {
      provider: 'codex',
      outputFormat: 'json',
      jsonSchema: JSON.stringify(schema),
    });

    assert.deepStrictEqual(prepared.options.jsonSchema, schema);
  });

  it('preserves boolean schemas and rejects malformed or non-schema JSON', async function () {
    const { prepareTaskProviderCommand } = await import('../task-lib/runner.js');
    const prepare = (jsonSchema) =>
      prepareTaskProviderCommand('validate the work', {
        provider: 'codex',
        outputFormat: 'json',
        jsonSchema,
      });

    assert.strictEqual(prepare('false').options.jsonSchema, false);
    assert.throws(() => prepare('{'), /--json-schema must be valid JSON/);
    assert.throws(() => prepare('[]'), /must be a boolean or JSON Schema object/);
    assert.throws(() => prepare('42'), /must be a boolean or JSON Schema object/);
  });
});
