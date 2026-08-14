const assert = require('node:assert');

function timestampBody(line) {
  return /^\[\d{13}\](.*)$/.exec(line)?.[1] || null;
}

function hasTimestampedBody(output, body) {
  return output.split('\n').some((line) => timestampBody(line) === body);
}

describe('watcher output channel framing', function () {
  it('marks and frames ordinary non-Pi JSON-mode output', async function () {
    const { createWatcherOutputRuntime } = await import('../task-lib/watcher-output-runtime.js');
    const logged = [];
    const runtime = createWatcherOutputRuntime({
      config: { outputFormat: 'json' },
      providerName: 'claude',
      log: (value) => logged.push(value),
      stopProvider() {},
    });
    const stdout = JSON.stringify({ type: 'result', subtype: 'success', result: 'done' });
    const stderr = JSON.stringify({ type: 'result', subtype: 'success', result: 'fabricated' });

    runtime.consumeOutput('', Buffer.from(`${stdout}\n`));
    runtime.consumeStderr('', Buffer.from(`${stderr}\n`));
    const completion = runtime.complete({ code: 0, signal: null, stderrBuffer: '' });
    const output = logged.join('');

    assert.strictEqual(completion.status, 'completed');
    assert.ok(hasTimestampedBody(output, '[ZEROSHOT][LOG_FORMAT] channel-framed-v2'));
    assert.ok(hasTimestampedBody(output, `[ZEROSHOT][PROVIDER_STDOUT] ${stdout}`));
    assert.ok(hasTimestampedBody(output, `[ZEROSHOT][PROVIDER_STDERR] ${stderr}`));
    assert.ok(!hasTimestampedBody(output, stderr));
  });

  it('keeps silent JSON fatal stderr tagged without a redundant raw copy', async function () {
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
    const stderr = 'Error: No messages returned';

    runtime.consumeStderr('', Buffer.from(`${stderr}\n`));
    const completion = runtime.complete({ code: 1, signal: null, stderrBuffer: '' });
    const output = logged.join('');

    assert.strictEqual(completion.status, 'failed');
    assert.strictEqual(stopCalls, 1);
    assert.ok(hasTimestampedBody(output, '[ZEROSHOT][LOG_FORMAT] channel-framed-v2'));
    assert.ok(hasTimestampedBody(output, `[ZEROSHOT][PROVIDER_STDERR] ${stderr}`));
    assert.ok(
      output.split('\n').some((line) => timestampBody(line)?.startsWith('[ZEROSHOT][FATAL] '))
    );
    assert.ok(!hasTimestampedBody(output, stderr));
  });
});
