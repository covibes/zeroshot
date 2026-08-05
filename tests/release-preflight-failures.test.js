const {
  assert,
  exactRuntimeOptions,
  path,
  resolveOmpSdkRuntime,
} = require('./helpers/release-preflight-harness');

describe('OMP SDK runtime asset failures', () => {
  it('fails closed on missing or drifted executable and source assets', () => {
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          readRuntimeVersion: () => '1.3.13',
        }),
      /Bun executable version drift/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          fileExists: (candidate) => !candidate.endsWith(path.join('src', 'index.ts')),
        }),
      /Pinned OMP SDK entry source is missing/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          fileExists: (candidate) => !candidate.endsWith(path.join('bin', 'bun.exe')),
        }),
      /Pinned Bun executable is missing/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          fileExists: (candidate) => !candidate.endsWith(path.join('omp', 'sidecar.ts')),
        }),
      /OMP SDK sidecar is missing/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          fileExists: (candidate) => !candidate.endsWith(path.join('omp', 'host-supervisor.ts')),
        }),
      /OMP SDK host supervisor is missing/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          readContainmentProbe: () =>
            JSON.stringify({
              protocolVersion: 1,
              type: 'cleanup-attestation',
              status: 'clean',
              mode: 'linux-subreaper-pidfd',
              subreaper: true,
              pidfd: true,
              terminalBuffered: true,
              ownedProcessCount: 1,
              cancelled: false,
              semantic: { exitCode: 0, signal: null },
            }),
        }),
      /containment probe returned invalid evidence/
    );
    assert.throws(
      () =>
        resolveOmpSdkRuntime({
          ...exactRuntimeOptions,
          readContainmentProbe: () => '{malformed',
        }),
      /Unable to attest Linux subreaper\/pidfd containment/
    );
  });
});
