const {
  SENTINEL_PROMPT,
  assert,
  buildCommandSpec,
  createOmpConfigOverlay,
  encodeWatcherPromptFrame,
  fs,
  nextTaskId,
  path,
  runWatcher,
  seedTask,
  storeGetTask,
  zeroshotHome,
} = require('./helpers/omp-rpc-watcher-harness');

describe('OMP RPC watcher: prompt channel failures', function () {
  this.timeout(20000);

  it('fails closed without spawning OMP when the prompt channel is absent, truncated, or over the 1 MiB contract', async function () {
    const oversizedHeader = `${JSON.stringify({
      kind: 'zeroshot-watcher-prompt-v1',
      promptBytes: 1024 * 1024 + 1,
    })}\n`;
    const completeFrame = encodeWatcherPromptFrame(SENTINEL_PROMPT);
    const cases = [
      { label: 'absent', sendPrompt: false, expected: /prompt-channel: .*closed before/ },
      {
        label: 'truncated',
        promptFrame: completeFrame.subarray(0, completeFrame.byteLength - 5),
        expected: /prompt-channel: .*closed after \d+ of \d+ declared bytes/,
      },
      {
        label: 'over-contract',
        promptFrame: Buffer.from(oversizedHeader, 'utf8'),
        expected: /prompt-channel: .*above the 1048576-byte contract/,
      },
      {
        label: 'header-only-then-close',
        promptFrame: Buffer.from(
          `${JSON.stringify({ kind: 'zeroshot-watcher-prompt-v1', promptBytes: 32 })}\n`,
          'utf8'
        ),
        expected: /prompt-channel: .*closed after 0 of 32 declared bytes/,
      },
    ];

    for (const { label, expected, ...channel } of cases) {
      const id = nextTaskId(`prompt-channel-${label}`);
      const overlay = createOmpConfigOverlay();
      const promptSink = path.join(zeroshotHome, `${id}-prompt.json`);
      const commandSpec = buildCommandSpec(overlay);
      await seedTask(id, commandSpec);

      const { code } = await runWatcher({
        id,
        commandSpec,
        scenario: 'happy',
        env: { OMP_FAKE_RPC_PROMPT_SINK: promptSink },
        ...channel,
      });

      assert.strictEqual(code, 1, `${label}: watcher must exit non-zero`);
      const task = await storeGetTask(id);
      assert.strictEqual(task.status, 'failed', `${label}: task must fail closed`);
      assert.match(task.error, expected, `${label}: error must name the prompt channel`);
      // Fail-closed means OMP was never prompted, and ownership-aware cleanup still ran.
      assert.strictEqual(fs.existsSync(promptSink), false, `${label}: OMP must never be prompted`);
      assert.strictEqual(task.commandCleanup, null, `${label}: cleanup receipt must be cleared`);
      assert.strictEqual(fs.existsSync(overlay.dir), false, `${label}: overlay must be removed`);
    }
  });
});
