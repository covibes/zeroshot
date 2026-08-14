const { describe, it } = require('mocha');
const { expect } = require('chai');
const { runPromptHarness } = require('../helpers/omp-spawn-boundary-harness');
const { encodeWatcherPromptFrame } = require('../../src/watcher-prompt-channel');
const SENTINEL_PROMPT = 'ZS_RUNNER_ARGV_SENTINEL_5d0c9a_DO_NOT_PUT_ME_IN_ARGV';

describe('detached watcher prompt channel (task-lib/runner.js)', function () {
  this.timeout(30000);

  it('keeps the OMP prompt out of argv and hands it to the watcher over a private pipe', async function () {
    const forks = await runPromptHarness({
      provider: 'omp',
      model: 'openai/test-model',
      prompt: SENTINEL_PROMPT,
    });
    expect(forks).to.have.lengthOf(1);
    const [watcher] = forks;

    expect(watcher.script).to.match(/rpc-watcher\.js$/);
    expect(JSON.stringify(watcher.argv)).to.not.include(
      SENTINEL_PROMPT,
      'prompt bytes must never be serialized into watcher argv'
    );
    expect(JSON.parse(watcher.argv[4])).to.not.have.property('prompt');
    expect(watcher.executable).to.equal(process.execPath);
    expect(watcher.options.stdio).to.deep.equal(['pipe', 'ignore', 'ignore']);
    expect(watcher.options.stdio).to.not.include('ipc');
    expect(watcher.stdinChunks).to.have.lengthOf(1);

    expect(
      Buffer.from(watcher.stdinChunks[0], 'base64').equals(
        encodeWatcherPromptFrame(SENTINEL_PROMPT)
      )
    ).to.equal(true, 'the pipe must carry exactly the framed sentinel prompt');
  });

  it('leaves non-rpc lanes on fully ignored stdio with no prompt channel', async function () {
    const forks = await runPromptHarness({
      provider: 'claude',
      model: 'sonnet',
      prompt: SENTINEL_PROMPT,
    });
    expect(forks).to.have.lengthOf(1);
    const [watcher] = forks;

    expect(watcher.script).to.not.match(/rpc-watcher\.js$/);
    expect(watcher.executable).to.equal(process.execPath);
    expect(watcher.options.stdio).to.equal('ignore');
    expect(watcher.stdinChunks).to.have.lengthOf(0);
  });
});
