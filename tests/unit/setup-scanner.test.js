const assert = require('assert');

const { scanSetupEnvironment } = require('../../cli/lib/setup-scanner');

function responseFor(kind, payload) {
  if (kind === 'git') {
    return {
      isRepo: true,
      branch: 'main',
      remote: 'https://github.com/acme/repo.git',
      defaultBranch: 'main',
      clean: true,
    };
  }
  if (kind === 'docker') return { available: true, error: null };
  if (kind === 'issue') return { installed: true, authenticated: true, error: null };
  return {
    id: payload.id,
    available: true,
    commandAvailable: true,
    command: payload.id,
    path: `/usr/bin/${payload.id}`,
    displayName: 'Codex',
    authStatus: 'ready',
    authReason: null,
    error: null,
  };
}

function scanInput(probe, onProgress) {
  return {
    cwd: '/repo',
    settings: { __meta: { fileExists: false } },
    repoSettings: null,
    env: { CI: 'true' },
    onProgress,
    deps: {
      probe,
      listProviderMetadata: () => [{ id: 'codex' }],
    },
  };
}

describe('asynchronous setup environment scan', function () {
  it('starts every independent probe concurrently and preserves registry result order', async function () {
    let active = 0;
    let maxActive = 0;
    const completions = [];
    const delays = { git: 35, docker: 5, issue: 20, provider: 10 };
    const probe = (kind, payload) =>
      new Promise((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => {
          active -= 1;
          resolve({ ok: true, result: responseFor(kind, payload) });
        }, delays[kind]);
      });

    const scan = await scanSetupEnvironment(
      scanInput(probe, (event) => {
        if (event.type === 'complete') completions.push(event.id);
      })
    );

    assert.strictEqual(maxActive, 4);
    assert.deepStrictEqual(completions, ['docker', 'provider:codex', 'issue', 'git']);
    assert.deepStrictEqual(Object.keys(scan.probes), ['git', 'docker', 'issue', 'provider:codex']);
    assert.deepStrictEqual(Object.keys(scan.plan.facts.providers), ['codex']);
  });

  it('keeps transient timing and readiness progress outside stable setup plan JSON', async function () {
    const probe = (kind, payload) =>
      Promise.resolve({ ok: true, result: responseFor(kind, payload) });
    const first = await scanSetupEnvironment(scanInput(probe));
    const second = await scanSetupEnvironment(scanInput(probe));
    assert.deepStrictEqual(first.plan, second.plan);
    const serialized = JSON.stringify(first.plan);
    assert.ok(!serialized.includes('elapsedMs'));
    assert.ok(!serialized.includes('authStatus'));
    assert.strictEqual(first.plan.schemaVersion, 2);
  });

  it('fails one probe closed without hiding successful independent results', async function () {
    const probe = (kind, payload) => {
      const response =
        kind === 'docker'
          ? { ok: false, error: 'daemon unavailable' }
          : { ok: true, result: responseFor(kind, payload) };
      return Promise.resolve(response);
    };
    const scan = await scanSetupEnvironment(scanInput(probe));
    assert.strictEqual(scan.probes.docker.available, false);
    assert.strictEqual(scan.probes['provider:codex'].available, true);
    assert.strictEqual(scan.plan.recommended.defaultIsolation, 'worktree');
  });

  for (const scenario of [
    { name: 'repository prefers worktree', isRepo: true, docker: true, expected: 'worktree' },
    { name: 'non-repository prefers Docker', isRepo: false, docker: true, expected: 'docker' },
    {
      name: 'non-repository without Docker stays local',
      isRepo: false,
      docker: false,
      expected: 'none',
    },
  ]) {
    it(scenario.name, async function () {
      const probe = (kind, payload) => {
        const result = responseFor(kind, payload);
        if (kind === 'git') result.isRepo = scenario.isRepo;
        if (kind === 'docker') result.available = scenario.docker;
        return Promise.resolve({ ok: true, result });
      };
      const scan = await scanSetupEnvironment(scanInput(probe));
      assert.strictEqual(scan.plan.recommended.defaultIsolation, scenario.expected);
    });
  }
});
