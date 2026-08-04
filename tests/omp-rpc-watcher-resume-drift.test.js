const {
  path,
  runWatcher,
  storeGetTask,
  zeroshotHome,
  assertFailedBeforePrompt,
  prepareResumeCase,
} = require('./helpers/omp-rpc-watcher-session-harness');

describe('OMP RPC watcher: resume execution drift', function () {
  this.timeout(20000);

  it('fails closed on selected concrete-model drift', async function () {
    const { resumedId, partition, commandSpec, expectation } = await prepareResumeCase({
      label: 'resume-model-drift',
    });
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
      env: {
        OMP_FAKE_RPC_SELECTED_MODEL: 'claude-some-other-concrete-model',
        OMP_FAKE_RPC_PROMPT_SINK: promptSink,
      },
    });
    assertFailedBeforePrompt({
      code,
      task: await storeGetTask(resumedId),
      promptSink,
      errorPattern: /selectedModel/,
    });
  });

  it('fails closed on thinking-level execution drift even when the model is unchanged', async function () {
    const { resumedId, partition, commandSpec, expectation } = await prepareResumeCase({
      label: 'resume-thinking-drift',
    });
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
      env: {
        OMP_FAKE_RPC_THINKING_LEVEL: 'xhigh',
        OMP_FAKE_RPC_PROMPT_SINK: promptSink,
      },
    });
    assertFailedBeforePrompt({
      code,
      task: await storeGetTask(resumedId),
      promptSink,
      errorPattern: /executionFingerprint/,
    });
  });

  it('fails closed on Zeroshot selector / overlay / version drift recorded in the fingerprint', async function () {
    const { resumedId, partition, commandSpec, expectation } = await prepareResumeCase({
      label: 'resume-selector-drift',
      expectationOverrides: { expectedExecutionFingerprint: `sha256:${'9'.repeat(64)}` },
    });
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
      env: { OMP_FAKE_RPC_PROMPT_SINK: promptSink },
    });
    assertFailedBeforePrompt({
      code,
      task: await storeGetTask(resumedId),
      promptSink,
      errorPattern: /executionFingerprint/,
    });
  });
});
