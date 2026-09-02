'use strict';

const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');
const {
  RemoteAllocationUncertainError,
  RemoteDetachedError,
} = require('../../private/hosted-cli-candidate/orchestrator');
const { base, CALLER_INPUT } = require('./orchestrator-harness');

it('refuses setup mismatches before allocation', async () => {
  const h = base();
  await assert.rejects(
    h.orchestrator.run({ ...h.options, expectedRepository: 'other/repo' }),
    /does not match/
  );
  assert.deepEqual(h.sequence, ['read-inputs', 'check-setup']);
});

it('rejects caller authority mismatches and malformed requests before allocation', async () => {
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
});

it('rejects unsupported artifact input before allocation', async () => {
  const h = base({ input: { source: 'artifact', artifacts: [] } });
  await assert.rejects(h.orchestrator.run(h.options), /artifact input is unavailable/);
  assert.equal(h.sequence.includes('allocate'), false);
});

it('emits one stable ownership key before an ambiguous allocation and never retries', async () => {
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
});

it('propagates deterministic allocation refusals without claiming ambiguity', async () => {
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
});

afterEach(() => {
  process.exitCode = 0;
});

describe('hosted lifecycle orchestration', () => {
  it('runs the exact allocate/initialize/plan/apply/watch/get sequence', async () => {
    const h = base();
    const result = await h.orchestrator.run(h.options);
    assert.equal(result.final.status.phase, 'finished');
    assert.deepEqual(h.sequence, [
      'read-inputs',
      'check-setup',
      'allocate',
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
      source: 'prompt',
      prompt: 'Ship the requested change.',
      artifacts: [],
      isolationProfile: 'isolation.prepared-worktree@1',
      providerProfile: 'provider.hosted-direct@1',
      repository: 'owner/repo',
      provider: 'codex',
      modelLevel: 'level2',
    });
  });

  it('returns detached only after committed apply when -d is used', async () => {
    const h = base();
    const result = await h.orchestrator.run({ ...h.options, detach: true });
    assert.equal(result.detached, true);
    assert.equal(result.apply.runId, 'server-run-1');
    assert.equal(h.sequence.includes('watch'), false);
    assert.equal(h.sequence.includes('get'), false);
  });

  it('surfaces only safe authority diagnostics and terminates the refused capsule', async () => {
    const h = base({
      initialClient: {
        apply() {
          h.sequence.push('apply');
          throw Object.assign(new Error('peer-controlled detail'), {
            code: 'HOSTED_REPOSITORY_MISMATCH',
            data: { code: 'HOSTED_REPOSITORY_MISMATCH' },
          });
        },
      },
    });
    await assert.rejects(h.orchestrator.run(h.options), (error) => {
      assert.equal(error.name, 'HostedProtocolError');
      assert.match(error.message, /HOSTED_REPOSITORY_MISMATCH/);
      assert.doesNotMatch(error.message, /peer-controlled/);
      return true;
    });
    assert.equal(h.sequence.filter((step) => step === 'apply').length, 1);
    assert.equal(h.sequence.filter((step) => step === 'terminate').length, 1);
  });

  it('preserves the capsule and identities when apply response is ambiguous', async () => {
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
  });

  it('preserves the capsule when authoritative final state remains nonterminal', async () => {
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
  });
  it('detaches on SIGINT with stable remediation identities and no termination', async () => {
    const abort = new AbortController();
    let h;
    h = base({
      coordinator: {
        watch() {
          h.sequence.push('watch');
          abort.abort(
            new globalThis.DOMException('operator interrupted observation', 'AbortError')
          );
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
  });

  it('does not read, log, serialize, or send direct credential environment values', async () => {
    const credentials = {
      GH_TOKEN: 'gh-direct-secret-canary-884',
      OPENAI_API_KEY: 'openai-direct-secret-canary-884',
    };
    const previous = Object.fromEntries(
      Object.keys(credentials).map((name) => [name, process.env[name]])
    );
    Object.assign(process.env, credentials);
    try {
      const h = base();
      const result = await h.orchestrator.run(h.options);
      const observed = JSON.stringify({ requests: h.requests, output: h.output, result });
      for (const [name, value] of Object.entries(credentials)) {
        assert.equal(observed.includes(name), false);
        assert.equal(observed.includes(value), false);
        assert.equal(Object.hasOwn(h.requests.apply[0].input, name), false);
      }
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('terminates only a definitely owned provisional capsule after deterministic plan refusal', async () => {
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
  });

  it('never allocates a replacement or terminates after readiness transport ambiguity', async () => {
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
  });
});
