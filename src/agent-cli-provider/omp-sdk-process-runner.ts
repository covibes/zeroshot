import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { Writable } from 'node:stream';

import {
  OMP_SDK_BACKEND_VERSION,
  OMP_SDK_BUN_VERSION,
  OMP_SDK_MAX_CREDENTIAL_BYTES,
  OMP_SDK_MAX_STDOUT_BYTES,
  createOmpSdkProtocolCollector,
  decodeOmpSdkSidecarRequest,
  parseOmpSdkProtocolFrame,
  type OmpSdkCollectedTerminal,
  type OmpSdkProtocolProgressFrame,
  type OmpSdkSidecarRequest,
} from './omp-sdk-protocol';
import {
  OMP_SDK_MAX_SUPERVISOR_ATTESTATION_BYTES,
  parseOmpSdkSupervisorAttestation,
  resolveOmpSdkHostSupervisorPath,
} from './omp-sdk-runtime';
import type { PreparedSingleAgentProviderCommand } from './single-agent-runtime';
import type {
  OmpSdkCleanupAttestation,
  OmpSdkContainmentRequirement,
  OmpSdkExecutionIdentity,
  OmpSdkSemanticIdentity,
  PreparedEnvironmentPolicy,
  PreparedPrivateArtifacts,
  PreparedProviderInvoke,
} from './types';
import type { ProcessResult, ProcessRunnerOptions } from './process-runner';

const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRIVATE_ROOT_NAME = /^zeroshot-omp-sdk-[A-Za-z0-9_-]+$/u;
const MAX_CREDENTIAL_COUNT = 32;
const MAX_CREDENTIAL_NAME_BYTES = 128;
const MAX_CREDENTIAL_VALUE_BYTES = 16 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_REAP_TIMEOUT_MS = 2_000;
const TEST_IDENTITY_CAP_ENV = 'ZEROSHOT_OMP_TEST_IDENTITY_CAP';
const PRIVATE_ENV_NAMES = new Set([
  'HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'PI_CODING_AGENT_DIR',
]);
const MINIMAL_ENV_NAMES = new Set([
  'ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'NO_PROXY', 'PATH',
  'SSL_CERT_DIR', 'SSL_CERT_FILE', 'TZ',
]);

interface OmpSdkPreparedInvocation extends PreparedSingleAgentProviderCommand {
  readonly invoke: PreparedProviderInvoke & {
    readonly lane: 'spawn';
    readonly parser: 'omp-sdk-ndjson';
    readonly ptyEligible: false;
    readonly strictTerminal: true;
  };
  readonly environmentPolicy: PreparedEnvironmentPolicy;
  readonly credentialNames: readonly string[];
  readonly privateArtifacts: PreparedPrivateArtifacts;
  readonly containmentRequirement: OmpSdkContainmentRequirement;
  readonly executionIdentity: OmpSdkExecutionIdentity;
  readonly semanticIdentity: OmpSdkSemanticIdentity;
}
export interface OmpSdkProcessRunnerOptions extends ProcessRunnerOptions {
  readonly onProgress?: (frame: OmpSdkProtocolProgressFrame) => void;
  readonly reapTimeoutMs?: number;
}
export interface OmpSdkProcessResult extends ProcessResult {
  readonly terminal: OmpSdkCollectedTerminal;
  readonly progress: readonly OmpSdkProtocolProgressFrame[];
  readonly diagnosticStderr: string;
  readonly cleanupAttestation: OmpSdkCleanupAttestation;
}
export interface OmpSdkRunningProcess {
  readonly pid: number;
  readonly result: Promise<OmpSdkProcessResult>;
  cancel(): void;
}
interface PrivateRuntime {
  readonly root: string;
  readonly requestPath: string;
  readonly home: string;
  readonly xdgConfig: string;
  readonly xdgCache: string;
  readonly xdgData: string;
  readonly xdgState: string;
  readonly piDirectory: string;
}
interface ChildOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError?: Error;
}

export class OmpSdkProcessRunnerError extends Error {
  readonly code: 'cleanup-error' | 'containment-error' | 'credential-error' | 'protocol-error';
  constructor(code: OmpSdkProcessRunnerError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OmpSdkProcessRunnerError';
    this.code = code;
  }
}

function assertPrepared(
  prepared: PreparedSingleAgentProviderCommand
): asserts prepared is OmpSdkPreparedInvocation {
  const valid = prepared.invoke.lane === 'spawn' && prepared.invoke.parser === 'omp-sdk-ndjson' &&
    prepared.invoke.ptyEligible === false && prepared.invoke.strictTerminal === true &&
    prepared.environmentPolicy?.inherit === 'minimal' && prepared.privateArtifacts?.owned === true &&
    prepared.containmentRequirement?.required === true &&
    prepared.executionIdentity?.backend === 'omp-sdk' &&
    prepared.semanticIdentity !== undefined &&
    Array.isArray(prepared.credentialNames);
  if (!valid) throw new OmpSdkProcessRunnerError('protocol-error', 'OMP SDK spawn requires a complete authoritative prepared invocation.');
  if (prepared.executionIdentity.backendVersion !== OMP_SDK_BACKEND_VERSION ||
      prepared.executionIdentity.runtime.name !== 'bun' ||
      prepared.executionIdentity.runtime.version !== OMP_SDK_BUN_VERSION ||
      prepared.executionIdentity.transport !== 'sdk') {
    throw new OmpSdkProcessRunnerError('protocol-error', 'OMP SDK prepared identity does not match the pinned runtime.');
  }
}
function assertHostContainment(requirement: OmpSdkContainmentRequirement): void {
  if (requirement.mode !== 'host-process-tree' || process.platform !== 'linux' ||
      (process.arch !== 'x64' && process.arch !== 'arm64')) {
    throw new OmpSdkProcessRunnerError(
      'containment-error',
      'OMP SDK host spawn requires the packaged Linux subreaper/pidfd supervisor; container invocations require the container spawn owner.'
    );
  }
}
function pathIsWithin(root: string, candidate: string): boolean {
  const fragment = relative(root, candidate);
  return fragment.length > 0 && fragment !== '..' && !fragment.startsWith(`..${sep}`) && !isAbsolute(fragment);
}
async function makePrivateRuntime(artifacts: PreparedPrivateArtifacts): Promise<PrivateRuntime> {
  if (!artifacts.owned || !isAbsolute(artifacts.root) || !isAbsolute(artifacts.requestPath)) {
    throw new OmpSdkProcessRunnerError('cleanup-error', 'OMP SDK private artifact ownership is invalid.');
  }
  const root = resolve(artifacts.root);
  const requestPath = resolve(artifacts.requestPath);
  if (root === parse(root).root || root === resolve(tmpdir()) || root === resolve(process.cwd()) ||
      dirname(root) !== resolve(tmpdir()) || !PRIVATE_ROOT_NAME.test(basename(root)) ||
      !pathIsWithin(root, requestPath) || dirname(requestPath) !== root) {
    throw new OmpSdkProcessRunnerError('cleanup-error', 'OMP SDK private artifact boundary is unsafe.');
  }
  const [rootStat, requestStat, canonicalRoot, canonicalRequest] = await Promise.all([
    fs.lstat(root), fs.lstat(requestPath), fs.realpath(root), fs.realpath(requestPath),
  ]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0 ||
      !requestStat.isFile() || requestStat.isSymbolicLink() || (requestStat.mode & 0o077) !== 0 ||
      canonicalRoot !== root || canonicalRequest !== requestPath) {
    throw new OmpSdkProcessRunnerError('cleanup-error', 'OMP SDK private artifacts are not owner-only regular paths.');
  }
  await Promise.all(['home', 'xdg-config', 'xdg-cache', 'xdg-data', 'xdg-state', 'pi']
    .map((name) => fs.mkdir(join(root, name), { mode: 0o700, recursive: false })));
  return {
    root, requestPath, home: join(root, 'home'), xdgConfig: join(root, 'xdg-config'),
    xdgCache: join(root, 'xdg-cache'), xdgData: join(root, 'xdg-data'),
    xdgState: join(root, 'xdg-state'), piDirectory: join(root, 'pi'),
  };
}
async function removePrivateRoot(runtime: PrivateRuntime): Promise<void> {
  try {
    if (await fs.realpath(runtime.root) !== runtime.root) throw new Error('private root changed identity');
    await fs.rm(runtime.root, { force: true, maxRetries: 3, recursive: true });
    try {
      await fs.lstat(runtime.root);
      throw new Error('private root remains');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } catch (error) {
    throw new OmpSdkProcessRunnerError('cleanup-error', 'OMP SDK owned private root could not be removed.', { cause: error });
  }
}

function childEnvironment(policy: PreparedEnvironmentPolicy, runtime: PrivateRuntime): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(policy.values)) {
    const normalized = name.toUpperCase();
    if (!MINIMAL_ENV_NAMES.has(normalized) || PRIVATE_ENV_NAMES.has(normalized) ||
        /(?:^|_)(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)(?:_|$)/i.test(name)) {
      throw new OmpSdkProcessRunnerError('protocol-error', `OMP SDK minimal environment contains unsupported key ${name}.`);
    }
    env[name] = value;
  }
  env.HOME = runtime.home;
  env.XDG_CONFIG_HOME = runtime.xdgConfig;
  env.XDG_CACHE_HOME = runtime.xdgCache;
  env.XDG_DATA_HOME = runtime.xdgData;
  env.XDG_STATE_HOME = runtime.xdgState;
  env.PI_CODING_AGENT_DIR = runtime.piDirectory;
  return env;
}

function credentialPayload(
  names: readonly string[],
  source: Readonly<Record<string, string | undefined>>
): { readonly payload: Buffer; readonly secretValues: readonly string[] } {
  if (names.length > MAX_CREDENTIAL_COUNT || new Set(names).size !== names.length) {
    throw new OmpSdkProcessRunnerError('credential-error', 'OMP SDK credential name set is invalid.');
  }
  const values: Record<string, string> = {};
  const secretValues: string[] = [];
  for (const name of names) {
    const value = source[name];
    if (!CREDENTIAL_NAME.test(name) || Buffer.byteLength(name) > MAX_CREDENTIAL_NAME_BYTES ||
        typeof value !== 'string' || value.length === 0 ||
        Buffer.byteLength(value) > MAX_CREDENTIAL_VALUE_BYTES) {
      throw new OmpSdkProcessRunnerError('credential-error', `OMP SDK credential ${name} is missing or invalid.`);
    }
    values[name] = value;
    secretValues.push(value);
  }
  const payload = Buffer.from(JSON.stringify({ protocolVersion: 1, values }), 'utf8');
  if (payload.byteLength > OMP_SDK_MAX_CREDENTIAL_BYTES) {
    payload.fill(0);
    throw new OmpSdkProcessRunnerError('credential-error', 'OMP SDK credential document is oversized.');
  }
  return { payload, secretValues };
}

function redactDiagnostic(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}


function cancelledTerminal(request: OmpSdkSidecarRequest): OmpSdkCollectedTerminal {
  const frame = parseOmpSdkProtocolFrame({
    protocolVersion: 1,
    type: 'error',
    runId: request.runId,
    backend: { id: 'omp-sdk', version: OMP_SDK_BACKEND_VERSION },
    runtime: { name: 'bun', version: OMP_SDK_BUN_VERSION },
    error: { code: 'cancelled', category: 'cancelled', retryable: false, redacted: true },
  });
  if (frame.type !== 'error') throw new Error('cancelled terminal construction failed');
  return { type: 'error', frame };
}

function childClose(child: ChildProcess): Promise<ChildOutcome> {
  return new Promise((resolveClose) => {
    const spawned = child.pid !== undefined;
    let spawnError: Error | undefined;
    child.once('error', (error) => {
      if (!spawned) spawnError = error;
    });
    child.once('close', (exitCode, signal) => {
      resolveClose({ exitCode, signal, ...(spawnError === undefined ? {} : { spawnError }) });
    });
  });
}

function credentialWriter(child: ChildProcess): Writable {
  const channel = child.stdio[3];
  if (channel === undefined || channel === null || typeof (channel as Writable).end !== 'function') {
    throw new OmpSdkProcessRunnerError('protocol-error', 'OMP SDK credential channel was not created.');
  }
  // Keep late peer-reset errors observed after the one-shot write callback from becoming uncaught.
  (channel as Writable).on('error', () => {});
  return channel as Writable;
}

async function writeCredentials(channel: Writable, payload: Buffer): Promise<void> {
  try {
    await new Promise<void>((resolveWrite, rejectWrite) => {
      channel.once('error', rejectWrite);
      channel.end(payload, () => {
        channel.removeListener('error', rejectWrite);
        resolveWrite();
      });
    });
  } finally {
    payload.fill(0);
  }
}

function duration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function testIdentityCapArgument(): readonly string[] {
  const source = process.env.NODE_ENV === 'test' ? process.env[TEST_IDENTITY_CAP_ENV] : undefined;
  if (source === undefined) return [];
  const cap = Number(source);
  if (!Number.isSafeInteger(cap) || cap < 8 || cap > 4_096) {
    throw new OmpSdkProcessRunnerError('protocol-error', 'OMP SDK private test identity cap is invalid.');
  }
  return [String(cap)];
}

export async function spawnOmpSdkProcess(
  prepared: PreparedSingleAgentProviderCommand,
  options: OmpSdkProcessRunnerOptions = {}
): Promise<OmpSdkRunningProcess> {
  assertPrepared(prepared);
  let runtime: PrivateRuntime | undefined;
  try {
    runtime = await makePrivateRuntime(prepared.privateArtifacts);
    assertHostContainment(prepared.containmentRequirement);
    const requestBytes = await fs.readFile(runtime.requestPath);
    const request = decodeOmpSdkSidecarRequest(requestBytes);
    requestBytes.fill(0);
    const environment = childEnvironment(prepared.environmentPolicy, runtime);
    const { payload, secretValues } = credentialPayload(
      prepared.credentialNames,
      process.env
    );
    const requestProvider = request.modelSelector.slice(0, request.modelSelector.indexOf('/'));
    const sidecarPath = prepared.commandSpec.args[0] ?? '';
    if (!isAbsolute(prepared.commandSpec.binary) ||
        prepared.commandSpec.args.length !== 2 ||
        !isAbsolute(sidecarPath) ||
        prepared.commandSpec.args[1] !== runtime.requestPath ||
        prepared.commandSpec.cwd !== request.cwd ||
        Object.keys(prepared.commandSpec.env).length !== 0 ||
        prepared.semanticIdentity.requestedModelSelector !== request.modelSelector ||
        prepared.semanticIdentity.reasoningEffort !== request.reasoningEffort ||
        prepared.semanticIdentity.provider !== requestProvider) {
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
    const terminationGraceMs = duration(
      options.timeoutKillGraceMs,
      DEFAULT_TERMINATION_GRACE_MS
    );
    const reapTimeoutMs = duration(options.reapTimeoutMs, DEFAULT_REAP_TIMEOUT_MS);
    const startedAt = Date.now();
    const collector = createOmpSdkProtocolCollector({
      request,
      maxStdoutBytes: OMP_SDK_MAX_STDOUT_BYTES,
    });
    const child = spawn(prepared.commandSpec.binary, [
      supervisorPath,
      sidecarPath,
      runtime.requestPath,
      String(terminationGraceMs),
      String(reapTimeoutMs),
      ...testIdentityCapArgument(),
    ], {
      cwd: prepared.commandSpec.cwd,
      detached: false,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const closePromise = childClose(child);
    const pid = child.pid;
    if (pid === undefined || pid <= 1) {
      payload.fill(0);
      const outcome = await closePromise;
      throw outcome.spawnError ??
        new OmpSdkProcessRunnerError('containment-error', 'OMP SDK supervisor PID is unavailable.');
    }

    const controller = new AbortController();
    let timedOut = false;
    let protocolError: unknown;
    let stderrBytes = 0;
    let attestationBytes = 0;
    const stderrChunks: Buffer[] = [];
    const attestationChunks: Buffer[] = [];
    let timeout: NodeJS.Timeout | undefined;
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
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs);
      timeout.unref();
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      attestationBytes += chunk.byteLength;
      if (attestationBytes > OMP_SDK_MAX_SUPERVISOR_ATTESTATION_BYTES) {
        protocolError = new OmpSdkProcessRunnerError(
          'cleanup-error',
          'OMP SDK supervisor attestation is oversized.'
        );
        terminate();
      } else {
        attestationChunks.push(chunk);
      }
    });
    child.stdout?.on('error', () => {
      protocolError = new OmpSdkProcessRunnerError(
        'cleanup-error',
        'OMP SDK supervisor attestation channel failed.'
      );
      terminate();
    });
    const protocolChannel = child.stdio[4];
    if (protocolChannel === undefined || protocolChannel === null ||
        typeof protocolChannel.on !== 'function') {
      protocolError = new OmpSdkProcessRunnerError(
        'protocol-error',
        'OMP SDK sidecar protocol channel was not created.'
      );
      terminate();
    } else {
      protocolChannel.on('data', (chunk: Buffer) => {
        if (protocolError !== undefined) return;
        try {
          for (const frame of collector.write(chunk)) {
            if (frame.type === 'progress') options.onProgress?.(frame);
          }
        } catch (error) {
          protocolError = error;
          terminate();
        }
      });
      protocolChannel.on('error', (error: Error) => {
        protocolError = new OmpSdkProcessRunnerError(
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
        protocolError = new OmpSdkProcessRunnerError(
          'protocol-error',
          'OMP SDK diagnostic stderr is oversized.'
        );
        terminate();
      } else {
        stderrChunks.push(chunk);
      }
    });
    child.stderr?.on('error', (error: Error) => {
      protocolError = new OmpSdkProcessRunnerError(
        'protocol-error',
        'OMP SDK diagnostic channel failed.',
        { cause: error }
      );
      terminate();
    });

    const writePromise = writeCredentials(credentialWriter(child), payload).catch((error) => {
      protocolError = new OmpSdkProcessRunnerError(
        'protocol-error',
        'OMP SDK credential channel failed.',
        { cause: error }
      );
      terminate();
    });

    const result = (async (): Promise<OmpSdkProcessResult> => {
      let rootRemoved = false;
      try {
        await writePromise;
        const outcome = await closePromise;
        if (outcome.spawnError !== undefined) throw outcome.spawnError;

        let supervisorAttestation;
        try {
          supervisorAttestation = parseOmpSdkSupervisorAttestation(
            Buffer.concat(attestationChunks)
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
        if (!controller.signal.aborted && protocolError === undefined) {
          if (supervisorAttestation.semantic.exitCode === null) {
            protocolError = new OmpSdkProcessRunnerError(
              'protocol-error',
              'OMP SDK sidecar terminated by signal without cancellation.'
            );
          } else {
            try {
              terminal = collector.finish(supervisorAttestation.semantic.exitCode);
            } catch (error) {
              protocolError = error;
            }
          }
        }

        await removePrivateRoot(runtime as PrivateRuntime);
        rootRemoved = true;
        const cleanupAttestation: OmpSdkCleanupAttestation = {
          mode: 'host-process-tree',
          terminalBuffered: true,
          descendantsReaped: true,
          clean: true,
        };
        const diagnosticStderr = redactDiagnostic(
          Buffer.concat(stderrChunks).toString('utf8'),
          [...secretValues, request.prompt, request.context]
        );
        if (controller.signal.aborted) {
          return {
            stdout: '',
            stderr: diagnosticStderr,
            diagnosticStderr,
            exitCode: supervisorAttestation.semantic.exitCode,
            signal: supervisorAttestation.semantic.signal as NodeJS.Signals | null,
            durationMs: Date.now() - startedAt,
            timedOut,
            ...(timedOut && options.timeoutMs !== undefined
              ? { timeoutMs: options.timeoutMs }
              : {}),
            terminal: cancelledTerminal(request),
            progress: [...collector.progress],
            cleanupAttestation,
          };
        }
        if (protocolError !== undefined) throw protocolError;
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
          signal: supervisorAttestation.semantic.signal as NodeJS.Signals | null,
          durationMs: Date.now() - startedAt,
          timedOut: false,
          terminal,
          progress: [...collector.progress],
          cleanupAttestation,
        };
      } catch (error) {
        if (!rootRemoved) {
          try {
            await removePrivateRoot(runtime as PrivateRuntime);
            rootRemoved = true;
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
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', externalAbort);
        for (const chunk of stderrChunks) chunk.fill(0);
        for (const chunk of attestationChunks) chunk.fill(0);
      }
    })();

    return {
      pid,
      result,
      cancel: () => controller.abort(),
    };
  } catch (error) {
    if (runtime !== undefined) {
      try {
        await removePrivateRoot(runtime);
      } catch (cleanupError) {
        throw cleanupError;
      }
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
