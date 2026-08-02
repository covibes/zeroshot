#!/usr/bin/env node
/**
 * Fake `omp --mode rpc` executable for deterministic RPC-driver tests, same convention as
 * tests/e2e/fixtures/fake-copilot.js. Writes the real startup frames (`ready` then
 * `available_commands_update`), handles `negotiate_protocol`/`get_state`/`prompt`/`abort`, and
 * exits 0 when stdin closes, per the real RPC mode's documented shutdown behavior.
 *
 * OMP_FAKE_RPC_SCENARIO=<name> selects behavior after negotiate_protocol succeeds:
 *   - unset/'happy': get_state → prompt ack(agentInvoked:true) → message/tool/turn_end →
 *     agent_end, then exit 0 on stdin close.
 *   - 'local-only': prompt ack has data.agentInvoked:false (no agent turn).
 *   - 'no-v2': ready frame only advertises protocol v1.
 *   - 'over-limits': ready frame advertises maxFrameBytes above the pinned decoder cap.
 *   - 'extension-ui:<method>': after prompt ack, emits one extension_ui_request for <method>,
 *     then agent_end once it receives any extension_ui_response.
 *   - 'host-tool': after prompt ack, emits host_tool_call and agent_end once host_tool_result
 *     arrives.
 *   - 'host-uri': after prompt ack, emits host_uri_request and agent_end once host_uri_result
 *     arrives.
 *   - 'extension-error': after prompt ack, emits an extension_error frame.
 *   - 'early-exit': exits immediately after the negotiate_protocol response, before any prompt.
 *   - 'malformed-frame': after prompt ack, writes a line that is not valid JSON.
 *   - 'pre-negotiation-chunk': writes a bare rpc_chunk frame before negotiate_protocol succeeds.
 *   - 'crash': after prompt ack, writes to stderr and exits with a non-zero code.
 *   - 'ignore-abort': never exits on its own; used to prove the driver's SIGTERM/SIGKILL
 *     escalation actually terminates a stuck process.
 *   - 'pending-flood': after prompt ack, emits OMP_FAKE_RPC_PENDING_COUNT extension_ui_request
 *     frames in a single stdout write (one chunk), each with a unique id; emits agent_end once
 *     it has received that many extension_ui_response replies (never reached when the count
 *     exceeds the driver's pending-frame-queue bound, since the driver fails first).
 *   - 'lifetime-id-flood': after prompt ack, ping-pongs OMP_FAKE_RPC_LIFETIME_COUNT distinct
 *     extension_ui_request/extension_ui_response round trips one at a time, then agent_end.
 *   - 'output-cap': after prompt ack, emits message_update text_delta frames whose combined
 *     byte length is exactly OMP_FAKE_RPC_OUTPUT_BYTES, then completes normally.
 *   - 'stderr-flood': after prompt ack, writes OMP_FAKE_RPC_STDERR_PREFIX_BYTES filler bytes to
 *     stderr followed by the literal contents of OMP_FAKE_RPC_STDERR_KEPT, then crashes.
 *   - '<name>': any other value streams tests/fixtures/omp-rpc/<name>.jsonl verbatim after the
 *     negotiate_protocol response (legacy decoder-fixture replay mode).
 *
 * OMP_FAKE_RPC_INJECT_SENTINELS=1 additionally injects tests/helpers/omp-rpc-sentinels.js's
 * SENTINEL_SYSTEM/SENTINEL_CONTROL/SENTINEL_MESSAGE into raw protocol fields the normalizer never
 * reads (the ready frame, the negotiate_protocol response, and message_start/message_end's
 * message object) so tests can prove those payloads never leak into normalized output.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { SENTINEL_SYSTEM, SENTINEL_MESSAGE, SENTINEL_CONTROL } = require('./omp-rpc-sentinels');

const injectSentinels = process.env.OMP_FAKE_RPC_INJECT_SENTINELS === '1';

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function streamScenario(scenario) {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'omp-rpc', `${scenario}.jsonl`);
  process.stdout.write(fs.readFileSync(fixturePath, 'utf8'));
}

const KNOWN_SCENARIOS = new Set([
  'happy',
  'local-only',
  'no-v2',
  'over-limits',
  'extension-error',
  'early-exit',
  'malformed-frame',
  'pre-negotiation-chunk',
  'crash',
  'ignore-abort',
  'extension-ui',
  'host-tool',
  'host-uri',
  'pending-flood',
  'lifetime-id-flood',
  'output-cap',
  'stderr-flood',
]);

function emitReady(scenario) {
  emit({
    type: 'ready',
    protocolVersion: 1,
    supportedProtocolVersions: scenario === 'no-v2' ? [1] : [1, 2],
    maxFrameBytes: scenario === 'over-limits' ? 1048576 * 4 : 1048576,
    maxReassembledFrameBytes: 67108864,
    ...(injectSentinels ? { hostContext: SENTINEL_SYSTEM } : {}),
  });
  emit({ type: 'available_commands_update', commands: [] });
}

function emitAgentTurn() {
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({
    type: 'message_start',
    message: {
      role: 'assistant',
      content: [],
      ...(injectSentinels ? { internalNote: SENTINEL_MESSAGE } : {}),
    },
  });
  emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'hello ' },
  });
  emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'world' },
  });
  emit({
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'read',
    args: { path: 'x.txt' },
  });
  emit({ type: 'tool_execution_end', toolCallId: 'tool-1', result: 'contents', isError: false });
  emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello world' }],
      ...(injectSentinels ? { internalNote: SENTINEL_MESSAGE } : {}),
    },
  });
  emit({
    type: 'turn_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello world' }],
      stopReason: 'stop',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
    },
  });
  emit({ type: 'agent_end', messages: [] });
}

function main() {
  const scenarioRaw = process.env.OMP_FAKE_RPC_SCENARIO || 'happy';
  const [scenario, scenarioArg] = scenarioRaw.split(':');
  emitReady(scenario);

  let negotiated = false;
  let promptAcked = false;
  let uiRequestSent = false;
  let hostToolSent = false;
  let hostUriSent = false;
  let pendingFloodTarget = 0;
  let pendingFloodReceived = 0;
  let lifetimeFloodTarget = 0;
  let lifetimeFloodSent = 0;

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      return;
    }
    if (!command || typeof command !== 'object') return;

    if (command.type === 'negotiate_protocol') {
      if (scenario === 'pre-negotiation-chunk') {
        process.stdout.write(
          `${JSON.stringify({ type: 'rpc_chunk', chunkId: 'x', index: 0, count: 2, byteLength: 4, data: 'AAAA' })}\n`
        );
        return;
      }
      emit({
        id: command.id,
        type: 'response',
        command: 'negotiate_protocol',
        success: true,
        ...(injectSentinels ? { debugControl: SENTINEL_CONTROL } : {}),
      });
      negotiated = true;
      if (scenario === 'early-exit') {
        process.stdin.pause();
        process.exit(0);
      }
      if (!KNOWN_SCENARIOS.has(scenario) && scenario !== 'happy' && scenario !== 'local-only') {
        streamScenario(scenario);
      }
      return;
    }

    if (command.type === 'get_state') {
      emit({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: { provider: 'anthropic', id: '@default' },
          thinkingLevel: 'medium',
        },
      });
      return;
    }

    if (command.type === 'prompt') {
      if (scenario === 'local-only') {
        emit({
          id: command.id,
          type: 'response',
          command: 'prompt',
          success: true,
          data: { agentInvoked: false },
        });
        return;
      }
      emit({
        id: command.id,
        type: 'response',
        command: 'prompt',
        success: true,
        data: { agentInvoked: true },
      });
      promptAcked = true;

      if (scenario === 'extension-error') {
        emit({ type: 'extension_error', extensionPath: 'x', event: 'y', error: 'boom' });
        return;
      }
      if (scenario === 'malformed-frame') {
        process.stdout.write('not json\n');
        return;
      }
      if (scenario === 'crash') {
        process.stderr.write('fake omp crashed mid-turn\n');
        process.exitCode = 1;
        process.exit(1);
      }
      if (scenario === 'extension-ui') {
        uiRequestSent = true;
        emit({
          type: 'extension_ui_request',
          id: 'ui-1',
          method: scenarioArg || 'confirm',
          title: 'Confirm',
          message: 'Continue?',
          timeout: 30000,
        });
        return;
      }
      if (scenario === 'host-tool') {
        hostToolSent = true;
        emit({
          type: 'host_tool_call',
          id: 'host-1',
          toolCallId: 'toolu-1',
          toolName: 'echo_host',
          arguments: { message: 'hello' },
        });
        return;
      }
      if (scenario === 'host-uri') {
        hostUriSent = true;
        emit({ type: 'host_uri_request', id: 'uri-1', operation: 'read', url: 'db://x' });
        return;
      }
      if (scenario === 'pending-flood') {
        pendingFloodTarget = Number(process.env.OMP_FAKE_RPC_PENDING_COUNT || 0);
        const lines = [];
        for (let i = 0; i < pendingFloodTarget; i += 1) {
          lines.push(
            JSON.stringify({
              type: 'extension_ui_request',
              id: `pf-${i}`,
              method: 'confirm',
              title: 'Confirm',
              message: 'Continue?',
              timeout: 30000,
            })
          );
        }
        process.stdout.write(`${lines.join('\n')}\n`);
        return;
      }
      if (scenario === 'lifetime-id-flood') {
        lifetimeFloodTarget = Number(process.env.OMP_FAKE_RPC_LIFETIME_COUNT || 0);
        emit({
          type: 'extension_ui_request',
          id: `lf-${lifetimeFloodSent}`,
          method: 'confirm',
          title: 'Confirm',
          message: 'Continue?',
          timeout: 30000,
        });
        lifetimeFloodSent += 1;
        return;
      }
      if (scenario === 'output-cap') {
        const targetBytes = Number(process.env.OMP_FAKE_RPC_OUTPUT_BYTES || 0);
        const CHUNK = 65536;
        emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
        let remaining = targetBytes;
        while (remaining > 0) {
          const size = Math.min(CHUNK, remaining);
          emit({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'A'.repeat(size) },
          });
          remaining -= size;
        }
        // Reset the normalizer's accumulated-text snapshot with a fresh message_start before
        // turn_end: otherwise turn_end's own result-field charge would re-count the entire
        // accumulated text a second time (normalizeTurnEnd falls back to the last known
        // assistant text when the turn_end frame's own message content is empty), throwing off
        // callers that need the byte total to land on an exact value.
        emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
        emit({
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            stopReason: 'stop',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          },
        });
        emit({ type: 'agent_end', messages: [] });
        return;
      }
      if (scenario === 'stderr-flood') {
        const prefixBytes = Number(process.env.OMP_FAKE_RPC_STDERR_PREFIX_BYTES || 0);
        const kept = process.env.OMP_FAKE_RPC_STDERR_KEPT || '';
        if (prefixBytes > 0) process.stderr.write('X'.repeat(prefixBytes));
        process.stderr.write(kept);
        process.exitCode = 1;
        process.exit(1);
      }
      if (scenario === 'ignore-abort') {
        // Deliberately never reaches a terminal frame and ignores `abort`, so the driver must
        // fall back to its SIGTERM/SIGKILL escalation to end the task.
        return;
      }
      emitAgentTurn();
      return;
    }

    if (command.type === 'abort') {
      if (scenario === 'ignore-abort') return; // Deliberately unresponsive.
      if (negotiated && promptAcked) emit({ type: 'agent_end', messages: [] });
      return;
    }

    if (command.type === 'extension_ui_response' && scenario === 'pending-flood') {
      pendingFloodReceived += 1;
      if (pendingFloodReceived >= pendingFloodTarget) emit({ type: 'agent_end', messages: [] });
      return;
    }
    if (command.type === 'extension_ui_response' && scenario === 'lifetime-id-flood') {
      if (lifetimeFloodSent >= lifetimeFloodTarget) {
        emit({ type: 'agent_end', messages: [] });
        return;
      }
      emit({
        type: 'extension_ui_request',
        id: `lf-${lifetimeFloodSent}`,
        method: 'confirm',
        title: 'Confirm',
        message: 'Continue?',
        timeout: 30000,
      });
      lifetimeFloodSent += 1;
      return;
    }
    if (command.type === 'extension_ui_response' && uiRequestSent) {
      emit({ type: 'agent_end', messages: [] });
      return;
    }
    if (command.type === 'host_tool_result' && hostToolSent) {
      emit({ type: 'agent_end', messages: [] });
      return;
    }
    if (command.type === 'host_uri_result' && hostUriSent) {
      emit({ type: 'agent_end', messages: [] });
    }
  });
  rl.on('close', () => {
    if (scenario === 'ignore-abort') return; // Never exits on its own; the test SIGKILLs it.
    process.exit(0);
  });
}

main();
