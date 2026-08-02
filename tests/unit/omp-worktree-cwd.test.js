/**
 * OMP keys session/state storage by cwd (there is no --resume/--continue), so worktree isolation
 * MUST bind the OMP process cwd to the isolated worktree, never the main checkout. This covers:
 *  - the workDir fallback order used to pick a cwd when an agent has none configured explicitly
 *    (`agent.config.cwd || cluster.worktree.path || cluster.cwd || process.cwd()`, see
 *    src/agent/agent-lifecycle.js `createValidatorIsolation`), and
 *  - that the real omp command builder honors an explicit worktree cwd end to end (commandSpec.cwd
 *    and the `--cwd` argv flag), and
 *  - that resumeSessionId/continueSession still fail closed (OMP has no session-resume flag), so a
 *    worktree rerun can never accidentally reuse another checkout's session file.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { prepareSingleAgentProviderCommand } = require('../../task-lib/provider-helper-runtime.js');

const OMP_CLI_FEATURES = {
  supportsModeJson: true,
  supportsPrint: true,
  supportsCwd: true,
  supportsAutoApprove: true,
  supportsModel: true,
  supportsThinking: true,
  supportsNoExtensions: true,
  supportsNoSkills: true,
  supportsNoRules: true,
  supportsNoTitle: true,
};

function resolveWorkDir(agent, cluster) {
  // Mirrors src/agent/agent-lifecycle.js createValidatorIsolation's workDir order exactly.
  return agent.config?.cwd || cluster.worktree?.path || cluster.cwd || process.cwd();
}

describe('OMP worktree cwd/session binding', function () {
  it('the resolved workDir falls back to cluster.worktree.path over cluster.cwd/process.cwd() when agent.config.cwd is unset', function () {
    const cluster = { worktree: { path: '/tmp/wt-x' }, cwd: '/tmp/main-checkout' };
    const agent = { config: {} };
    assert.strictEqual(resolveWorkDir(agent, cluster), '/tmp/wt-x');
  });

  it('agent.config.cwd still wins over the worktree when explicitly set', function () {
    const cluster = { worktree: { path: '/tmp/wt-x' }, cwd: '/tmp/main-checkout' };
    const agent = { config: { cwd: '/tmp/explicit' } };
    assert.strictEqual(resolveWorkDir(agent, cluster), '/tmp/explicit');
  });

  it('guards the fallback order against silent drift in agent-lifecycle.js', function () {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'agent', 'agent-lifecycle.js'),
      'utf8'
    );
    assert.ok(
      source.includes(
        'agent.config?.cwd || cluster.worktree?.path || cluster.cwd || process.cwd()'
      ),
      'createValidatorIsolation workDir fallback order changed; update this test to match the new order'
    );
  });

  it('binds the built omp commandSpec cwd and --cwd argv to an explicit worktree path', function () {
    const worktreePath = '/tmp/zeroshot-wt-x';
    const prepared = prepareSingleAgentProviderCommand({
      provider: 'omp',
      context: 'do the work',
      options: { autoApprove: true, cwd: worktreePath, cliFeatures: OMP_CLI_FEATURES },
    });
    assert.strictEqual(prepared.commandSpec.cwd, worktreePath);
    assert.notStrictEqual(prepared.commandSpec.cwd, process.cwd());
    const flagIndex = prepared.commandSpec.args.indexOf('--cwd');
    assert.ok(
      flagIndex >= 0,
      `expected --cwd in argv: ${JSON.stringify(prepared.commandSpec.args)}`
    );
    assert.strictEqual(prepared.commandSpec.args[flagIndex + 1], worktreePath);
  });

  it('fails closed on resumeSessionId (no cross-worktree session reuse)', function () {
    assert.throws(
      () =>
        prepareSingleAgentProviderCommand({
          provider: 'omp',
          context: 'do the work',
          options: {
            autoApprove: true,
            cwd: '/tmp/zeroshot-wt-x',
            cliFeatures: OMP_CLI_FEATURES,
            resumeSessionId: 'some-session-id',
          },
        }),
      (err) => err.code === 'invalid-field' && err.field === 'options.resumeSessionId'
    );
  });

  it('fails closed on continueSession (no cross-worktree session reuse)', function () {
    assert.throws(
      () =>
        prepareSingleAgentProviderCommand({
          provider: 'omp',
          context: 'do the work',
          options: {
            autoApprove: true,
            cwd: '/tmp/zeroshot-wt-x',
            cliFeatures: OMP_CLI_FEATURES,
            continueSession: true,
          },
        }),
      (err) => err.code === 'invalid-field' && err.field === 'options.continueSession'
    );
  });
});
