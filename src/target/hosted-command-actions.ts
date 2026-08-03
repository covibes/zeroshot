import type { Command } from 'commander';
import chalk from 'chalk';
import open from 'open';
import type { TargetCredentialStore } from './credential-store.js';

export interface TargetRecord {
  readonly id: string;
  readonly url: string;
  readonly organization?: { readonly name: string };
  readonly createdAt: string;
}

export interface SettingsState {
  _targets?: Record<string, TargetRecord>;
  [key: string]: unknown;
}

export interface SettingsPort {
  load(): SettingsState;
  mutate(mutator: (settings: SettingsState) => void): void;
}


interface TargetSessionEndpoints {
  readonly deviceAuthorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
}

interface TargetDiscoveryDescriptor {
  readonly origin: string;
  readonly adapter: { readonly majorVersion: number };
}

interface HttpTransport {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

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
  options: { http: HttpTransport; discoveryEndpoints: TargetSessionEndpoints },
  force: boolean,
];

export interface HostedCommandServices {
  addTarget(
    name: string,
    url: string,
    settings: SettingsPort,
    descriptor: TargetDiscoveryDescriptor,
  ): TargetRecord;
  normalizeAndValidateUrl(rawUrl: string): string;
  getTarget(name: string, settings: SettingsPort): TargetRecord | null;
  listTargets(settings: SettingsPort): Array<{ name: string; record: TargetRecord }>;
  removeTarget(name: string, settings: SettingsPort): TargetRecord;
  targetLogin(...args: TargetLoginArguments): Promise<{ organization: { name: string } }>;
  revokeAndCleanup(...args: RevokeArguments): Promise<void>;
  KeyringCredentialStore: { create(): Promise<TargetCredentialStore> };
  targetServiceKey(targetId: string): string;
  TARGET_ACCOUNT: string;
  acquireTargetLock(targetId: string): Promise<() => Promise<void>>;
  discoverTarget(
    targetUrl: string,
    http: HttpTransport,
  ): Promise<TargetDiscoveryDescriptor>;
  discoverTargetSessionEndpoints(
    targetUrl: string,
    http: HttpTransport,
  ): Promise<TargetSessionEndpoints>;
}

interface CommandContext {
  readonly services: HostedCommandServices;
  readonly settings: SettingsPort;
}

function fail(error: unknown): never {
  console.error(chalk.red((error as Error).message));
  process.exit(1);
}

function registerAdd(target: Command, context: CommandContext): void {
  target
    .command('add <name>')
    .description('Register a named remote target')
    .requiredOption('--url <url>', 'Service URL for the target')
    .action(async (name, options) => {
      try {
        const url = context.services.normalizeAndValidateUrl(options.url);
        const http = { fetch: (requestUrl: string, init: RequestInit) => fetch(requestUrl, init) };
        const discovery = await context.services.discoverTarget(url, http);
        const record = context.services.addTarget(name, url, context.settings, discovery);
        console.log(chalk.green(`✓ Target "${name}" added (${record.url})`));
      } catch (error) {
        fail(error);
      }
    });
}

function registerLogin(target: Command, context: CommandContext): void {
  target
    .command('login <name>')
    .description('Authenticate with a remote target via device login')
    .action(async (name) => {
      try {
        const record = context.services.getTarget(name, context.settings);
        if (record === null) fail(new Error(`Target "${name}" not found.`));
        const http = { fetch: (url: string, init: RequestInit) => fetch(url, init) };
        const discovery = await context.services.discoverTargetSessionEndpoints(record.url, http);
        const credentials = await context.services.KeyringCredentialStore.create();
        const result = await context.services.targetLogin(
          name,
          record,
          credentials,
          () => context.services.acquireTargetLock(record.id),
          context.settings,
          {
            http,
            clock: { now: () => Date.now() },
            browserOpener: { open: async (url) => { await open(url); } },
            stderr: process.stderr,
            discoveryEndpoints: discovery,
          },
        );
        console.log(
          chalk.green(`✓ Logged in to "${name}" (organization: ${result.organization.name})`),
        );
      } catch (error) {
        fail(error);
      }
    });
}

async function listJson(context: CommandContext): Promise<void> {
  const targets = context.services.listTargets(context.settings);
  const output = targets.map(({ name, record }) => ({
    name,
    id: record.id,
    url: record.url,
    organization: record.organization ?? null,
    loggedIn: false,
    createdAt: record.createdAt,
  }));
  try {
    const store = await context.services.KeyringCredentialStore.create();
    for (const item of output) {
      const matching = targets.find((target) => target.name === item.name);
      if (matching !== undefined) {
        const credential = await store.get(
          context.services.targetServiceKey(matching.record.id),
          context.services.TARGET_ACCOUNT,
        );
        item.loggedIn = credential !== null;
      }
    }
  } catch {
    // An unavailable optional keyring is represented as logged out without exposing details.
  }
  console.log(JSON.stringify(output, null, 2));
}

function listText(context: CommandContext): void {
  const targets = context.services.listTargets(context.settings);
  if (targets.length === 0) {
    console.log(
      chalk.dim('No targets registered. Use `zeroshot target add <name> --url <url>` to add one.'),
    );
    return;
  }
  for (const { name, record } of targets) {
    const organization = record.organization ? ` (org: ${record.organization.name})` : '';
    console.log(`  ${chalk.bold(name)}  ${record.url}${organization}`);
  }
}

function registerList(target: Command, context: CommandContext): void {
  target
    .command('list')
    .description('List registered remote targets')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        if (options.json) await listJson(context);
        else listText(context);
      } catch (error) {
        fail(error);
      }
    });
}

async function cleanupTarget(
  record: TargetRecord,
  force: boolean,
  context: CommandContext,
): Promise<void> {
  let credentials: TargetCredentialStore;
  try {
    credentials = await context.services.KeyringCredentialStore.create();
  } catch (error) {
    if (!force) throw error;
    return;
  }
  try {
    const http = { fetch: (url: string, init: RequestInit) => fetch(url, init) };
    const discovery = await context.services.discoverTargetSessionEndpoints(record.url, http);
    await context.services.revokeAndCleanup(
      record,
      credentials,
      () => context.services.acquireTargetLock(record.id),
      { http, discoveryEndpoints: discovery },
      force,
    );
  } catch (error) {
    if (!force) throw error;
    const release = await context.services.acquireTargetLock(record.id);
    try {
      await credentials.delete(
        context.services.targetServiceKey(record.id),
        context.services.TARGET_ACCOUNT,
      );
    } finally {
      await release();
    }
  }
}

function registerRemove(target: Command, context: CommandContext): void {
  target
    .command('remove <name>')
    .description('Remove a named remote target')
    .option('--force', 'Remove even if remote revocation fails')
    .action(async (name, options) => {
      try {
        const record = context.services.getTarget(name, context.settings);
        if (record === null) fail(new Error(`Target "${name}" not found.`));
        await cleanupTarget(record, Boolean(options.force), context);
        context.services.removeTarget(name, context.settings);
        console.log(chalk.green(`✓ Target "${name}" removed`));
      } catch (error) {
        fail(error);
      }
    });
}

export function registerTargetCommands(
  program: Command,
  services: HostedCommandServices,
  settings: SettingsPort,
): void {
  const target = program.command('target').description('Manage named remote targets');
  const context = { services, settings };
  registerAdd(target, context);
  registerLogin(target, context);
  registerList(target, context);
  registerRemove(target, context);
  target.action(() => target.help());
}
