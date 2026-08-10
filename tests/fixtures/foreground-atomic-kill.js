#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const [resultPath, markerPath, phase] = process.argv.slice(2);
const originalLink = fs.linkSync;
let links = 0;
fs.linkSync = (source, target) => {
  links += 1;
  if (links !== 2) return originalLink(source, target);
  if (phase === 'after') originalLink(source, target);
  fs.writeFileSync(markerPath, `${phase}\n`, { flag: 'wx', mode: 0o600 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const { writeBenchmarkResultBundle } = require('../../src/foreground-benchmark-files');
writeBenchmarkResultBundle(
  resultPath,
  {
    schema: 'zeroshot-benchmark-result/v1',
    runId: 'atomic-kill-test',
    outcome: 'completed',
    terminalOwner: 'task',
    code: 'ok',
    kind: 'workflow_complete',
    retryable: false,
    diagnostic: {
      byteLength: 0,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    provider: null,
    event: null,
    category: null,
  },
  {
    messageCount: 0,
    tokensByRole: {
      _total: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalCostUsd: 0,
        count: 0,
      },
    },
  }
);
