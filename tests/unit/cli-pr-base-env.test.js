/**
 * Test: PR config env fallback
 *
 * Ensures detached/daemon runs can read PR config from env vars.
 */

const assert = require('assert');
const { buildStartOptions } = require('../../lib/start-cluster');

const ENV_VARS = [
  'ZEROSHOT_CWD',
  'ZEROSHOT_RUN_OPTIONS',
  'ZEROSHOT_PR_BASE',
  'ZEROSHOT_MERGE_QUEUE',
  'ZEROSHOT_CLOSE_ISSUE',
];

const originalEnv = ENV_VARS.reduce((acc, key) => {
  acc[key] = process.env[key];
  return acc;
}, {});

function restoreEnv() {
  for (const key of ENV_VARS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
}

describe('CLI PR config env fallback', function () {
  beforeEach(function () {
    for (const key of ENV_VARS) {
      delete process.env[key];
    }
  });

  afterEach(function () {
    restoreEnv();
  });

  it('uses ZEROSHOT_PR_BASE when options.prBase is missing', function () {
    process.env.ZEROSHOT_CWD = '/tmp/zeroshot-test';
    process.env.ZEROSHOT_PR_BASE = 'dev';

    const result = buildStartOptions({ clusterId: 'test', options: {}, settings: {} });

    assert.strictEqual(result.prBase, 'dev');
  });

  it('uses ZEROSHOT_RUN_OPTIONS when options are missing', function () {
    process.env.ZEROSHOT_CWD = '/tmp/zeroshot-test';
    process.env.ZEROSHOT_RUN_OPTIONS = JSON.stringify({
      prBase: 'dev',
      mergeQueue: true,
      closeIssue: 'always',
      prBody: 'Issue {{issue_number}}',
    });

    const result = buildStartOptions({ clusterId: 'test', options: {}, settings: {} });

    assert.strictEqual(result.prBase, 'dev');
    assert.strictEqual(result.mergeQueue, true);
    assert.strictEqual(result.closeIssue, 'always');
    assert.strictEqual(result.prBody, 'Issue {{issue_number}}');
  });

  it('prefers explicit options over ZEROSHOT_RUN_OPTIONS', function () {
    process.env.ZEROSHOT_CWD = '/tmp/zeroshot-test';
    process.env.ZEROSHOT_RUN_OPTIONS = JSON.stringify({
      prBase: 'dev',
      mergeQueue: false,
      closeIssue: 'always',
    });

    const result = buildStartOptions({
      clusterId: 'test',
      options: { prBase: 'main', mergeQueue: true, closeIssue: 'never' },
      settings: {},
    });

    assert.strictEqual(result.prBase, 'main');
    assert.strictEqual(result.mergeQueue, true);
    assert.strictEqual(result.closeIssue, 'never');
  });

  it('prefers options.prBase over ZEROSHOT_PR_BASE', function () {
    process.env.ZEROSHOT_CWD = '/tmp/zeroshot-test';
    process.env.ZEROSHOT_PR_BASE = 'dev';

    const result = buildStartOptions({
      clusterId: 'test',
      options: { prBase: 'main' },
      settings: {},
    });

    assert.strictEqual(result.prBase, 'main');
  });

  it('uses ZEROSHOT_MERGE_QUEUE when options.mergeQueue is missing', function () {
    process.env.ZEROSHOT_CWD = '/tmp/zeroshot-test';
    process.env.ZEROSHOT_MERGE_QUEUE = '1';

    const result = buildStartOptions({ clusterId: 'test', options: {}, settings: {} });

    assert.strictEqual(result.mergeQueue, true);
  });

  it('prefers options.mergeQueue over ZEROSHOT_MERGE_QUEUE', function () {
    process.env.ZEROSHOT_CWD = '/tmp/zeroshot-test';
    process.env.ZEROSHOT_MERGE_QUEUE = '0';

    const result = buildStartOptions({
      clusterId: 'test',
      options: { mergeQueue: true },
      settings: {},
    });

    assert.strictEqual(result.mergeQueue, true);
  });

  it('uses ZEROSHOT_CLOSE_ISSUE when options.closeIssue is missing', function () {
    process.env.ZEROSHOT_CWD = '/tmp/zeroshot-test';
    process.env.ZEROSHOT_CLOSE_ISSUE = 'always';

    const result = buildStartOptions({ clusterId: 'test', options: {}, settings: {} });

    assert.strictEqual(result.closeIssue, 'always');
  });

  it('prefers options.closeIssue over ZEROSHOT_CLOSE_ISSUE', function () {
    process.env.ZEROSHOT_CWD = '/tmp/zeroshot-test';
    process.env.ZEROSHOT_CLOSE_ISSUE = 'always';

    const result = buildStartOptions({
      clusterId: 'test',
      options: { closeIssue: 'never' },
      settings: {},
    });

    assert.strictEqual(result.closeIssue, 'never');
  });
});
