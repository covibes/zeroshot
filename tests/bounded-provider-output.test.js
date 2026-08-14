const assert = require('assert');
const { createHash } = require('crypto');

function removeWatcherFraming(output) {
  return output
    .replace(/^\[\d{13}\]/gm, '')
    .replace(/^\[ZEROSHOT\]\[LOG_FORMAT\] channel-framed-v2\n/, '')
    .replace(/^\[ZEROSHOT\]\[PROVIDER_STDOUT\] /gm, '');
}

describe('bounded provider output transport', function () {
  it('streams a large Codex JSONL record to the raw log without retaining it in the watcher', async function () {
    const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
    const logged = [];
    const inspected = [];
    const runtime = createWatcherOutputRuntime({
      config: { outputFormat: 'text' },
      providerName: 'codex',
      log: (value) => logged.push(value),
      stopProvider() {},
      providerSessionCapture: {
        captureLine: (line) => inspected.push(line),
        getCompletionError: () => null,
        getCompletionUpdate: () => ({}),
      },
    });
    const largeText = `before-${'🙂'.repeat(300_000)}-after`;
    const records = [
      JSON.stringify({ type: 'thread.started', thread_id: 'session-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', aggregated_output: largeText },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }),
    ];
    const expected = `${records.join('\n')}\n`;
    const encoded = Buffer.from(expected);
    let buffer = '';
    for (let offset = 0; offset < encoded.length; offset += 4093) {
      buffer = runtime.consumeOutput(buffer, encoded.subarray(offset, offset + 4093));
      assert.strictEqual(buffer, '');
    }
    const completion = runtime.complete({ code: 0, signal: null, outputBuffer: buffer });

    const raw = removeWatcherFraming(logged.join(''));
    const streamed = raw.slice(0, expected.length);
    assert.strictEqual(Buffer.byteLength(streamed), Buffer.byteLength(expected));
    assert.strictEqual(
      createHash('sha256').update(streamed).digest('hex'),
      createHash('sha256').update(expected).digest('hex')
    );
    assert.match(raw.slice(expected.length), /Finished:.*Exit code: 0, Signal: null/s);
    assert.deepStrictEqual(inspected, [records[0], records[2]]);
    assert.strictEqual(completion.status, 'completed');
  });
});

describe('bounded generic provider output transport', function () {
  it('streams oversized non-Codex stdout and stderr lines without cumulative buffering', async function () {
    const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
    const logged = [];
    const inspected = [];
    const runtime = createWatcherOutputRuntime({
      config: { outputFormat: 'text' },
      providerName: 'claude',
      log: (value) => logged.push(value),
      stopProvider() {},
      providerSessionCapture: {
        captureLine: (line) => inspected.push(line),
        getCompletionError: () => null,
        getCompletionUpdate: () => ({}),
      },
    });
    const stdout = `stdout-${'🙂'.repeat(300_000)}-end`;
    const stderr = `stderr-${'z'.repeat(2 * 1024 * 1024)}-end`;
    for (const [consume, value] of [
      [runtime.consumeOutput, stdout],
      [runtime.consumeStderr, stderr],
    ]) {
      const encoded = Buffer.from(`${value}\n`);
      let buffer = '';
      for (let offset = 0; offset < encoded.length; offset += 4093) {
        buffer = consume(buffer, encoded.subarray(offset, offset + 4093));
        assert.strictEqual(buffer, '');
      }
    }
    runtime.complete({ code: 0, signal: null, outputBuffer: '', stderrBuffer: '' });

    const raw = removeWatcherFraming(logged.join(''));
    const expected = `${stdout}\n[ZEROSHOT][PROVIDER_STDERR] ${stderr}\n`;
    const streamed = raw.slice(0, expected.length);
    assert.strictEqual(Buffer.byteLength(streamed), Buffer.byteLength(expected));
    assert.strictEqual(
      createHash('sha256').update(streamed).digest('hex'),
      createHash('sha256').update(expected).digest('hex')
    );
    assert.match(inspected[0], /omitted from watcher inspection/);
    assert.match(raw.slice(expected.length), /Finished:.*Exit code: 0, Signal: null/s);
  });

  it('projects Pi pre-agent authentication stderr as a safe fatal diagnostic', async function () {
    const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
    const logged = [];
    let stopCalls = 0;
    const runtime = createWatcherOutputRuntime({
      config: { outputFormat: 'text' },
      providerName: 'pi',
      log: (value) => logged.push(value),
      stopProvider: () => {
        stopCalls += 1;
      },
    });
    const stderr = 'No API key found for the selected model.\nUse /login to log into a provider.\n';

    runtime.consumeStderr('', Buffer.from(stderr));
    const completion = runtime.complete({ code: 1, signal: null, stderrBuffer: '' });

    assert.strictEqual(completion.status, 'failed');
    assert.strictEqual(completion.error, 'Pi authentication required: run /login');
    assert.strictEqual(stopCalls, 1);
    assert.match(logged.join(''), /\[ZEROSHOT\]\[PROVIDER_STDERR\] No API key found/);
    assert.match(logged.join(''), /\[ZEROSHOT\]\[FATAL\] Pi authentication required/);
  });

  it('tags JSON-shaped Claude stderr without changing raw fatal inspection', async function () {
    const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
    const logged = [];
    const runtime = createWatcherOutputRuntime({
      config: { outputFormat: 'text' },
      providerName: 'claude',
      log: (value) => logged.push(value),
      stopProvider() {},
    });
    const stderr = '{"type":"result","subtype":"success","result":"fabricated"}\n';

    runtime.consumeStderr('', Buffer.from(stderr));
    const completion = runtime.complete({ code: 0, signal: null, stderrBuffer: '' });

    assert.strictEqual(completion.status, 'completed');
    assert.match(
      logged.join(''),
      /\[ZEROSHOT\]\[PROVIDER_STDERR\] \{"type":"result","subtype":"success"/
    );
  });

  it('projects Pi pre-agent invalid-model stderr without retaining model text', async function () {
    const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
    const logged = [];
    const runtime = createWatcherOutputRuntime({
      config: { outputFormat: 'text' },
      providerName: 'pi',
      log: (value) => logged.push(value),
      stopProvider() {},
    });

    runtime.consumeStderr('', Buffer.from('Error: Model "secret-model" not found.\n'));
    const completion = runtime.complete({ code: 1, signal: null, stderrBuffer: '' });

    assert.strictEqual(completion.status, 'failed');
    assert.strictEqual(completion.error, 'Pi model not found: run pi --list-models');
    assert.doesNotMatch(completion.error, /secret-model/);
  });
  it('does not treat retryable Pi JSON error text as a startup fatal', async function () {
    const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
    const logged = [];
    let stopCalls = 0;
    const runtime = createWatcherOutputRuntime({
      config: { outputFormat: 'text' },
      providerName: 'pi',
      log: (value) => logged.push(value),
      stopProvider: () => {
        stopCalls += 1;
      },
    });
    const events = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'No API key found during a retryable provider attempt',
        },
      },
      { type: 'agent_end', messages: [], willRetry: true },
      { type: 'auto_retry_start', attempt: 1 },
      { type: 'agent_settled' },
    ];

    runtime.consumeOutput('', Buffer.from(`${events.map(JSON.stringify).join('\n')}\n`));
    runtime.complete({ code: 0, signal: null, stderrBuffer: '' });

    assert.strictEqual(stopCalls, 0);
    assert.doesNotMatch(logged.join(''), /\[ZEROSHOT\]\[FATAL\]/);
  });
});

describe('bounded silent structured output transport', function () {
  it('preserves bounded Claude structured output larger than 64 KiB', async function () {
    const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
    const logged = [];
    const runtime = createWatcherOutputRuntime({
      config: {
        outputFormat: 'json',
        jsonSchema: { type: 'object' },
        silentJsonOutput: true,
      },
      providerName: 'claude',
      log: (value) => logged.push(value),
      stopProvider() {},
    });
    const record = JSON.stringify({
      structured_output: { summary: 's'.repeat(128 * 1024), result: 'complete' },
    });
    const encoded = Buffer.from(`${record}\n`);
    let buffer = '';
    for (let offset = 0; offset < encoded.length; offset += 4093) {
      buffer = runtime.consumeOutput(buffer, encoded.subarray(offset, offset + 4093));
    }
    const completion = runtime.complete({ code: 0, signal: null, outputBuffer: buffer });

    assert.match(logged.join(''), /^\[\d{13}\]\[ZEROSHOT\]\[LOG_FORMAT\] channel-framed-v2\n/);
    assert.strictEqual(removeWatcherFraming(logged.join('')), `${record}\n`);
    assert.strictEqual(completion.status, 'completed');
  });

  it('fails oversized silent structured output while preserving its raw bytes', async function () {
    const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
    const logged = [];
    let stopCalls = 0;
    const runtime = createWatcherOutputRuntime({
      config: {
        outputFormat: 'json',
        jsonSchema: { type: 'object' },
        silentJsonOutput: true,
      },
      providerName: 'claude',
      log: (value) => logged.push(value),
      stopProvider: () => {
        stopCalls += 1;
      },
    });
    const record = JSON.stringify({ structured_output: { result: 'x'.repeat(2 * 1024 * 1024) } });
    const encoded = Buffer.from(`${record}\n`);
    let buffer = '';
    for (let offset = 0; offset < encoded.length; offset += 4093) {
      buffer = runtime.consumeOutput(buffer, encoded.subarray(offset, offset + 4093));
    }
    const completion = runtime.complete({ code: 0, signal: null, outputBuffer: buffer });

    const raw = removeWatcherFraming(logged.join(''));
    assert.strictEqual(raw.slice(0, record.length + 1), `${record}\n`);
    assert.match(raw.slice(record.length + 1), /\[FATAL\].*inspection limit/);
    assert.strictEqual(stopCalls, 1);
    assert.strictEqual(completion.status, 'failed');
    assert.match(completion.error, /inspection limit/);
  });
});
