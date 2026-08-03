'use strict';

const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');
const {
  HostedRunOrchestrator,
  RemoteAllocationUncertainError,
  RemoteDetachedError,
} = require('../../private/hosted-cli-candidate/orchestrator');

const RUNTIME_DIGEST = `sha256:${'a'.repeat(64)}`;
const GRAPH = {
  profile: 'openengine.graph.single-worker/v1',
  root: { kind: 'step', worker: 'legacy.zeroshot.ship@1', attempts: 1 },
};

function base(overrides = {}) {
  const sequence = [];
  let ids = 0;
  const adapter = {
    credentialInstall: { supported: true, descriptor: {} },
    allocate() {
      sequence.push('allocate');
      return { id: 'cap1', state: 'ready' };
    },
    inspect() {
      sequence.push('inspect');
      return { id: 'cap1', state: 'ready' };
    },
    terminate() {
      sequence.push('terminate');
      return { id: 'cap1', state: 'terminating' };
    },
    ...overrides.adapter,
  };
  const initialClient = {
    plan() {
      sequence.push('plan');
      return { ok: true, diagnostics: [] };
    },
    apply() {
      sequence.push('apply');
      return { generation: 1, runId: 'server-run-1', phase: 'running', deduped: false };
    },
    ...overrides.initialClient,
  };
  const finalClient = {
    get() {
      sequence.push('get');
      return {
        status: {
          phase: 'finished',
          observedGeneration: 1,
          currentRunId: 'server-run-1',
          atCursor: 'cursor-2',
        },
      };
    },
    ...overrides.finalClient,
  };
  let opens = 0;
  const coordinator = {
    open() {
      sequence.push('initialize');
      opens += 1;
      return {
        initializeResult: {
          capabilities: { graphProfiles: ['openengine.graph.single-worker/v1'] },
        },
        client: opens === 1 ? initialClient : finalClient,
      };
    },
    watch() {
      sequence.push('watch');
      let delivered = false;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          if (delivered) return { done: true };
          delivered = true;
          return {
            done: false,
            value: {
              type: 'event',
              runId: 'server-run-1',
              cursor: 'cursor-2',
              event: {
                type: 'finished',
                final_status: {
                  phase: 'finished',
                  observedGeneration: 1,
                  currentRunId: 'server-run-1',
                  atCursor: 'cursor-2',
                },
              },
            },
          };
        },
        cancel() {
          sequence.push('watch-cancel');
        },
      };
    },
    close() {
      sequence.push('close');
    },
    ...overrides.coordinator,
  };
  const githubToken = Buffer.from('github-canary');
  const openrouterKey = Buffer.from('openrouter-canary');
  const output = { stdout: [], stderr: [] };
  const orchestrator = new HostedRunOrchestrator({
    assertGraphSpec: () => undefined,
    readInputs: () => {
      sequence.push('read-inputs');
      return { graph: GRAPH, input: null };
    },
    checkCredentialSources: () => {
      sequence.push('check-credentials');
      return {
        repository: 'github.com/owner/repo',
        profile: 'provider.codex-openrouter-pr@1',
        model: 'openai/gpt-5.2-codex',
        github: { account: 'octocat' },
      };
    },
    readCredentials: () => {
      sequence.push('read-credentials');
      return { githubToken, openrouterKey };
    },
    installClient: {
      preflight() {
        sequence.push('install-preflight');
        return { expected: {}, capability: {} };
      },
      async install(options) {
        const credentials = await options.credentialProvider();
        sequence.push('install');
        options.onUploadStart();
        credentials.githubToken.fill(0);
        credentials.openrouterKey.fill(0);
      },
      ...overrides.installClient,
    },
    createCoordinator: () => coordinator,
    randomUUID: () => `${String(++ids).padStart(8, '0')}-0000-0000-0000-000000000000`,
    runtimeImageDigest: RUNTIME_DIGEST,
    sleep: () => undefined,
    output: {
      stdout: (line) => output.stdout.push(line),
      stderr: (line) => output.stderr.push(line),
    },
  });
  return {
    adapter,
    coordinator,
    githubToken,
    openrouterKey,
    orchestrator,
    output,
    sequence,
    options: {
      adapter,
      descriptor: { origin: 'https://target.example' },
      sessionManager: {},
      target: { id: 'target1', url: 'https://target.example', organization: { id: 'org1' } },
      credentialStore: {},
      graphPath: 'graph.json',
      inputPath: 'input.json',
      detach: false,
    },
  };
}
it('refuses install capability preflight before allocation or secret acquisition', async () => {
  const h = base({
    installClient: {
      preflight() {
        h.sequence.push('install-preflight');
        throw new Error('sealed install unsupported');
      },
    },
  });
  await assert.rejects(h.orchestrator.run(h.options), /sealed install unsupported/);
  assert.deepEqual(h.sequence, ['read-inputs', 'check-credentials', 'install-preflight']);
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
  assert.equal(h.sequence.includes('read-credentials'), false);
});

afterEach(() => {
  process.exitCode = 0;
});

describe('hosted lifecycle orchestration', () => {
  it('runs the exact allocate/install/initialize/plan/apply/watch/get sequence with stable identities', async () => {
    const h = base();
    const result = await h.orchestrator.run(h.options);
    assert.equal(result.final.status.phase, 'finished');
    assert.deepEqual(h.sequence, [
      'read-inputs',
      'check-credentials',
      'install-preflight',
      'allocate',
      'read-credentials',
      'install',
      'initialize',
      'plan',
      'apply',
      'watch',
      'watch-cancel',
      'initialize',
      'get',
      'close',
    ]);
    assert.equal(result.identities.applyIdempotencyKey, 'apply_00000003000000000000000000000000');
    assert.equal(h.sequence.includes('terminate'), false);
    assert.ok(h.githubToken.every((byte) => byte === 0));
    assert.ok(h.openrouterKey.every((byte) => byte === 0));
  });

  it('returns detached only after committed apply when -d is used', async () => {
    const h = base();
    const result = await h.orchestrator.run({ ...h.options, detach: true });
    assert.equal(result.detached, true);
    assert.equal(result.apply.runId, 'server-run-1');
    assert.equal(h.sequence.includes('watch'), false);
    assert.equal(h.sequence.includes('get'), false);
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
    assert.equal(h.sequence.includes('terminate'), false);
    assert.equal(h.output.stderr.length, 1);
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
    assert.equal(h.sequence.includes('install'), false);
  });
});
