import type { Command } from 'commander';
import {
  registerTargetCommands,
  type HostedCommandServices,
  type SettingsPort,
} from './hosted-command-actions.js';

function loadHostedCommandServices(): HostedCommandServices {
  const registry = require('./target-registry') as Pick<
    HostedCommandServices,
    'addTarget' | 'getTarget' | 'listTargets' | 'removeTarget' | 'normalizeAndValidateUrl'
  >;
  const session = require('./target-session') as Pick<
    HostedCommandServices,
    'targetLogin' | 'revokeAndCleanup'
  >;
  const credentials = require('./credential-store') as Pick<
    HostedCommandServices,
    'KeyringCredentialStore' | 'targetServiceKey' | 'TARGET_ACCOUNT'
  >;
  const lock = require('./credential-lock') as Pick<HostedCommandServices, 'acquireTargetLock'>;
  const discovery = require('./discovery') as Pick<
    HostedCommandServices,
    'discoverTarget' | 'discoverTargetSessionEndpoints'
  >;
  return { ...registry, ...session, ...credentials, ...lock, ...discovery };
}

export interface HostedCommandsDependencies {
  loadSettings: SettingsPort['load'];
  mutateSettings: SettingsPort['mutate'];
  services?: HostedCommandServices;
}

/**
 * Construct the hosted command tree for isolated development and contract tests.
 * The stable CLI must not import this boundary until an authorized hosted cutover.
 */
export function registerHostedCommands(
  program: Command,
  dependencies: HostedCommandsDependencies,
): void {
  const settings: SettingsPort = {
    load: () => dependencies.loadSettings(),
    mutate: (mutator) => dependencies.mutateSettings(mutator),
  };
  registerTargetCommands(
    program,
    dependencies.services ?? loadHostedCommandServices(),
    settings,
  );
}
