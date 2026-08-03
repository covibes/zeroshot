import type { TargetCredentialStore } from './credential-store.ts';
import type { Clock } from './device-flow.ts';
import {
  TargetSessionManager,
  type TargetSessionDeps,
} from './target-session-manager.ts';
import type { SettingsPort, TargetRecord } from './target-registry.ts';

export {
  LoginRequiredError,
  TargetSessionManager,
  type BrowserOpener,
  type TargetSessionDeps,
  type TargetSessionManagerInit,
} from './target-session-manager.ts';

export interface TargetAccessTokenProvider {
  getAccessToken(signal?: AbortSignal): Promise<string>;
}

type LegacySessionDeps = Pick<TargetSessionDeps, 'http' | 'discoveryEndpoints'> & {
  readonly settings?: SettingsPort;
  readonly targetName?: string;
  readonly clock?: Clock;
};

type TargetLoginArgs = readonly [
  targetName: string,
  target: TargetRecord,
  credentialStore: TargetCredentialStore,
  acquireLock: () => Promise<() => Promise<void>>,
  settings: SettingsPort,
  deps: TargetSessionDeps,
];

type RefreshAccessArgs = readonly [
  targetName: string,
  target: TargetRecord,
  credentialStore: TargetCredentialStore,
  acquireLock: () => Promise<() => Promise<void>>,
  deps: LegacySessionDeps,
  clock?: Clock,
];

type RevokeArgs = readonly [
  target: TargetRecord,
  credentialStore: TargetCredentialStore,
  acquireLock: () => Promise<() => Promise<void>>,
  deps: LegacySessionDeps,
  force: boolean,
];

type LegacyManagerInit = {
  readonly targetName: string;
  readonly target: TargetRecord;
  readonly credentialStore: TargetCredentialStore;
  readonly acquireLock: () => Promise<() => Promise<void>>;
  readonly deps: LegacySessionDeps;
  readonly clock?: Clock;
};

function transientSettings(targetName: string, target: TargetRecord): SettingsPort {
  const state: { _targets: Record<string, TargetRecord> } = {
    _targets: { [targetName]: target },
  };
  return {
    load: () => state,
    mutate: (mutator) => mutator(state),
  };
}

function legacyManager(init: LegacyManagerInit): TargetSessionManager {
  const clock = init.clock ?? init.deps.clock ?? { now: () => Date.now() };
  return new TargetSessionManager({
    targetName: init.targetName,
    target: init.target,
    credentialStore: init.credentialStore,
    acquireLock: init.acquireLock,
    settings: init.deps.settings ?? transientSettings(init.targetName, init.target),
    deps: {
      http: init.deps.http,
      clock,
      browserOpener: { open: () => Promise.resolve() },
      stderr: { write: () => undefined },
      discoveryEndpoints: init.deps.discoveryEndpoints,
    },
  });
}

export function targetLogin(...args: TargetLoginArgs): Promise<{ organization: { id: string } }> {
  const [targetName, target, credentialStore, acquireLock, settings, deps] = args;
  return new TargetSessionManager({
    targetName,
    target,
    credentialStore,
    acquireLock,
    settings,
    deps,
  }).login();
}

export async function refreshAccessToken(
  ...args: RefreshAccessArgs
): Promise<{ accessToken: string; expiresIn: number }> {
  const [targetName, target, credentialStore, acquireLock, deps, clock] = args;
  return legacyManager({
    targetName,
    target,
    credentialStore,
    acquireLock,
    deps,
    ...(clock === undefined ? {} : { clock }),
  }).getAccessTokenWithLifetime('capsule');
}

export function getAccessTokenProvider(...args: RefreshAccessArgs): TargetAccessTokenProvider {
  const [targetName, target, credentialStore, acquireLock, deps, clock] = args;
  return legacyManager({
    targetName,
    target,
    credentialStore,
    acquireLock,
    deps,
    ...(clock === undefined ? {} : { clock }),
  }).tokenProvider('capsule');
}

export function revokeAndCleanup(...args: RevokeArgs): Promise<void> {
  const [target, credentialStore, acquireLock, deps, force] = args;
  const targetName = deps.targetName ?? target.id;
  return legacyManager({ targetName, target, credentialStore, acquireLock, deps }).revoke(force);
}
