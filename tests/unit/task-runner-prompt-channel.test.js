/**
 * task-lib/runner.js#spawnTask must never place prompt bytes in the detached watcher's argv.
 *
 * Regression for the argv-exposure finding on PR #907: buildWatcherConfig embedded the whole OMP
 * prompt in the JSON config blob that spawnWatcher serializes into fork() arguments, so `ps` and
 * /proc/<pid>/cmdline exposed task content to every local user for the watcher's whole lifetime.
 * The prompt now travels over the private stdin pipe in src/watcher-prompt-channel.js instead.
 *
 * The harness runs in its own child process because it monkey-patches child_process.fork before
 * importing runner.js, and because runner.js resolves ZEROSHOT_HOME at module-load time.
 */

const { describe, it } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { promisify } = require('util');
const {
  createExplicitOmpRpcSettings,
  FAKE_OMP_WITH_RPC,
} = require('../helpers/explicit-omp-rpc-settings');

const execFileAsync = promisify(execFile);

const runnerUrl = pathToFileURL(path.resolve(__dirname, '../../task-lib/runner.js')).href;
const promptChannelPath = path.resolve(__dirname, '../../src/watcher-prompt-channel.js');

const SENTINEL_PROMPT = 'ZS_RUNNER_ARGV_SENTINEL_5d0c9a_DO_NOT_PUT_ME_IN_ARGV';

const HARNESS = `import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('child_process');

const forks = [];
childProcess.fork = (script, argv, options) => {
  const written = [];
  const record = { script, argv, options, stdinChunks: written };
  forks.push(record);
  return {
    stdin: {
      on() {},
      end(chunk) {
        if (chunk !== undefined) written.push(Buffer.from(chunk).toString('base64'));
      },
    },
    unref() {},
    disconnect() {},
  };
};

const { spawnTask } = await import(${JSON.stringify(runnerUrl)});

spawnTask(process.env.HARNESS_PROMPT, {
  provider: process.env.HARNESS_PROVIDER,
  model: process.env.HARNESS_MODEL,
});

process.stdout.write(JSON.stringify(forks));
`;

async function runHarness({ provider, model, prompt }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-runner-prompt-channel-'));
  const binDir = path.join(home, 'bin');
  const { env: rpcSettingsEnv } = createExplicitOmpRpcSettings(home);
  fs.mkdirSync(binDir);
  const fakeOmp = path.join(binDir, 'omp');
  fs.writeFileSync(fakeOmp, FAKE_OMP_WITH_RPC);
  fs.chmodSync(fakeOmp, 0o755);
  const harnessPath = path.join(home, 'harness.mjs');
  fs.writeFileSync(harnessPath, HARNESS);

  try {
    const { stdout } = await execFileAsync(process.execPath, [harnessPath], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ZEROSHOT_HOME: home,
        ...rpcSettingsEnv,
        HARNESS_PROVIDER: provider,
        HARNESS_MODEL: model,
        HARNESS_PROMPT: prompt,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      },
    });
    return JSON.parse(stdout.trim().split('\n').at(-1));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('detached watcher prompt channel (task-lib/runner.js)', function () {
  this.timeout(30000);

  it('keeps the OMP prompt out of argv and hands it to the watcher over a private pipe', async function () {
    const forks = await runHarness({
      provider: 'omp',
      model: 'test-model',
      prompt: SENTINEL_PROMPT,
    });
    expect(forks).to.have.lengthOf(1);
    const [watcher] = forks;

    expect(watcher.script).to.match(/rpc-watcher\.js$/);
    expect(JSON.stringify(watcher.argv)).to.not.include(
      SENTINEL_PROMPT,
      'prompt bytes must never be serialized into watcher argv'
    );
    // The watcher config blob in argv must not carry a prompt field at all.
    expect(JSON.parse(watcher.argv[4])).to.not.have.property('prompt');

    // fd 0 is a real pipe (not 'ignore'), and it carries exactly one framed prompt.
    expect(watcher.options.stdio[0]).to.equal('pipe');
    expect(watcher.stdinChunks).to.have.lengthOf(1);

    const { encodeWatcherPromptFrame } = require(promptChannelPath);
    expect(
      Buffer.from(watcher.stdinChunks[0], 'base64').equals(
        encodeWatcherPromptFrame(SENTINEL_PROMPT)
      )
    ).to.equal(true, 'the pipe must carry exactly the framed sentinel prompt');
  });

  it('leaves non-rpc lanes on fully ignored stdio with no prompt channel', async function () {
    const forks = await runHarness({
      provider: 'claude',
      model: 'sonnet',
      prompt: SENTINEL_PROMPT,
    });
    expect(forks).to.have.lengthOf(1);
    const [watcher] = forks;

    expect(watcher.script).to.not.match(/rpc-watcher\.js$/);
    expect(watcher.options.stdio).to.equal('ignore');
    expect(watcher.stdinChunks).to.have.lengthOf(0);
  });
});
