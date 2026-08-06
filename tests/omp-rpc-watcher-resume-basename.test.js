const {
  fs,
  path,
  runWatcher,
  storeGetTask,
  zeroshotHome,
  assertFailedBeforePrompt,
  prepareResumeCase,
} = require('./helpers/omp-rpc-watcher-session-harness');

describe('OMP RPC watcher: resume file identity', function () {
  this.timeout(20000);

  it('rejects a returned session file that only shares the requested basename', async function () {
    const { resumedId, partition, commandSpec, expectation } = await prepareResumeCase({
      label: 'resume-basename',
    });

    // A different directory holding a file with the *same basename* — the exact case a
    // basename-only comparison would wave through.
    const decoyDir = fs.mkdtempSync(path.join(zeroshotHome, 'omp-decoy-'));
    const decoy = path.join(decoyDir, partition.sessionFileName);
    fs.copyFileSync(partition.sessionFilePath, decoy);
    const promptSink = path.join(zeroshotHome, `${resumedId}-prompt.json`);

    const { code } = await runWatcher({
      id: resumedId,
      commandSpec,
      scenario: 'happy',
      ompSession: {
        kind: 'resume',
        partition: { path: partition.partitionPath },
        file: { path: partition.sessionFilePath },
      },
      ompResumeExpectation: expectation,
      env: { OMP_FAKE_RPC_SESSION_FILE: decoy, OMP_FAKE_RPC_PROMPT_SINK: promptSink },
    });
    assertFailedBeforePrompt({
      code,
      task: await storeGetTask(resumedId),
      promptSink,
      errorPattern: /echoed sessionFile/,
    });
  });
});
