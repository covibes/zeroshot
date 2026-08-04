import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  OMP_SDK_MAX_STDOUT_BYTES,
  createOmpSdkProtocolCollector,
  decodeOmpSdkSidecarRequest,
} from './sdk-protocol';
import {
  OMP_SDK_MAX_SUPERVISOR_ATTESTATION_BYTES,
  resolveOmpSdkHostSupervisorPath,
} from './sdk-runtime';
import type { PreparedSingleAgentProviderCommand } from '../single-agent-runtime';
import {
  DEFAULT_REAP_TIMEOUT_MS,
  DEFAULT_TERMINATION_GRACE_MS,
  MAX_STDERR_BYTES,
  childClose,
  credentialWriter,
  duration,
  testIdentityCapArgument,
  writeCredentials,
} from './sdk-process-io';
import { collectOmpSdkProcessResult, type OmpSdkSupervisionState } from './sdk-process-result';
import {
  OmpSdkProcessRunnerError,
  assertHostContainment,
  assertPrepared,
  childEnvironment,
  credentialPayload,
  makePrivateRuntime,
  removePrivateRoot,
  type OmpSdkProcessResult,
  type OmpSdkProcessRunnerOptions,
  type OmpSdkRunningProcess,
  type PrivateRuntime,
} from './sdk-process-private-runtime';

export { OmpSdkProcessRunnerError } from './sdk-process-private-runtime';
export type {
  OmpSdkProcessResult,
  OmpSdkProcessRunnerOptions,
  OmpSdkRunningProcess,
} from './sdk-process-private-runtime';

export async function spawnOmpSdkProcess(
  prepared: PreparedSingleAgentProviderCommand,
  options: OmpSdkProcessRunnerOptions = {}
): Promise<OmpSdkRunningProcess> {
  assertPrepared(prepared);
  let runtime: PrivateRuntime | undefined;
  try {
    const privateRuntime = await makePrivateRuntime(prepared.privateArtifacts);
    runtime = privateRuntime;
    assertHostContainment(prepared.containmentRequirement);
    const requestBytes = await fs.readFile(privateRuntime.requestPath);
    const request = decodeOmpSdkSidecarRequest(requestBytes);
    requestBytes.fill(0);
    const environment = childEnvironment(prepared.environmentPolicy, privateRuntime);
    const { payload, secretValues } = credentialPayload(prepared.credentialNames, process.env);
    const requestProvider = request.modelSelector.slice(0, request.modelSelector.indexOf('/'));
    const sidecarPath = prepared.commandSpec.args[0] ?? '';
    if (
      !isAbsolute(prepared.commandSpec.binary) ||
      prepared.commandSpec.args.length !== 2 ||
      !isAbsolute(sidecarPath) ||
      prepared.commandSpec.args[1] !== privateRuntime.requestPath ||
      prepared.commandSpec.cwd !== request.cwd ||
      Object.keys(prepared.commandSpec.env).length !== 0 ||
      prepared.semanticIdentity.requestedModelSelector !== request.modelSelector ||
      prepared.semanticIdentity.reasoningEffort !== request.reasoningEffort ||
      prepared.semanticIdentity.provider !== requestProvider
    ) {
      payload.fill(0);
      throw new OmpSdkProcessRunnerError(
        'protocol-error',
        'OMP SDK command metadata does not match its authoritative private request.'
      );
    }

    const supervisorPath = resolveOmpSdkHostSupervisorPath();
    let supervisorStat;
    try {
      supervisorStat = await fs.lstat(supervisorPath);
    } catch (error) {
      payload.fill(0);
      throw new OmpSdkProcessRunnerError(
        'containment-error',
        'Pinned OMP SDK host supervisor is unavailable.',
        { cause: error }
      );
    }
    if (!supervisorStat.isFile() || supervisorStat.isSymbolicLink()) {
      payload.fill(0);
      throw new OmpSdkProcessRunnerError(
        'containment-error',
        'Pinned OMP SDK host supervisor is unavailable.'
      );
    }
    const terminationGraceMs = duration(options.timeoutKillGraceMs, DEFAULT_TERMINATION_GRACE_MS);
    const reapTimeoutMs = duration(options.reapTimeoutMs, DEFAULT_REAP_TIMEOUT_MS);
    const startedAt = Date.now();
    const collector = createOmpSdkProtocolCollector({
      request,
      maxStdoutBytes: OMP_SDK_MAX_STDOUT_BYTES,
    });
    const child = spawn(
      prepared.commandSpec.binary,
      [
        supervisorPath,
        sidecarPath,
        privateRuntime.requestPath,
        String(terminationGraceMs),
        String(reapTimeoutMs),
        ...testIdentityCapArgument(),
      ],
      {
        cwd: prepared.commandSpec.cwd,
        detached: false,
        env: environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    const closePromise = childClose(child);
    const pid = child.pid;
    if (pid === undefined || pid <= 1) {
      payload.fill(0);
      const outcome = await closePromise;
      throw (
        outcome.spawnError ??
        new OmpSdkProcessRunnerError('containment-error', 'OMP SDK supervisor PID is unavailable.')
      );
    }

    const controller = new AbortController();
    const state: OmpSdkSupervisionState = {
      timedOut: false,
      protocolError: undefined,
      stderrChunks: [],
      attestationChunks: [],
      timeout: undefined,
    };
    let stderrBytes = 0;
    let attestationBytes = 0;
    const terminate = (): void => {
      try {
        child.kill('SIGCONT');
        child.kill('SIGTERM');
      } catch {
        // Close/attestation decides whether cleanup is authoritative.
      }
    };
    const externalAbort = (): void => controller.abort();
    controller.signal.addEventListener('abort', terminate, { once: true });
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    if (options.timeoutMs !== undefined) {
      state.timeout = setTimeout(() => {
        state.timedOut = true;
        controller.abort();
      }, options.timeoutMs);
      state.timeout.unref();
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      attestationBytes += chunk.byteLength;
      if (attestationBytes > OMP_SDK_MAX_SUPERVISOR_ATTESTATION_BYTES) {
        state.protocolError = new OmpSdkProcessRunnerError(
          'cleanup-error',
          'OMP SDK supervisor attestation is oversized.'
        );
        terminate();
      } else {
        state.attestationChunks.push(chunk);
      }
    });
    child.stdout?.on('error', () => {
      state.protocolError = new OmpSdkProcessRunnerError(
        'cleanup-error',
        'OMP SDK supervisor attestation channel failed.'
      );
      terminate();
    });
    const protocolChannel = child.stdio[4];
    if (
      protocolChannel === undefined ||
      protocolChannel === null ||
      typeof protocolChannel.on !== 'function'
    ) {
      state.protocolError = new OmpSdkProcessRunnerError(
        'protocol-error',
        'OMP SDK sidecar protocol channel was not created.'
      );
      terminate();
    } else {
      protocolChannel.on('data', (chunk: Buffer) => {
        if (state.protocolError !== undefined) return;
        try {
          for (const frame of collector.write(chunk)) {
            if (frame.type === 'progress') options.onProgress?.(frame);
          }
        } catch (error) {
          state.protocolError = error;
          terminate();
        }
      });
      protocolChannel.on('error', (error: Error) => {
        state.protocolError = new OmpSdkProcessRunnerError(
          'protocol-error',
          'OMP SDK sidecar protocol channel failed.',
          { cause: error }
        );
        terminate();
      });
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) {
        state.protocolError = new OmpSdkProcessRunnerError(
          'protocol-error',
          'OMP SDK diagnostic stderr is oversized.'
        );
        terminate();
      } else {
        state.stderrChunks.push(chunk);
      }
    });
    child.stderr?.on('error', (error: Error) => {
      state.protocolError = new OmpSdkProcessRunnerError(
        'protocol-error',
        'OMP SDK diagnostic channel failed.',
        { cause: error }
      );
      terminate();
    });

    const writePromise = writeCredentials(credentialWriter(child), payload).catch((error) => {
      state.protocolError = new OmpSdkProcessRunnerError(
        'protocol-error',
        'OMP SDK credential channel failed.',
        { cause: error }
      );
      terminate();
    });

    const result = collectOmpSdkProcessResult({
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
    });

    return {
      pid,
      result,
      cancel: () => controller.abort(),
    };
  } catch (error) {
    if (runtime !== undefined) {
      await removePrivateRoot(runtime);
    }
    throw error;
  }
}

export async function runOmpSdkProcess(
  prepared: PreparedSingleAgentProviderCommand,
  options: OmpSdkProcessRunnerOptions = {}
): Promise<OmpSdkProcessResult> {
  return (await spawnOmpSdkProcess(prepared, options)).result;
}
