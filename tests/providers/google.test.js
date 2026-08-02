const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseProviderChunk } = require('../../src/providers');

describe('Gemini provider parser', () => {
  it('parses assistant text output', () => {
    const fixture = fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'gemini', 'text.jsonl'),
      'utf8'
    );
    const events = parseProviderChunk('gemini', fixture);

    const textEvent = events.find((e) => e.type === 'text');
    const result = events.find((e) => e.type === 'result');

    assert.strictEqual(textEvent.text, 'Hello from Gemini.');
    assert.strictEqual(result.success, true);
  });

  it('parses tool call and result output', () => {
    const fixture = fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'gemini', 'tool.jsonl'),
      'utf8'
    );
    const events = parseProviderChunk('gemini', fixture);

    const toolCall = events.find((e) => e.type === 'tool_call');
    const toolResult = events.find((e) => e.type === 'tool_result');
    const result = events.find((e) => e.type === 'result');

    assert.strictEqual(toolCall.toolName, 'read_file');
    assert.strictEqual(toolCall.toolId, 'tool-42');
    assert.strictEqual(toolCall.input.path, 'README.md');
    assert.strictEqual(toolResult.toolId, 'tool-42');
    assert.strictEqual(toolResult.content, 'README contents');
    assert.strictEqual(result.success, true);
  });

  it('parses current terminal and tool error contracts', () => {
    const events = parseProviderChunk(
      'gemini',
      [
        JSON.stringify({
          type: 'tool_result',
          tool_id: 'tool-9',
          status: 'error',
          error: { type: 'ToolError', message: 'read failed' },
        }),
        JSON.stringify({
          type: 'result',
          status: 'error',
          error: { type: 'FatalError', message: 'model failed' },
        }),
        JSON.stringify({ type: 'error', severity: 'error', message: 'terminal failure' }),
      ].join('\n')
    );

    assert.deepStrictEqual(events, [
      {
        type: 'tool_result',
        toolId: 'tool-9',
        content: 'read failed',
        isError: true,
      },
      { type: 'result', success: false, result: '', error: 'model failed' },
      { type: 'result', success: false, result: '', error: 'terminal failure' },
    ]);
  });
});
