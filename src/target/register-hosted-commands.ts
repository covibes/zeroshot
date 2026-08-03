import type { Command } from 'commander';
import chalk from 'chalk';
interface TargetRecord {
  readonly id: string;
  readonly url: string;
  readonly organization?: { readonly name: string };
  readonly createdAt: string;
}

interface SettingsState {
  _targets?: Record<string, TargetRecord>;
  [key: string]: unknown;
}

interface SettingsPort {
  load(): SettingsState;
  mutate(mutator: (settings: SettingsState) => void): void;
}

interface TargetCredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, token: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

interface TargetSessionEndpoints {
  readonly deviceAuthorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
}

interface HttpTransport {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

type AcquireTargetLock = (targetId: string) => Promise<() => Promise<void>>;
type TargetLoginArguments = [
  targetName: string,
  target: TargetRecord,
  credentialStore: TargetCredentialStore,
  acquireLock: () => Promise<() => Promise<void>>,
  settings: SettingsPort,
  options: {
    http: HttpTransport;
    clock: { now(): number };
    browserOpener: { open(url: string): Promise<void> };
    stderr: NodeJS.WritableStream;
    discoveryEndpoints: TargetSessionEndpoints;
  },
];
type RevokeArguments = [
  target: TargetRecord,
  credentialStore: TargetCredentialStore,
  acquireLock: () => Promise<() => Promise<void>>,
  options: {
    http: HttpTransport;
    discoveryEndpoints: TargetSessionEndpoints;
  },
  force: boolean,
];

interface HostedCommandServices {
  addTarget(name: string, url: string, settings: SettingsPort): TargetRecord;
  getTarget(name: string, settings: SettingsPort): TargetRecord | null;
  listTargets(settings: SettingsPort): Array<{ name: string; record: TargetRecord }>;
  removeTarget(name: string, settings: SettingsPort): TargetRecord;
  targetLogin(...args: TargetLoginArguments): Promise<{ organization: { name: string } }>;
  revokeAndCleanup(...args: RevokeArguments): Promise<void>;
  KeyringCredentialStore: { create(): Promise<TargetCredentialStore> };
  targetServiceKey(targetId: string): string;
  TARGET_ACCOUNT: string;
  acquireTargetLock: AcquireTargetLock;
  discoverTargetSessionEndpoints(
    targetUrl: string,
    http: HttpTransport,
  ): Promise<TargetSessionEndpoints>;
}

function loadHostedCommandServices(): HostedCommandServices {
  const registry = require('./target-registry') as Pick<
    HostedCommandServices,
    'addTarget' | 'getTarget' | 'listTargets' | 'removeTarget'
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
    'discoverTargetSessionEndpoints'
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
 *
 * The stable CLI must not import or call this boundary until a separately authorized
 * hosted MVP cutover. Keeping construction in one module prevents tests and future
 * hosted commands from growing a second command registry in cli/index.js.
 */
export function registerHostedCommands(
  program: Command,
  dependencies: HostedCommandsDependencies,
): void {
  const {
    addTarget,
    getTarget,
    listTargets,
    removeTarget,
    targetLogin,
    revokeAndCleanup,
    KeyringCredentialStore,
    targetServiceKey,
    TARGET_ACCOUNT,
    acquireTargetLock,
    discoverTargetSessionEndpoints,
  } = dependencies.services ?? loadHostedCommandServices();
  const settingsPort: SettingsPort = {
    load: () => dependencies.loadSettings(),
    mutate: (fn) => dependencies.mutateSettings(fn),
  };

  const targetCmd = program.command('target').description('Manage named remote targets');

  targetCmd
    .command('add <name>')
    .description('Register a named remote target')
    .requiredOption('--url <url>', 'Service URL for the target')
    .action(async (name, options) => {
      try {
        const record = addTarget(name, options.url, settingsPort);
        console.log(chalk.green(`✓ Target "${name}" added (${record.url})`));
      } catch (error) {
        console.error(chalk.red((error as Error).message));
        process.exit(1);
      }
    });

  targetCmd
    .command('login <name>')
    .description('Authenticate with a remote target via device login')
    .action(async (name) => {
      try {
        const target = getTarget(name, settingsPort);
        if (!target) {
          console.error(chalk.red(`Target "${name}" not found.`));
          process.exit(1);
        }

        const http = { fetch: (url: string, init: RequestInit) => fetch(url, init) };
        const discoveryEndpoints = await discoverTargetSessionEndpoints(target.url, http);

        const credentialStore = await KeyringCredentialStore.create();
        const openPkg = await import('open');
        const browserOpen = openPkg.default || openPkg;

        const result = await targetLogin(
          name,
          target,
          credentialStore,
          () => acquireTargetLock(target.id),
          settingsPort,
          {
            http,
            clock: { now: () => Date.now() },
            browserOpener: {
              open: async (url: string) => {
                await browserOpen(url);
              },
            },
            stderr: process.stderr,
            discoveryEndpoints,
          },
        );

        console.log(
          chalk.green(`✓ Logged in to "${name}" (organization: ${result.organization.name})`),
        );
      } catch (error) {
        console.error(chalk.red((error as Error).message));
        process.exit(1);
      }
    });

  targetCmd
    .command('list')
    .description('List registered remote targets')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const targets = listTargets(settingsPort);

        if (options.json) {
          const output = targets.map(({ name, record }) => ({
            name,
            id: record.id,
            url: record.url,
            organization: record.organization ?? null,
            loggedIn: false,
            createdAt: record.createdAt,
          }));

          try {
            const store = await KeyringCredentialStore.create();
            for (const item of output) {
              const matchingTarget = targets.find((t) => t.name === item.name);
              if (matchingTarget) {
                const cred = await store.get(
                  targetServiceKey(matchingTarget.record.id),
                  TARGET_ACCOUNT,
                );
                item.loggedIn = cred !== null;
              }
            }
          } catch {
            // Keyring unavailable, all show as not logged in
          }

          console.log(JSON.stringify(output, null, 2));
          return;
        }

        if (targets.length === 0) {
          console.log(
            chalk.dim(
              'No targets registered. Use `zeroshot target add <name> --url <url>` to add one.',
            ),
          );
          return;
        }

        for (const { name, record } of targets) {
          const org = record.organization ? ` (org: ${record.organization.name})` : '';
          console.log(`  ${chalk.bold(name)}  ${record.url}${org}`);
        }
      } catch (error) {
        console.error(chalk.red((error as Error).message));
        process.exit(1);
      }
    });

  targetCmd
    .command('remove <name>')
    .description('Remove a named remote target')
    .option('--force', 'Remove even if remote revocation fails')
    .action(async (name, options) => {
      try {
        const target = getTarget(name, settingsPort);
        if (!target) {
          console.error(chalk.red(`Target "${name}" not found.`));
          process.exit(1);
        }

        try {
          const credentialStore = await KeyringCredentialStore.create();
          const http = { fetch: (url: string, init: RequestInit) => fetch(url, init) };
          const discoveryEndpoints = await discoverTargetSessionEndpoints(target.url, http);
          await revokeAndCleanup(
            target,
            credentialStore,
            () => acquireTargetLock(target.id),
            {
              http,
              discoveryEndpoints,
            },
            !!options.force,
          );
        } catch (error) {
          if (!options.force) {
            console.error(chalk.red((error as Error).message));
            process.exit(1);
          }
        }

        removeTarget(name, settingsPort);
        console.log(chalk.green(`✓ Target "${name}" removed`));
      } catch (error) {
        console.error(chalk.red((error as Error).message));
        process.exit(1);
      }
    });

  targetCmd.action(() => {
    targetCmd.help();
  });
}
