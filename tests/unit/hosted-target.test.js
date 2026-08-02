'use strict';

const assert = require('node:assert').strict;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('mocha');

const {
  addTarget,
  getTarget,
  loadTargets,
  removeTarget,
} = require('../../cli/hosted/target-store');
const {
  graph,
  issueInput,
  resolveInput,
  validateHostedOptions,
  websocketUrl,
} = require('../../cli/hosted/run');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroshot-hosted-target-'));
  return {
    directory,
    environment: { ZEROSHOT_TARGETS_FILE: path.join(directory, 'targets.json') },
  };
}

describe('hosted target CLI', function () {
  it('persists endpoint metadata without credentials', function () {
    const { directory, environment } = fixture();
    try {
      addTarget('local', 'http://127.0.0.1:8080/', environment);
      assert.deepEqual(getTarget('local', environment), { endpoint: 'http://127.0.0.1:8080' });
      assert.deepEqual(Object.keys(loadTargets(environment).targets), ['local']);
      assert.equal(fs.statSync(environment.ZEROSHOT_TARGETS_FILE).mode & 0o777, 0o600);
      assert.ok(!fs.readFileSync(environment.ZEROSHOT_TARGETS_FILE, 'utf8').includes('token'));
      removeTarget('local', environment);
      assert.deepEqual(loadTargets(environment).targets, {});
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects endpoints and names with ambiguous authority', function () {
    const { directory, environment } = fixture();
    try {
      assert.throws(() => addTarget('../escape', 'https://cloud.example', environment));
      assert.throws(() => addTarget('prod', 'https://user:secret@cloud.example', environment));
      assert.throws(() => addTarget('prod', 'https://cloud.example/api', environment));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the canonical single-worker facade for hosted issues', function () {
    const issue = issueInput('the-open-engine/zeroshot#837');
    assert.equal(issue.repository, 'the-open-engine/zeroshot');
    assert.equal(issue.request.issue, 'https://github.com/the-open-engine/zeroshot/issues/837');
    assert.ok(!Object.hasOwn(issue.request, 'prompt'));
    const specification = graph();
    assert.equal(specification.profile, 'openengine.graph.single-worker/v1');
    assert.equal(specification.root.worker, 'legacy.zeroshot.ship@1');
    assert.equal(specification.root.input.fields.providerProfile.required, true);
    assert.equal(specification.root.output.fields.summary.type.kind, 'string');
  });

  it('selects reviewed PR delivery only when the hosted run requests it', async function () {
    assert.equal(
      (await resolveInput('the-open-engine/zeroshot#837', {})).request.isolationProfile,
      'isolation.worktree@1'
    );
    const issuePr = await resolveInput('the-open-engine/zeroshot#837', { pr: true });
    assert.equal(issuePr.request.isolationProfile, 'isolation.pr@1');
    assert.equal(issuePr.request.providerProfile, 'provider.codex-openrouter-pr@1');
    assert.equal(
      (
        await resolveInput('Implement the issue', {
          pr: true,
          repository: 'the-open-engine/zeroshot',
        })
      ).request.isolationProfile,
      'isolation.pr@1'
    );
  });

  it('rejects repository path segments that Git would normalize', function () {
    assert.equal(issueInput('../zeroshot#837'), null);
    assert.equal(issueInput('the-open-engine/..#837'), null);
    assert.equal(issueInput('https://github.com/../zeroshot/issues/837'), null);
  });

  it('routes localhost advertised wss access through the target', function () {
    assert.equal(
      websocketUrl(
        { endpoint: 'http://127.0.0.1:49152' },
        'wss://capsule.localtest.me/v1/capsules/example/oecp'
      ),
      'ws://127.0.0.1:49152/v1/capsules/example/oecp'
    );
  });

  it('rejects local-only flags instead of silently ignoring them', function () {
    assert.doesNotThrow(() => validateHostedOptions({ target: 'local', model: 'openai/gpt-5.4' }));
    assert.doesNotThrow(() => validateHostedOptions({ target: 'local', pr: true }));
    assert.doesNotThrow(() => validateHostedOptions({ target: 'local', provider: 'codex' }));
    assert.doesNotThrow(() => validateHostedOptions({ target: 'local', size: 'standard' }));
    assert.throws(
      () => validateHostedOptions({ target: 'local', docker: true, provider: 'claude' }),
      /--docker, --provider/
    );
    assert.throws(
      () => validateHostedOptions({ target: 'local', model: 'openai/gpt-5.4\n[model_providers]' }),
      /provider\/model slug/
    );
    assert.throws(
      () => validateHostedOptions({ target: 'local', size: 'xlarge' }),
      /--size tiny, small, standard, or large/
    );
  });
});
