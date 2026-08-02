import { spawn } from 'node:child_process';
import { omitProcessControlEnv, omitUnsafeProviderEnv } from './env-safety';
import {
  DEFAULT_OMP_RPC_DECODER_LIMITS,
  OmpRpcFrameDecoder,
  OmpRpcProtocolError,
  assertNoPreNegotiationRpcChunk,
  encodeOmpRpcCommand,
  type OmpRpcCommand,
  type OmpRpcInboundFrame,
} from './omp-rpc-protocol';
import { createOmpRpcEventState, normalizeOmpRpcFrame } from './omp-rpc-events';
import {
  MAX_LIFETIME_REQUEST_IDS,
  MAX_PENDING_REQUESTS,
  MAX_STDERR_TAIL_BYTES,
} from './omp-rpc-bounds';
import { getArray, getBoolean, getNumber, getOptionalString, getRecord, getString } from './json';
import type { OmpSessionLaunch } from './omp-rpc-session';
import type { CommandSpec, OutputEvent } from './types';

export interface OmpRpcSpawnEvidence {
  readonly pid: number;
  readonly processGroupId: number | null;
  readonly terminationStrategy: 'process-group' | 'process-tree';
}

export interface OmpRpcSessionEvidence {
  readonly phase: 'ready' | 'terminal';
  readonly sessionId: string | null;
  readonly sessionFile: string | null;
  readonly selectedProvider: string;
  readonly selectedModel: string;
  readonly thinkingLevel: string;
}

export interface OmpRpcTaskRequest {
  readonly commandSpec: CommandSpec;
  readonly prompt: string;
  readonly expectedVersion: string;
  readonly session: OmpSessionLaunch;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly abortGraceMs: number;
  readonly exitGraceMs: number;
}

export interface OmpRpcTaskHooks {
  readonly onSpawn: (evidence: OmpRpcSpawnEvidence) => Promise<void>;
  readonly onEvent: (event: OutputEvent) => Promise<void>;
  readonly onSession: (evidence: OmpRpcSessionEvidence) => Promise<void>;
}

export interface OmpRpcTaskResult {
  readonly events: readonly OutputEvent[];
  readonly text: string;
  readonly session: OmpRpcSessionEvidence;
  readonly stopReason: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

const UNKNOWN_SESSION_EVIDENCE: Omit<OmpRpcSessionEvidence, 'phase'> = {
  sessionId: null,
  sessionFile: null,
  selectedProvider: '',
  selectedModel: '',
  thinkingLevel: '',
};

type UiResponder = (id: string) => OmpRpcCommand;

// extension_ui_request method table (docs/rpc.md "Extension UI Sub-Protocol"). Zeroshot has no
// interactive host surface, so every method resolves to a cancelled/no-op response instead of
// blocking the child indefinitely.
const UI_RESPONDERS: Readonly<Record<string, UiResponder>> = {
  confirm: (id) => ({ type: 'extension_ui_response', id, confirmed: false, cancelled: true }),
  select: (id) => ({ type: 'extension_ui_response', id, cancelled: true }),
  input: (id) => ({ type: 'extension_ui_response', id, cancelled: true }),
  editor: (id) => ({ type: 'extension_ui_response', id, cancelled: true }),
  open_url: (id) => ({ type: 'extension_ui_response', id, cancelled: true }),
  notify: (id) => ({ type: 'extension_ui_response', id, cancelled: false }),
  setStatus: (id) => ({ type: 'extension_ui_response', id, cancelled: false }),
  setWidget: (id) => ({ type: 'extension_ui_response', id, cancelled: false }),
  setTitle: (id) => ({ type: 'extension_ui_response', id, cancelled: false }),
  set_editor_text: (id) => ({ type: 'extension_ui_response', id, cancelled: false }),
  cancel: (id) => ({ type: 'extension_ui_response', id, cancelled: false }),
};

class OmpRpcTaskFailure extends Error {
  readonly stopReason: string;

  constructor(stopReason: string, message: string) {
    super(message);
    this.name = 'OmpRpcTaskFailure';
    this.stopReason = stopReason;
  }
}

interface PendingCommand {
  readonly resolve: (frame: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

interface DriverState {
  readonly decoder: OmpRpcFrameDecoder;
  readonly eventState: ReturnType<typeof createOmpRpcEventState>;
  readonly pending: Map<string, PendingCommand>;
  readonly lifetimeRequestIds: Set<string>;
  queuedFrames: number;
  readonly events: OutputEvent[];
  readonly textParts: string[];
  stderrTail: string;
  negotiatedV2: boolean;
  readyReceived: boolean;
  promptSent: boolean;
  terminal: boolean;
  settled: boolean;
  abortStopReason: string | null;
  pendingStopReason: string | null;
  terminationStarted: boolean;
  sessionEvidence: Omit<OmpRpcSessionEvidence, 'phase'>;
  processExit: { exitCode: number | null; signal: string | null } | null;
  chain: Promise<void>;
}

function createDriverState(): DriverState {
  return {
    decoder: new OmpRpcFrameDecoder(DEFAULT_OMP_RPC_DECODER_LIMITS),
    eventState: createOmpRpcEventState(),
    pending: new Map(),
    lifetimeRequestIds: new Set(),
    queuedFrames: 0,
    events: [],
    textParts: [],
    stderrTail: '',
    negotiatedV2: false,
    readyReceived: false,
    promptSent: false,
    terminal: false,
    settled: false,
    abortStopReason: null,
    pendingStopReason: null,
    terminationStarted: false,
    sessionEvidence: UNKNOWN_SESSION_EVIDENCE,
    processExit: null,
    chain: Promise.resolve(),
  };
}

// eslint-disable-next-line max-lines-per-function
export function runOmpRpcTask(
  request: OmpRpcTaskRequest,
  hooks: OmpRpcTaskHooks
): Promise<OmpRpcTaskResult> {
  return new Promise<OmpRpcTaskResult>((resolvePromise, rejectPromise) => {
    const { commandSpec } = request;
    const state = createDriverState();
    const child = spawn(commandSpec.binary, [...commandSpec.args], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(commandSpec.cwd === undefined ? {} : { cwd: commandSpec.cwd }),
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...omitProcessControlEnv(process.env), ...omitUnsafeProviderEnv(commandSpec.env) },
    });

    // Gated on the 'spawn' event (fires only once the OS has actually created the process and
    // assigned a real pid), not called synchronously right after spawn(): when the binary is
    // missing, `child.pid` is still undefined at this point and the eventual 'error' event is
    // what surfaces the failure. Synthesizing spawn evidence for a pid that was never real (e.g.
    // a placeholder) would let ownership-based termination signal an unrelated, potentially
    // privileged PID once that placeholder is treated as an owned process/group id. No stdin
    // write happens before this resolves (negotiateAndPrompt awaits it), so spawn evidence stays
    // durable before the prompt is written, and is simply never reported when spawn never
    // succeeds.
    const spawnHookPromise: Promise<void> = new Promise<void>((resolveSpawnHook) => {
      child.once('spawn', () => {
        const pid = child.pid;
        // Node guarantees a defined pid once 'spawn' fires; this is a defensive narrowing only.
        if (pid === undefined) {
          failPermanently('spawn-hook-failed', 'Process spawned without a pid.');
          resolveSpawnHook();
          return;
        }
        hooks
          .onSpawn({
            pid,
            processGroupId: process.platform === 'win32' ? null : pid,
            terminationStrategy: process.platform === 'win32' ? 'process-tree' : 'process-group',
          })
          .then(resolveSpawnHook, (error: unknown) => {
            failPermanently(
              'spawn-hook-failed',
              error instanceof Error ? error.message : String(error)
            );
            resolveSpawnHook();
          });
      });
    });

    let abortTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    function clearTimers(): void {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    }

    function deriveStopReason(): string {
      const lastResult = [...state.events].reverse().find((event) => event.type === 'result');
      if (lastResult && lastResult.type === 'result' && lastResult.success === false) {
        return 'turn-failed';
      }
      return 'completed';
    }

    function finish(stopReason: string): void {
      if (state.settled) return;
      state.settled = true;
      clearTimers();
      resolvePromise({
        events: state.events,
        text: state.textParts.join(''),
        session: { ...state.sessionEvidence, phase: 'terminal' },
        stopReason,
        exitCode: state.processExit?.exitCode ?? null,
        signal: state.processExit?.signal ?? null,
      });
    }

    function pushEvent(event: OutputEvent): void {
      state.events.push(event);
      if (event.type === 'text') state.textParts.push(event.text);
      void hooks.onEvent(event).catch(() => {});
    }

    // A child that exits *on a signal* leaves child.exitCode null and reports the signal name in
    // child.signalCode instead, so exitCode alone is not a terminal check. Both must be consulted
    // before any kill(): once the child has been reaped its pid — and therefore the negative pid
    // captured here as a process-group id — can be reused by an unrelated process group, and
    // signalling that group would terminate a process this driver never owned.
    function hasExited(): boolean {
      return child.exitCode !== null || child.signalCode !== null;
    }

    function terminateOwnedBoundary(): void {
      if (state.terminationStarted || child.pid === undefined || hasExited()) return;
      state.terminationStarted = true;
      const pid = child.pid;
      try {
        if (process.platform === 'win32') child.kill('SIGTERM');
        else process.kill(-pid, 'SIGTERM');
      } catch {
        // Process may already be gone.
      }
      setTimeout(() => {
        if (hasExited()) return;
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-pid, 'SIGKILL');
        } catch {
          // Process may already be gone.
        }
      }, request.exitGraceMs);
    }

    function failPermanently(stopReason: string, message: string): void {
      if (state.terminal) return;
      state.terminal = true;
      state.pendingStopReason = stopReason;
      pushEvent({ type: 'result', success: false, result: null, error: `${stopReason}: ${message}` });
      terminateOwnedBoundary();
    }

    function registerLifetimeId(id: string): boolean {
      if (state.lifetimeRequestIds.has(id)) return true;
      if (state.lifetimeRequestIds.size >= MAX_LIFETIME_REQUEST_IDS) return false;
      state.lifetimeRequestIds.add(id);
      return true;
    }

    function writeFrame(frame: OmpRpcCommand): void {
      if (child.stdin.destroyed) return;
      try {
        child.stdin.write(
          encodeOmpRpcCommand(frame, DEFAULT_OMP_RPC_DECODER_LIMITS.maxPhysicalFrameBytes)
        );
      } catch {
        // Stdin already closed; the close handler settles the task.
      }
    }

    function sendCommand(command: OmpRpcCommand): Promise<Record<string, unknown>> {
      const id = command.id ?? '';
      if (!registerLifetimeId(id)) {
        return Promise.reject(
          new OmpRpcTaskFailure('lifetime-request-id-exceeded', `command id "${id}" exceeds the lifetime request-id bound.`)
        );
      }
      if (state.pending.size >= MAX_PENDING_REQUESTS) {
        return Promise.reject(
          new OmpRpcTaskFailure('pending-request-exceeded', 'too many concurrent outbound RPC commands are awaiting a response.')
        );
      }
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        state.pending.set(id, { resolve, reject });
        writeFrame(command);
      });
    }

    function assertSuccessfulResponse(response: Record<string, unknown>, command: string, id: string): void {
      if (getString(response, 'command') !== command || getString(response, 'id') !== id) {
        throw new OmpRpcTaskFailure('malformed-response', `Expected a ${command} response with id "${id}".`);
      }
      if (getBoolean(response, 'success') !== true) {
        throw new OmpRpcTaskFailure('unsafe-config', getString(response, 'error') ?? `${command} was rejected.`);
      }
    }

    function handleResponse(frame: OmpRpcInboundFrame): void {
      const id = getOptionalString(frame, 'id');
      if (!id) return;
      const command = state.pending.get(id);
      if (command === undefined) return;
      state.pending.delete(id);
      command.resolve(frame);
    }

    function handleExtensionUiRequest(frame: OmpRpcInboundFrame): void {
      const id = getString(frame, 'id');
      const method = getString(frame, 'method');
      if (id === null || method === null) {
        throw new OmpRpcTaskFailure('malformed-extension-ui-request', 'extension_ui_request is missing id/method.');
      }
      if (!registerLifetimeId(id)) {
        throw new OmpRpcTaskFailure(
          'lifetime-request-id-exceeded',
          `extension_ui_request id "${id}" exceeds the lifetime request-id bound.`
        );
      }
      const responder = UI_RESPONDERS[method];
      if (responder === undefined) {
        throw new OmpRpcTaskFailure('unsupported-ui-method', `extension_ui_request used unsupported method "${method}".`);
      }
      writeFrame(responder(id));
    }

    function handleHostToolCall(frame: OmpRpcInboundFrame): void {
      const id = getString(frame, 'id');
      if (id === null) throw new OmpRpcTaskFailure('malformed-host-tool-call', 'host_tool_call is missing id.');
      if (!registerLifetimeId(id)) {
        throw new OmpRpcTaskFailure(
          'lifetime-request-id-exceeded',
          `host_tool_call id "${id}" exceeds the lifetime request-id bound.`
        );
      }
      writeFrame({
        type: 'host_tool_result',
        id,
        isError: true,
        result: { content: [{ type: 'text', text: 'Zeroshot declares no host tools' }] },
      });
    }

    function handleHostUriRequest(frame: OmpRpcInboundFrame): void {
      const id = getString(frame, 'id');
      if (id === null) throw new OmpRpcTaskFailure('malformed-host-uri-request', 'host_uri_request is missing id.');
      if (!registerLifetimeId(id)) {
        throw new OmpRpcTaskFailure(
          'lifetime-request-id-exceeded',
          `host_uri_request id "${id}" exceeds the lifetime request-id bound.`
        );
      }
      writeFrame({ type: 'host_uri_result', id, isError: true, error: 'Zeroshot declares no host URI schemes' });
    }

    function handlePromptResultFrame(frame: OmpRpcInboundFrame): void {
      if (getString(frame, 'id') !== 'zs-2') return;
      const agentInvoked = getBoolean(frame, 'agentInvoked') ?? false;
      if (agentInvoked) return; // agent_end is authoritative for the invoked path.
      // Do not set state.terminal here: the enqueue() .catch() handler calls failPermanently(),
      // which owns that transition and no-ops if it's already true (see negotiateAndPrompt()).
      throw new OmpRpcTaskFailure(
        'local-only-prompt',
        'OMP resolved the prompt without invoking the agent (no agent turn).'
      );
    }

    function handleAgentEnd(): void {
      if (state.terminal) return;
      state.terminal = true;
      state.pendingStopReason = deriveStopReason();
      // Graceful shutdown: close stdin so OMP exits on its own (docs/rpc.md: "When stdin closes
      // ... the process exits with code 0"). Only escalate to SIGTERM/SIGKILL if that stalls.
      child.stdin?.end();
      setTimeout(() => terminateOwnedBoundary(), request.exitGraceMs);
    }

    function emitNormalized(frame: OmpRpcInboundFrame): void {
      for (const event of normalizeOmpRpcFrame(frame, state.eventState)) pushEvent(event);
    }

    function dispatchReadyFrame(frame: OmpRpcInboundFrame): void {
      state.readyReceived = true;
      if (frame.type !== 'ready') {
        throw new OmpRpcTaskFailure('unsupported-protocol', `Expected an initial ready frame, got "${frame.type}".`);
      }
      const supportedVersions = getArray(frame, 'supportedProtocolVersions');
      if (!supportedVersions.includes(2)) {
        throw new OmpRpcTaskFailure(
          'unsupported-protocol',
          `OMP ready frame did not advertise protocol v2 (supportedProtocolVersions=${JSON.stringify(supportedVersions)}).`
        );
      }
      const maxFrameBytes = getNumber(frame, 'maxFrameBytes');
      const maxReassembledFrameBytes = getNumber(frame, 'maxReassembledFrameBytes');
      if (
        maxFrameBytes === null ||
        maxFrameBytes > DEFAULT_OMP_RPC_DECODER_LIMITS.maxPhysicalFrameBytes ||
        maxReassembledFrameBytes === null ||
        maxReassembledFrameBytes > DEFAULT_OMP_RPC_DECODER_LIMITS.maxReassembledFrameBytes
      ) {
        throw new OmpRpcTaskFailure(
          'unsupported-limits',
          `OMP ready frame advertised limits above the pinned decoder caps (maxFrameBytes=${String(maxFrameBytes)}, maxReassembledFrameBytes=${String(maxReassembledFrameBytes)}).`
        );
      }
      negotiateAndPrompt().catch((error: unknown) => {
        if (error instanceof OmpRpcProtocolError) failPermanently(error.code, error.message);
        else if (error instanceof OmpRpcTaskFailure) failPermanently(error.stopReason, error.message);
        else failPermanently('driver-error', error instanceof Error ? error.message : String(error));
      });
    }

    async function negotiateAndPrompt(): Promise<void> {
      // Every stdin write is ordered after onSpawn resolves (spawn evidence must be durable
      // before the prompt is written, so a detached watcher crash after spawn is still owned).
      await spawnHookPromise;
      if (state.settled) return;
      const negotiateResponse = await sendCommand({ id: 'zs-1', type: 'negotiate_protocol', protocolVersion: 2 });
      assertSuccessfulResponse(negotiateResponse, 'negotiate_protocol', 'zs-1');
      state.negotiatedV2 = true;

      const stateResponse = await sendCommand({ id: 'zs-state', type: 'get_state' }).catch(() => null);
      state.sessionEvidence = sessionEvidenceFromState(stateResponse);
      await hooks.onSession({ ...state.sessionEvidence, phase: 'ready' });

      state.promptSent = true;
      const ack = await sendCommand({ id: 'zs-2', type: 'prompt', message: request.prompt });
      assertSuccessfulResponse(ack, 'prompt', 'zs-2');
      const data = getRecord(ack, 'data');
      const agentInvoked = data ? getBoolean(data, 'agentInvoked') : null;
      if (agentInvoked === false) {
        // Do not set state.terminal here: failPermanently() (invoked by this function's
        // .catch() handler) owns that transition and no-ops if it's already true, which would
        // skip pushEvent/terminateOwnedBoundary and hang the task forever.
        throw new OmpRpcTaskFailure(
          'local-only-prompt',
          'OMP resolved the prompt without invoking the agent (no agent turn).'
        );
      }
      // agentInvoked true or omitted: completion is driven entirely by later frame dispatch
      // (agent_end / a delayed prompt_result), not by this function returning.
    }

    function sessionEvidenceFromState(
      stateResponse: Record<string, unknown> | null
    ): Omit<OmpRpcSessionEvidence, 'phase'> {
      if (stateResponse === null || getBoolean(stateResponse, 'success') !== true) return UNKNOWN_SESSION_EVIDENCE;
      const data = getRecord(stateResponse, 'data');
      const model = data ? getRecord(data, 'model') : null;
      return {
        sessionId: null,
        sessionFile: null,
        selectedProvider: (model ? getString(model, 'provider') : null) ?? '',
        selectedModel: (model ? getString(model, 'id') : null) ?? '',
        thinkingLevel: (data ? getString(data, 'thinkingLevel') : null) ?? '',
      };
    }

    function dispatchFrame(frame: OmpRpcInboundFrame): void {
      if (state.terminal) return; // Frames after the terminal frame are dropped.
      if (!state.readyReceived) {
        dispatchReadyFrame(frame);
        return;
      }
      assertNoPreNegotiationRpcChunk(frame.type, state.negotiatedV2);
      switch (frame.type) {
        case 'response':
          handleResponse(frame);
          return;
        case 'extension_ui_request':
          handleExtensionUiRequest(frame);
          return;
        case 'host_tool_call':
          handleHostToolCall(frame);
          return;
        case 'host_uri_request':
          handleHostUriRequest(frame);
          return;
        case 'host_tool_cancel':
        case 'host_uri_cancel':
          return; // No long-running host operation is ever started, so nothing to cancel.
        case 'extension_error':
          throw new OmpRpcTaskFailure(
            'extension-error',
            getString(frame, 'error') ?? 'OMP extension runner reported an error.'
          );
        case 'prompt_result':
          handlePromptResultFrame(frame);
          return;
        case 'agent_end':
          handleAgentEnd();
          return;
        default:
          if (state.promptSent) emitNormalized(frame);
      }
    }

    function enqueue(frame: OmpRpcInboundFrame): void {
      // Bounded before anything is queued: a single stdout chunk can decode to an
      // attacker-controlled number of frames (each individually within the decoder's per-frame
      // caps), and dispatch is asynchronous (chained via state.chain), so without this check a
      // burst could queue unbounded work before any of it is actually processed.
      if (state.queuedFrames >= MAX_PENDING_REQUESTS) {
        failPermanently(
          'pending-request-exceeded',
          `More than ${MAX_PENDING_REQUESTS} RPC frames are queued awaiting dispatch.`
        );
        return;
      }
      state.queuedFrames += 1;
      state.chain = state.chain
        .then(() => dispatchFrame(frame))
        .catch((error: unknown) => {
          if (error instanceof OmpRpcProtocolError) failPermanently(error.code, error.message);
          else if (error instanceof OmpRpcTaskFailure) failPermanently(error.stopReason, error.message);
          else failPermanently('driver-error', error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          state.queuedFrames -= 1;
        });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      let frames: readonly OmpRpcInboundFrame[];
      try {
        frames = state.decoder.push(chunk, state.negotiatedV2);
      } catch (error) {
        if (error instanceof OmpRpcProtocolError) failPermanently(error.code, error.message);
        else failPermanently('decoder-error', error instanceof Error ? error.message : String(error));
        return;
      }
      for (const frame of frames) enqueue(frame);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      state.stderrTail = (state.stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_TAIL_BYTES);
    });

    child.once('error', (error) => {
      if (state.settled) return;
      state.settled = true;
      clearTimers();
      rejectPromise(error);
    });

    child.once('close', (exitCode, signal) => {
      state.processExit = { exitCode, signal: signal ?? null };
      for (const command of state.pending.values()) {
        command.reject(new OmpRpcTaskFailure('process-closed', 'child process ended before a response arrived.'));
      }
      state.pending.clear();
      if (state.terminal) {
        // Outcome already decided (agent_end / a permanent failure); the process has now actually
        // exited, so resolve with the real exitCode/signal.
        finish(state.pendingStopReason ?? deriveStopReason());
        return;
      }
      state.terminal = true;
      let detail: string;
      try {
        state.decoder.finish();
        detail = `OMP process exited (code=${exitCode ?? 'null'}, signal=${signal ?? 'null'}) before a terminal RPC frame arrived.`;
      } catch (error) {
        detail = error instanceof OmpRpcProtocolError ? error.message : String(error);
      }
      if (state.stderrTail) detail += ` stderr: ${state.stderrTail}`;
      const stopReason = state.abortStopReason ?? 'stream-ended-before-terminal';
      pushEvent({ type: 'result', success: false, result: null, error: `${stopReason}: ${detail}` });
      finish(stopReason);
    });

    function beginAbort(stopReason: string): void {
      if (state.settled || state.terminal || state.abortStopReason !== null) return;
      state.abortStopReason = stopReason;
      writeFrame({ id: 'zs-abort', type: 'abort' });
      abortTimer = setTimeout(() => {
        if (!state.terminal) terminateOwnedBoundary();
      }, request.abortGraceMs);
    }

    if (request.signal.aborted) {
      beginAbort('cancelled');
    } else {
      request.signal.addEventListener('abort', () => beginAbort('cancelled'), { once: true });
    }
    timeoutTimer = setTimeout(() => beginAbort('timeout'), request.timeoutMs);
  });
}
