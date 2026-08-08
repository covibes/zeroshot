/** Mocha global setup for hermetic Zeroshot state. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Tests must never inherit a running cluster's options or ~/.zeroshot/settings.json.
// In parallel mode, suites that temporarily mutate env can share a worker, so restore
// the process-local baseline before every subsequent test.
const inheritedSettingsFile = process.env.ZEROSHOT_SETTINGS_FILE;
const fallbackSettingsFile = path.join(
  os.tmpdir(),
  `zeroshot-mocha-settings-${process.pid}-${crypto.randomUUID()}.json`
);
const testSettingsFile = inheritedSettingsFile || fallbackSettingsFile;
const taskStoreHome = process.env.ZEROSHOT_HOME;
const ambientRunVariables = [
  'ZEROSHOT_CLOSE_ISSUE',
  'ZEROSHOT_CLAUDE_MCP_CONFIG_FILE',
  'ZEROSHOT_CLAUDE_SETTINGS_FILE',
  'ZEROSHOT_CLUSTER_ID',
  'ZEROSHOT_CWD',
  'ZEROSHOT_DAEMON',
  'ZEROSHOT_DOCKER',
  'ZEROSHOT_DOCKER_IMAGE',
  'ZEROSHOT_MERGE',
  'ZEROSHOT_MERGE_QUEUE',
  'ZEROSHOT_MODEL',
  'ZEROSHOT_PR',
  'ZEROSHOT_PR_BASE',
  'ZEROSHOT_PROVIDER',
  'ZEROSHOT_PUSH',
  'ZEROSHOT_RUN_OPTIONS',
  'ZEROSHOT_STDIN_TASK',
  'ZEROSHOT_TASK_EXECUTION_CONTEXT',
  'ZEROSHOT_WORKERS',
  'ZEROSHOT_WORKTREE',
];

function assertStableTaskStoreHome() {
  if (process.env.ZEROSHOT_HOME === taskStoreHome) return;

  if (taskStoreHome === undefined) {
    delete process.env.ZEROSHOT_HOME;
  } else {
    process.env.ZEROSHOT_HOME = taskStoreHome;
  }
  throw new Error(
    'Tests must not mutate ZEROSHOT_HOME in a shared Mocha worker. ' +
      'task-lib/config.js caches the task-store root; run alternate-home scenarios in a child process.'
  );
}

function restoreTestEnvironment() {
  for (const variable of ambientRunVariables) {
    delete process.env[variable];
  }
  if (!process.env.ZEROSHOT_SETTINGS_FILE) {
    process.env.ZEROSHOT_SETTINGS_FILE = testSettingsFile;
  }
}

restoreTestEnvironment();

exports.mochaHooks = {
  beforeEach() {
    assertStableTaskStoreHome();
    restoreTestEnvironment();
  },
  afterEach: assertStableTaskStoreHome,
  afterAll() {
    if (!inheritedSettingsFile) {
      fs.rmSync(fallbackSettingsFile, { force: true });
    }
  },
};
