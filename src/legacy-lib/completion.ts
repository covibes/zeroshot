import os = require('os');
import path = require('path');
import type { Command, Option } from 'commander';
import omelette = require('omelette');
import clustersRegistry = require('./clusters-registry');

interface ClustersRegistryFacade {
  readClustersFileSync(storageDir: string): unknown;
}

interface CompletionDependencies {
  listClusterIds?: () => unknown;
}

const { readClustersFileSync }: ClustersRegistryFacade = clustersRegistry;

const CLUSTER_ID_COMMANDS = new Set([
  'attach',
  'export',
  'finish',
  'kill',
  'logs',
  'resume',
  'status',
  'stop',
]);

function commandNames(command: Command): string[] {
  return [command.name(), ...command.aliases()];
}

function visibleCommands(command: Command): Command[] {
  return command.createHelp().visibleCommands(command);
}

function visibleOptions(command: Command): Option[] {
  return command.createHelp().visibleOptions(command);
}

function optionNames(option: Option): string[] {
  return [option.short, option.long].filter((name): name is string => Boolean(name));
}

function findSubcommand(command: Command, token: string): Command | undefined {
  return visibleCommands(command).find((candidate) => commandNames(candidate).includes(token));
}

function findOption(command: Command, token: string): Option | undefined {
  const optionToken = token.split('=', 1)[0] ?? '';
  return visibleOptions(command).find((option) => optionNames(option).includes(optionToken));
}

function parseCompletionLine(line: string): { completed: string[]; current: string } {
  const trailingSpace = /\s$/.test(line);
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  tokens.shift();
  const current = trailingSpace ? '' : (tokens.pop() ?? '');
  return { completed: tokens, current };
}

function resolveCommandContext(
  program: Command,
  tokens: string[]
): { command: Command; commandPath: string } {
  let command = program;
  const pathParts: string[] = [];
  let expectsOptionValue = false;
  let sawPositional = false;

  for (const token of tokens) {
    if (expectsOptionValue) {
      expectsOptionValue = false;
      continue;
    }

    const option = findOption(command, token);
    if (option) {
      expectsOptionValue = !token.includes('=') && (option.required || option.optional);
      continue;
    }
    if (token.startsWith('-')) continue;

    const subcommand = sawPositional ? undefined : findSubcommand(command, token);
    if (subcommand) {
      command = subcommand;
      pathParts.push(subcommand.name());
      continue;
    }
    sawPositional = true;
  }

  return { command, commandPath: pathParts.join(' ') };
}

function defaultListClusterIds(): string[] {
  const homeDir =
    process.env.ZEROSHOT_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const registry = readClustersFileSync(path.join(homeDir, '.zeroshot'));
  // Preserve the legacy failure behavior if a corrupt registry is not an object.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return Object.keys(registry as object);
}

function safeDynamicIds(commandPath: string, listClusterIds: () => unknown): string[] {
  if (!CLUSTER_ID_COMMANDS.has(commandPath)) return [];
  try {
    const ids = listClusterIds();
    if (!Array.isArray(ids)) return [];
    const unknownIds: unknown[] = ids;
    return unknownIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

function getCompletionCandidates(
  program: Command,
  line: string,
  deps: CompletionDependencies = {}
): string[] {
  const { completed, current } = parseCompletionLine(line);
  const { command, commandPath } = resolveCommandContext(program, completed);
  const listClusterIds = deps.listClusterIds || defaultListClusterIds;
  const candidates = [
    ...visibleCommands(command).flatMap(commandNames),
    ...visibleOptions(command).flatMap(optionNames),
    ...safeDynamicIds(commandPath, listClusterIds),
  ];

  return [...new Set(candidates)].filter((candidate) => candidate.startsWith(current));
}

function setupCompletion(
  program: Command,
  deps: CompletionDependencies = {}
): ReturnType<typeof omelette> {
  const complete = omelette('zeroshot');
  complete.on('complete', (_fragment, data) => {
    data.reply(getCompletionCandidates(program, data.line, deps));
  });
  complete.init();
  return complete;
}

export = {
  getCompletionCandidates,
  setupCompletion,
};
