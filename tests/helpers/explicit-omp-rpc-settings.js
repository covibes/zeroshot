'use strict';

const fs = require('fs');
const path = require('path');

// Advertises exactly the evidence assertRequiredOmpFeatures() demands, so tests reach the
// rpc-stdio lane without requiring a real OMP installation.
const FAKE_OMP_WITH_RPC = `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('omp 17.2.1\\n');
  process.exit(0);
}
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: omp [options]\\n  Modes: rpc\\n  --config --model --thinking --approval-mode --no-title --no-session --session-dir --resume\\n');
  process.exit(0);
}
process.exit(0);
`;

/**
 * Write an explicit RPC transport selection under a caller-owned home directory.
 *
 * The caller owns both the returned environment overlay and cleanup of `home`; this helper never
 * mutates process.env or removes the caller's other home, bin, or harness fixtures.
 */
function createExplicitOmpRpcSettings(home) {
  const settingsFile = path.join(home, '.zeroshot', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ providerSettings: { omp: { transport: 'rpc' } } }),
    { mode: 0o600 }
  );
  return {
    settingsFile,
    env: { ZEROSHOT_SETTINGS_FILE: settingsFile },
  };
}

module.exports = { createExplicitOmpRpcSettings, FAKE_OMP_WITH_RPC };
