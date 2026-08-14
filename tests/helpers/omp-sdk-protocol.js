function ompSdkErrorFrame(error = {}) {
  return {
    protocolVersion: 1,
    type: 'error',
    runId: 'omp-run-1',
    backend: { id: 'omp-sdk', version: '17.2.1' },
    runtime: { name: 'bun', version: '1.3.14' },
    error: {
      code: 'provider-auth',
      category: 'auth',
      retryable: false,
      redacted: true,
      ...error,
    },
  };
}

module.exports = { ompSdkErrorFrame };
