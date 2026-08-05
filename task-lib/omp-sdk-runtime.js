import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export const { resolveOmpTransport } = require('../lib/agent-cli-provider/single-agent-runtime.js');
export const {
  spawnOmpSdkProcess,
} = require('../lib/agent-cli-provider/omp/sdk-process-runner.js');
