const { PassThrough } = require('stream');

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const CLI_PATH = path.join(__dirname, '..', '..', 'cli', 'index.js');

function ttyStream(isTTY) {
  const stream = new PassThrough();
  stream.isTTY = isTTY;
  return stream;
}

describe('setup wizard CLI integration', function () {
  it('routes bare setup to the wizard and gives non-TTY recovery commands', function () {
    const result = spawnSync(process.execPath, [CLI_PATH, 'setup'], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf8',
    });

    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stdout, /Interactive setup requires a TTY/);
    assert.match(result.stdout, /zeroshot setup plan/);
    assert.match(result.stdout, /zeroshot setup apply --decisions <file>/);
  });
});

describe('automatic first-run setup gate', function () {
  const { handleNoArgumentInvocation, shouldRunInitialSetup } = require('../../cli');

  it('runs the wizard only for bare interactive use without a settings file', async function () {
    const stdin = ttyStream(true);
    const stdout = ttyStream(true);
    let wizardRuns = 0;
    let helpRuns = 0;
    let exitCode;

    const handled = await handleNoArgumentInvocation({
      args: [],
      stdin,
      stdout,
      settingsExist: false,
      runWizard: () => {
        wizardRuns += 1;
        return { exitCode: 0 };
      },
      outputHelp: () => {
        helpRuns += 1;
      },
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    assert.strictEqual(handled, true);
    assert.strictEqual(wizardRuns, 1);
    assert.strictEqual(helpRuns, 0);
    assert.strictEqual(exitCode, 0);
  });

  for (const testCase of [
    { name: 'an existing settings file', settingsExist: true, stdinTTY: true, stdoutTTY: true },
    { name: 'piped stdin', settingsExist: false, stdinTTY: false, stdoutTTY: true },
    { name: 'redirected stdout', settingsExist: false, stdinTTY: true, stdoutTTY: false },
  ]) {
    it(`prints help without writes for ${testCase.name}`, async function () {
      let wizardRuns = 0;
      let helpRuns = 0;
      const handled = await handleNoArgumentInvocation({
        args: [],
        stdin: ttyStream(testCase.stdinTTY),
        stdout: ttyStream(testCase.stdoutTTY),
        settingsExist: testCase.settingsExist,
        runWizard: () => {
          wizardRuns += 1;
          return { exitCode: 0 };
        },
        outputHelp: () => {
          helpRuns += 1;
        },
        setExitCode: () => {},
      });

      assert.strictEqual(handled, true);
      assert.strictEqual(wizardRuns, 0);
      assert.strictEqual(helpRuns, 1);
    });
  }

  it('never handles an explicit command or quiet option as bare setup', async function () {
    const base = {
      stdin: ttyStream(true),
      stdout: ttyStream(true),
      settingsExist: false,
    };
    assert.strictEqual(shouldRunInitialSetup({ ...base, args: ['--quiet'] }), false);
    assert.strictEqual(
      await handleNoArgumentInvocation({
        ...base,
        args: ['setup'],
        runWizard: () => {
          throw new Error('wizard must not run');
        },
        outputHelp: () => {
          throw new Error('help must not run');
        },
      }),
      false
    );
  });
});
