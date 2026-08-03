'use strict';

const importTarget = (mod) => import(`../lib/target/${mod}.js`);

function settingsPort(deps) {
  return {
    load: () => deps.loadSettings(),
    mutate: (mutation) => deps.mutateSettings(mutation),
  };
}

function fail(deps, error) {
  deps.console.error(deps.chalk.red(error instanceof Error ? error.message : String(error)));
  deps.setExitCode(1);
}

function registerAdd(target, deps) {
  target
    .command('add <name>')
    .description('Register a named remote target')
    .requiredOption('--url <url>', 'Service origin for the target')
    .action(async (name, options) => {
      try {
        const [{ addTarget, normalizeAndValidateUrl }, { discoverTarget }] = await Promise.all([
          importTarget('target-registry'),
          importTarget('discovery'),
        ]);
        const http = { fetch: (url, init) => deps.fetch(url, init) };
        const url = normalizeAndValidateUrl(options.url);
        const descriptor = await discoverTarget(url, http);
        const record = addTarget(name, url, settingsPort(deps), descriptor);
        deps.console.log(deps.chalk.green(`Target "${name}" added (${record.url})`));
      } catch (error) {
        fail(deps, error);
      }
    });
}

function registerLogin(target, deps) {
  target
    .command('login <name>')
    .description('Authenticate with a remote target via device login')
    .action(async (name) => {
      try {
        const [
          { getTarget },
          { TargetSessionManager },
          { KeyringCredentialStore },
          { acquireTargetLock },
          { discoverTargetSessionEndpoints },
        ] = await Promise.all([
          importTarget('target-registry'),
          importTarget('target-session'),
          importTarget('credential-store'),
          importTarget('credential-lock'),
          importTarget('discovery'),
        ]);
        const settings = settingsPort(deps);
        const record = getTarget(name, settings);
        if (!record) throw new Error(`Target "${name}" not found.`);
        const http = { fetch: (url, init) => deps.fetch(url, init) };
        const endpoints = await discoverTargetSessionEndpoints(record.url, http);
        const store = await KeyringCredentialStore.create();
        const openModule = await import('open');
        const open = openModule.default || openModule;
        const manager = new TargetSessionManager({
          targetName: name,
          target: record,
          credentialStore: store,
          acquireLock: () => acquireTargetLock(record.id),
          settings,
          deps: {
            http,
            clock: { now: () => Date.now() },
            browserOpener: {
              open: async (url) => {
                await open(url);
              },
            },
            stderr: deps.stderr,
            discoveryEndpoints: endpoints,
          },
        });
        const result = await manager.login();
        deps.console.log(
          deps.chalk.green(`Logged in to "${name}" (organization: ${result.organization.id})`)
        );
      } catch (error) {
        fail(deps, error);
      }
    });
}

function registerList(target, deps) {
  target
    .command('list')
    .description('List registered remote targets')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const { listTargets } = await importTarget('target-registry');
        const targets = listTargets(settingsPort(deps));
        const output = targets.map(({ name, record }) => ({
          name,
          id: record.id,
          url: record.url,
          organization: record.organization ?? null,
          createdAt: record.createdAt,
        }));
        if (options.json) {
          deps.console.log(JSON.stringify(output, null, 2));
          return;
        }
        if (targets.length === 0) {
          deps.console.log(deps.chalk.dim('No targets registered.'));
          return;
        }
        for (const { name, record } of targets) {
          const organization = record.organization
            ? ` (org: ${record.organization.name ?? record.organization.id})`
            : '';
          deps.console.log(`  ${deps.chalk.bold(name)}  ${record.url}${organization}`);
        }
      } catch (error) {
        fail(deps, error);
      }
    });
}

function registerRemove(target, deps) {
  target
    .command('remove <name>')
    .description('Remove a named remote target')
    .option('--force', 'Remove even if remote revocation fails')
    .action(async (name, options) => {
      try {
        const [
          { getTarget, removeTarget },
          { TargetSessionManager },
          { KeyringCredentialStore },
          { acquireTargetLock },
          { discoverTargetSessionEndpoints },
        ] = await Promise.all([
          importTarget('target-registry'),
          importTarget('target-session'),
          importTarget('credential-store'),
          importTarget('credential-lock'),
          importTarget('discovery'),
        ]);
        const settings = settingsPort(deps);
        const record = getTarget(name, settings);
        if (!record) throw new Error(`Target "${name}" not found.`);
        const http = { fetch: (url, init) => deps.fetch(url, init) };
        const manager = new TargetSessionManager({
          targetName: name,
          target: record,
          credentialStore: await KeyringCredentialStore.create(),
          acquireLock: () => acquireTargetLock(record.id),
          settings,
          deps: {
            http,
            clock: { now: () => Date.now() },
            browserOpener: { open: () => Promise.resolve() },
            stderr: deps.stderr,
            discoveryEndpoints: await discoverTargetSessionEndpoints(record.url, http),
          },
        });
        await manager.revoke(Boolean(options.force));
        removeTarget(name, settings);
        deps.console.log(deps.chalk.green(`Target "${name}" removed`));
      } catch (error) {
        fail(deps, error);
      }
    });
}

function registerHostedCommands(program, dependencies) {
  const deps = {
    ...dependencies,
    console: dependencies.console ?? console,
    stderr: dependencies.stderr ?? process.stderr,
    fetch: dependencies.fetch ?? globalThis.fetch,
    setExitCode:
      dependencies.setExitCode ??
      ((code) => {
        process.exitCode = code;
      }),
  };
  const target = program.command('target').description('Manage named remote targets');
  registerAdd(target, deps);
  registerLogin(target, deps);
  registerList(target, deps);
  registerRemove(target, deps);
  target.action(() => target.help());
  return target;
}

module.exports = { registerHostedCommands };
