#!/usr/bin/env node
/**
 * Fake `omp --mode rpc` executable for deterministic RPC-codec tests, same convention as
 * tests/e2e/fixtures/fake-copilot.js. Writes the real startup frames (`ready` then
 * `available_commands_update`), then on a `negotiate_protocol` command echoes a success
 * response using the request's own `id` (matching real request/response correlation).
 *
 * OMP_FAKE_RPC_SCENARIO=<name> streams tests/fixtures/omp-rpc/<name>.jsonl verbatim,
 * once, immediately after the negotiate_protocol response. Reusable by a future RPC
 * runner subissue; this issue's own tests only need the bare negotiate handshake.
 *
 * Exits 0 when stdin closes, per the real RPC mode's documented shutdown behavior.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function streamScenario(scenario) {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'omp-rpc', `${scenario}.jsonl`);
  process.stdout.write(fs.readFileSync(fixturePath, 'utf8'));
}

function main() {
  emit({
    type: 'ready',
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: 1048576,
    maxReassembledFrameBytes: 67108864,
  });
  emit({ type: 'available_commands_update', commands: [] });

  const scenario = process.env.OMP_FAKE_RPC_SCENARIO;
  let scenarioStreamed = false;

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      return;
    }
    if (command && typeof command === 'object' && command.type === 'negotiate_protocol') {
      emit({ id: command.id, type: 'response', command: 'negotiate_protocol', success: true });
      if (scenario && !scenarioStreamed) {
        scenarioStreamed = true;
        streamScenario(scenario);
      }
    }
  });
  rl.on('close', () => {
    process.exit(0);
  });
}

main();
