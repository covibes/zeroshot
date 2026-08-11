const assert = require('assert');
const { parseEvent, parseChunk } = require('../../lib/stream-json-parser');

describe('stream-json parser (Codex)', () => {
  it('preserves the CommonJS API contract', () => {
    const parser = require('../../lib/stream-json-parser');
    assert.deepStrictEqual(Reflect.ownKeys(parser), ['parseEvent', 'parseChunk']);
    assert.deepStrictEqual(
      Object.values(parser).map((value) => value.length),
      [1, 1]
    );
  });

  it('normalizes prefixes and returns the first provider event', () => {
    const seen = [];
    const providerParsers = [
      { parseEvent: (content) => (seen.push(`first:${content}`), null) },
      { parseEvent: (content) => (seen.push(`second:${content}`), [{ type: 'one' }]) },
      { parseEvent: () => assert.fail('later providers must not run') },
    ];

    assert.deepStrictEqual(parseEvent('[1700000000000] {"type":"sample"}', providerParsers), [
      { type: 'one' },
    ]);
    assert.deepStrictEqual(seen, ['first:{"type":"sample"}', 'second:{"type":"sample"}']);
  });

  it('accepts pipe-prefixed arrays and ignores empty non-string input', () => {
    const seen = [];
    const event = parseEvent('codex |   [1,2]\r', [
      { parseEvent: (content) => (seen.push(content), { type: 'array' }) },
    ]);
    assert.deepStrictEqual(event, { type: 'array' });
    assert.deepStrictEqual(seen, ['[1,2]']);
    assert.strictEqual(parseEvent(null, []), null);
    assert.deepStrictEqual(parseChunk(null), []);
  });
});

describe('stream-json parser provider mapping', () => {
  it('maps command_execution start/completed into tool_call/tool_result', () => {
    const chunk = [
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_1', type: 'command_execution', command: 'ls -la' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          aggregated_output: 'file1.txt\nfile2.txt\n',
          exit_code: 0,
        },
      }),
    ].join('\n');

    const events = parseChunk(chunk);
    assert.deepStrictEqual(events[0], {
      type: 'tool_call',
      toolName: 'Bash',
      toolId: 'item_1',
      input: { command: 'ls -la' },
    });
    assert.deepStrictEqual(events[1], {
      type: 'tool_result',
      toolId: 'item_1',
      content: 'file1.txt\nfile2.txt\n',
      isError: false,
    });
  });

  it('maps reasoning items into thinking', () => {
    const chunk = JSON.stringify({
      type: 'item.completed',
      item: { id: 'r1', type: 'reasoning', text: 'thinking...' },
    });
    const events = parseChunk(chunk);
    assert.deepStrictEqual(events, [{ type: 'thinking', text: 'thinking...' }]);
  });

  it('maps top-level errors into result errors', () => {
    const chunk = JSON.stringify({ type: 'error', error: { message: 'boom' } });
    const events = parseChunk(chunk);
    assert.deepStrictEqual(events, [{ type: 'result', success: false, error: 'boom' }]);
  });

  it('does not leak Gemini tool ids across parseChunk calls', () => {
    const toolUse = JSON.stringify({
      type: 'tool_use',
      tool_call_id: 'tool-1',
      tool_name: 'bash',
      input: { cmd: 'ls' },
    });
    const toolResult = JSON.stringify({ type: 'tool_result', output: 'ok', success: true });

    assert.deepStrictEqual(parseChunk(toolUse), [
      {
        type: 'tool_call',
        toolName: 'bash',
        toolId: 'tool-1',
        input: { cmd: 'ls' },
      },
    ]);
    assert.deepStrictEqual(parseChunk(toolResult), [
      {
        type: 'tool_result',
        toolId: undefined,
        content: 'ok',
        isError: false,
      },
    ]);
  });
});
