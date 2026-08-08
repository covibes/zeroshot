'use strict';

const { strict: assert } = require('node:assert');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  cloneFixedRepository,
  fixedGitArguments,
  verifyEmptyWorkspace,
} = require('../../zeroshot-rust/hosted-node/workspace-bootstrap');

const REVISION = 'a'.repeat(40);
const DEFAULT_HEAD_REVISION = 'b'.repeat(40);
const WRONG_REVISION = 'c'.repeat(40);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zeroshot-hosted-bootstrap-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  return { root, workspace };
}

function config() {
  return Object.freeze({
    repository: 'the-open-engine/zeroshot',
    baseRevision: REVISION,
    provider: 'codex',
    modelLevel: 'level2',
    workerEnvironment: Object.freeze({
      GH_TOKEN: 'git-canary',
      OPENAI_API_KEY: 'provider-canary',
    }),
  });
}
function fixtureGit(calls, { headRevision = REVISION } = {}) {
  return (program, args, options) => {
    calls.push({ program, args, options });
    const lastArguments = args.slice(-3);
    if (lastArguments.includes('refs/remotes/origin/HEAD')) {
      return { stdout: `${DEFAULT_HEAD_REVISION}\n`, stderr: '' };
    }
    if (lastArguments.includes('HEAD')) {
      return { stdout: `${headRevision}\n`, stderr: '' };
    }
    if (lastArguments.includes('get-url')) {
      return { stdout: 'https://github.com/the-open-engine/zeroshot.git\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

describe('private hosted repository bootstrap', () => {
  it('trusts only the fixed workspace for every worker-side Git command', () => {
    assert.deepEqual(fixedGitArguments(['status', '--short']), [
      '-c',
      'credential.helper=',
      '-c',
      'core.askPass=/opt/zeroshot/zeroshot-rust/hosted-node/git-askpass.js',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'safe.directory=/workspace',
      '-c',
      'http.followRedirects=false',
      '-c',
      'http.proxy=',
      '-c',
      'https.proxy=',
      'status',
      '--short',
    ]);
  });

  it('accepts the exact fixed revision when the default branch has advanced', async () => {
    const { root, workspace } = fixture();
    const calls = [];
    const execute = fixtureGit(calls);
    try {
      await cloneFixedRepository(config(), { workspace, execute });
      assert.equal(calls.length, 5);
      assert.match(calls[0].args.join(' '), /clone --no-checkout --origin origin/);
      assert.equal(
        calls.some((call) => call.args.includes('refs/remotes/origin/HEAD')),
        false
      );
      assert.equal(
        calls[0].args.some((argument) => argument.includes('git-canary')),
        false
      );
      for (const call of calls) {
        assert.equal(call.program, '/usr/bin/git');
        assert.equal(call.options.env.GH_TOKEN, 'git-canary');
        assert.equal(call.options.env.OPENAI_API_KEY, undefined);
        assert.equal(call.options.uid, 10002);
        assert.equal(call.options.gid, 10002);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a checkout whose HEAD differs from the configured base revision', async () => {
    const { root, workspace } = fixture();
    try {
      await assert.rejects(
        cloneFixedRepository(config(), {
          workspace,
          execute: fixtureGit([], { headRevision: WRONG_REVISION }),
        }),
        /does not match fixed repository authority/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a nonempty or non-directory workspace before Git execution', () => {
    const { root, workspace } = fixture();
    try {
      writeFileSync(join(workspace, 'unexpected'), 'content');
      assert.throws(() => verifyEmptyWorkspace(workspace), /not an empty fixed directory/);
      rmSync(workspace, { recursive: true });
      writeFileSync(workspace, 'not a directory');
      assert.throws(() => verifyEmptyWorkspace(workspace), /not an empty fixed directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
