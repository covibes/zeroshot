import type { Command } from 'commander';
import chalk from 'chalk';
import {
  addTarget,
  getTarget,
  listTargets,
  removeTarget,
  type SettingsPort,
} from './target-registry.ts';
import { targetLogin, revokeAndCleanup } from './target-session.ts';
import {
  KeyringCredentialStore,
  targetServiceKey,
  TARGET_ACCOUNT,
} from './credential-store.ts';
import { acquireTargetLock } from './credential-lock.ts';
import { discoverTargetSessionEndpoints } from './discovery.ts';

export interface HostedCommandsDependencies {
  loadSettings: SettingsPort['load'];
  mutateSettings: SettingsPort['mutate'];
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

          // Try to check keyring presence for each target
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

        // Try to revoke and cleanup keyring
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
          // Force mode: continue with removal
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
