import { parseOmpSdkSupervisorAttestation } from './sdk-runtime';
import type {
  OmpSdkCollectedTerminal,
  OmpSdkProtocolCollector,
  OmpSdkSidecarRequest,
} from './sdk-protocol';
import type { OmpSdkCleanupAttestation, OmpSdkContainmentRequirement } from '../types';
import { cancelledTerminal, type ChildOutcome } from './sdk-process-io';
import {
  OmpSdkProcessRunnerError,
  redactDiagnostic,
  removePrivateRoot,
  type OmpSdkProcessResult,
  type OmpSdkProcessRunnerOptions,
  type PrivateRuntime,
} from './sdk-process-private-runtime';

export interface OmpSdkSupervisionState {
  timedOut: boolean;
  protocolError: unknown;
  readonly stderrChunks: Buffer[];
  readonly attestationChunks: Buffer[];
  timeout: NodeJS.Timeout | undefined;
}

interface OmpSdkResultContext {
  readonly privateRuntime: PrivateRuntime;
  readonly request: OmpSdkSidecarRequest;
  readonly controller: AbortController;
  readonly options: OmpSdkProcessRunnerOptions;
  readonly collector: OmpSdkProtocolCollector;
  readonly closePromise: Promise<ChildOutcome>;
  readonly writePromise: Promise<void>;
  readonly state: OmpSdkSupervisionState;
  readonly secretValues: readonly string[];
  readonly startedAt: number;
  readonly externalAbort: () => void;
  readonly containmentMode: OmpSdkContainmentRequirement['mode'];
}

export async function collectOmpSdkProcessResult(
  context: OmpSdkResultContext
): Promise<OmpSdkProcessResult> {
  const {
    privateRuntime,
    request,
    controller,
    options,
    collector,
    closePromise,
    writePromise,
    state,
    secretValues,
    startedAt,
    externalAbort,
    containmentMode,
  } = context;
  let rootRemoved = false;
  try {
    await writePromise;
    const outcome = await closePromise;
    if (outcome.spawnError !== undefined) throw outcome.spawnError;

    let supervisorAttestation;
    try {
      supervisorAttestation = parseOmpSdkSupervisorAttestation(
        Buffer.concat(state.attestationChunks)
      );
    } catch (error) {
      throw new OmpSdkProcessRunnerError(
        'cleanup-error',
        'OMP SDK supervisor cleanup attestation is malformed or unavailable.',
        { cause: error }
      );
    }
    if (supervisorAttestation.status === 'error') {
      throw new OmpSdkProcessRunnerError(
        supervisorAttestation.code === 'capability-unavailable'
          ? 'containment-error'
          : 'cleanup-error',
        supervisorAttestation.code === 'capability-unavailable'
          ? 'OMP SDK Linux subreaper/pidfd containment is unavailable.'
          : 'OMP SDK supervisor could not attest descendant cleanup.'
      );
    }
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      throw new OmpSdkProcessRunnerError(
        'cleanup-error',
        'OMP SDK supervisor did not exit cleanly after its cleanup attestation.'
      );
    }
    if (supervisorAttestation.cancelled !== controller.signal.aborted) {
      throw new OmpSdkProcessRunnerError(
        'cleanup-error',
        'OMP SDK supervisor cancellation attestation does not match the owner state.'
      );
    }

    let terminal: OmpSdkCollectedTerminal | undefined;
    if (!controller.signal.aborted && state.protocolError === undefined) {
      if (supervisorAttestation.semantic.exitCode === null) {
        state.protocolError = new OmpSdkProcessRunnerError(
          'protocol-error',
          'OMP SDK sidecar terminated by signal without cancellation.'
        );
      } else {
        try {
          terminal = collector.finish(supervisorAttestation.semantic.exitCode);
        } catch (error) {
          state.protocolError = error;
        }
      }
    }

    await removePrivateRoot(privateRuntime);
    rootRemoved = true;
    const cleanupAttestation: OmpSdkCleanupAttestation = {
      mode: containmentMode,
      terminalBuffered: true,
      descendantsReaped: true,
      clean: true,
    };
    const diagnosticStderr = redactDiagnostic(Buffer.concat(state.stderrChunks).toString('utf8'), [
      ...secretValues,
      request.prompt,
      request.context,
    ]);
    if (controller.signal.aborted) {
      return {
        stdout: '',
        stderr: diagnosticStderr,
        diagnosticStderr,
        exitCode: supervisorAttestation.semantic.exitCode,
        signal: supervisorAttestation.semantic.signal,
        durationMs: Date.now() - startedAt,
        timedOut: state.timedOut,
        ...(state.timedOut && options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
        terminal: cancelledTerminal(request),
        progress: [...collector.progress],
        cleanupAttestation,
      };
    }
    if (state.protocolError !== undefined) throw state.protocolError;
    if (terminal === undefined) {
      throw new OmpSdkProcessRunnerError(
        'protocol-error',
        'OMP SDK terminal frame is unavailable.'
      );
    }
    return {
      stdout: '',
      stderr: diagnosticStderr,
      diagnosticStderr,
      exitCode: supervisorAttestation.semantic.exitCode,
      signal: supervisorAttestation.semantic.signal,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      terminal,
      progress: [...collector.progress],
      cleanupAttestation,
    };
  } catch (error) {
    if (!rootRemoved) {
      try {
        await removePrivateRoot(privateRuntime);
      } catch (removeError) {
        throw new OmpSdkProcessRunnerError(
          'cleanup-error',
          'OMP SDK private-root cleanup failed after supervisor shutdown.',
          { cause: removeError }
        );
      }
    }
    throw error;
  } finally {
    clearTimeout(state.timeout);
    options.signal?.removeEventListener('abort', externalAbort);
    for (const chunk of state.stderrChunks) chunk.fill(0);
    for (const chunk of state.attestationChunks) chunk.fill(0);
  }
}
