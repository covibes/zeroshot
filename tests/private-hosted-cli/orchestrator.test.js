'use strict';

const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');
const {
  RemoteAllocationUncertainError,
  RemoteDetachedError,
} = require('../../private/hosted-cli-candidate/orchestrator');
const { assertSecretsAbsent, withEnvironment } = require('./environment-harness');
const { base, CALLER_INPUT } = require('./orchestrator-harness');
async function resolvesRuntimeBeforeAllocation() {
  const h = base();
  await h.orchestrator.run(h.options);
  assert.ok(h.sequence.indexOf('resolve-runtime') < h.sequence.indexOf('allocate'));
}

async function rejectsCallerAuthorityMismatches() {
  for (const input of [
    { ...CALLER_INPUT, repository: 'other/repo' },
    { ...CALLER_INPUT, provider: 'gateway' },
    { ...CALLER_INPUT, modelLevel: 'level3' },
    { ...CALLER_INPUT, providerProfile: 'provider.other@1' },
    { ...CALLER_INPUT, isolationProfile: 'isolation.other@1' },
    { ...CALLER_INPUT, command: 'caller-controlled' },
  ]) {
    const h = base({ input });
    await assert.rejects(h.orchestrator.run(h.options));
    assert.equal(h.sequence.includes('allocate'), false);
  }
}

async function rejectsUnsupportedArtifactInput() {
  const h = base({ input: { source: 'artifact', artifacts: [] } });
  await assert.rejects(h.orchestrator.run(h.options), /artifact input is unavailable/);
  assert.equal(h.sequence.includes('allocate'), false);
}

async function emitsStableOwnershipKeyBeforeAmbiguousAllocation() {
  let allocations = 0;
  const h = base({
    adapter: {
      allocate() {
        allocations += 1;
        h.sequence.push('allocate');
        throw new Error('response lost after send');
      },
    },
  });
  await assert.rejects(h.orchestrator.run(h.options), RemoteAllocationUncertainError);
  assert.equal(allocations, 1);
  assert.match(h.output.stdout[0], /^Allocation key: allocate_/);
  assert.match(h.output.stderr[0], /Do not allocate a replacement/);
  assert.equal(h.sequence.includes('initialize'), false);
}

async function propagatesDeterministicAllocationRefusals() {
  const refusal = Object.assign(new Error('Target access authorization failed'), {
    code: 'AUTH_FAILED',
  });
  const h = base({
    adapter: {
      allocate() {
        h.sequence.push('allocate');
        throw refusal;
      },
    },
  });
  await assert.rejects(h.orchestrator.run(h.options), (error) => error === refusal);
  assert.equal(h.output.stderr.length, 0);
  assert.equal(h.sequence.includes('initialize'), false);
}

async function runsExactHostedLifecycleSequence() {
  const h = base();
  const result = await h.orchestrator.run(h.options);
  assert.equal(result.final.status.phase, 'finished');
  assert.deepEqual(h.sequence, [
    'read-inputs',
    'resolve-runtime',
    'allocate',
    'access',
    'install-runtime',
    'initialize',
    'plan',
    'apply',
    'watch',
    'watch-cancel',
    'initialize',
    'get',
    'close',
  ]);
  assert.equal(result.identities.applyIdempotencyKey, 'apply_00000002000000000000000000000000');
  assert.equal(h.sequence.includes('terminate'), false);
  assert.deepEqual(h.requests.apply[0].input, {
    ...CALLER_INPUT,
    isolationProfile: 'isolation.prepared-worktree@1',
    providerProfile: 'provider.hosted-direct@1',
    repository: 'owner/repository',
    provider: 'claude',
    modelLevel: 'level1',
  });
  assert.equal(h.requests.runtime.accessToken, 'capsule-access');
  assert.equal(h.requests.runtime.runtime.runtime.provider, 'claude');
}

async function returnsDetachedAfterCommittedApply() {
  const h = base();
  const result = await h.orchestrator.run({ ...h.options, detach: true });
  assert.equal(result.detached, true);
  assert.equal(result.apply.runId, 'server-run-1');
  assert.equal(h.sequence.includes('watch'), false);
  assert.equal(h.sequence.includes('get'), false);
}

async function preservesCapsuleAfterAmbiguousApply() {
  const h = base({
    initialClient: {
      apply() {
        h.sequence.push('apply');
        throw new Error('connection reset after send');
      },
    },
  });
  await assert.rejects(h.orchestrator.run(h.options), (error) => {
    assert.ok(error instanceof RemoteDetachedError);
    assert.equal(error.capsuleId, 'cap1');
    assert.match(error.message, /preserved/);
    return true;
  });
  assert.match(
    h.output.stdout.find((line) => line.startsWith('Apply key:')),
    /^Apply key: apply_/
  );
  assert.equal(h.sequence.includes('terminate'), false);
  assert.equal(h.output.stderr.length, 1);
}

async function preservesCapsuleForNonterminalFinalState() {
  const h = base({
    finalClient: {
      get() {
        h.sequence.push('get');
        return {
          status: {
            phase: 'running',
            observedGeneration: 1,
            currentRunId: 'server-run-1',
            atCursor: 'cursor-2',
          },
        };
      },
    },
  });
  await assert.rejects(h.orchestrator.run(h.options), RemoteDetachedError);
  assert.equal(h.sequence.includes('terminate'), false);
}

async function detachesOnSigintWithoutTermination() {
  const abort = new AbortController();
  let h;
  h = base({
    coordinator: {
      watch() {
        h.sequence.push('watch');
        abort.abort(new globalThis.DOMException('operator interrupted observation', 'AbortError'));
        throw abort.signal.reason;
      },
    },
  });
  await assert.rejects(h.orchestrator.run({ ...h.options, signal: abort.signal }), (error) => {
    assert.ok(error instanceof RemoteDetachedError);
    assert.equal(error.capsuleId, 'cap1');
    assert.match(error.identities.allocationIdempotencyKey, /^allocate_/);
    assert.match(error.identities.applyIdempotencyKey, /^apply_/);
    return true;
  });
  assert.match(
    h.output.stdout.find((line) => line.startsWith('Allocation key:')),
    /allocate_/
  );
  assert.match(
    h.output.stdout.find((line) => line.startsWith('Apply key:')),
    /apply_/
  );
  assert.equal(h.sequence.includes('terminate'), false);
}

async function excludesDirectCredentialEnvironmentValues() {
  const credentials = {
    GH_TOKEN: 'gh-direct-secret-canary-884',
    OPENAI_API_KEY: 'openai-direct-secret-canary-884',
  };
  await withEnvironment(credentials, async () => {
    const h = base();
    const result = await h.orchestrator.run(h.options);
    const observed = JSON.stringify({ requests: h.requests, output: h.output, result });
    assertSecretsAbsent(observed, credentials);
    for (const name of Object.keys(credentials)) {
      assert.equal(Object.hasOwn(h.requests.apply[0].input, name), false);
    }
  });
}

async function terminatesOwnedCapsuleAfterPlanRefusal() {
  const h = base({
    initialClient: {
      plan() {
        h.sequence.push('plan');
        return { ok: false, diagnostics: [{ severity: 'error' }] };
      },
    },
  });
  await assert.rejects(h.orchestrator.run(h.options), /refused the graph/);
  assert.equal(h.sequence.includes('apply'), false);
  assert.equal(h.sequence.filter((step) => step === 'terminate').length, 1);
  assert.ok(h.sequence.indexOf('terminate') < h.sequence.indexOf('close'));
}

async function preservesCapsuleAfterReadinessAmbiguity() {
  let allocations = 0;
  const h = base({
    adapter: {
      allocate() {
        allocations += 1;
        h.sequence.push('allocate');
        return { id: 'cap1', state: 'provisioning' };
      },
      inspect() {
        h.sequence.push('inspect');
        throw new Error('unknown transport');
      },
    },
  });
  await assert.rejects(h.orchestrator.run(h.options), RemoteDetachedError);
  assert.equal(allocations, 1);
  assert.equal(h.sequence.includes('terminate'), false);
  assert.equal(h.sequence.includes('initialize'), false);
}
for (const [name, test] of [
  ['resolves runtime before allocation', resolvesRuntimeBeforeAllocation],
  ['rejects caller authority mismatches before allocation', rejectsCallerAuthorityMismatches],
  ['rejects unsupported artifact input before allocation', rejectsUnsupportedArtifactInput],
  [
    'emits one ownership key before ambiguous allocation',
    emitsStableOwnershipKeyBeforeAmbiguousAllocation,
  ],
  ['propagates deterministic allocation refusals', propagatesDeterministicAllocationRefusals],
]) {
  it(name, test);
}
afterEach(() => {
  process.exitCode = 0;
});
function registerHostedLifecycleTests() {
  const cases = [
    ['runs the exact hosted lifecycle sequence', runsExactHostedLifecycleSequence],
    ['returns detached only after committed apply', returnsDetachedAfterCommittedApply],
    ['preserves the capsule after ambiguous apply', preservesCapsuleAfterAmbiguousApply],
    ['preserves a nonterminal capsule', preservesCapsuleForNonterminalFinalState],
    ['detaches on SIGINT without termination', detachesOnSigintWithoutTermination],
    ['excludes direct credential values', excludesDirectCredentialEnvironmentValues],
    ['terminates after deterministic plan refusal', terminatesOwnedCapsuleAfterPlanRefusal],
    ['preserves the capsule after readiness ambiguity', preservesCapsuleAfterReadinessAmbiguity],
  ];
  for (const [name, test] of cases) it(name, test);
}
describe('hosted lifecycle orchestration', registerHostedLifecycleTests);
