import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import {
  OMP_SDK_BACKEND_VERSION,
  OMP_SDK_BUN_VERSION,
  type OmpSdkCollectedTerminal,
  type OmpSdkProtocolProgressFrame,
} from './sdk-protocol';
import type { PreparedSingleAgentProviderCommand } from '../single-agent-runtime';
import type {
  OmpSdkCleanupAttestation,
  OmpSdkContainmentRequirement,
  OmpSdkExecutionIdentity,
  OmpSdkSemanticIdentity,
  PreparedEnvironmentPolicy,
  PreparedPrivateArtifacts,
  PreparedProviderInvoke,
} from '../types';
import type { ProcessResult, ProcessRunnerOptions } from '../process-runner';
import { OmpSdkProcessRunnerError } from './sdk-process-error';

export { credentialPayload, redactDiagnostic } from './sdk-process-credentials';
export { OmpSdkProcessRunnerError } from './sdk-process-error';

const PRIVATE_ROOT_NAME = /^zeroshot-omp-sdk-[A-Za-z0-9_-]+$/u;
const PRIVATE_ENV_NAMES = new Set([
  'HOME',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'PI_CODING_AGENT_DIR',
]);
const MINIMAL_ENV_NAMES = new Set([
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'NO_PROXY',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TZ',
]);

export interface OmpSdkPreparedInvocation extends PreparedSingleAgentProviderCommand {
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
export interface PrivateRuntime {
  readonly root: string;
  readonly requestPath: string;
  readonly home: string;
  readonly xdgConfig: string;
  readonly xdgCache: string;
  readonly xdgData: string;
  readonly xdgState: string;
  readonly piDirectory: string;
}

export function assertPrepared(
  prepared: PreparedSingleAgentProviderCommand
): asserts prepared is OmpSdkPreparedInvocation {
  const valid =
    prepared.invoke.lane === 'spawn' &&
    prepared.invoke.parser === 'omp-sdk-ndjson' &&
    prepared.invoke.ptyEligible === false &&
    prepared.invoke.strictTerminal === true &&
    prepared.environmentPolicy?.inherit === 'minimal' &&
    prepared.privateArtifacts?.owned === true &&
    prepared.containmentRequirement?.required === true &&
    prepared.executionIdentity?.backend === 'omp-sdk' &&
    prepared.semanticIdentity !== undefined &&
    Array.isArray(prepared.credentialNames);
  if (!valid)
    throw new OmpSdkProcessRunnerError(
      'protocol-error',
      'OMP SDK spawn requires a complete authoritative prepared invocation.'
    );
  if (
    prepared.executionIdentity.backendVersion !== OMP_SDK_BACKEND_VERSION ||
    prepared.executionIdentity.runtime.name !== 'bun' ||
    prepared.executionIdentity.runtime.version !== OMP_SDK_BUN_VERSION ||
    prepared.executionIdentity.transport !== 'sdk'
  ) {
    throw new OmpSdkProcessRunnerError(
      'protocol-error',
      'OMP SDK prepared identity does not match the pinned runtime.'
    );
  }
}
export function assertHostContainment(requirement: OmpSdkContainmentRequirement): void {
  if (
    requirement.mode !== 'host-process-tree' ||
    process.platform !== 'linux' ||
    (process.arch !== 'x64' && process.arch !== 'arm64')
  ) {
    throw new OmpSdkProcessRunnerError(
      'containment-error',
      'OMP SDK host spawn requires the packaged Linux subreaper/pidfd supervisor; container invocations require the container spawn owner.'
    );
  }
}
function pathIsWithin(root: string, candidate: string): boolean {
  const fragment = relative(root, candidate);
  return (
    fragment.length > 0 &&
    fragment !== '..' &&
    !fragment.startsWith(`..${sep}`) &&
    !isAbsolute(fragment)
  );
}
export async function makePrivateRuntime(
  artifacts: PreparedPrivateArtifacts
): Promise<PrivateRuntime> {
  if (!artifacts.owned || !isAbsolute(artifacts.root) || !isAbsolute(artifacts.requestPath)) {
    throw new OmpSdkProcessRunnerError(
      'cleanup-error',
      'OMP SDK private artifact ownership is invalid.'
    );
  }
  const root = resolve(artifacts.root);
  const requestPath = resolve(artifacts.requestPath);
  if (
    root === parse(root).root ||
    root === resolve(tmpdir()) ||
    root === resolve(process.cwd()) ||
    dirname(root) !== resolve(tmpdir()) ||
    !PRIVATE_ROOT_NAME.test(basename(root)) ||
    !pathIsWithin(root, requestPath) ||
    dirname(requestPath) !== root
  ) {
    throw new OmpSdkProcessRunnerError(
      'cleanup-error',
      'OMP SDK private artifact boundary is unsafe.'
    );
  }
  const [rootStat, requestStat, canonicalRoot, canonicalRequest] = await Promise.all([
    fs.lstat(root),
    fs.lstat(requestPath),
    fs.realpath(root),
    fs.realpath(requestPath),
  ]);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o077) !== 0 ||
    !requestStat.isFile() ||
    requestStat.isSymbolicLink() ||
    (requestStat.mode & 0o077) !== 0 ||
    canonicalRoot !== root ||
    canonicalRequest !== requestPath
  ) {
    throw new OmpSdkProcessRunnerError(
      'cleanup-error',
      'OMP SDK private artifacts are not owner-only regular paths.'
    );
  }
  await Promise.all(
    ['home', 'xdg-config', 'xdg-cache', 'xdg-data', 'xdg-state', 'pi'].map((name) =>
      fs.mkdir(join(root, name), { mode: 0o700, recursive: false })
    )
  );
  return {
    root,
    requestPath,
    home: join(root, 'home'),
    xdgConfig: join(root, 'xdg-config'),
    xdgCache: join(root, 'xdg-cache'),
    xdgData: join(root, 'xdg-data'),
    xdgState: join(root, 'xdg-state'),
    piDirectory: join(root, 'pi'),
  };
}
export async function removePrivateRoot(runtime: PrivateRuntime): Promise<void> {
  try {
    if ((await fs.realpath(runtime.root)) !== runtime.root)
      throw new Error('private root changed identity');
    await fs.rm(runtime.root, { force: true, maxRetries: 3, recursive: true });
    try {
      await fs.lstat(runtime.root);
      throw new Error('private root remains');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  } catch (error) {
    throw new OmpSdkProcessRunnerError(
      'cleanup-error',
      'OMP SDK owned private root could not be removed.',
      { cause: error }
    );
  }
}

export function childEnvironment(
  policy: PreparedEnvironmentPolicy,
  runtime: PrivateRuntime
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(policy.values)) {
    const normalized = name.toUpperCase();
    if (
      !MINIMAL_ENV_NAMES.has(normalized) ||
      PRIVATE_ENV_NAMES.has(normalized) ||
      /(?:^|_)(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)(?:_|$)/i.test(name)
    ) {
      throw new OmpSdkProcessRunnerError(
        'protocol-error',
        `OMP SDK minimal environment contains unsupported key ${name}.`
      );
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
